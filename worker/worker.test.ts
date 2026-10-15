import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  Fetcher, FetchError, classifyAnnouncement, fetchSnapshot, parseAsOf, parseCompany, parseIndices, parseNum,
  parseRange, parseScreener, toPrice, toScreenRows,
} from './feed.ts';
import { MemoryStore, type UserCtx } from './store.ts';
import { processTelegramUpdates } from './telegram.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('feed parsers (saved PSX pages, 2026-10-05 close)', () => {
  it('parses numbers, ranges and times', () => {
    expect(parseNum('Rs.114.37')).toBe(114.37);
    expect(parseNum('(-1.27%)')).toBe(-1.27);
    expect(parseNum('1,830,789')).toBe(1830789);
    expect(parseNum('12.6B')).toBeCloseTo(12.6e9);
    expect(parseNum('N/A')).toBeNull();
    expect(parseNum('')).toBeNull();
    expect(parseRange('105.98 — 174.40')).toEqual([105.98, 174.4]);
    expect(parseAsOf('^ As of Mon, Oct 5, 2026 3:49 PM')).toBe('2026-10-05T10:49:00.000Z');
    expect(parseAsOf('nothing')).toBeNull();
  });

  it('classifies announcements', () => {
    expect(classifyAnnouncement('Final Cash Dividend')).toBe('dividend');
    expect(classifyAnnouncement('FINANCIAL RESULTS FOR THE HALF YEAR')).toBe('results');
    expect(classifyAnnouncement('237th Board Meeting')).toBe('board_meeting');
    expect(classifyAnnouncement('Notice of AGM')).toBe('other');
  });

  it('reads KSE-100 from the homepage', () => {
    const i = parseIndices(fx('home.html'));
    expect(i.KSE100).toEqual({ name: 'KSE100', value: 165867.31, change: -2288.18, change_pct: -1.36 });
  });

  it('reads the annual profit table (thousands) and the 30-day average volume for the blue-chip checks', () => {
    const q = parseCompany(fx('company_SYS.html'), 'SYS');
    expect(q.annual_profits).toEqual([
      { year: 2025, profit_after_tax: 8_019_014_000 }, { year: 2024, profit_after_tax: 6_115_297_000 },
      { year: 2023, profit_after_tax: 8_559_160_000 }, { year: 2022, profit_after_tax: 6_299_837_000 },
    ]);
    const s = parseScreener(fx('screener_trimmed.html'));
    expect(s.SYS.avg_volume_30d).toBeGreaterThan(0);
    expect(s.SYS.listed_in).toContain('KSE100');
  });

  it('reads a company page', () => {
    const q = parseCompany(fx('company_SYS.html'), 'sys');
    expect(q).toMatchObject({
      symbol: 'SYS', price: 114.37, change: -1.47, change_pct: -1.27, ldcp: 115.84, volume: 1830789,
      low_52w: 105.98, high_52w: 174.4, as_of: '2026-10-05T10:49:00.000Z', sector: 'TECHNOLOGY & COMMUNICATION',
    });
    expect(q.announcements.length).toBeGreaterThan(3);
    expect(new Set(q.announcements.map((a) => a.id)).size).toBe(q.announcements.length);
    expect(q.announcements.every((a) => a.pdf_url == null || a.pdf_url.startsWith('https://dps.psx.com.pk/'))).toBe(true);
  });

  it('reads the screener, including Shariah (KMI All Share) membership', () => {
    const s = parseScreener(fx('screener_trimmed.html'));
    expect(s.SYS.price).toBe(114.37);
    expect(s.MEBL.dividend_yield_pct).toBe(5.71);
    expect(s.SYS.sector).toBe('TECHNOLOGY & COMMUNICATION');
    expect(toPrice(parseCompany(fx('company_SYS.html'), 'SYS'), s.SYS).is_shariah).toBe(true);
    expect(toPrice(parseCompany(fx('company_SYS.html'), 'UBL'), s.UBL).is_shariah).toBe(false);
    expect(typeof s.SYS.change_1y_pct).toBe('number');
    const xd = parseScreener('<table><tr><th>SYMBOL</th><th>PRICE</th><th>LISTED IN</th></tr><tr><td data-order="HUBC">HUBC<span class="badge">XD</span></td><td>195.5</td><td>KSE100</td></tr></table>');
    expect(Object.keys(xd)).toEqual(['HUBC']);
    const rows = toScreenRows(s);
    expect(rows.find((r) => r.symbol === 'SYS')).toMatchObject({ is_shariah: true, price: 114.37 });
    expect(rows.find((r) => r.symbol === 'UBL')?.is_shariah).toBe(false);
  });

  it('a redesigned page gives nulls, never garbage', () => {
    const badge = parseCompany('<div class="quote__name">Lucky Cement Limited<span class="badge">XD</span></div>', 'LUCK');
    expect(badge.name).toBe('Lucky Cement Limited');
    const q = parseCompany('<html><body>new layout</body></html>', 'SYS');
    expect(q.price).toBeNull();
    expect(q.announcements).toEqual([]);
    expect(parseIndices('<html></html>')).toEqual({});
    expect(parseScreener('<html></html>')).toEqual({});
  });
});

describe('fetcher', () => {
  const noSleep = async () => {};
  it('never throws from fetchSnapshot when PSX is down', async () => {
    const down: typeof fetch = async () => { throw new TypeError('fetch failed'); };
    const snap = await fetchSnapshot(['SYS'], { fetcher: new Fetcher({ fetchImpl: down, sleep: noSleep }) });
    expect(snap.quotes).toEqual({});
    expect(snap.errors).toHaveLength(3);
  });
  it('retries 5xx but not 4xx', async () => {
    let calls = 0;
    const f = (status: number): typeof fetch => async () => { calls++; return new Response('', { status }); };
    await expect(new Fetcher({ fetchImpl: f(404), sleep: noSleep }).get('/x')).rejects.toBeInstanceOf(FetchError);
    expect(calls).toBe(1);
    calls = 0;
    await expect(new Fetcher({ fetchImpl: f(503), sleep: noSleep }).get('/x')).rejects.toBeInstanceOf(FetchError);
    expect(calls).toBe(3);
  });
  it('sends an honest User-Agent', async () => {
    let ua = '';
    const f: typeof fetch = async (_u, init) => { ua = new Headers(init?.headers).get('User-Agent') ?? ''; return new Response('ok'); };
    await new Fetcher({ fetchImpl: f, sleep: noSleep }).get('/');
    expect(ua).toMatch(/^psx-personal-assistant/);
  });
});


const owner = (): UserCtx => ({
  id: 'owner-1', settings: { ...DEFAULT_SETTINGS }, holdings: SEED_HOLDINGS, watchlist: SEED_WATCHLIST, telegram_chat_id: null, subs: [],
});

describe('telegram linking', () => {
  it('links a chat with a valid code and rejects a bad one', async () => {
    const store = new MemoryStore([owner()]);
    store.linkCodes['ABCD1234'] = { user_id: 'owner-1', expires_at: new Date(Date.now() + 60000).toISOString() };
    const calls: { method: string; body: any }[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = String(url).split('/').pop()!;
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ method, body });
      const result = method === 'getUpdates' && body.offset == null
        ? [{ update_id: 10, message: { chat: { id: 555 }, text: '/start ABCD1234' } }, { update_id: 11, message: { chat: { id: 777 }, text: '/start ZZZZ9999' } }]
        : true;
      return new Response(JSON.stringify({ ok: true, result }));
    });
    const r = await processTelegramUpdates('TOKEN', store, () => {});
    fetchMock.mockRestore();
    expect(r.linked).toBe(1);
    expect(store.telegram['owner-1']).toBe(555);
    expect(calls.find((c) => c.method === 'getUpdates' && c.body.offset === 12)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.chat_id)).toEqual([555, 777]);
  });
});

describe('audit opinion from an annual report (no AI)', () => {
  it('reads a qualified, adverse or disclaimed opinion as a red flag and an unqualified one as clean', async () => {
    const { auditOpinion, reportYear } = await import('./bluechip.ts');
    expect(auditOpinion("INDEPENDENT AUDITOR'S REPORT ... Basis for Qualified Opinion ... except for the effects")).toEqual({ qualified: true });
    expect(auditOpinion("Independent Auditor's Report. Opinion: We have audited ... In our opinion the financial statements give a true and fair view")).toEqual({ qualified: false });
    expect(auditOpinion('Independent auditor report: we express an unqualified opinion')).toEqual({ qualified: false });
    expect(auditOpinion('Chairman review and directors report only')).toBeNull(); // no auditor's report in the text: unknown
    expect(reportYear('Transmission of Annual Report for the year ended June 30, 2026', '2026-10-01')).toBe(2026);
  });
});
