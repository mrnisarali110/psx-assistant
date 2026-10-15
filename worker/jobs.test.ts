import { describe, expect, it } from 'vitest';
import { publicErrors, runJob } from './jobs.ts';
import { dedupeFilings } from '../shared/news.ts';
import { ConsoleNotifier } from './notify.ts';
import { MemoryStore, type UserCtx } from './store.ts';
import type { Snapshot } from './feed.ts';
import type { LlmRouter } from '../shared/llm.ts';
import type { Announcement } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_SCREEN, SEED_SETTINGS, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';

const quiet = () => {};
const MON_1230 = new Date('2026-10-05T07:30:00Z'); // market hours
const MON_1515 = new Date('2026-10-05T10:15:00Z'); // 15 min before close
const MON_2100 = new Date('2026-10-05T16:00:00Z'); // night digest
const AS_OF = '2026-10-05T10:49:00.000Z';

const owner = (ai = true): UserCtx => ({
  id: 'owner-1', settings: { ...SEED_SETTINGS, ai_enabled: ai, trim_pe_over_sector_pct: 0 }, holdings: SEED_HOLDINGS, watchlist: SEED_WATCHLIST, // P/E trim off: these tests are about the price rules
  telegram_chat_id: null, subs: [{ id: 's1', endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' }],
});

const filing: Announcement = { id: 'psx-doc-1', symbol: 'MEBL', title: 'Financial results with interim cash dividend', kind: 'results', published_at: '2026-10-05', pdf_url: 'https://dps.psx.com.pk/download/document/1.pdf' };

function snap(changePct = -1.36, asOf = AS_OF, symbols?: string[]): Snapshot {
  const screener = Object.fromEntries(SEED_SCREEN.map((r) => [r.symbol, {
    symbol: r.symbol, ex: null, sector_code: '', sector: r.sector, listed_in: ['KSE100', ...(r.is_shariah ? ['KMIALLSHR'] : [])], price: r.price,
    change_pct: r.change_pct, change_1y_pct: r.change_1y_pct ?? null, pe: r.pe, dividend_yield_pct: r.dividend_yield_pct, market_cap: r.market_cap,
  }]));
  const quotes = Object.fromEntries(Object.values(SEED_PRICES).filter((p) => !symbols || symbols.includes(p.symbol)).map((p) => [p.symbol, {
    ...p, open: null, high: null, low: null, as_of: asOf, announcements: p.symbol === 'MEBL' ? [filing] : [],
  }]));
  return { fetched_at: asOf, errors: [], screener, quotes, indices: { KSE100: { name: 'KSE100', value: SEED_INDEX.kse100, change: null, change_pct: changePct } } };
}
const broken = async (): Promise<Snapshot> => ({ fetched_at: '', indices: {}, quotes: {}, screener: {}, errors: ['GET / failed: HTTP 503'] });

/** Canned AI: dividend from the filing, an insight, and picks. `fail` makes every call throw; `oldNotice` makes the filing read like a 2020 re-upload. */
function fakeAi(fail = false, oldNotice = false): LlmRouter & { calls: string[] } {
  const calls: string[] = [];
  return {
    available: true, calls,
    async json(task: string, system: string, parts: any[]) {
      calls.push(task);
      if (fail) throw new Error('AI unavailable: 429');
      if (task === 'pdf' && oldNotice) return { model: 'fake', data: { summary: 'Board meeting held on September 30, 2020 approved an interim dividend.', figures: [{ label: 'Meeting date', value: 'September 30, 2020' }], cash_dividend_per_share: 7, dividend_type: 'interim', book_closure_from: '2020-10-20', book_closure_to: '2020-10-22' } };
      if (task === 'pdf') return { model: 'fake', data: { summary: 'MEBL profit up; interim dividend Rs 7.', figures: [], cash_dividend_per_share: 7, dividend_type: 'interim', book_closure_from: '2026-10-19', book_closure_to: '2026-10-21', quarter_end: '2026-09-30', quarter_profit_after_tax: -539104000 } };
      if (system.includes('cautious assistant')) return { model: 'fake', data: {
        headline: 'Banks are cheap versus your last buys.', stance: 'buy',
        holding_calls: [{ symbol: 'UBL', call: 'opportunity', text: 'UBL 6.5% below your last buy' }],
        suggestions: [{ action: 'add', symbol: 'MEBL', text: 'Add MEBL', why: '6% below your last buy, weight 19.5%', confidence: 'high' }],
      } };
      const facts = JSON.parse(parts[0].text.split('Facts (JSON):\n')[1]);
      return { model: 'fake', data: { items: facts.slice(0, 2).map((f: any) => ({ symbol: f.symbol, why: `${f.dividend_yield_pct}% yield` })) } };
    },
  } as unknown as LlmRouter & { calls: string[] };
}

const deps = (store: MemoryStore, n: ConsoleNotifier, now: Date, extra: Record<string, unknown> = {}) =>
  ({ store, notifier: n, fetchSnapshot: async () => snap(), now: () => now, log: quiet, ...extra });

describe('market job', () => {
  it('writes prices, index, screen and filings, and a heartbeat row', async () => {
    const store = new MemoryStore([owner(false)]);
    const r = await runJob('market', deps(store, new ConsoleNotifier(quiet), MON_1230));
    expect(r.ok).toBe(true);
    expect(Object.keys(store.prices)).toHaveLength(13);
    expect(store.index).toHaveLength(1);
    expect(store.screen.length).toBeGreaterThan(50);
    expect(store.announcements.map((a) => a.id)).toEqual(['psx-doc-1']);
    expect(store.runs[0]).toMatchObject({ job: 'market', ok: true });
  });

  it('files a holding that has no sector under PSX\'s own sector, without asking anyone', async () => {
    const u = owner(false);
    u.holdings = [...SEED_HOLDINGS, { id: 'h-new', symbol: 'HUBC', shares: 10, avg_cost: 100, sector: null, is_shariah: false, status: 'core', note: null }];
    const store = new MemoryStore([u]);
    await runJob('market', deps(store, new ConsoleNotifier(quiet), MON_1230));
    const want = SEED_PRICES.HUBC?.sector ?? SEED_SCREEN.find((r) => r.symbol === 'HUBC')?.sector;
    expect(want).toBeTruthy();
    expect(store.users[0].holdings.find((h) => h.symbol === 'HUBC')!.sector).toBe(want);
    expect(store.users[0].holdings.find((h) => h.symbol === 'SYS')!.sector).toBe('Technology'); // an existing value is left alone
  });

  it('a duplicate tick minutes after a good run does nothing; a failed run or a later tick runs again', async () => {
    const store = new MemoryStore([owner(false)], () => MON_1230);
    const n = new ConsoleNotifier(quiet);
    expect((await runJob('market', deps(store, n, MON_1230))).skipped).toBeUndefined();
    expect((await runJob('market', deps(store, n, new Date(MON_1230.getTime() + 5 * 60_000)))).skipped).toBe(true);
    expect(store.runs).toHaveLength(1); // the duplicate left no heartbeat row
    expect((await runJob('market', deps(store, n, new Date(MON_1230.getTime() + 25 * 60_000)))).skipped).toBeUndefined();
    const down = new MemoryStore([owner(false)], () => MON_1230);
    await runJob('market', deps(down, n, MON_1230, { fetchSnapshot: broken }));
    expect((await runJob('market', deps(down, n, new Date(MON_1230.getTime() + 5 * 60_000)))).skipped).toBeUndefined(); // last run failed: try again
  });

  it('sends one bundled notification of buy chances and does not repeat it in the next run', async () => {
    const store = new MemoryStore([owner(false)]);
    const n = new ConsoleNotifier(quiet);
    await runJob('market', deps(store, n, MON_1230, { fetchSnapshot: async () => snap(-2.5) }));
    expect(n.sent).toHaveLength(1);
    const kinds = n.sent[0].n.alerts.map((a) => `${a.kind}:${a.symbol ?? ''}`);
    expect(kinds).toEqual(expect.arrayContaining(['dip:', 'buy_chance:SYS', 'buy_chance:MEBL']));
    expect(kinds.some((k) => k.startsWith('announcement'))).toBe(false); // news waits for the night digest
    await runJob('market', deps(store, n, new Date('2026-10-05T08:00:00Z'), { fetchSnapshot: async () => snap(-2.5) }));
    expect(n.sent).toHaveLength(1);
  });

  it('labels the last run before the close', async () => {
    const store = new MemoryStore([owner(false)]);
    const n = new ConsoleNotifier(quiet);
    await runJob('market', deps(store, n, MON_1515, { fetchSnapshot: async () => snap(-2.5, '2026-10-05T10:10:00.000Z') }));
    expect(n.sent[0].n.title).toMatch(/^Before close: /);
  });

  it('crash goes through even after 3 notifications today', async () => {
    const store = new MemoryStore([owner(false)]);
    for (let i = 0; i < 3; i++) store.alerts.push({ user_id: 'owner-1', kind: 'x', symbol: null, message: 'm', channel: 'push', sent_at: '2026-10-05T05:00:00Z', dedupe_key: `x${i}`, batch_id: `b${i}` });
    const n = new ConsoleNotifier(quiet);
    await runJob('market', deps(store, n, MON_1230, { fetchSnapshot: async () => snap(-4.5) }));
    expect(n.sent.map((s) => s.n.urgent)).toEqual([true]);
    expect(store.alerts.some((a) => a.channel === 'none')).toBe(true); // the rest went to the app's history
  });

  it('sends "data unavailable" at most once a day', async () => {
    const store = new MemoryStore([owner(false)]);
    const n = new ConsoleNotifier(quiet);
    await runJob('market', deps(store, n, MON_1230, { fetchSnapshot: broken }));
    await runJob('market', deps(store, n, new Date('2026-10-05T08:30:00Z'), { fetchSnapshot: broken }));
    expect(n.sent.filter((s) => s.n.alerts.some((a) => a.kind === 'data_unavailable'))).toHaveLength(1);
    expect(store.runs.every((x) => x.ok === false)).toBe(true);
  });

  it('stays quiet on a day PSX did not trade', async () => {
    const store = new MemoryStore([owner(false)]);
    const n = new ConsoleNotifier(quiet);
    await runJob('market', deps(store, n, MON_1230, { fetchSnapshot: async () => snap(-3, '2026-10-02T10:49:00.000Z') }));
    expect(n.sent).toEqual([]);
  });
});

describe('AI in the market job', () => {
  it('stores an insight, notifies a strong call, and uses the AI holding call in alerts', async () => {
    const store = new MemoryStore([owner()], () => MON_1230);
    const n = new ConsoleNotifier(quiet);
    const ai = fakeAi();
    const r = await runJob('market', deps(store, n, MON_1230, { ai, fetchPdf: async () => new Uint8Array([1]) }));
    expect(r.ai).toMatchObject({ announcements_read: 1, dividends: 1, insights: 1 });
    expect(store.insights[0]).toMatchObject({ stance: 'buy', job: 'market' });
    expect(store.divs[0]).toMatchObject({ symbol: 'MEBL', dps: 7, book_closure_from: '2026-10-19' });
    expect(store.earningsRows[0]).toMatchObject({ symbol: 'MEBL', period_end: '2026-09-30', profit_after_tax: -539104000 }); // the quarter's profit feeds the loss-quarter rules
    const alerts = n.sent.flatMap((s) => s.n.alerts);
    expect(alerts.find((a) => a.kind === 'ai_suggestion')?.message).toMatch(/^AI Assistant suggests: Add MEBL/);
    expect(alerts.find((a) => a.kind === 'buy_chance' && a.symbol === 'UBL')?.title).toBe('Opportunity: UBL'); // AI upgraded it
  });

  it('drops book closure dates that cannot belong to the filing and flags an old notice (ISSUE-06)', async () => {
    const store = new MemoryStore([owner()], () => MON_1230);
    await runJob('market', deps(store, new ConsoleNotifier(quiet), MON_1230, { ai: fakeAi(false, true), fetchPdf: async () => new Uint8Array([1]) }));
    expect(store.divs[0]).toMatchObject({ symbol: 'MEBL', dps: 7, book_closure_from: null, book_closure_to: null }); // 2020 dates on a 2026-10-05 filing
    expect(store.announcements[0].ai_date_note).toBe('older_document');
  });

  it('refreshes the insight every few hours, not every run, and always before the close', async () => {
    const store = new MemoryStore([owner()], () => MON_1230);
    const ai = fakeAi();
    await runJob('market', deps(store, new ConsoleNotifier(quiet), MON_1230, { ai }));
    await runJob('market', deps(store, new ConsoleNotifier(quiet), new Date('2026-10-05T08:00:00Z'), { ai }));
    expect(store.insights).toHaveLength(1);
    await runJob('market', deps(store, new ConsoleNotifier(quiet), MON_1515, { ai, fetchSnapshot: async () => snap(-1.36, '2026-10-05T10:10:00.000Z') }));
    expect(store.insights).toHaveLength(2);
  });

  it('skips users who turned AI off, and keeps normal alerts when the AI is down', async () => {
    const off = new MemoryStore([owner(false)]);
    expect((await runJob('market', deps(off, new ConsoleNotifier(quiet), MON_1230, { ai: fakeAi() }))).ai.insights).toBe(0);
    const store = new MemoryStore([owner()]);
    const n = new ConsoleNotifier(quiet);
    const r = await runJob('market', deps(store, n, MON_1230, { ai: fakeAi(true), fetchPdf: async () => new Uint8Array([1]) }));
    expect(r.errors.some((e) => e.startsWith('ai'))).toBe(true);
    expect(n.sent.flatMap((s) => s.n.alerts).some((a) => a.kind === 'buy_chance')).toBe(true);
    expect(store.announcements[0].ai_checked_at).toBeUndefined(); // retried next run
  });
});

describe('night job', () => {
  it('sends one digest (close, portfolio, news, dividends) outside the daily limit, and saves Discover picks', async () => {
    const store = new MemoryStore([owner()], () => MON_2100);
    for (let i = 0; i < 3; i++) store.alerts.push({ user_id: 'owner-1', kind: 'x', symbol: null, message: 'm', channel: 'push', sent_at: '2026-10-05T05:00:00Z', dedupe_key: `x${i}`, batch_id: `b${i}` });
    const n = new ConsoleNotifier(quiet);
    const fetched: string[][] = [];
    const r = await runJob('night', deps(store, n, MON_2100, {
      ai: fakeAi(), fetchPdf: async () => new Uint8Array([1]),
      fetchSnapshot: async (s: string[]) => { fetched.push(s); return snap(-1.36, AS_OF, s.length ? s : undefined); },
    }));
    expect(fetched).toHaveLength(2); // user symbols, then extra dividend payers
    expect(r.ai.picks).toBe(2);
    expect(store.picks.map((p) => p.kind).sort()).toEqual(['dividend', 'undervalued']);
    expect(n.sent).toHaveLength(1);
    const d = n.sent[0].n;
    expect(d.title).toMatch(/^Tonight: KSE-100 -1\.4%/);
    expect(d.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['night_digest', 'announcement_results', 'dividend_upcoming']));
    expect(d.alerts.find((a) => a.kind === 'announcement_results')?.message).toBe('MEBL: MEBL profit up; interim dividend Rs 7.');
    expect(d.alerts.find((a) => a.kind === 'dividend_upcoming')?.message).toMatch(/buy by 2026-10-15/); // Mon 19 Oct book closure, T+1: Thu 15 Oct
    expect(store.portfolioDays).toHaveLength(1); // one value per trading day for the Performance chart
    expect(store.portfolioDays[0]).toMatchObject({ user_id: 'owner-1', day: '2026-10-05' });
    expect(store.indexDays).toEqual([{ day: '2026-10-05', close: SEED_INDEX.kse100 }]);
    expect(store.alerts.some((a) => a.kind === 'buy_chance')).toBe(false); // buying chances are for market hours
    await runJob('night', deps(store, n, new Date('2026-10-05T16:30:00Z'), { fetchSnapshot: async () => snap() }));
    expect(n.sent).toHaveLength(1); // nothing repeats
  });

  it('collapses PSX\'s duplicate notices', () => {
    expect(dedupeFilings([{ symbol: 'UBL', title: 'Disclosure of Interest' }, { symbol: 'UBL', title: 'Disclosure of interest ' }, { symbol: 'SYS', title: 'Disclosure of Interest' }])).toHaveLength(2);
  });
});

describe('public logs', () => {
  it('never name your stocks in errors (the repo logs are public)', () => {
    const e = publicErrors(['SYS: GET https://dps.psx.com.pk/company/SYS failed: HTTP 503', 'MEBL: no price on company page', 'indices: GET / failed: HTTP 500'], ['SYS', 'MEBL']);
    expect(e).toEqual(['indices: GET / failed: HTTP 500', '2 company page(s) failed (HTTP 503, no price)']);
    expect(e.join(' ')).not.toMatch(/SYS|MEBL/);
  });
});

describe('test job', () => {
  it('reaches the user by email', async () => {
    const store = new MemoryStore([owner()]);
    store.emails['me@example.com'] = 'owner-1';
    const n = new ConsoleNotifier(quiet);
    const r = await runJob('test', { ...deps(store, n, MON_1230), testEmail: 'me@example.com' });
    expect(r.ok).toBe(true);
    expect(n.sent[0].n.urgent).toBe(true);
  });
});
