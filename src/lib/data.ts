/**
 * App data access. LiveSource uses the signed-in user's Supabase session, so row-level security
 * decides what is visible. DemoSource serves the seed portfolio with saved PSX data in memory.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AiInsight, AiPicks, Announcement, AlertLogRow, DividendEvent, Holding, IndexSnapshot, PriceMap, Settings, Txn, WatchItem,
} from '../../shared/types.ts';
import { DEFAULT_SETTINGS } from '../../shared/types.ts';
import type { ScreenRow } from '../../shared/discover.ts';
import type { ImportedRow } from '../../shared/changes.ts';
import { addDays, pktDate } from '../../shared/time.ts';
import {
  SEED_ANNOUNCEMENTS, SEED_CAPTURED_AT, SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_SCREEN, SEED_TXNS, SEED_WATCHLIST,
} from '../../shared/fixtures/seed.ts';
import { config } from './config.ts';
import { readScreenshots } from './importer.ts';

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
  telegramLinked: boolean;
  email: string | null;
  aiInsight: AiInsight | null;
  screen: ScreenRow[];
  transactions: Txn[]; // this month
  dividends: DividendEvent[];
  picks: { undervalued: AiPicks | null; dividend: AiPicks | null };
}

export interface DataSource {
  kind: 'live' | 'demo';
  load(): Promise<AppData>;
  /** One write path for every holding change: edit, delete, record buy, import. */
  saveHoldingChange(before: Holding | undefined, after: Holding | null, txn: Txn | null): Promise<void>;
  addWatch(symbol: string, note?: string): Promise<void>;
  deleteWatch(id: string): Promise<void>;
  saveSettings(s: Partial<Settings>): Promise<void>;
  createTelegramCode(): Promise<string>;
  savePushSubscription(sub: PushSubscriptionJSON): Promise<void>;
  deletePushSubscription(endpoint: string): Promise<void>;
  readScreenshots(files: File[]): Promise<{ holdings: ImportedRow[]; dropped: string[] }>;
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
});

/** Optional extras (AI, screen, dividends): if a table is missing or empty, the app still works. */
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
    const [prices, anns, insights, screen, txns, divs, uv, dv] = await Promise.all([
      symbols.length ? optional(sb.from('prices').select('*').in('symbol', symbols), [] as any[]) : Promise.resolve([] as any[]),
      symbols.length ? optional(sb.from('announcements').select('*').in('symbol', symbols).gte('published_at', addDays(today, -60)).order('published_at', { ascending: false }).limit(150), [] as any[]) : Promise.resolve([] as any[]),
      optional(sb.from('ai_insights').select('created_at, job, headline, stance, suggestions, holding_calls, rebalance, cash_note, risks, model').order('created_at', { ascending: false }).limit(1), [] as any[]),
      optional(sb.from('market_screen').select('*'), [] as any[]),
      optional(sb.from('transactions').select('*').gte('executed_on', `${today.slice(0, 7)}-01`), [] as any[]),
      optional(sb.from('dividends').select('*').gte('announced_on', addDays(today, -400)).order('announced_on', { ascending: false }).limit(500), [] as any[]),
      optional(sb.from('ai_picks').select('*').eq('kind', 'undervalued').order('created_at', { ascending: false }).limit(1), [] as any[]),
      optional(sb.from('ai_picks').select('*').eq('kind', 'dividend').order('created_at', { ascending: false }).limit(1), [] as any[]),
    ]);
    const s = ok(settings) as any;
    const history = (ok(idx) as any[]).map(normIdx);
    return {
      settings: s ? {
        ...DEFAULT_SETTINGS, ...s, monthly_budget_pkr: Number(s.monthly_budget_pkr), crash_fund_pkr: Number(s.crash_fund_pkr),
        crash_trigger_kse: Number(s.crash_trigger_kse), max_position_pct: Number(s.max_position_pct), drop_alert_pct: Number(s.drop_alert_pct),
      } : { ...DEFAULT_SETTINGS },
      holdings: H,
      watchlist: W,
      prices: Object.fromEntries(prices.map((p: any) => [p.symbol, normPrice(p)])),
      index: history[0] ?? null,
      indexHistory: [...history].reverse(),
      announcements: anns as Announcement[],
      alerts: ok(alerts) as AlertLogRow[],
      lastRun: ((ok(run) as any[])[0] ?? null) as WorkerRun | null,
      telegramLinked: !!(ok(profile) as any)?.telegram_chat_id,
      email: this.email,
      aiInsight: insights[0] ? { holding_calls: [], suggestions: [], ...insights[0] } as AiInsight : null,
      screen: screen.map((r: any) => ({
        symbol: r.symbol, sector: r.sector, price: n(r.price), change_pct: n(r.change_pct), change_1y_pct: n(r.change_1y_pct), pe: n(r.pe),
        dividend_yield_pct: n(r.dividend_yield_pct), market_cap: n(r.market_cap), is_shariah: r.is_shariah,
      })),
      transactions: txns.map((t: any) => ({ ...t, shares: Number(t.shares), price: Number(t.price), amount: Number(t.amount) })),
      dividends: divs.map((d: any) => ({ ...d, dps: n(d.dps) })),
      picks: { undervalued: (uv[0] ?? null) as AiPicks | null, dividend: (dv[0] ?? null) as AiPicks | null },
    };
  }

  async saveHoldingChange(before: Holding | undefined, after: Holding | null, txn: Txn | null) {
    const sb = supabase();
    if (!after) ok(await sb.from('holdings').delete().eq('id', before!.id!));
    else if (before?.id) ok(await sb.from('holdings').update(holdingRow(after)).eq('id', before.id));
    else ok(await sb.from('holdings').insert({ ...holdingRow(after), user_id: this.userId }));
    if (txn) ok(await sb.from('transactions').insert({ ...txn, user_id: this.userId }));
  }
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
  async readScreenshots(files: File[]) {
    const { data } = await supabase().auth.getSession();
    if (!data.session) throw new Error('Please sign in again.');
    return readScreenshots(files, data.session.access_token);
  }
}

/** In-memory demo: the owner's seed portfolio and the PSX close of 2026-10-05. Nothing is saved. */
export class DemoSource implements DataSource {
  kind = 'demo' as const;
  private holdings: Holding[] = SEED_HOLDINGS.map((h, i) => ({ ...h, id: `demo-h${i}` }));
  private watch: WatchItem[] = SEED_WATCHLIST.map((w, i) => ({ ...w, id: `demo-w${i}` }));
  private settings: Settings = { ...DEFAULT_SETTINGS };
  // Recorded buys, moved into the current month so "invested this month" shows something.
  private txns: Txn[] = SEED_TXNS.map((t) => ({ ...t, executed_on: pktDate(new Date()) }));
  private alerts: AlertLogRow[] = [
    { kind: 'buy_chance', symbol: 'SYS', message: 'SYS Rs 114.37: 12.3% below your last buy.', channel: 'push', sent_at: '2026-10-05T07:30:00Z', dedupe_key: 'd1' },
    { kind: 'night_digest', symbol: null, message: 'KSE-100 closed at 165,867. Your portfolio Rs 56,279, today -Rs 593, total -Rs 4,836.', channel: 'push', sent_at: '2026-10-05T16:00:00Z', dedupe_key: 'd3' },
  ];

  async load(): Promise<AppData> {
    return {
      settings: { ...this.settings }, holdings: this.holdings.map((h) => ({ ...h })), watchlist: [...this.watch],
      prices: SEED_PRICES, index: SEED_INDEX, indexHistory: [SEED_INDEX], announcements: SEED_ANNOUNCEMENTS,
      alerts: [...this.alerts], telegramLinked: false, email: 'demo',
      lastRun: { job: 'market', started_at: SEED_CAPTURED_AT, finished_at: SEED_CAPTURED_AT, ok: true },
      aiInsight: null, // never show made-up AI text; real suggestions appear after the first signed-in run
      screen: SEED_SCREEN, transactions: [...this.txns], dividends: [], picks: { undervalued: null, dividend: null },
    };
  }
  async saveHoldingChange(before: Holding | undefined, after: Holding | null, txn: Txn | null) {
    if (!after) this.holdings = this.holdings.filter((h) => h.id !== before?.id);
    else if (before?.id) this.holdings = this.holdings.map((h) => (h.id === before.id ? { ...after, id: before.id } : h));
    else this.holdings.push({ ...after, id: `demo-h${Date.now()}` });
    if (txn) this.txns.push(txn);
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
}
