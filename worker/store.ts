/**
 * Storage for the worker. SupabaseStore talks to the real database with the service-role key
 * (GitHub Actions secret only). MemoryStore holds the seed user for dry runs and tests.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Announcement, AlertLogRow, Holding, IndexSnapshot, Price, PriceMap, Settings, WatchItem } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { ScreenRow } from '../shared/opportunities.ts';

export interface PushSub { id: string; endpoint: string; p256dh: string; auth: string }

export interface UserCtx {
  id: string;
  settings: Settings;
  holdings: Holding[];
  watchlist: WatchItem[];
  telegram_chat_id: number | null;
  subs: PushSub[];
}

export interface LoggedAlert extends AlertLogRow { batch_id: string | null }

export interface Recommendation { id: string; created_at: string; amount_pkr: number; payload: any; outcome_checked_at: string | null }

export interface Store {
  loadUsers(): Promise<UserCtx[]>;
  savePrices(prices: Price[]): Promise<void>;
  saveIndex(idx: IndexSnapshot): Promise<void>;
  /** Inserts announcements not seen before and returns only those. */
  saveNewAnnouncements(anns: Announcement[]): Promise<Announcement[]>;
  latestPrices(symbols: string[]): Promise<PriceMap>;
  latestIndex(): Promise<IndexSnapshot | null>;
  recentAlerts(userId: string, sinceIso: string): Promise<LoggedAlert[]>;
  logAlerts(userId: string, rows: Omit<LoggedAlert, 'id'>[]): Promise<void>;
  deleteSubscription(id: string): Promise<void>;
  recommendations(userId: string, sinceIso: string): Promise<Recommendation[]>;
  saveRecommendation(userId: string, amount: number, payload: unknown): Promise<void>;
  markRecommendationChecked(id: string, payload: unknown): Promise<void>;
  startRun(job: string): Promise<number | null>;
  finishRun(id: number | null, ok: boolean, errors: string[]): Promise<void>;
  findUserByEmail(email: string): Promise<string | null>;
  consumeLinkCode(code: string): Promise<string | null>;
  setTelegramChat(userId: string, chatId: number): Promise<void>;
  // AI layer + opportunity screen (migration 0003)
  saveScreen(rows: ScreenRow[]): Promise<void>;
  announcementsToRead(symbols: string[], sinceDate: string, limit: number): Promise<Announcement[]>;
  saveAnnouncementDigest(id: string, d: { summary: string | null; figures: unknown; verified: boolean | null }): Promise<void>;
  recentDigests(symbols: string[], sinceDate: string): Promise<Announcement[]>;
  saveInsight(userId: string, row: InsightRow): Promise<void>;
}

export interface InsightRow {
  job: string; headline: string; suggestions: unknown; plan_note: string | null; risks: string | null; model: string | null; dropped: number;
}

const READ_KINDS = ['dividend', 'results', 'board_meeting'];

const num = (v: unknown) => (v == null ? null : Number(v));

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export class SupabaseStore implements Store {
  private sb: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.sb = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async loadUsers(): Promise<UserCtx[]> {
    const [settings, holdings, watchlist, profiles, subs] = await Promise.all([
      this.sb.from('settings').select('*'),
      this.sb.from('holdings').select('*'),
      this.sb.from('watchlist').select('*'),
      this.sb.from('profiles').select('id, telegram_chat_id'),
      this.sb.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth'),
    ]);
    const S = check(settings, 'settings') as any[];
    const H = check(holdings, 'holdings') as any[];
    const W = check(watchlist, 'watchlist') as any[];
    const P = check(profiles, 'profiles') as any[];
    const PS = check(subs, 'push_subscriptions') as any[];
    return S.map((s) => ({
      id: s.user_id,
      settings: {
        ...DEFAULT_SETTINGS, ...s,
        monthly_budget_pkr: Number(s.monthly_budget_pkr), crash_fund_pkr: Number(s.crash_fund_pkr),
        crash_trigger_kse: Number(s.crash_trigger_kse), max_position_pct: Number(s.max_position_pct),
        drop_alert_pct: Number(s.drop_alert_pct),
      },
      holdings: H.filter((h) => h.user_id === s.user_id).map((h) => ({ ...h, shares: Number(h.shares), avg_cost: Number(h.avg_cost) })),
      watchlist: W.filter((w) => w.user_id === s.user_id),
      telegram_chat_id: num(P.find((p) => p.id === s.user_id)?.telegram_chat_id),
      subs: PS.filter((x) => x.user_id === s.user_id),
    }));
  }

  async savePrices(prices: Price[]) {
    const rows = prices.filter((p) => p.price != null).map((p) => ({ ...p, updated_at: new Date().toISOString() }));
    if (rows.length) check(await this.sb.from('prices').upsert(rows, { onConflict: 'symbol' }), 'save prices');
  }

  async saveIndex(idx: IndexSnapshot) {
    check(await this.sb.from('index_snapshots').upsert(idx, { onConflict: 'ts', ignoreDuplicates: true }), 'save index');
  }

  async saveNewAnnouncements(anns: Announcement[]) {
    if (!anns.length) return [];
    const ids = [...new Set(anns.map((a) => a.id))];
    const existing = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const rows = check(await this.sb.from('announcements').select('id').in('id', ids.slice(i, i + 200)), 'read announcements') as { id: string }[];
      rows.forEach((r) => existing.add(r.id));
    }
    const fresh = anns.filter((a, i) => !existing.has(a.id) && anns.findIndex((b) => b.id === a.id) === i);
    if (fresh.length) check(await this.sb.from('announcements').insert(fresh), 'save announcements');
    return fresh;
  }

  async latestPrices(symbols: string[]) {
    if (!symbols.length) return {};
    const rows = check(await this.sb.from('prices').select('*').in('symbol', symbols), 'read prices') as any[];
    return Object.fromEntries(rows.map((r) => [r.symbol, r]));
  }

  async latestIndex() {
    const rows = check(await this.sb.from('index_snapshots').select('ts, kse100, change, change_pct').order('ts', { ascending: false }).limit(1), 'read index') as any[];
    return rows[0] ? { ...rows[0], kse100: Number(rows[0].kse100), change: num(rows[0].change), change_pct: num(rows[0].change_pct) } : null;
  }

  async recentAlerts(userId: string, sinceIso: string) {
    return check(await this.sb.from('alerts_log').select('*').eq('user_id', userId).gte('sent_at', sinceIso), 'read alerts') as LoggedAlert[];
  }

  async logAlerts(userId: string, rows: Omit<LoggedAlert, 'id'>[]) {
    if (!rows.length) return;
    check(await this.sb.from('alerts_log').upsert(rows.map((r) => ({ ...r, user_id: userId })), { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true }), 'log alerts');
  }

  async deleteSubscription(id: string) {
    check(await this.sb.from('push_subscriptions').delete().eq('id', id), 'delete subscription');
  }

  async recommendations(userId: string, sinceIso: string) {
    return check(await this.sb.from('recommendations').select('*').eq('user_id', userId).gte('created_at', sinceIso).order('created_at', { ascending: false }), 'read recommendations') as Recommendation[];
  }

  async saveRecommendation(userId: string, amount: number, payload: unknown) {
    check(await this.sb.from('recommendations').insert({ user_id: userId, amount_pkr: amount, payload }), 'save recommendation');
  }

  async markRecommendationChecked(id: string, payload: unknown) {
    check(await this.sb.from('recommendations').update({ outcome_checked_at: new Date().toISOString(), payload }).eq('id', id), 'update recommendation');
  }

  async startRun(job: string) {
    const rows = check(await this.sb.from('worker_runs').insert({ job }).select('id'), 'heartbeat') as { id: number }[];
    return rows[0]?.id ?? null;
  }

  async finishRun(id: number | null, ok: boolean, errors: string[]) {
    if (id == null) return;
    check(await this.sb.from('worker_runs').update({ finished_at: new Date().toISOString(), ok, errors }).eq('id', id), 'finish run');
  }

  async findUserByEmail(email: string) {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await this.sb.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`list users: ${error.message}`);
      const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (hit) return hit.id;
      if (data.users.length < 200) return null;
    }
    return null;
  }

  async consumeLinkCode(code: string) {
    const rows = check(await this.sb.from('telegram_link_codes').select('user_id, expires_at').eq('code', code.toUpperCase()), 'read link code') as any[];
    const row = rows[0];
    if (!row || Date.parse(row.expires_at) < Date.now()) return null;
    check(await this.sb.from('telegram_link_codes').delete().eq('user_id', row.user_id), 'consume link code');
    return row.user_id as string;
  }

  async setTelegramChat(userId: string, chatId: number) {
    check(await this.sb.from('profiles').update({ telegram_chat_id: chatId }).eq('id', userId), 'link telegram');
  }

  async saveScreen(rows: ScreenRow[]) {
    if (!rows.length) return;
    const now = new Date().toISOString();
    check(await this.sb.from('market_screen').upsert(rows.map((r) => ({ ...r, updated_at: now })), { onConflict: 'symbol' }), 'save screen');
  }

  async announcementsToRead(symbols: string[], sinceDate: string, limit: number) {
    if (!symbols.length) return [];
    return check(await this.sb.from('announcements').select('*').in('symbol', symbols).in('kind', READ_KINDS)
      .is('ai_checked_at', null).not('pdf_url', 'is', null).gte('published_at', sinceDate)
      .order('published_at', { ascending: false }).limit(limit), 'announcements to read') as Announcement[];
  }

  async saveAnnouncementDigest(id: string, d: { summary: string | null; figures: unknown; verified: boolean | null }) {
    check(await this.sb.from('announcements').update({
      ai_summary: d.summary, ai_figures: d.figures, ai_verified: d.verified, ai_checked_at: new Date().toISOString(),
    }).eq('id', id), 'save digest');
  }

  async recentDigests(symbols: string[], sinceDate: string) {
    if (!symbols.length) return [];
    return check(await this.sb.from('announcements').select('*').in('symbol', symbols).not('ai_summary', 'is', null)
      .gte('published_at', sinceDate).order('published_at', { ascending: false }).limit(20), 'recent digests') as Announcement[];
  }

  async saveInsight(userId: string, row: InsightRow) {
    check(await this.sb.from('ai_insights').insert({ ...row, user_id: userId }), 'save insight');
  }
}

/** In-memory store for dry runs and tests. */
export class MemoryStore implements Store {
  prices: PriceMap = {};
  index: IndexSnapshot[] = [];
  announcements: Announcement[] = [];
  alerts: (LoggedAlert & { user_id: string })[] = [];
  recs: (Recommendation & { user_id: string })[] = [];
  runs: { id: number; job: string; ok?: boolean; errors?: string[] }[] = [];
  deletedSubs: string[] = [];
  linkCodes: Record<string, { user_id: string; expires_at: string }> = {};
  telegram: Record<string, number> = {};
  emails: Record<string, string> = {};

  constructor(public users: UserCtx[]) {}

  async loadUsers() { return this.users.map((u) => ({ ...u, telegram_chat_id: this.telegram[u.id] ?? u.telegram_chat_id })); }
  async savePrices(p: Price[]) { for (const x of p) if (x.price != null) this.prices[x.symbol] = x; }
  async saveIndex(i: IndexSnapshot) { if (!this.index.some((x) => x.ts === i.ts)) this.index.push(i); }
  async saveNewAnnouncements(a: Announcement[]) {
    const fresh = a.filter((x, i) => !this.announcements.some((y) => y.id === x.id) && a.findIndex((b) => b.id === x.id) === i);
    this.announcements.push(...fresh);
    return fresh;
  }
  async latestPrices(symbols: string[]) { return Object.fromEntries(symbols.filter((s) => this.prices[s]).map((s) => [s, this.prices[s]])); }
  async latestIndex() { return [...this.index].sort((a, b) => b.ts.localeCompare(a.ts))[0] ?? null; }
  async recentAlerts(userId: string, since: string) { return this.alerts.filter((a) => a.user_id === userId && a.sent_at >= since); }
  async logAlerts(userId: string, rows: Omit<LoggedAlert, 'id'>[]) {
    for (const r of rows) {
      if (!this.alerts.some((a) => a.user_id === userId && a.dedupe_key === r.dedupe_key)) this.alerts.push({ ...r, user_id: userId });
    }
  }
  async deleteSubscription(id: string) { this.deletedSubs.push(id); }
  async recommendations(userId: string, since: string) {
    return this.recs.filter((r) => r.user_id === userId && r.created_at >= since).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async saveRecommendation(userId: string, amount: number, payload: unknown) {
    this.recs.push({ id: `rec-${this.recs.length + 1}`, user_id: userId, created_at: new Date().toISOString(), amount_pkr: amount, payload, outcome_checked_at: null });
  }
  async markRecommendationChecked(id: string, payload: unknown) {
    const r = this.recs.find((x) => x.id === id);
    if (r) Object.assign(r, { outcome_checked_at: new Date().toISOString(), payload });
  }
  async startRun(job: string) { this.runs.push({ id: this.runs.length + 1, job }); return this.runs.length; }
  async finishRun(id: number | null, ok: boolean, errors: string[]) { const r = this.runs.find((x) => x.id === id); if (r) Object.assign(r, { ok, errors }); }
  async findUserByEmail(email: string) { return this.emails[email.toLowerCase()] ?? null; }
  async consumeLinkCode(code: string) {
    const row = this.linkCodes[code.toUpperCase()];
    if (!row || Date.parse(row.expires_at) < Date.now()) return null;
    delete this.linkCodes[code.toUpperCase()];
    return row.user_id;
  }
  async setTelegramChat(userId: string, chatId: number) { this.telegram[userId] = chatId; }

  screen: ScreenRow[] = [];
  insights: (InsightRow & { user_id: string })[] = [];
  async saveScreen(rows: ScreenRow[]) { this.screen = rows; }
  async announcementsToRead(symbols: string[], since: string, limit: number) {
    return this.announcements.filter((a) => symbols.includes(a.symbol) && READ_KINDS.includes(a.kind) && a.pdf_url
      && a.published_at >= since && !(a as any).ai_checked_at).sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, limit);
  }
  async saveAnnouncementDigest(id: string, d: { summary: string | null; figures: unknown; verified: boolean | null }) {
    const a = this.announcements.find((x) => x.id === id);
    if (a) Object.assign(a, { ai_summary: d.summary, ai_figures: d.figures, ai_verified: d.verified, ai_checked_at: new Date().toISOString() });
  }
  async recentDigests(symbols: string[], since: string) {
    return this.announcements.filter((a) => symbols.includes(a.symbol) && a.ai_summary && a.published_at >= since);
  }
  async saveInsight(userId: string, row: InsightRow) { this.insights.push({ ...row, user_id: userId }); }
}
