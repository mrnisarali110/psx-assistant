import { describe, expect, it } from 'vitest';
import { latestResults, publicErrors, runJob, stockExtras } from './jobs.ts';
import { NO_METRICS } from './ai.ts';
import { dedupeFilings } from '../shared/news.ts';
import { ConsoleNotifier } from './notify.ts';
import { MemoryStore, type UserCtx } from './store.ts';
import { toScreenRows, type Snapshot } from './feed.ts';
import { tinyPdf } from './fixtures/tiny-pdf.ts';
import { dividendLeaders } from '../shared/discover.ts';
import type { LlmRouter } from '../shared/llm.ts';
import type { Announcement, AnnouncementMetrics } from '../shared/types.ts';
import sbpRates from '../shared/sbp-policy-rates.json' with { type: 'json' };
import type { PolicyRate } from '../shared/regime.ts';
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

/**
 * Peers of the held tech stocks and banks on a high P/E, so MEBL and UBL are cheap on earnings and the price rules fire.
 * Tech has only 4 KSE-100 stocks in the seed, under the 5 a sector comparison needs, so SYS gets no value check.
 */
const richPeers = (r: { symbol: string; sector: string | null; pe: number | null }) =>
  ['TECHNOLOGY & COMMUNICATION', 'COMMERCIAL BANKS'].includes(r.sector ?? '') && !SEED_HOLDINGS.some((h) => h.symbol === r.symbol) ? 40 : r.pe;

function snap(changePct = -1.36, asOf = AS_OF, symbols?: string[]): Snapshot {
  const screener = Object.fromEntries(SEED_SCREEN.map((r) => [r.symbol, {
    symbol: r.symbol, ex: null, sector_code: '', sector: r.sector, listed_in: ['KSE100', ...(r.is_shariah ? ['KMIALLSHR'] : [])], price: r.price,
    change_pct: r.change_pct, change_1y_pct: r.change_1y_pct ?? null, pe: richPeers(r), dividend_yield_pct: r.dividend_yield_pct, market_cap: r.market_cap,
  }]));
  const quotes = Object.fromEntries(Object.values(SEED_PRICES).filter((p) => !symbols || symbols.includes(p.symbol)).map((p) => [p.symbol, {
    ...p, open: null, high: null, low: null, as_of: asOf, announcements: p.symbol === 'MEBL' ? [filing] : [],
  }]));
  return { fetched_at: asOf, errors: [], screener, quotes, indices: { KSE100: { name: 'KSE100', value: SEED_INDEX.kse100, change: null, change_pct: changePct } } };
}
const broken = async (): Promise<Snapshot> => ({ fetched_at: '', indices: {}, quotes: {}, screener: {}, errors: ['GET / failed: HTTP 503'] });

/**
 * Canned AI: dividend from the filing, an insight, and picks. `fail` makes every call throw; `oldNotice` makes the
 * filing read like a 2020 re-upload; `pdf` replaces the filing answer. `seen` keeps the facts each picks/insight call got.
 */
function fakeAi(fail = false, oldNotice = false, pdf?: Record<string, unknown>): LlmRouter & { calls: string[]; seen: Record<string, any> } {
  const calls: string[] = [];
  const seen: Record<string, any> = {};
  return {
    available: true, calls, seen,
    async json(task: string, system: string, parts: any[]) {
      calls.push(task);
      if (fail) throw new Error('AI unavailable: 429');
      if (task === 'pdf' && pdf) return { model: 'fake', data: pdf };
      if (task === 'pdf' && oldNotice) return { model: 'fake', data: { summary: 'Board meeting held on September 30, 2020 approved an interim dividend.', figures: [{ label: 'Meeting date', value: 'September 30, 2020' }], cash_dividend_per_share: 7, dividend_type: 'interim', book_closure_from: '2020-10-20', book_closure_to: '2020-10-22' } };
      if (task === 'pdf') return { model: 'fake', data: { summary: 'MEBL profit up; interim dividend Rs 7.', figures: [], cash_dividend_per_share: 7, dividend_type: 'interim', book_closure_from: '2026-10-19', book_closure_to: '2026-10-21', quarter_end: '2026-09-30', quarter_profit_after_tax: -539104000 } };
      const facts = JSON.parse(parts[0].text.split('Facts (JSON):\n')[1]);
      if (system.includes('cautious assistant')) {
        seen.insight = facts;
        return { model: 'fake', data: {
          headline: 'Banks are cheap versus your last buys.', stance: 'buy',
          holding_calls: [{ symbol: 'UBL', call: 'opportunity', text: 'UBL 6.5% below your last buy' }],
          suggestions: [{ action: 'add', symbol: 'MEBL', text: 'Add MEBL', why: '6% below your last buy, weight 19.5%', confidence: 'high' }],
        } };
      }
      seen[/dividend payers/.test(parts[0].text) ? 'dividend' : 'undervalued'] = facts;
      return { model: 'fake', data: { items: facts.filter((f: any) => f.more.payout_pct != null).slice(0, 2).map((f: any) => ({ symbol: f.symbol, why: `Pays out ${f.more.payout_pct}% of its profit` })) } };
    },
  } as unknown as LlmRouter & { calls: string[]; seen: Record<string, any> };
}

const deps = (store: MemoryStore, n: ConsoleNotifier, now: Date, extra: Record<string, unknown> = {}) =>
  ({ store, notifier: n, fetchSnapshot: async () => snap(), now: () => now, log: quiet, sleep: async () => {}, ...extra });

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
    expect(kinds).toEqual(expect.arrayContaining(['dip:', 'buy_chance:MEBL', 'buy_chance:UBL']));
    expect(kinds).not.toContain('buy_chance:SYS'); // too few sector peers to compare its P/E
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

  it('a one-off network blip sends nothing: the read is retried, and only two failed checks in a row alert', async () => {
    const store = new MemoryStore([owner(false)]);
    const n = new ConsoleNotifier(quiet);
    let calls = 0;
    const blip = async (s: string[]) => (++calls === 1 ? broken() : snap(-1.36, AS_OF, s.length ? s : undefined));
    const waits: number[] = [];
    const r = await runJob('market', deps(store, n, MON_1230, { fetchSnapshot: blip, sleep: async (ms: number) => { waits.push(ms); } }));
    expect(waits).toEqual([60_000]);
    expect(r.ok).toBe(true); // the retry read PSX fine
    const store2 = new MemoryStore([owner(false)]);
    const n2 = new ConsoleNotifier(quiet);
    await runJob('market', deps(store2, n2, MON_1230, { fetchSnapshot: broken }));
    expect(n2.sent.some((s) => s.n.alerts.some((a) => a.kind === 'data_unavailable'))).toBe(false); // first failed check: quiet
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
    expect(alerts.find((a) => a.kind === 'buy_chance' && a.symbol === 'UBL')?.title).toBe('Average down: UBL'); // the AI asked for Opportunity; only your rules set Buy more / Opportunity
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
    expect(fetched).toHaveLength(3); // user symbols, extra dividend payers, then company pages for the blue-chip recheck
    // Blue chips: each due company is checked once, with a history row; with no annual reports read yet none passes.
    expect(store.bc.length).toBeGreaterThan(0);
    expect(store.bc.every((b) => !b.badge && b.status !== 'bc')).toBe(true);
    expect(store.bcHistory.every((h) => h.trigger === 'first')).toBe(true);
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

describe('refresh job (the Refresh latest button)', () => {
  it('gathers everything like the night run, makes fresh AI suggestions, rechecks your blue chips, and sends nothing', async () => {
    const store = new MemoryStore([owner()], () => MON_1230);
    const n = new ConsoleNotifier(quiet);
    const r = await runJob('refresh', deps(store, n, MON_1230, { ai: fakeAi(), fetchPdf: async () => new Uint8Array([1]), fetchSnapshot: async (s: string[]) => snap(-2.5, AS_OF, s.length ? s : undefined) }));
    expect(r.ok).toBe(true);
    expect(store.insights).toHaveLength(1); // fresh AI suggestions, even if one was made minutes ago
    expect(r.ai.picks).toBe(2); // Discover picks too
    const mine = SEED_HOLDINGS.map((h) => h.symbol);
    expect(mine.every((s) => store.bcHistory.some((h) => h.symbol === s && h.trigger === 'manual'))).toBe(true);
    expect(n.sent).toEqual([]); // a dip day, buying chances: still no push from a manual refresh
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

describe('Market Compass and policy rate (night job)', () => {
  const RATES = sbpRates as PolicyRate[];
  const src = 'https://www.sbp.org.pk/assets/document/test.pdf';
  const MACRO = [
    { series: 'pib_10y', as_of: '2026-10-01', value: 12.85, source: src }, { series: 'tbill_3m', as_of: '2026-10-01', value: 12, source: src },
    { series: 'cpi_yoy', as_of: '2026-09-01', value: 10.3, source: src }, { series: 'kse100_1y_pct', as_of: '2026-10-05', value: 1.2, source: 'https://dps.psx.com.pk/' },
  ];
  const night = (store: MemoryStore, n: ConsoleNotifier, fetchPolicyRates?: () => Promise<{ rates: PolicyRate[]; errors: string[] }>) =>
    runJob('night', deps(store, n, MON_2100, {
      fetchSnapshot: async (s: string[]) => snap(-1.36, AS_OF, s.length ? s : undefined), fetchPolicyRates,
      fetchMacro: async () => ({ readings: MACRO, errors: [] }),
    }));
  const yesterday = (trend: 'up' | 'down', action: string) => ({ day: '2026-10-02', bull: trend === 'up', close: 160000, ma: null, change_1y_pct: 30, drawdown_pct: null, earnings_yield_pct: 12, policy_rate: 11.5, reasons: [], trend, action });
  const kinds = (n: ConsoleNotifier) => n.sent.flatMap((s) => s.n.alerts).map((a) => a.kind);

  it('saves the State Bank history, the SBP/PBS/PSX figures and a compass reading; the first reading sends nothing', async () => {
    const store = new MemoryStore([owner(false)], () => MON_2100);
    const n = new ConsoleNotifier(quiet);
    await night(store, n, async () => ({ rates: RATES, errors: [] }));
    expect(store.rates).toHaveLength(89);
    expect(store.macro).toHaveLength(4);
    expect(store.regime).toHaveLength(1);
    expect(store.regime[0]).toMatchObject({ day: '2026-10-05', close: SEED_INDEX.kse100, policy_rate: 11.5, trend: 'sideways', change_1y_pct: 1.2, bull: false });
    expect(store.regime[0].action).toBeTruthy();
    expect((store.regime[0].compass as { cpi: number }).cpi).toBe(10.3);
    expect((store.regime[0].compass as { gap_basis: string }).gap_basis).toBe('money_market'); // older rows have none: "vs 10-year bond"
    expect(kinds(n).some((k) => ['market_trend', 'market_compass', 'policy_rate'].includes(k))).toBe(false);
  });

  it('a rate decision, a trend change and new advice go into the night digest, once each', async () => {
    const store = new MemoryStore([owner(false)], () => MON_2100);
    store.rates = RATES.filter((r) => r.decided_on < '2026-04-28'); // we last saw 10.5%
    const n = new ConsoleNotifier(quiet);
    await night(store, n, async () => ({ rates: RATES, errors: [] }));
    expect(n.sent.flatMap((s) => s.n.alerts).find((a) => a.kind === 'policy_rate')?.title).toBe('State Bank raised the policy rate to 11.5%');
    const today = store.regime.find((d) => d.day === '2026-10-05')!;
    store.regime.push(yesterday('up', today.action === 'add_extra' ? 'park_extra' : 'add_extra'));
    store.runs = [];
    const n2 = new ConsoleNotifier(quiet);
    await night(store, n2, async () => ({ rates: RATES, errors: [] }));
    const alerts = n2.sent.flatMap((s) => s.n.alerts);
    const trend = alerts.find((a) => a.kind === 'market_trend');
    expect(trend?.title).toBe('KSE-100 trend now sideways');
    expect(trend?.message).toMatch(/Your monthly investment stays on/);
    expect(trend?.url).toBe('/#/market');
    const advice = alerts.find((a) => a.kind === 'market_compass');
    expect(advice?.title).toMatch(/^Market Compass: /);
    expect(advice?.message).toMatch(/rule of thumb, not advice/);
    expect(advice?.message).toMatch(/against about [\d.]+% in a money-market fund \(estimate\)/); // the gap the advice acts on
    expect(alerts.some((a) => a.kind === 'policy_rate')).toBe(false); // already sent the first night
    store.runs = [];
    const n3 = new ConsoleNotifier(quiet);
    await night(store, n3, async () => ({ rates: RATES, errors: [] }));
    expect(kinds(n3).some((k) => ['market_trend', 'market_compass', 'policy_rate'].includes(k))).toBe(false);
  });

  it('an SBP failure is reported and nothing else breaks', async () => {
    const store = new MemoryStore([owner(false)], () => MON_2100);
    const r = await night(store, new ConsoleNotifier(quiet), async () => { throw new Error('GET https://www.sbp.org.pk failed: HTTP 503'); });
    expect(r.errors.some((e) => e.startsWith('sbp: '))).toBe(true);
    expect(store.regime).toHaveLength(1); // the compass reading still happens
  });
});

describe('filing EPS (owner review A2)', () => {
  const RESULTS_TEXT = 'Condensed interim accounts for the quarter ended September 30, 2026 (unconsolidated). Loss after tax (539,104) Rupees in thousand. '
    + 'Loss per share - basic and diluted (Rupees) (2.15). Interim cash dividend Rs 7.00 per share (70%).';

  it('stores the EPS with its basis and months, and the News card figures, all found in the PDF', async () => {
    const store = new MemoryStore([owner()], () => MON_1230);
    const ai = fakeAi(false, false, {
      summary: 'MEBL made a loss this quarter; interim dividend Rs 7.', figures: [], headline: 'Quarterly loss, Rs 7 dividend',
      cash_dividend_per_share: 7, dividend_type: 'interim', quarter_end: '2026-09-30', quarter_profit_after_tax: -539104000,
      eps: -2.15, eps_period_months: 3, eps_basis: 'unconsolidated',
    });
    await runJob('market', deps(store, new ConsoleNotifier(quiet), MON_1230, { ai, fetchPdf: async () => tinyPdf(RESULTS_TEXT) }));
    expect(store.earningsRows).toEqual([expect.objectContaining({ id: 'psx-doc-1', period_end: '2026-09-30', eps: -2.15, eps_basis: 'unconsolidated', period_months: 3 })]);
    expect(store.announcements[0].ai_metrics).toEqual({ headline: 'Quarterly loss, Rs 7 dividend', eps: -2.15, eps_basis: 'unconsolidated', dps: 7, profit_change_pct: null });
  });

  it('the night job reads older results filings of your stocks that have no EPS, a few a night (latest annual + 3 quarters)', async () => {
    const store = new MemoryStore([owner(false)], () => MON_2100);
    const old = (symbol: string, id: string, title: string, published_at: string) =>
      ({ id, symbol, title, kind: 'results' as const, published_at, pdf_url: `https://dps.psx.com.pk/download/document/${id}.pdf`, ai_summary: 'Read before', ai_checked_at: '2026-10-01T00:00:00Z' });
    store.announcements.push(
      old('SYS', 'sys-q3', 'Financial Results for the Quarter Ended September 30, 2026', '2026-10-01'),
      old('SYS', 'sys-h1', 'Financial Results for the Half Year Ended June 30, 2026', '2026-08-15'),
      old('SYS', 'sys-q1', 'Financial Results for the Quarter Ended March 31, 2026', '2026-04-20'),
      old('SYS', 'sys-ar', 'Annual Report 2025', '2026-03-30'),
      old('SYS', 'sys-fy', 'Financial Results for the Year Ended December 31, 2025', '2026-02-20'),
      old('SYS', 'sys-q3-25', 'Financial Results for the Quarter Ended September 30, 2025', '2025-10-20'),
      old('MEBL', 'mebl-fy', 'Financial Results for the Year Ended December 31, 2025', '2026-02-25'),
      old('UBL', 'ubl-fy', 'Financial Results for the Year Ended December 31, 2025', '2026-02-26'),
    );
    store.earningsRows.push({ id: 'ubl-y', symbol: 'UBL', period_end: '2025-12-31', profit_after_tax: 1e9, verified: true, eps: 30.2, eps_basis: 'consolidated', period_months: 12 }); // UBL has a full-year EPS already
    const read: string[] = [];
    const night = () => runJob('night', deps(store, new ConsoleNotifier(quiet), MON_2100, {
      ai: fakeAi(), fetchPdf: async (url: string) => { read.push(url.split('/').at(-1)!.replace('.pdf', '')); return new Uint8Array([1]); },
      fetchSnapshot: async (s: string[]) => snap(-1.36, AS_OF, s.length ? s : undefined),
    }));
    const r = await night();
    expect(read).toEqual(['1', 'sys-fy', 'sys-q3', 'sys-h1', 'sys-q1']); // tonight's new filing first, then SYS's backfill (4 a night)
    expect(r.ai.eps_backfill).toBe(4);
    const by = (id: string) => store.announcements.find((a) => a.id === id)!;
    expect(by('sys-fy').ai_metrics).toEqual({ headline: null, eps: null, eps_basis: null, dps: null, profit_change_pct: null }); // read: not again
    expect(by('sys-fy').ai_summary).toBe('Read before'); // the summary people saw stays
    expect(by('sys-q3-25').ai_metrics).toBeUndefined();
    expect(by('sys-ar').ai_metrics).toBeUndefined();
    read.length = 0;
    store.runs = [];
    await night();
    expect(read).toEqual(['mebl-fy']); // SYS's latest annual and 3 quarters are done; older ones are not worth a read
    expect(r.errors.join(' ')).not.toMatch(/SYS|MEBL/);
  });

  const oldFiling = (symbol: string, id: string, title: string, published_at: string) =>
    ({ id, symbol, title, kind: 'results' as const, published_at, pdf_url: `https://dps.psx.com.pk/download/document/${id}.pdf`, ai_summary: 'Read before', ai_checked_at: '2026-10-01T00:00:00Z' });
  const nightWith = (store: MemoryStore, read: string[], ai: LlmRouter) => runJob('night', deps(store, new ConsoleNotifier(quiet), MON_2100, {
    ai, fetchPdf: async (url: string) => { read.push(url.split('/').at(-1)!.replace('.pdf', '')); return new Uint8Array([1]); },
    fetchSnapshot: async (s: string[]) => snap(-1.36, AS_OF, s.length ? s : undefined),
  }));

  it('one stored quarter is not a full year: the backfill still reads the latest annual until the P/E comes from filings', async () => {
    const store = new MemoryStore([owner(false)], () => MON_2100);
    store.announcements.push(oldFiling('UBL', 'ubl-fy', 'Financial Results for the Year Ended December 31, 2025', '2026-02-26'));
    store.earningsRows.push({ id: 'ubl-q', symbol: 'UBL', period_end: '2026-09-30', profit_after_tax: 1e9, verified: true, eps: 9.1, eps_basis: 'consolidated', period_months: 3 });
    const read: string[] = [];
    await nightWith(store, read, fakeAi());
    expect(read).toContain('ubl-fy');
  });

  it('a filing whose read keeps failing is marked and not planned again every night (it would starve the backfill)', async () => {
    const store = new MemoryStore([owner(false)], () => MON_2100);
    store.announcements.push(oldFiling('SYS', 'sys-fy', 'Financial Results for the Year Ended December 31, 2025', '2026-02-20'));
    const broken = { available: true, async json() { throw new Error('no AI provider can handle a pdf task'); } } as unknown as LlmRouter;
    const read: string[] = [];
    const r = await nightWith(store, read, broken);
    expect(read).toContain('sys-fy');
    expect(r.errors.some((e) => e.startsWith('ai: eps backfill sys-fy'))).toBe(true);
    expect(store.announcements.find((a) => a.id === 'sys-fy')!.ai_metrics).toEqual(NO_METRICS);
    read.length = 0;
    store.runs = [];
    await nightWith(store, read, broken);
    expect(read).not.toContain('sys-fy');

    // Both AI providers down is not the filing's fault: it is tried again on a later night.
    const down = new MemoryStore([owner(false)], () => MON_2100);
    down.announcements.push(oldFiling('SYS', 'sys-fy', 'Financial Results for the Year Ended December 31, 2025', '2026-02-20'));
    await nightWith(down, [], fakeAi(true));
    expect(down.announcements.find((a) => a.id === 'sys-fy')!.ai_metrics).toBeUndefined();
  });

  it('latest results: a filing with no figures (PDF gone, unreadable) does not hide an older filing\'s profit change', () => {
    const a = (id: string, published_at: string, ai_metrics: AnnouncementMetrics): Announcement =>
      ({ id, symbol: 'SYS', title: 'Financial Results', kind: 'results', published_at, pdf_url: null, ai_metrics });
    const older = a('old', '2026-02-20', { ...NO_METRICS, profit_change_pct: 18.2 });
    expect(latestResults([older, a('gone', '2026-08-01', { ...NO_METRICS })])).toEqual({ SYS: { on: '2026-02-20', profit_change_pct: 18.2 } });
    // A newer filing with figures still wins, even without a profit change.
    expect(latestResults([older, a('new', '2026-08-01', { ...NO_METRICS, eps: 3.1, eps_basis: 'consolidated' })])).toEqual({ SYS: { on: '2026-08-01', profit_change_pct: null } });
  });
});

describe('payout facts for the AI (owner review A8)', () => {
  it('are the payout the app shows: the last 12 months of filings first, then PSX yield x price', () => {
    const div = (id: string, announced_on: string, dps: number) => ({ id, symbol: 'XYZ', announced_on, dps, dividend_type: 'interim' as const, book_closure_from: null, book_closure_to: null, verified: true, pdf_url: null });
    const fig = { pe: 10, basis: 'consolidated' as const, eps: 10, label: 'consolidated, year to Jun 2026', outlier: false, loss: false };
    const dividends = [div('a', '2026-08-01', 4), div('b', '2026-02-01', 4)];
    // Filings say Rs 8 a share (80% of EPS 10); PSX's 12% yield would say 120%.
    expect(stockExtras('XYZ', 100, 12, fig, { today: '2026-10-05', dividends })).toMatchObject({ payout_pct: 80, suspect: false });
    expect(stockExtras('XYZ', 100, 16, fig, { today: '2026-10-05', dividends: [] })).toMatchObject({ payout_pct: 160, suspect: true });
  });
});

describe('price and portfolio history (owner review B7, B8)', () => {
  it('the night job and Refresh write one close per stock for the trading day: KSE-100, held and watched', async () => {
    const store = new MemoryStore([owner(false)], () => MON_2100);
    await runJob('night', deps(store, new ConsoleNotifier(quiet), MON_2100, { fetchSnapshot: async (s: string[]) => snap(-1.36, AS_OF, s.length ? s : undefined) }));
    expect(store.priceDays.every((p) => p.day === '2026-10-05')).toBe(true);
    expect(store.priceDays.find((p) => p.symbol === 'SYS')).toEqual({ symbol: 'SYS', day: '2026-10-05', close: 114.37, change_pct: -1.27 });
    const symbols = new Set(store.priceDays.map((p) => p.symbol));
    expect(toScreenRows(snap().screener).every((r) => r.price == null || symbols.has(r.symbol))).toBe(true);
    expect([...SEED_HOLDINGS, ...SEED_WATCHLIST].every((h) => !SEED_PRICES[h.symbol] || symbols.has(h.symbol))).toBe(true);
    expect(store.priceDays).toHaveLength(symbols.size); // one row per stock

    const market = new MemoryStore([owner(false)], () => MON_1230);
    await runJob('market', deps(market, new ConsoleNotifier(quiet), MON_1230));
    expect(market.priceDays).toEqual([]); // the 30-minute checks do not
  });

  it('Refresh latest also stores the portfolio value of the trading day', async () => {
    const store = new MemoryStore([owner(false)], () => MON_1230);
    await runJob('refresh', deps(store, new ConsoleNotifier(quiet), MON_1230, { fetchSnapshot: async (s: string[]) => snap(-1.36, AS_OF, s.length ? s : undefined) }));
    expect(store.portfolioDays).toEqual([expect.objectContaining({ user_id: 'owner-1', day: '2026-10-05' })]);
    expect(store.priceDays.length).toBeGreaterThan(50);
  });

  it('each market check stores your portfolio value (1D chart) and drops ticks older than 10 days', async () => {
    const store = new MemoryStore([owner(false)], () => MON_1230);
    store.ticks.push({ user_id: 'owner-1', ts: '2026-09-20T10:00:00.000Z', value: 1 }, { user_id: 'owner-1', ts: '2026-09-30T10:00:00.000Z', value: 2 });
    await runJob('market', deps(store, new ConsoleNotifier(quiet), MON_1230));
    expect(store.ticks.map((t) => t.ts)).toEqual(['2026-09-30T10:00:00.000Z', AS_OF]);
    expect(store.ticks[1].value).toBeGreaterThan(10000);
    const closed = new MemoryStore([owner(false)], () => MON_1230);
    await runJob('market', deps(closed, new ConsoleNotifier(quiet), MON_1230, { fetchSnapshot: async () => snap(-1, '2026-10-02T10:49:00.000Z') }));
    expect(closed.ticks).toEqual([]); // no trading today: nothing new to draw
  });
});

describe('AI facts use the app\'s figures (owner review A2, A8, A10)', () => {
  it('the AI sees the P/E from filings (the one the app shows), and the payout, one-off and results facts', async () => {
    const store = new MemoryStore([owner()], () => MON_1230);
    store.earningsRows.push({ id: 'sys-fy', symbol: 'SYS', period_end: '2025-12-31', profit_after_tax: 1e10, verified: true, eps: 10, eps_basis: 'consolidated', period_months: 12 });
    store.announcements.push({ id: 'sys-fy', symbol: 'SYS', title: 'Financial Results for the Year Ended December 31, 2025', kind: 'results', published_at: '2026-02-20', pdf_url: null,
      ai_metrics: { headline: null, eps: 10, eps_basis: 'consolidated', dps: null, profit_change_pct: 18.2 } });
    const ai = fakeAi();
    await runJob('market', deps(store, new ConsoleNotifier(quiet), MON_1230, { ai }));
    const sys = ai.seen.insight.holdings.find((h: any) => h.symbol === 'SYS');
    expect(sys).toMatchObject({ pe: 11.44, pe_basis: 'consolidated, year to Dec 2025', results_profit_change_pct: 18.2, results_on: '2026-02-20' });
    expect(sys).toHaveProperty('payout_pct');
    expect(sys).toHaveProperty('one_off');
    expect(sys).toHaveProperty('dividend_cut');
  });

  it('Discover picks: suspect payouts never reach the dividend list, and each candidate says what its card already shows', async () => {
    const store = new MemoryStore([owner()], () => MON_2100);
    const ai = fakeAi();
    await runJob('night', deps(store, new ConsoleNotifier(quiet), MON_2100, { ai, fetchSnapshot: async (s: string[]) => snap(-1.36, AS_OF, s.length ? s : undefined) }));
    const suspect = dividendLeaders(toScreenRows(snap().screener), [], '2026-10-05').filter((d) => d.suspect).map((d) => d.symbol);
    expect(suspect.length).toBeGreaterThan(0);
    expect(ai.seen.dividend.length).toBeGreaterThan(0);
    expect(ai.seen.dividend.some((c: any) => suspect.includes(c.symbol))).toBe(false);
    expect(ai.seen.dividend[0]).toMatchObject({ on_card: expect.objectContaining({ dividend_yield_pct: expect.any(Number) }), more: expect.objectContaining({ suspect: false }) });
    expect(ai.seen.undervalued[0].more).toHaveProperty('payout_pct');
    const saved = store.picks.find((p) => p.kind === 'dividend')!.items[0] as { why: string; facts?: Record<string, number> };
    expect(saved.why).toMatch(/^Pays out [\d.]+% of its profit$/);
    expect(saved.facts).toHaveProperty('payout_pct'); // the app checks the reason against these, not the card
  });
});
