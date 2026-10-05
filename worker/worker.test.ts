import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Fetcher, FetchError, classifyAnnouncement, fetchSnapshot, parseAsOf, parseCompany, parseIndices, parseNum,
  parseRange, parseScreener, toPrice, type Snapshot,
} from './feed.ts';
import { runJob } from './jobs.ts';
import { ConsoleNotifier } from './notify.ts';
import { MemoryStore, type UserCtx } from './store.ts';
import { processTelegramUpdates } from './telegram.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';
import { vi } from 'vitest';

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

// ---------------------------------------------------------------------------
// Job orchestration with an in-memory store and a canned snapshot
// ---------------------------------------------------------------------------
function snapshotFromFixtures(changePct = -1.36, asOf = '2026-10-05T10:49:00.000Z'): Snapshot {
  const scr = parseScreener(fx('screener_trimmed.html'));
  const sys = parseCompany(fx('company_SYS.html'), 'SYS');
  const quotes: Snapshot['quotes'] = {};
  for (const h of SEED_HOLDINGS) {
    const base = h.symbol === 'SYS' ? sys : { ...sys, symbol: h.symbol, announcements: [], price: h.avg_cost * 0.97 };
    quotes[h.symbol] = { ...base, as_of: asOf, change_pct: base.change_pct };
  }
  return {
    fetched_at: asOf, screener: scr, errors: [], quotes,
    indices: { KSE100: { name: 'KSE100', value: 160000, change: changePct * 1600, change_pct: changePct } },
  };
}

const owner = (): UserCtx => ({
  id: 'owner-1', settings: { ...DEFAULT_SETTINGS }, holdings: SEED_HOLDINGS, watchlist: SEED_WATCHLIST,
  telegram_chat_id: null, subs: [{ id: 's1', endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' }],
});

describe('jobs', () => {
  const midday = new Date('2026-10-05T07:30:00Z'); // Mon 12:30 PKT
  const quiet = () => {};

  it('writes prices, index and announcements, and a heartbeat row', async () => {
    const store = new MemoryStore([owner()]);
    const r = await runJob('midday', { store, notifier: new ConsoleNotifier(quiet), fetchSnapshot: async () => snapshotFromFixtures(), now: () => midday, log: quiet });
    expect(r.ok).toBe(true);
    expect(Object.keys(store.prices)).toHaveLength(8);
    expect(store.index).toHaveLength(1);
    expect(store.announcements.length).toBeGreaterThan(0);
    expect(store.runs[0]).toMatchObject({ job: 'midday', ok: true });
  });

  it('does not repeat an alert in the next run (dedupe)', async () => {
    const store = new MemoryStore([owner()]);
    const n = new ConsoleNotifier(quiet);
    const deps = { store, notifier: n, fetchSnapshot: async () => snapshotFromFixtures(-2.5), log: quiet };
    await runJob('midday', { ...deps, now: () => midday });
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0].n.alerts.some((a) => a.kind === 'dip')).toBe(true);
    await runJob('preclose', { ...deps, now: () => new Date('2026-10-05T10:00:00Z') });
    expect(n.sent).toHaveLength(1); // nothing new
  });

  it('crash goes through even after 3 notifications today', async () => {
    const store = new MemoryStore([owner()]);
    for (let i = 0; i < 3; i++) {
      store.alerts.push({ user_id: 'owner-1', kind: 'x', symbol: null, message: 'm', channel: 'push', sent_at: '2026-10-05T05:00:00Z', dedupe_key: `x${i}`, batch_id: `b${i}` });
    }
    const n = new ConsoleNotifier(quiet);
    await runJob('midday', { store, notifier: n, fetchSnapshot: async () => snapshotFromFixtures(-4.5), now: () => midday, log: quiet });
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0].n.urgent).toBe(true);
    expect(store.alerts.filter((a) => a.channel === 'none').length).toBeGreaterThan(0); // the rest were held back, but logged
  });

  it('sends "data unavailable" at most once a day and keeps the last good prices', async () => {
    const store = new MemoryStore([owner()]);
    const n = new ConsoleNotifier(quiet);
    const broken = async (): Promise<Snapshot> => ({ fetched_at: '', indices: {}, quotes: {}, screener: {}, errors: ['GET / failed: HTTP 503'] });
    const r1 = await runJob('midday', { store, notifier: n, fetchSnapshot: broken, now: () => midday, log: quiet });
    await runJob('preclose', { store, notifier: n, fetchSnapshot: broken, now: () => new Date('2026-10-05T10:00:00Z'), log: quiet });
    expect(r1.ok).toBe(false);
    expect(n.sent.filter((s) => s.n.alerts.some((a) => a.kind === 'data_unavailable'))).toHaveLength(1);
    expect(store.runs.every((x) => x.ok === false)).toBe(true);
  });

  it('skips market alerts on a day PSX did not trade (weekend/holiday)', async () => {
    const store = new MemoryStore([owner()]);
    const n = new ConsoleNotifier(quiet);
    // Data still from Friday; run on Monday (e.g. a holiday)
    await runJob('midday', { store, notifier: n, fetchSnapshot: async () => snapshotFromFixtures(-3, '2026-10-02T10:49:00.000Z'), now: () => midday, log: quiet });
    expect(n.sent.flatMap((s) => s.n.alerts).some((a) => a.kind === 'dip')).toBe(false);
  });

  it('weekly job saves one plan a month and reviews old ones', async () => {
    const store = new MemoryStore([owner()]);
    const n = new ConsoleNotifier(quiet);
    const sunday = new Date('2026-10-04T13:00:00Z');
    await runJob('weekly', { store, notifier: n, fetchSnapshot: async () => snapshotFromFixtures(), now: () => sunday, log: quiet });
    expect(store.recs).toHaveLength(1);
    expect(n.sent[0].n.title).toMatch(/^Weekly plan/);
    // A week later: no second plan, and the first gets reviewed
    store.recs[0].created_at = '2026-10-04T13:00:00Z';
    await runJob('weekly', { store, notifier: n, fetchSnapshot: async () => snapshotFromFixtures(), now: () => new Date('2026-10-11T13:00:00Z'), log: quiet });
    expect(store.recs).toHaveLength(1);
    expect(store.recs[0].outcome_checked_at).not.toBeNull();
  });

  it('test job reaches the user by email', async () => {
    const store = new MemoryStore([owner()]);
    store.emails['me@example.com'] = 'owner-1';
    const n = new ConsoleNotifier(quiet);
    const r = await runJob('test', { store, notifier: n, fetchSnapshot: async () => snapshotFromFixtures(), testEmail: 'me@example.com', log: quiet });
    expect(r.ok).toBe(true);
    expect(n.sent[0].n.urgent).toBe(true);
  });
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
