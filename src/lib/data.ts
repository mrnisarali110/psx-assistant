/**
 * App data access. LiveSource uses the signed-in user's Supabase session, so row-level security
 * decides what is visible. DemoSource serves the seed portfolio with saved PSX data in memory.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AiInsight, AiPicks, Announcement, AlertLogRow, DividendEvent, DividendReceipt, Holding, IndexDay, IndexSnapshot, PortfolioDay, PortfolioTick, PriceDay, PriceMap, QuarterEarnings, Settings, Txn, WatchItem,
} from '../../shared/types.ts';
import { DEFAULT_SETTINGS } from '../../shared/types.ts';
import type { ScreenRow } from '../../shared/discover.ts';
import type { ImportedRow } from '../../shared/changes.ts';
import { addDays, pktDate } from '../../shared/time.ts';
import { dedupeBySymbol, normalisePriceMap } from '../../shared/symbols.ts';
import { evaluateBc, marketCapRanks, nextBcState, type BcState } from '../../shared/bluechip.ts';
import { evaluateTrend, marketBreadth, rateOn, type PolicyRate, type RegimeDay } from '../../shared/regime.ts';
import type { MacroReading } from '../../shared/compass.ts';
import sbpPolicyRates from '../../shared/sbp-policy-rates.json' with { type: 'json' };
import {
  SEED_ANNOUNCEMENTS, SEED_CAPTURED_AT, SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_SCREEN, SEED_TXNS, SEED_WATCHLIST,
} from '../../shared/fixtures/seed.ts';
import { config } from './config.ts';
import { fetchAiStatus, readScreenshots, requestRefresh, type AiStatus, type RefreshReply } from './importer.ts';

export interface WorkerRun { job: string; started_at: string; finished_at: string | null; ok: boolean | null }

export interface AppData {
  settings: Settings;
  holdings: Holding[];
  watchlist: WatchItem[];
  prices: PriceMap;
  index: IndexSnapshot | null;
  indexHistory: IndexSnapshot[]; // oldest first
  announcements: Announcement[];
  alerts: AlertLogRow[];
  lastRun: WorkerRun | null;
  lastRefresh: WorkerRun | null; // the latest Refresh latest run (job "refresh")
  telegramLinked: boolean;
  email: string | null;
  aiInsight: AiInsight | null;
  screen: ScreenRow[];
  transactions: Txn[]; // every buy and sell ever recorded, oldest first (FIFO lots, XIRR and the tax ledger need them all)
  dividends: DividendEvent[];
  receipts: DividendReceipt[]; // dividends credited to the account, newest first
  indexDaily: IndexDay[]; // KSE-100 close per trading day, oldest first (benchmark)
  portfolioDaily: PortfolioDay[]; // your value per trading day, oldest first (Performance chart)
  earnings: QuarterEarnings[]; // quarterly profit after tax read from results filings (loss-quarter rules)
  bluechip: Record<string, BcState>; // blue-chip state per company, from the worker's checks (empty until the first night run)
  picks: { undervalued: AiPicks | null; dividend: AiPicks | null };
  policyRates: PolicyRate[]; // State Bank policy-rate decisions, oldest first (empty until the table exists and is filled)
  regime: RegimeDay[]; // market reading per trading day (trend, P/E, action), oldest first (empty until the night check stores one)
  macro: MacroReading[]; // dated SBP / PBS / PSX figures (T-bills, PIB, CPI, reserves, PKR), oldest first (empty until migration 0011 runs and the worker fills it)
  priceDaily: PriceDay[]; // daily closes of held and watched stocks, oldest first (builds from 2026-10-23; other symbols: source.priceHistory)
  portfolioTicks: PortfolioTick[]; // your value at each market check, last 10 days, oldest first (1D chart)
}

export interface DataSource {
  kind: 'live' | 'demo';
  load(): Promise<AppData>;
  /** One write path for every holding change: edit, delete, record buy, import. */
  saveHoldingChange(before: Holding | undefined, after: Holding | null, txn: Txn | null): Promise<void>;
  /** Transactions on their own (CSV import, corrections); holdings are not touched. */
  saveTxns(txns: Txn[]): Promise<void>;
  updateTxn(id: string, patch: Partial<Txn>): Promise<void>;
  deleteTxn(id: string): Promise<void>;
  /** A dividend credited to the account. */
  saveReceipt(r: DividendReceipt): Promise<void>;
  /** Correct a saved receipt in place (shares, date, amount). */
  updateReceipt(id: string, r: DividendReceipt): Promise<void>;
  deleteReceipt(id: string): Promise<void>;
  addWatch(symbol: string, note?: string): Promise<void>;
  deleteWatch(id: string): Promise<void>;
  saveSettings(s: Partial<Settings>): Promise<void>;
  createTelegramCode(): Promise<string>;
  savePushSubscription(sub: PushSubscriptionJSON): Promise<void>;
  deletePushSubscription(endpoint: string): Promise<void>;
  /** known = symbols already held, sent as reading hints (never quantities or costs). */
  readScreenshots(files: File[], known: string[]): Promise<{ holdings: ImportedRow[]; dropped: string[] }>;
  /** Which AI providers can read screenshots right now (free check, no tokens). */
  aiStatus(): Promise<AiStatus>;
  /** Start the full refresh on the server (PSX data, filings, AI, blue chips). */
  refreshAll(): Promise<RefreshReply>;
  /** The latest refresh run, to follow its progress. */
  refreshRun(): Promise<WorkerRun | null>;
  /** Daily closes of any one stock, oldest first (stock page for symbols you neither hold nor watch). */
  priceHistory(symbol: string): Promise<PriceDay[]>;
}

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!config.supabaseUrl || !config.supabaseKey) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_KEY).');
  client ??= createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

function ok<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

const n = (v: unknown) => (v == null ? null : Number(v));
const normPrice = (p: any) => ({
  ...p, price: n(p.price), change: n(p.change), change_pct: n(p.change_pct), volume: n(p.volume), ldcp: n(p.ldcp),
  high_52w: n(p.high_52w), low_52w: n(p.low_52w), dividend_yield_pct: n(p.dividend_yield_pct), pe: n(p.pe),
});
const normIdx = (r: any): IndexSnapshot => ({ ts: r.ts, kse100: Number(r.kse100), change: n(r.change), change_pct: n(r.change_pct) });
const normHolding = (h: any): Holding => ({ ...h, shares: Number(h.shares), avg_cost: Number(h.avg_cost), last_buy_price: n(h.last_buy_price) });
const holdingRow = (h: Holding) => ({
  symbol: h.symbol, shares: h.shares, avg_cost: h.avg_cost, status: h.status, sector: h.sector || null,
  is_shariah: h.is_shariah, note: h.note || null, last_buy_price: h.last_buy_price ?? null, last_buy_on: h.last_buy_on ?? null,
  thesis: h.thesis || null, review_on: h.review_on || null, target_price: h.target_price ?? null,
});
const normTxn = (t: any): Txn => ({ ...t, shares: Number(t.shares), price: Number(t.price), amount: Number(t.amount), charges: n(t.charges) });
const txnRow = (t: Txn) => ({
  symbol: t.symbol, side: t.side, shares: t.shares, price: t.price, amount: t.amount, executed_on: t.executed_on, source: t.source, charges: t.charges ?? null,
});
const normPriceDay = (r: any): PriceDay => ({ symbol: r.symbol, day: String(r.day).slice(0, 10), close: Number(r.close), change_pct: n(r.change_pct) });
const normEarnings = (r: any): QuarterEarnings => ({
  ...r, profit_after_tax: Number(r.profit_after_tax), eps: n(r.eps), period_months: n(r.period_months),
  eps_basis: r.eps_basis === 'consolidated' || r.eps_basis === 'unconsolidated' || r.eps_basis === 'not_stated' ? r.eps_basis : null,
});
const normReceipt = (r: any): DividendReceipt => ({ ...r, shares: Number(r.shares), dps: Number(r.dps), gross: Number(r.gross), wht_pct: Number(r.wht_pct), net: Number(r.net) });
const receiptRow = (r: DividendReceipt) => ({
  symbol: r.symbol, paid_on: r.paid_on, shares: r.shares, dps: r.dps, gross: r.gross, wht_pct: r.wht_pct, net: r.net, dividend_id: r.dividend_id ?? null, note: r.note || null,
});
const normRate = (r: any): PolicyRate => ({ decided_on: r.decided_on, policy_rate: Number(r.policy_rate), ceiling: n(r.ceiling), floor: n(r.floor), source: r.source ?? '' });
const normRegime = (r: any): RegimeDay => ({
  day: r.day, bull: !!r.bull, close: n(r.close), ma: n(r.ma), change_1y_pct: n(r.change_1y_pct), drawdown_pct: n(r.drawdown_pct),
  earnings_yield_pct: n(r.earnings_yield_pct), policy_rate: n(r.policy_rate), reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [],
  // Market Compass columns (migration 0011): absent on older rows, and any value outside the known words reads as unknown.
  trend: r.trend === 'up' || r.trend === 'sideways' || r.trend === 'down' ? r.trend : null,
  pe: n(r.pe), dividend_yield_pct: n(r.dividend_yield_pct),
  value_state: r.value_state === 'cheap' || r.value_state === 'fair' || r.value_state === 'expensive' ? r.value_state : null,
  action: typeof r.action === 'string' ? r.action : null,
  compass: r.compass ?? null, // stored reading incl. gap_basis (Market: past readings vs money market or the 10-year bond)
});
const normMacro = (r: any): MacroReading | null => {
  const value = Number(r.value);
  return typeof r.series === 'string' && typeof r.as_of === 'string' && Number.isFinite(value) ? { series: r.series, as_of: r.as_of.slice(0, 10), value, source: r.source ?? '' } : null;
};
/** Settings row -> Settings: numbers are numeric strings in PostgREST; new columns fall back to the defaults. */
function normSettings(s: any): Settings {
  const num = (k: keyof Settings) => Number(s[k] ?? (DEFAULT_SETTINGS as any)[k]);
  return {
    ...DEFAULT_SETTINGS, ...s,
    monthly_budget_pkr: num('monthly_budget_pkr'), sip_step_up_pct: num('sip_step_up_pct'), crash_fund_pkr: num('crash_fund_pkr'),
    crash_trigger_kse: num('crash_trigger_kse'), max_position_pct: num('max_position_pct'), drop_alert_pct: num('drop_alert_pct'),
    max_sector_pct: num('max_sector_pct'), trim_pe_over_sector_pct: num('trim_pe_over_sector_pct'),
    buy_more_below_pct: num('buy_more_below_pct'), hard_stock_cap_pct: num('hard_stock_cap_pct'), hard_sector_cap_pct: num('hard_sector_cap_pct'),
    review_after_loss_quarters: num('review_after_loss_quarters'), sell_after_loss_quarters: num('sell_after_loss_quarters'),
    commission_pct: num('commission_pct'), min_commission_per_share: num('min_commission_per_share'), sales_tax_pct: num('sales_tax_pct'),
    cgt_paid: s.cgt_paid ?? {}, loss_carry_forward: s.loss_carry_forward ?? {},
    inflation_pct: num('inflation_pct'), onboarded: s.onboarded ?? DEFAULT_SETTINGS.onboarded,
  };
}

/** Optional extras (AI, screen, dividends): if a table is missing or empty, the app still works. */
/** PostgREST caps a response at the project's max rows (1000 by default) and drops the rest silently: read long tables a page at a time. */
async function allRows(make: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: unknown }>, page = 1000, maxPages = 20): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < maxPages; i++) {
    let rows: any[];
    try { const r = await make(i * page, (i + 1) * page - 1); if (r.error || r.data == null) break; rows = r.data; } catch { break; }
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

async function optional<T>(q: PromiseLike<{ data: T | null; error: unknown }>, fallback: T): Promise<T> {
  try { const r = await q; return r.error || r.data == null ? fallback : r.data; } catch { return fallback; }
}

export class LiveSource implements DataSource {
  kind = 'live' as const;
  constructor(private userId: string, private email: string | null) {}

  async load(): Promise<AppData> {
    const sb = supabase();
    const today = pktDate(new Date());
    const [settings, holdings, watchlist, idx, alerts, run, profile] = await Promise.all([
      sb.from('settings').select('*').maybeSingle(),
      sb.from('holdings').select('*').order('symbol'),
      sb.from('watchlist').select('*').order('symbol'),
      sb.from('index_snapshots').select('ts, kse100, change, change_pct').order('ts', { ascending: false }).limit(60),
      sb.from('alerts_log').select('*').order('sent_at', { ascending: false }).limit(80),
      sb.from('worker_runs').select('job, started_at, finished_at, ok').order('started_at', { ascending: false }).limit(1),
      sb.from('profiles').select('telegram_chat_id').maybeSingle(),
    ]);
    const H = (ok(holdings) as any[]).map(normHolding);
    const W = ok(watchlist) as WatchItem[];
    const symbols = [...new Set([...H.map((h) => h.symbol), ...W.map((w) => w.symbol)])];
    const [prices, anns, insights, screen, txns, divs, uv, dv, receipts, indexDaily, portfolioDaily, earnings, bluechip, rates, regime, macro, priceDaily, ticks] = await Promise.all([
      symbols.length ? optional(sb.from('prices').select('*').in('symbol', symbols), [] as any[]) : Promise.resolve([] as any[]),
      symbols.length ? optional(sb.from('announcements').select('*').in('symbol', symbols).gte('published_at', addDays(today, -60)).order('published_at', { ascending: false }).limit(150), [] as any[]) : Promise.resolve([] as any[]),
      optional(sb.from('ai_insights').select('created_at, job, headline, stance, suggestions, holding_calls, rebalance, cash_note, risks, model').order('created_at', { ascending: false }).limit(1), [] as any[]),
      optional(sb.from('market_screen').select('*'), [] as any[]),
      allRows((a, b) => sb.from('transactions').select('*').order('executed_on').order('created_at').range(a, b)),
      optional(sb.from('dividends').select('*').gte('announced_on', addDays(today, -1100)).order('announced_on', { ascending: false }).limit(500), [] as any[]),
      optional(sb.from('ai_picks').select('*').eq('kind', 'undervalued').order('created_at', { ascending: false }).limit(1), [] as any[]),
      optional(sb.from('ai_picks').select('*').eq('kind', 'dividend').order('created_at', { ascending: false }).limit(1), [] as any[]),
      allRows((a, b) => sb.from('dividend_receipts').select('*').order('paid_on', { ascending: false }).range(a, b)),
      allRows((a, b) => sb.from('index_daily').select('day, close').order('day').range(a, b)),
      allRows((a, b) => sb.from('portfolio_daily').select('day, value, invested').order('day').range(a, b)),
      symbols.length ? optional(sb.from('earnings').select('*').in('symbol', symbols).gte('period_end', addDays(today, -1100)).order('period_end', { ascending: false }).limit(1000), [] as any[]) : Promise.resolve([] as any[]),
      optional(sb.from('bluechip').select('*').limit(2000), [] as any[]),
      // New tables (migration 0010): missing or empty until it runs, and the app loads either way.
      optional(sb.from('policy_rates').select('decided_on, policy_rate, ceiling, floor, source').order('decided_on').limit(1000), [] as any[]),
      optional(sb.from('market_regime').select('*').order('day', { ascending: false }).limit(800), [] as any[]),
      // Migration 0011: missing until it runs; allRows stops quietly on an error, so the app loads either way.
      allRows((a, b) => sb.from('macro_readings').select('series, as_of, value, source').gte('as_of', addDays(today, -800)).order('as_of').order('series').range(a, b), 1000, 5),
      // Migration 0012: missing or empty until it runs and the worker fills it; the app loads either way.
      symbols.length ? allRows((a, b) => sb.from('price_daily').select('symbol, day, close, change_pct').in('symbol', symbols).gte('day', addDays(today, -800)).order('day').range(a, b), 1000, 20) : Promise.resolve([] as any[]),
      allRows((a, b) => sb.from('portfolio_ticks').select('ts, value').gte('ts', addDays(today, -10)).order('ts').range(a, b), 1000, 3),
    ]);
    const s = ok(settings) as any;
    const history = (ok(idx) as any[]).map(normIdx);
    return {
      settings: s ? normSettings(s) : { ...DEFAULT_SETTINGS },
      holdings: H,
      watchlist: W,
      prices: normalisePriceMap(Object.fromEntries(prices.map((p: any) => [p.symbol, normPrice(p)]))),
      index: history[0] ?? null,
      indexHistory: [...history].reverse(),
      announcements: anns as Announcement[],
      alerts: ok(alerts) as AlertLogRow[],
      lastRun: ((ok(run) as any[])[0] ?? null) as WorkerRun | null,
      lastRefresh: await this.refreshRun().catch(() => null),
      telegramLinked: !!(ok(profile) as any)?.telegram_chat_id,
      email: this.email,
      aiInsight: insights[0] ? { holding_calls: [], suggestions: [], ...insights[0] } as AiInsight : null,
      screen: dedupeBySymbol(screen.map((r: any) => ({
        symbol: r.symbol, ex: r.ex ?? null, listed_in: Array.isArray(r.listed_in) ? r.listed_in : null, avg_volume_30d: n(r.avg_volume_30d), mcap_rank: n(r.mcap_rank), sector: r.sector, price: n(r.price), change_pct: n(r.change_pct), change_1y_pct: n(r.change_1y_pct), pe: n(r.pe),
        dividend_yield_pct: n(r.dividend_yield_pct), market_cap: n(r.market_cap), is_shariah: r.is_shariah,
      }))),
      transactions: txns.map(normTxn),
      dividends: divs.map((d: any) => ({ ...d, dps: n(d.dps) })),
      receipts: receipts.map(normReceipt),
      indexDaily: indexDaily.map((r: any) => ({ day: r.day, close: Number(r.close) })),
      portfolioDaily: portfolioDaily.map((r: any) => ({ day: r.day, value: Number(r.value), invested: Number(r.invested) })),
      earnings: earnings.map(normEarnings),
      bluechip: Object.fromEntries(bluechip.map((b: any) => [b.symbol, { ...b, fails: Number(b.fails) } as BcState])),
      picks: { undervalued: (uv[0] ?? null) as AiPicks | null, dividend: (dv[0] ?? null) as AiPicks | null },
      policyRates: rates.map(normRate),
      regime: regime.map(normRegime).reverse(),
      macro: macro.map(normMacro).filter((m): m is MacroReading => m != null),
      priceDaily: priceDaily.map(normPriceDay),
      portfolioTicks: ticks.map((r: any) => ({ ts: r.ts, value: Number(r.value) })),
    };
  }

  async priceHistory(symbol: string) {
    const rows = await allRows((a, b) => supabase().from('price_daily').select('symbol, day, close, change_pct').eq('symbol', symbol).order('day').range(a, b), 1000, 2);
    return rows.map(normPriceDay);
  }

  async saveHoldingChange(before: Holding | undefined, after: Holding | null, txn: Txn | null) {
    const sb = supabase();
    if (!after) ok(await sb.from('holdings').delete().eq('id', before!.id!));
    else if (before?.id) ok(await sb.from('holdings').update(holdingRow(after)).eq('id', before.id));
    else ok(await sb.from('holdings').insert({ ...holdingRow(after), user_id: this.userId }));
    if (txn) ok(await sb.from('transactions').insert({ ...txnRow(txn), user_id: this.userId }));
  }
  async saveTxns(txns: Txn[]) { if (txns.length) ok(await supabase().from('transactions').insert(txns.map((t) => ({ ...txnRow(t), user_id: this.userId })))); }
  async updateTxn(id: string, patch: Partial<Txn>) {
    const row: Record<string, unknown> = {};
    for (const k of ['symbol', 'side', 'shares', 'price', 'amount', 'executed_on', 'source', 'charges'] as const) if (k in patch) row[k] = patch[k] ?? null;
    ok(await supabase().from('transactions').update(row).eq('id', id));
  }
  async deleteTxn(id: string) { ok(await supabase().from('transactions').delete().eq('id', id)); }
  async saveReceipt(r: DividendReceipt) { ok(await supabase().from('dividend_receipts').insert({ ...receiptRow(r), user_id: this.userId })); }
  async updateReceipt(id: string, r: DividendReceipt) { ok(await supabase().from('dividend_receipts').update(receiptRow(r)).eq('id', id)); }
  async deleteReceipt(id: string) { ok(await supabase().from('dividend_receipts').delete().eq('id', id)); }
  async addWatch(symbol: string, note?: string) { ok(await supabase().from('watchlist').insert({ symbol, note: note || null, user_id: this.userId })); }
  async deleteWatch(id: string) { ok(await supabase().from('watchlist').delete().eq('id', id)); }
  async saveSettings(s: Partial<Settings>) { ok(await supabase().from('settings').update(s).eq('user_id', this.userId)); }
  async createTelegramCode() {
    const sb = supabase();
    ok(await sb.from('telegram_link_codes').delete().eq('user_id', this.userId));
    const rows = ok(await sb.from('telegram_link_codes').insert({ user_id: this.userId }).select('code')) as { code: string }[];
    return rows[0].code;
  }
  async savePushSubscription(sub: PushSubscriptionJSON) {
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Browser returned an incomplete push subscription');
    const sb = supabase();
    const existing = ok(await sb.from('push_subscriptions').select('id').eq('endpoint', sub.endpoint)) as any[];
    if (!existing.length) {
      ok(await sb.from('push_subscriptions').insert({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, user_id: this.userId }));
    }
  }
  async deletePushSubscription(endpoint: string) { ok(await supabase().from('push_subscriptions').delete().eq('endpoint', endpoint)); }
  async readScreenshots(files: File[], known: string[]) {
    return readScreenshots(files, await this.token(), known);
  }
  async aiStatus() { return fetchAiStatus(await this.token()); }
  async refreshAll() { return requestRefresh(await this.token()); }
  async refreshRun() {
    const rows = ok(await supabase().from('worker_runs').select('job, started_at, finished_at, ok').eq('job', 'refresh').order('started_at', { ascending: false }).limit(1)) as WorkerRun[];
    return rows[0] ?? null;
  }
  private async token() {
    const { data } = await supabase().auth.getSession();
    if (!data.session) throw new Error('Please sign in again.');
    return data.session.access_token;
  }
}

/** Blue-chip states worked out from the demo's own seed data (no annual results or filings in it: not enough data). */
function demoBluechip(): Record<string, BcState> {
  const today = pktDate(new Date());
  const ranks = marketCapRanks(SEED_SCREEN);
  const symbols = [...new Set([...SEED_HOLDINGS.map((h) => h.symbol), ...SEED_SCREEN.map((r) => r.symbol)])];
  return Object.fromEntries(symbols.map((symbol) => [symbol, nextBcState(null, evaluateBc({
    symbol, today, index_members: null, market_cap_rank: ranks[symbol] ?? null, avg_volume_30d: null,
    price: SEED_PRICES[symbol]?.price ?? SEED_SCREEN.find((r) => r.symbol === symbol)?.price ?? null,
    trailing_yield_pct: SEED_SCREEN.find((r) => r.symbol === symbol)?.dividend_yield_pct ?? null,
    annual: [], dividends: [], filings_since: null, audit: null,
  }), today)]));
}

/**
 * The demo's one bull-market reading: the seed day's KSE-100 close and PSX screen, put through the same rules as the
 * night check. No history is made up, so with a single close and no index membership in the seed the trend has no
 * clear signal; then there is no reading at all and the app says it is building data, rather than showing OFF.
 */
function demoRegime(rates: PolicyRate[]): RegimeDay[] {
  const day = SEED_INDEX.ts.slice(0, 10);
  const breadth = marketBreadth(SEED_SCREEN);
  const t = evaluateTrend({ today: day, closes: [{ day, close: SEED_INDEX.kse100 }], close: SEED_INDEX.kse100, change_1y_pct: breadth.change_1y_pct }, null);
  const decided = t.on != null && !t.reasons.some((r) => r.startsWith('No clear signal'));
  if (!decided) return [];
  return [{
    day, bull: !!t.on, close: SEED_INDEX.kse100, ma: t.ma, change_1y_pct: breadth.change_1y_pct, drawdown_pct: t.drawdown_pct,
    earnings_yield_pct: breadth.earnings_yield_pct, policy_rate: rateOn(rates, day), reasons: t.reasons,
  }];
}
const DEMO_RATES = sbpPolicyRates as PolicyRate[];

/** The demo's buys of the seed holdings are dated the last day of the month before the seed capture. */
const DEMO_BASELINE_DAY = addDays(`${SEED_CAPTURED_AT.slice(0, 7)}-01`, -1);
const r2 = (v: number) => Math.round(v * 100) / 100;
function demoTxns(): Txn[] {
  const held = new Set(SEED_HOLDINGS.map((h) => h.symbol));
  const recent = SEED_TXNS.filter((t) => held.has(t.symbol)).map((t, i) => ({ ...t, id: `demo-s${i}`, executed_on: pktDate(new Date()) }));
  const baseline = SEED_HOLDINGS.flatMap((h, i) => {
    const mine = recent.filter((t) => t.symbol === h.symbol);
    const shares = h.shares - mine.reduce((a, t) => a + t.shares, 0);
    const amount = r2(h.shares * h.avg_cost - mine.reduce((a, t) => a + t.amount, 0));
    if (shares <= 0 || amount <= 0) return [];
    return [{ id: `demo-t${i}`, symbol: h.symbol, side: 'buy' as const, shares, price: r2(amount / shares), amount, executed_on: DEMO_BASELINE_DAY, source: 'import' as const }];
  });
  return [...baseline, ...recent];
}

/**
 * Sample series for checking charts while developing (`?demo=1&sample=1` only). The plain demo makes no history up:
 * its charts show their "builds from" empty state, like a new account.
 */
const wantSample = () => { try { return new URLSearchParams(location.search).has('sample'); } catch { return false; } };
function wave(seed: string, i: number) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.sin(i / 3 + (h % 7)) * 0.012 + Math.sin(i / 11 + (h % 5)) * 0.02;
}
function samplePriceDays(days = 120): PriceDay[] {
  const end = SEED_CAPTURED_AT.slice(0, 10);
  const symbols = [...new Set([...SEED_HOLDINGS.map((h) => h.symbol), ...SEED_WATCHLIST.map((w) => w.symbol)])];
  return symbols.flatMap((symbol) => {
    const last = SEED_PRICES[symbol]?.price;
    if (!last) return [];
    return Array.from({ length: days }, (_, k) => {
      const i = days - 1 - k;
      return { symbol, day: addDays(end, -i), close: r2(last * (1 + wave(symbol, i))), change_pct: r2((wave(symbol, i) - wave(symbol, i + 1)) * 100) };
    });
  }).sort((a, b) => a.day.localeCompare(b.day));
}
function samplePortfolioDays(value: number, invested: number, days = 120): PortfolioDay[] {
  const end = SEED_CAPTURED_AT.slice(0, 10);
  return Array.from({ length: days }, (_, k) => ({ day: addDays(end, -(days - 1 - k)), value: r2(value * (1 + wave('pf', days - 1 - k))), invested }));
}
function sampleTicks(value: number): PortfolioTick[] {
  const day = SEED_CAPTURED_AT.slice(0, 10);
  return Array.from({ length: 13 }, (_, i) => {
    const m = 9 * 60 + 45 + i * 30 - 5 * 60; // PKT market checks, written as UTC
    return { ts: `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`, value: r2(value * (1 + wave('tick', i) / 4)) };
  });
}

/** In-memory demo: the owner's seed portfolio and the PSX close of 2026-10-05. Nothing is saved. */
export class DemoSource implements DataSource {
  kind = 'demo' as const;
  private holdings: Holding[] = SEED_HOLDINGS.map((h, i) => ({ ...h, id: `demo-h${i}` }));
  private watch: WatchItem[] = SEED_WATCHLIST.map((w, i) => ({ ...w, id: `demo-w${i}` }));
  private settings: Settings = { ...DEFAULT_SETTINGS };
  // A trade history that adds up to the seed holdings: this month's recorded buys (moved to today), and for the
  // rest of each holding one buy at the end of the month before the seed capture, priced so the average cost
  // matches. Last month keeps the baseline out of "invested this month"; the demo has no real trade dates.
  private txns: Txn[] = demoTxns();
  private receipts: DividendReceipt[] = [];
  private alerts: AlertLogRow[] = [
    { kind: 'buy_chance', symbol: 'SYS', message: 'SYS Rs 114.37: 12.3% below your last buy.', channel: 'push', sent_at: '2026-10-05T07:30:00Z', dedupe_key: 'd1' },
    { kind: 'night_digest', symbol: null, message: 'KSE-100 closed at 165,867. Your portfolio Rs 56,279, today -Rs 593, total -Rs 4,836.', channel: 'push', sent_at: '2026-10-05T16:00:00Z', dedupe_key: 'd3' },
  ];

  async load(): Promise<AppData> {
    return {
      settings: { ...this.settings }, holdings: this.holdings.map((h) => ({ ...h })), watchlist: [...this.watch],
      prices: SEED_PRICES, index: SEED_INDEX, indexHistory: [SEED_INDEX], announcements: SEED_ANNOUNCEMENTS,
      alerts: [...this.alerts], telegramLinked: false, email: 'demo',
      lastRun: { job: 'market', started_at: SEED_CAPTURED_AT, finished_at: SEED_CAPTURED_AT, ok: true }, lastRefresh: null,
      aiInsight: null, // never show made-up AI text; real suggestions appear after the first signed-in run
      screen: SEED_SCREEN, transactions: [...this.txns], dividends: [], picks: { undervalued: null, dividend: null },
      receipts: [...this.receipts], indexDaily: [{ day: SEED_INDEX.ts.slice(0, 10), close: SEED_INDEX.kse100 }], earnings: [], bluechip: demoBluechip(),
      policyRates: DEMO_RATES, regime: demoRegime(DEMO_RATES),
      macro: [], // no SBP / PBS figures are bundled: the demo shows them as unknown rather than invent any
      ...this.series(),
    };
  }
  private series(): Pick<AppData, 'priceDaily' | 'portfolioTicks' | 'portfolioDaily'> {
    if (!wantSample()) return { priceDaily: [], portfolioTicks: [], portfolioDaily: [] };
    const value = this.holdings.reduce((a, h) => a + h.shares * (SEED_PRICES[h.symbol]?.price ?? h.avg_cost), 0);
    const invested = this.holdings.reduce((a, h) => a + h.shares * h.avg_cost, 0);
    return { priceDaily: samplePriceDays(), portfolioTicks: sampleTicks(value), portfolioDaily: samplePortfolioDays(value, invested) };
  }
  async priceHistory(symbol: string) { return this.series().priceDaily.filter((p) => p.symbol === symbol); }
  async saveTxns(txns: Txn[]) { this.txns.push(...txns.map((t, i) => ({ ...t, id: t.id ?? `demo-t${Date.now()}-${i}` }))); }
  async updateTxn(id: string, patch: Partial<Txn>) { this.txns = this.txns.map((t) => (t.id === id ? { ...t, ...patch } : t)); }
  async deleteTxn(id: string) { this.txns = this.txns.filter((t) => t.id !== id); }
  async saveReceipt(r: DividendReceipt) { this.receipts.unshift({ ...r, id: r.id ?? `demo-r${Date.now()}` }); }
  async updateReceipt(id: string, r: DividendReceipt) { this.receipts = this.receipts.map((x) => (x.id === id ? { ...r, id } : x)); }
  async deleteReceipt(id: string) { this.receipts = this.receipts.filter((r) => r.id !== id); }
  async saveHoldingChange(before: Holding | undefined, after: Holding | null, txn: Txn | null) {
    if (!after) this.holdings = this.holdings.filter((h) => h.id !== before?.id);
    else if (before?.id) this.holdings = this.holdings.map((h) => (h.id === before.id ? { ...after, id: before.id } : h));
    else this.holdings.push({ ...after, id: `demo-h${Date.now()}` });
    if (txn) this.txns.push({ ...txn, id: `demo-t${Date.now()}` });
  }
  async addWatch(symbol: string, note?: string) { this.watch.push({ id: `demo-w${Date.now()}`, symbol, note }); }
  async deleteWatch(id: string) { this.watch = this.watch.filter((w) => w.id !== id); }
  async saveSettings(s: Partial<Settings>) { this.settings = { ...this.settings, ...s }; }
  async createTelegramCode() { return 'DEMO1234'; }
  async savePushSubscription() { throw new Error('Notifications need an account. Sign in to turn them on.'); }
  async deletePushSubscription() {}
  async readScreenshots(): Promise<{ holdings: ImportedRow[]; dropped: string[] }> {
    throw new Error('Screenshot import needs an account. Sign in to use it.');
  }
  async aiStatus(): Promise<AiStatus> { return { providers: [], vision: [], ready: false, retry_at: null }; }
  async refreshAll(): Promise<RefreshReply> { throw new Error('Refresh needs an account. Sign in to use it.'); }
  async refreshRun() { return null; }
}
