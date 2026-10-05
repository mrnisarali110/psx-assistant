/**
 * App data access. LiveSource uses the signed-in user's Supabase session, so row-level security
 * decides what is visible. DemoSource serves the seed portfolio with saved PSX prices in memory.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AiInsight, Announcement, AlertLogRow, Holding, IndexSnapshot, PriceMap, Settings, WatchItem } from '../../shared/types.ts';
import { DEFAULT_SETTINGS } from '../../shared/types.ts';
import type { ScreenRow } from '../../shared/opportunities.ts';
import {
  SEED_ANNOUNCEMENTS, SEED_CAPTURED_AT, SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_SCREEN, SEED_WATCHLIST,
} from '../../shared/fixtures/seed.ts';
import { config } from './config.ts';

export interface SavedPlan { id: string; created_at: string; amount_pkr: number; payload: any }
export interface WorkerRun { job: string; started_at: string; finished_at: string | null; ok: boolean | null }

export interface AppData {
  settings: Settings;
  holdings: Holding[];
  watchlist: WatchItem[];
  prices: PriceMap;
  index: IndexSnapshot | null;
  indexHistory: IndexSnapshot[]; // oldest first, for the tiny trend line
  announcements: Announcement[];
  alerts: AlertLogRow[];
  latestPlan: SavedPlan | null;
  lastRun: WorkerRun | null;
  telegramLinked: boolean;
  email: string | null;
  aiInsight: AiInsight | null;
  screen: ScreenRow[];
}

export interface DataSource {
  kind: 'live' | 'demo';
  load(): Promise<AppData>;
  saveHolding(h: Holding): Promise<void>;
  deleteHolding(id: string): Promise<void>;
  addWatch(symbol: string, note?: string): Promise<void>;
  deleteWatch(id: string): Promise<void>;
  saveSettings(s: Partial<Settings>): Promise<void>;
  savePlan(amount: number, payload: unknown): Promise<void>;
  createTelegramCode(): Promise<string>;
  savePushSubscription(sub: PushSubscriptionJSON): Promise<void>;
  deletePushSubscription(endpoint: string): Promise<void>;
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

export class LiveSource implements DataSource {
  kind = 'live' as const;
  constructor(private userId: string, private email: string | null) {}

  async load(): Promise<AppData> {
    const sb = supabase();
    // AI and screen tables are optional extras: if they are missing or empty, the app still works.
    const optional = async <T,>(q: PromiseLike<{ data: T | null; error: unknown }>, fallback: T): Promise<T> => {
      try { const r = await q; return r.error || r.data == null ? fallback : r.data; } catch { return fallback; }
    };
    const insightP = optional(sb.from('ai_insights').select('created_at, job, headline, suggestions, plan_note, risks, model').order('created_at', { ascending: false }).limit(1), [] as any[]);
    const screenP = optional(sb.from('market_screen').select('*'), [] as any[]);
    const [settings, holdings, watchlist, idx, alerts, plan, run, profile] = await Promise.all([
      sb.from('settings').select('*').maybeSingle(),
      sb.from('holdings').select('*').order('symbol'),
      sb.from('watchlist').select('*').order('symbol'),
      sb.from('index_snapshots').select('ts, kse100, change, change_pct').order('ts', { ascending: false }).limit(30),
      sb.from('alerts_log').select('*').order('sent_at', { ascending: false }).limit(60),
      sb.from('recommendations').select('id, created_at, amount_pkr, payload').order('created_at', { ascending: false }).limit(1),
      sb.from('worker_runs').select('job, started_at, finished_at, ok').order('started_at', { ascending: false }).limit(1),
      sb.from('profiles').select('telegram_chat_id').maybeSingle(),
    ]);
    const H = (ok(holdings) as any[]).map((h) => ({ ...h, shares: Number(h.shares), avg_cost: Number(h.avg_cost) }));
    const W = ok(watchlist) as WatchItem[];
    const symbols = [...new Set([...H.map((h) => h.symbol), ...W.map((w) => w.symbol)])];
    const [prices, anns] = symbols.length
      ? await Promise.all([
        sb.from('prices').select('*').in('symbol', symbols),
        sb.from('announcements').select('*').in('symbol', symbols).order('published_at', { ascending: false }).limit(120),
      ])
      : [{ data: [], error: null }, { data: [], error: null }];
    const s = ok(settings) as any;
    const history = (ok(idx) as any[]).map(normIdx);
    const [insights, screen] = await Promise.all([insightP, screenP]);
    return {
      settings: s ? {
        ...DEFAULT_SETTINGS, ...s, monthly_budget_pkr: Number(s.monthly_budget_pkr), crash_fund_pkr: Number(s.crash_fund_pkr),
        crash_trigger_kse: Number(s.crash_trigger_kse), max_position_pct: Number(s.max_position_pct), drop_alert_pct: Number(s.drop_alert_pct),
      } : { ...DEFAULT_SETTINGS },
      holdings: H,
      watchlist: W,
      prices: Object.fromEntries((ok(prices) as any[]).map((p) => [p.symbol, normPrice(p)])),
      index: history[0] ?? null,
      indexHistory: [...history].reverse(),
      announcements: ok(anns) as Announcement[],
      alerts: ok(alerts) as AlertLogRow[],
      latestPlan: ((ok(plan) as any[])[0] ?? null) as SavedPlan | null,
      lastRun: ((ok(run) as any[])[0] ?? null) as WorkerRun | null,
      telegramLinked: !!(ok(profile) as any)?.telegram_chat_id,
      email: this.email,
      aiInsight: (insights[0] ?? null) as AiInsight | null,
      screen: screen.map((r: any) => ({
        symbol: r.symbol, sector: r.sector, price: n(r.price), change_pct: n(r.change_pct), pe: n(r.pe),
        dividend_yield_pct: n(r.dividend_yield_pct), market_cap: n(r.market_cap), is_shariah: r.is_shariah,
      })),
    };
  }

  async saveHolding(h: Holding) {
    const row = {
      symbol: h.symbol, shares: h.shares, avg_cost: h.avg_cost, status: h.status,
      sector: h.sector || null, is_shariah: h.is_shariah, note: h.note || null,
    };
    if (h.id) ok(await supabase().from('holdings').update(row).eq('id', h.id));
    else ok(await supabase().from('holdings').insert({ ...row, user_id: this.userId }));
  }
  async deleteHolding(id: string) { ok(await supabase().from('holdings').delete().eq('id', id)); }
  async addWatch(symbol: string, note?: string) { ok(await supabase().from('watchlist').insert({ symbol, note: note || null, user_id: this.userId })); }
  async deleteWatch(id: string) { ok(await supabase().from('watchlist').delete().eq('id', id)); }
  async saveSettings(s: Partial<Settings>) { ok(await supabase().from('settings').update(s).eq('user_id', this.userId)); }
  async savePlan(amount: number, payload: unknown) {
    ok(await supabase().from('recommendations').insert({ amount_pkr: amount, payload, user_id: this.userId }));
  }
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
}

/** In-memory demo with the owner's seed portfolio and the PSX close of 2026-10-05. */
export class DemoSource implements DataSource {
  kind = 'demo' as const;
  private holdings: Holding[] = SEED_HOLDINGS.map((h, i) => ({ ...h, id: `demo-h${i}` }));
  private watch: WatchItem[] = SEED_WATCHLIST.map((w, i) => ({ ...w, id: `demo-w${i}` }));
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private plan: SavedPlan | null = null;
  private alerts: AlertLogRow[] = [
    { kind: 'below_cost', symbol: 'SYS', message: 'SYS at Rs 114.37 is 12.3% below your average cost of Rs 130.45. Core holding: eligible for averaging down.', channel: 'push', sent_at: '2026-10-05T07:30:00Z', dedupe_key: 'd1' },
    { kind: 'below_cost', symbol: 'LUCK', message: 'LUCK at Rs 407.54 is 11.1% below your average cost of Rs 458.39.', channel: 'push', sent_at: '2026-10-05T07:30:00Z', dedupe_key: 'd2' },
    { kind: 'daily_summary', symbol: null, message: 'KSE-100 closed at 165,867. Your portfolio Rs 56,279, today -Rs 593, total P/L -Rs 4,836 (-7.9%).', channel: 'push', sent_at: '2026-10-05T12:00:00Z', dedupe_key: 'd3' },
  ];

  async load(): Promise<AppData> {
    // Only the one real captured close: the trend line appears once real snapshots accumulate.
    const history = [SEED_INDEX];
    return {
      settings: { ...this.settings }, holdings: this.holdings.map((h) => ({ ...h })), watchlist: [...this.watch],
      prices: SEED_PRICES, index: SEED_INDEX, indexHistory: history, announcements: SEED_ANNOUNCEMENTS,
      alerts: [...this.alerts], latestPlan: this.plan, telegramLinked: false, email: 'demo',
      aiInsight: null, // never show made-up AI text; real suggestions appear after the first signed-in run
      screen: SEED_SCREEN,
      lastRun: { job: 'eod', started_at: SEED_CAPTURED_AT, finished_at: SEED_CAPTURED_AT, ok: true },
    };
  }
  async saveHolding(h: Holding) {
    if (h.id) this.holdings = this.holdings.map((x) => (x.id === h.id ? { ...h } : x));
    else this.holdings.push({ ...h, id: `demo-h${Date.now()}` });
  }
  async deleteHolding(id: string) { this.holdings = this.holdings.filter((h) => h.id !== id); }
  async addWatch(symbol: string, note?: string) { this.watch.push({ id: `demo-w${Date.now()}`, symbol, note }); }
  async deleteWatch(id: string) { this.watch = this.watch.filter((w) => w.id !== id); }
  async saveSettings(s: Partial<Settings>) { this.settings = { ...this.settings, ...s }; }
  async savePlan(amount: number, payload: unknown) {
    this.plan = { id: 'demo-plan', created_at: new Date().toISOString(), amount_pkr: amount, payload };
  }
  async createTelegramCode() { return 'DEMO1234'; }
  async savePushSubscription() { throw new Error('Notifications are not available in demo mode. Sign in to enable them.'); }
  async deletePushSubscription() {}
}
