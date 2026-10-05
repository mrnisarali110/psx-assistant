/**
 * Scheduled jobs. Each run: heartbeat row, refresh PSX data once, let the AI read new announcements,
 * evaluate rules (and the AI second opinion) for every user, deliver within limits, log every alert.
 * Every AI step is optional and isolated: if Gemini fails, prices, rules and alerts still run.
 */
import { randomUUID } from 'node:crypto';
import { allocate, planToText } from '../shared/allocate.ts';
import { findOpportunities, type ScreenRow } from '../shared/opportunities.ts';
import { buildPortfolio, type PortfolioView } from '../shared/portfolio.ts';
import { holdingAlerts, marketAlerts, planDelivery, todayBanner, type AlertCandidate } from '../shared/signals.ts';
import { addDays, daysBetween, isoWeek, pktDate } from '../shared/time.ts';
import { DEFAULT_RULES, type Announcement, type IndexSnapshot, type PriceMap } from '../shared/types.ts';
import type { AnnouncementDigest, GuardContext, Insight, InsightFacts } from './ai.ts';
import { FetchError, isUsable, toPrice, type Snapshot } from './feed.ts';
import type { Notifier } from './notify.ts';
import type { Store, UserCtx } from './store.ts';

export type JobName = 'morning' | 'midday' | 'preclose' | 'eod' | 'weekly' | 'test';

/** The AI as the jobs see it (real: Gemini via ./ai.ts; tests: a fake). */
export interface AiService {
  readAnnouncement(pdf: Uint8Array, meta: { symbol: string; title: string }): Promise<AnnouncementDigest & { model: string }>;
  portfolioInsight(facts: InsightFacts, guard: GuardContext): Promise<{ insight: Insight; dropped: number; reasons: string[]; model: string }>;
}

export interface JobDeps {
  store: Store;
  notifier: Notifier;
  fetchSnapshot: (symbols: string[]) => Promise<Snapshot>;
  fetchPdf?: (url: string) => Promise<Uint8Array>;
  ai?: AiService;
  now?: () => Date;
  log?: (m: string) => void;
  testEmail?: string;
}

export interface RunReport {
  ok: boolean; errors: string[]; notified: number; suppressed: number; users: number;
  ai: { announcements_read: number; insights: number; suggestions_dropped: number };
}

const rules = DEFAULT_RULES;
const fmt0 = (v: number) => Math.round(v).toLocaleString('en-PK');
const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '-' : '');
const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runJob(job: JobName, deps: JobDeps): Promise<RunReport> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? console.log;
  const { store } = deps;
  const report: RunReport = { ok: true, errors: [], notified: 0, suppressed: 0, users: 0, ai: { announcements_read: 0, insights: 0, suggestions_dropped: 0 } };
  const runId = await store.startRun(job);
  try {
    const users = await store.loadUsers();
    report.users = users.length;

    if (job === 'test') {
      await sendTest(users, deps, now, report);
      return report;
    }

    // ---- refresh market data once for everyone ----------------------
    const symbols = [...new Set(users.flatMap((u) => [...u.holdings.map((h) => h.symbol), ...u.watchlist.map((w) => w.symbol)]))];
    const snap = await deps.fetchSnapshot(symbols);
    report.errors.push(...snap.errors);
    const usable = isUsable(snap);
    let prices: PriceMap = {};
    let idx: IndexSnapshot | null = null;
    let newAnns: Announcement[] = [];
    const screen: ScreenRow[] = Object.values(snap.screener).filter((s) => s.listed_in.includes('KSE100')).map((s) => ({
      symbol: s.symbol, sector: s.sector, price: s.price, change_pct: s.change_pct, pe: s.pe,
      dividend_yield_pct: s.dividend_yield_pct, market_cap: s.market_cap, is_shariah: s.listed_in.includes('KMIALLSHR'),
    }));
    if (usable) {
      const fresh = Object.values(snap.quotes).filter((q) => q.price != null).map((q) => toPrice(q, snap.screener[q.symbol]));
      await store.savePrices(fresh);
      const asOf = Object.values(snap.quotes).map((q) => q.as_of).filter(Boolean).sort().at(-1) ?? snap.fetched_at;
      const k = snap.indices.KSE100!;
      idx = { ts: asOf as string, kse100: k.value as number, change: k.change, change_pct: k.change_pct };
      await store.saveIndex(idx);
      newAnns = await store.saveNewAnnouncements(Object.values(snap.quotes).flatMap((q) => q.announcements));
      // Symbols that failed this run keep their last good price, never a made-up one.
      prices = { ...(await store.latestPrices(symbols)), ...Object.fromEntries(fresh.map((p) => [p.symbol, p])) };
      if (screen.length) await store.saveScreen(screen).catch((e) => report.errors.push(`screen: ${errMsg(e)}`));
    } else {
      report.ok = false;
      prices = await store.latestPrices(symbols);
      idx = await store.latestIndex();
      log(`PSX data unavailable this run: ${snap.errors.slice(0, 3).join(' | ')}`);
    }
    const today = pktDate(now);
    // Only raise market/holding alerts if PSX actually traded today (skips weekends and holidays).
    const tradedToday = usable && !!idx && pktDate(new Date(idx.ts)) === today;

    // ---- AI reads new dividend / results / board-meeting PDFs ---------
    const digests = new Map<string, Announcement>();
    if (deps.ai && deps.fetchPdf) await readAnnouncements(symbols, today, deps, digests, report, log);
    let news: Announcement[] = [];
    if (deps.ai) news = await store.recentDigests(symbols, addDays(today, -14)).catch(() => []);

    log(`job=${job} users=${users.length} symbols=${symbols.length} usable=${usable} tradedToday=${tradedToday} newAnnouncements=${newAnns.length} aiRead=${digests.size}`);

    let aiBudget = rules.ai.max_users_per_run;
    for (const u of users) {
      try {
        const wantAi = !!deps.ai && !!u.settings.ai_enabled && !!idx && aiBudget > 0 && (tradedToday || job === 'morning' || job === 'weekly');
        if (wantAi) aiBudget--;
        await processUser(u, { job, deps, now, today, prices, idx, usable, tradedToday, newAnns, digests, news, screen, wantAi, report });
      } catch (e) {
        report.errors.push(`user ${u.id.slice(0, 8)}: ${errMsg(e)}`);
      }
    }
    return report;
  } catch (e) {
    report.ok = false;
    report.errors.push(errMsg(e));
    return report;
  } finally {
    await store.finishRun(runId, report.ok, report.errors.slice(0, 50)).catch((e) => log(`heartbeat finish failed: ${e.message}`));
  }
}

async function readAnnouncements(symbols: string[], today: string, deps: JobDeps, digests: Map<string, Announcement>,
  report: RunReport, log: (m: string) => void) {
  let toRead: Announcement[] = [];
  try {
    toRead = await deps.store.announcementsToRead(symbols, addDays(today, -rules.ai.announcement_max_age_days), rules.ai.announcements_per_run);
  } catch (e) {
    report.errors.push(`ai: cannot list announcements (${errMsg(e)})`);
    return;
  }
  for (const a of toRead) {
    let pdf: Uint8Array;
    try {
      pdf = await deps.fetchPdf!(a.pdf_url!);
    } catch (e) {
      // The document itself is unavailable: record that, so we don't retry it every run.
      if (e instanceof FetchError) await deps.store.saveAnnouncementDigest(a.id, { summary: null, figures: null, verified: null }).catch(() => {});
      report.errors.push(`ai: ${a.symbol} pdf: ${errMsg(e)}`);
      continue;
    }
    try {
      const d = await deps.ai!.readAnnouncement(pdf, { symbol: a.symbol, title: a.title });
      await deps.store.saveAnnouncementDigest(a.id, { summary: d.summary, figures: d.figures, verified: d.verified });
      digests.set(a.id, { ...a, ai_summary: d.summary, ai_figures: d.figures, ai_verified: d.verified });
      report.ai.announcements_read++;
      log(`ai read ${a.symbol} "${a.title.slice(0, 50)}" (${d.model}, verified=${d.verified})`);
    } catch (e) {
      report.errors.push(`ai: ${a.symbol}: ${errMsg(e)}`);
      if (/Gemini unavailable/.test(errMsg(e))) break; // rate limited or down: try again next run
    }
  }
}

interface Ctx {
  job: JobName; deps: JobDeps; now: Date; today: string; prices: PriceMap; idx: IndexSnapshot | null;
  usable: boolean; tradedToday: boolean; newAnns: Announcement[]; digests: Map<string, Announcement>;
  news: Announcement[]; screen: ScreenRow[]; wantAi: boolean; report: RunReport;
}

async function processUser(u: UserCtx, c: Ctx) {
  const { store, notifier } = c.deps;
  const recent = await store.recentAlerts(u.id, new Date(c.now.getTime() - 10 * 86400000).toISOString());
  const sentKeys = new Set(recent.map((r) => r.dedupe_key));
  const lastSent = (kind: string, symbol: string) =>
    recent.filter((r) => r.kind === kind && r.symbol === symbol && r.channel && r.channel !== 'none')
      .map((r) => pktDate(new Date(r.sent_at))).sort().at(-1) ?? null;
  const view = buildPortfolio(u.holdings, c.prices, u.settings);
  const mine = new Set([...u.holdings.map((h) => h.symbol), ...u.watchlist.map((w) => w.symbol)]);
  const cands: AlertCandidate[] = [];

  // ---- AI second opinion (stored for the app; strong calls also notify) ----
  let insight: Insight | null = null;
  if (c.wantAi) {
    try {
      insight = await makeInsight(u, view, mine, c);
      for (const s of insight.suggestions) {
        if (s.confidence !== 'high' || !['buy', 'add', 'trim', 'sell'].includes(s.action)) continue;
        cands.push({
          kind: 'ai_suggestion', symbol: s.symbol, urgent: false, url: '/#/today',
          dedupe_key: `ai:${s.action}:${s.symbol ?? '-'}:${isoWeek(c.today)}`,
          title: `AI Assistant suggests: ${s.action}${s.symbol ? ` ${s.symbol}` : ''}`,
          message: `AI Assistant suggests: ${s.text} (${s.why})`,
        });
      }
    } catch (e) {
      c.report.errors.push(`ai insight ${u.id.slice(0, 8)}: ${errMsg(e)}`);
    }
  }

  if (!c.usable) {
    cands.push({
      kind: 'data_unavailable', symbol: null, urgent: false, url: '/#/today', dedupe_key: `nodata:${c.today}`,
      title: 'PSX data unavailable', message: "Couldn't read PSX prices this run. Check live prices in your broker app; the app shows the last good data.",
    });
  }
  if (c.tradedToday && c.job !== 'weekly') {
    cands.push(...marketAlerts(c.idx, u.settings, c.today), ...holdingAlerts(view, u.settings, c.today, lastSent));
  }
  for (const a of c.newAnns) {
    // Alert only on dividends, results and board meetings; routine filings stay on the News screen.
    if (!mine.has(a.symbol) || a.kind === 'other' || daysBetween(a.published_at, c.today) > 5) continue;
    const ai = c.digests.get(a.id)?.ai_summary;
    cands.push({
      kind: `announcement_${a.kind}`, symbol: a.symbol, urgent: false, url: '/#/news', dedupe_key: `ann:${a.id}`,
      title: `${a.symbol}: ${a.kind.replace('_', ' ')}`, message: `${a.symbol}: ${ai ?? a.title}`,
    });
  }
  const aiLine = insight ? ` AI Assistant: ${insight.headline}` : '';
  if (c.job === 'morning' && c.idx) cands.unshift(morningBrief(u, view, c, aiLine));
  if (c.job === 'eod' && c.tradedToday && c.idx) cands.unshift(dailySummary(view, c, aiLine));
  if (c.job === 'weekly') {
    const w = await weeklyPlan(u, c, insight);
    if (w) cands.unshift(w);
  }

  const fresh = cands.filter((x, i) => !sentKeys.has(x.dedupe_key) && cands.findIndex((y) => y.dedupe_key === x.dedupe_key) === i);
  const sentToday = new Set(recent.filter((r) => pktDate(new Date(r.sent_at)) === c.today && r.batch_id && r.channel !== 'none').map((r) => r.batch_id)).size;
  const plan = planDelivery(fresh, { now: c.now, sentToday, quiet: u.settings.quiet_hours, enabled: u.settings.notifications_enabled });

  for (const n of plan.send) {
    const channel = await notifier.send(u, n);
    const batch = randomUUID();
    await store.logAlerts(u.id, n.alerts.map((a) => ({
      kind: a.kind, symbol: a.symbol, message: a.message, dedupe_key: a.dedupe_key,
      channel, sent_at: c.now.toISOString(), batch_id: channel === 'none' ? null : batch,
    })));
    if (channel !== 'none') c.report.notified++;
  }
  if (plan.suppressed.length) {
    await store.logAlerts(u.id, plan.suppressed.map((a) => ({
      kind: a.kind, symbol: a.symbol, message: a.message, dedupe_key: a.dedupe_key,
      channel: 'none', sent_at: c.now.toISOString(), batch_id: null,
    })));
    c.report.suppressed += plan.suppressed.length;
  }
}

// ---------------------------------------------------------------------------
// AI facts: everything the model may use, rounded the way it will be quoted
// ---------------------------------------------------------------------------
export function buildFacts(u: UserCtx, view: PortfolioView, mine: Set<string>, c: Pick<Ctx, 'today' | 'idx' | 'prices' | 'screen' | 'news'>) {
  const s = u.settings;
  const banner = todayBanner(c.idx, s);
  const plan = allocate({ amount: s.monthly_budget_pkr, holdings: u.holdings, watchlist: u.watchlist, prices: c.prices, settings: s, today: c.today });
  const metrics = (sym: string) => {
    const p = c.prices[sym];
    return {
      price: r2(p?.price), day_change_pct: r2(p?.change_pct), high_52w: r2(p?.high_52w), low_52w: r2(p?.low_52w),
      below_52w_high_pct: p?.price && p?.high_52w ? r1(((p.high_52w - p.price) / p.high_52w) * 100) : null,
      dividend_yield_pct: r2(p?.dividend_yield_pct), pe: r2(p?.pe), sector: p?.sector ?? null, is_shariah: p?.is_shariah ?? null,
    };
  };
  const candidates = findOpportunities(c.screen, mine, s.shariah_only);
  const facts: InsightFacts = {
    date: c.today,
    market: { kse100: r2(c.idx?.kse100), change_pct: r2(c.idx?.change_pct), rules_say: banner.action, rules_reason: banner.reason, crash_level: s.crash_trigger_kse },
    rules: { max_position_pct: s.max_position_pct, below_cost_alert_pct: s.drop_alert_pct, shariah_only: s.shariah_only, monthly_budget_pkr: s.monthly_budget_pkr, crash_fund_pkr: s.crash_fund_pkr },
    portfolio: { total_value_pkr: Math.round(view.total_value), total_pnl_pct: r1(view.total_pnl_pct), sectors: view.sector_weights.map((w) => ({ sector: w.sector, pct: r1(w.pct)! })) },
    holdings: view.rows.map((r) => ({
      symbol: r.holding.symbol, status: r.holding.status, shares: r.holding.shares, avg_cost: r.holding.avg_cost,
      value_pkr: r.value == null ? null : Math.round(r.value), pnl_pct: r1(r.pnl_pct), weight_pct: r1(r.weight_pct),
      ...metrics(r.holding.symbol), is_shariah: r.holding.is_shariah, note: r.holding.note ?? null,
    })),
    watchlist: u.watchlist.map((w) => ({ symbol: w.symbol, ...metrics(w.symbol) })),
    screen_candidates: candidates.map((o) => ({ symbol: o.symbol, sector: o.sector, price: o.price, dividend_yield_pct: o.dividend_yield_pct, pe: o.pe, is_shariah: o.is_shariah })),
    plan_tranche_1: (plan.tranches[0]?.items ?? []).map((i) => ({ symbol: i.symbol, shares: i.shares, rupees: Math.round(i.rupees), kind: i.kind })),
    recent_news: c.news.filter((a) => mine.has(a.symbol) && a.ai_summary).slice(0, 8).map((a) => ({ symbol: a.symbol, date: a.published_at, summary: a.ai_summary as string })),
  };
  const guard: GuardContext = {
    holdings: view.rows.map((r) => ({ symbol: r.holding.symbol, status: r.holding.status, weight_pct: r.weight_pct, is_shariah: r.holding.is_shariah })),
    universe: new Set([...mine, ...candidates.map((o) => o.symbol)]),
    shariahOf: (sym) => u.holdings.find((h) => h.symbol === sym)?.is_shariah ?? c.prices[sym]?.is_shariah ?? candidates.find((o) => o.symbol === sym)?.is_shariah ?? null,
    maxPositionPct: s.max_position_pct,
    shariahOnly: s.shariah_only,
    rulesSay: banner.action,
  };
  return { facts, guard };
}

async function makeInsight(u: UserCtx, view: PortfolioView, mine: Set<string>, c: Ctx): Promise<Insight> {
  const { facts, guard } = buildFacts(u, view, mine, c);
  const res = await c.deps.ai!.portfolioInsight(facts, guard);
  await c.deps.store.saveInsight(u.id, {
    job: c.job, headline: res.insight.headline, suggestions: res.insight.suggestions, plan_note: res.insight.plan_note,
    risks: res.insight.risks, model: res.model, dropped: res.dropped,
  }).catch((e) => c.report.errors.push(`ai: save insight: ${errMsg(e)}`));
  c.report.ai.insights++;
  c.report.ai.suggestions_dropped += res.dropped;
  if (res.reasons.length) c.deps.log?.(`ai guardrails dropped for ${u.id.slice(0, 8)}: ${res.reasons.join(' | ')}`);
  return res.insight;
}

// ---------------------------------------------------------------------------
// Summaries (template wording; the AI headline is appended when there is one)
// ---------------------------------------------------------------------------
function morningBrief(u: UserCtx, view: PortfolioView, c: Ctx, aiLine: string): AlertCandidate {
  const i = c.idx!;
  const watch: string[] = [];
  const below = view.rows.filter((r) => r.flags.below_cost).map((r) => r.holding.symbol);
  if (below.length) watch.push(`${below.join(', ')} below cost`);
  const over = view.rows.filter((r) => r.flags.over_cap).map((r) => r.holding.symbol);
  if (over.length) watch.push(`${over.join(', ')} over cap`);
  if (!u.holdings.length) watch.push('add your holdings in the app');
  return {
    kind: 'morning_brief', symbol: null, urgent: false, url: '/#/today', dedupe_key: `morning:${c.today}`,
    title: 'Morning brief',
    message: `Last close: KSE-100 ${fmt0(i.kse100)} (${sign(i.change_pct ?? 0)}${Math.abs(i.change_pct ?? 0).toFixed(1)}%). ` +
      `Portfolio Rs ${fmt0(view.total_value)}, P/L ${sign(view.total_pnl)}Rs ${fmt0(Math.abs(view.total_pnl))}. ` +
      (watch.length ? `Watch today: ${watch.join('; ')}.` : 'Nothing needs attention today.') + aiLine,
  };
}

function dailySummary(view: PortfolioView, c: Ctx, aiLine: string): AlertCandidate {
  const i = c.idx!;
  const movers = view.rows.filter((r) => r.price?.change_pct != null)
    .sort((a, b) => Math.abs(b.price!.change_pct!) - Math.abs(a.price!.change_pct!)).slice(0, 2)
    .map((r) => `${r.holding.symbol} ${sign(r.price!.change_pct!)}${Math.abs(r.price!.change_pct!).toFixed(1)}%`);
  const day = view.day_change;
  return {
    kind: 'daily_summary', symbol: null, urgent: false, url: '/#/portfolio', dedupe_key: `daily:${c.today}`,
    title: `Close: KSE-100 ${sign(i.change_pct ?? 0)}${Math.abs(i.change_pct ?? 0).toFixed(1)}%`,
    message: `KSE-100 closed at ${fmt0(i.kse100)}. Your portfolio Rs ${fmt0(view.total_value)}` +
      (day != null ? `, today ${sign(day)}Rs ${fmt0(Math.abs(day))}` : '') +
      `, total P/L ${sign(view.total_pnl)}Rs ${fmt0(Math.abs(view.total_pnl))}` +
      (view.total_pnl_pct != null ? ` (${sign(view.total_pnl_pct)}${Math.abs(view.total_pnl_pct).toFixed(1)}%)` : '') +
      (movers.length ? `. Biggest moves: ${movers.join(', ')}.` : '.') + aiLine,
  };
}

/**
 * Weekly plan (Sunday): reviews how past suggestions did, then reminds what is due this week.
 * A new monthly plan is saved only when there is none from the last 25 days, so tranche dates hold.
 */
async function weeklyPlan(u: UserCtx, c: Ctx, insight: Insight | null): Promise<AlertCandidate | null> {
  const { store } = c.deps;
  const recs = await store.recommendations(u.id, new Date(c.now.getTime() - 60 * 86400000).toISOString());
  const lines: string[] = [];

  // Review: suggestions at least 7 days old that have not been checked yet.
  for (const r of recs.filter((x) => !x.outcome_checked_at && daysBetween(pktDate(new Date(x.created_at)), c.today) >= 7)) {
    const first = r.payload?.plan?.tranches?.[0]?.items ?? [];
    const cost = first.reduce((a: number, i: any) => a + i.rupees, 0);
    const nowValue = first.reduce((a: number, i: any) => a + i.shares * (c.prices[i.symbol]?.price ?? i.price), 0);
    if (cost > 0) {
      const ret = ((nowValue - cost) / cost) * 100;
      lines.push(`Plan from ${pktDate(new Date(r.created_at))}: first-tranche picks ${sign(ret)}${Math.abs(ret).toFixed(1)}% since.`);
      await store.markRecommendationChecked(r.id, { ...r.payload, outcome: { checked_on: c.today, return_pct: Math.round(ret * 100) / 100 } });
    }
  }

  let active = recs.find((r) => daysBetween(pktDate(new Date(r.created_at)), c.today) <= 25 && r.payload?.plan);
  if (!active && u.settings.monthly_budget_pkr > 0) {
    const plan = allocate({ amount: u.settings.monthly_budget_pkr, holdings: u.holdings, watchlist: u.watchlist, prices: c.prices, settings: u.settings, today: c.today });
    const payload = { source: 'weekly_job', plan, text: planToText(plan), ai_note: insight?.plan_note ?? null };
    await store.saveRecommendation(u.id, plan.amount, payload);
    active = { id: 'new', created_at: c.now.toISOString(), amount_pkr: plan.amount, payload, outcome_checked_at: null };
    lines.unshift(`New plan for this month's Rs ${fmt0(plan.amount)} is ready on the Plan screen.`);
  }
  const weekEnd = addDays(c.today, 7);
  const due = (active?.payload?.plan?.tranches ?? []).filter((t: any) => t.date >= c.today && t.date <= weekEnd && t.items.length);
  for (const t of due) {
    lines.push(`Tranche ${t.index} on ${t.date}: ${t.items.map((i: any) => `${i.symbol} ${i.shares}`).join(', ')} (Rs ${fmt0(t.spent)}).`);
  }
  if (!lines.length) lines.push('No tranche due this week. Your plan is on track.');
  if (insight?.plan_note) lines.push(`AI Assistant: ${insight.plan_note}`);
  return {
    kind: 'weekly_plan', symbol: null, urgent: false, url: '/#/plan', dedupe_key: `weekly:${isoWeek(c.today)}`,
    title: 'Weekly plan', message: lines.join(' '),
  };
}

async function sendTest(users: UserCtx[], deps: JobDeps, now: Date, report: RunReport) {
  if (!deps.testEmail) throw new Error('job=test needs an email (workflow input "email")');
  const id = await deps.store.findUserByEmail(deps.testEmail);
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error(`no account with email ${deps.testEmail}`);
  if (!u.subs.length && !u.telegram_chat_id) {
    report.errors.push('that account has no push subscription and no Telegram link yet: enable notifications in Settings first');
  }
  const n = {
    title: 'Test: crash alert', urgent: true, url: '/#/today',
    body: 'This is a test. A real crash alert looks like this: KSE-100 down 4%+, consider using part of your crash fund.',
    alerts: [{ kind: 'test', symbol: null, title: 'Test', message: 'Test alert', dedupe_key: `test:${now.toISOString()}`, urgent: true, url: '/#/today' }],
  };
  const channel = await deps.notifier.send(u, n);
  await deps.store.logAlerts(u.id, [{ kind: 'test', symbol: null, message: n.body, dedupe_key: n.alerts[0].dedupe_key, channel, sent_at: now.toISOString(), batch_id: null }]);
  if (channel === 'none') report.errors.push('test alert reached no channel');
  else report.notified++;
  report.ok = channel !== 'none';
}
