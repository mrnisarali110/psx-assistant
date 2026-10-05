/**
 * Scheduled jobs. Each run: heartbeat row, refresh PSX data once, evaluate rules for every user,
 * deliver within limits, log every alert (sent or suppressed) for dedupe and the app's history.
 */
import { randomUUID } from 'node:crypto';
import { allocate, planToText } from '../shared/allocate.ts';
import { buildPortfolio } from '../shared/portfolio.ts';
import { holdingAlerts, marketAlerts, planDelivery, type AlertCandidate } from '../shared/signals.ts';
import { addDays, daysBetween, isoWeek, pktDate } from '../shared/time.ts';
import type { Announcement, IndexSnapshot, PriceMap } from '../shared/types.ts';
import { isUsable, toPrice, type Snapshot } from './feed.ts';
import type { Notifier } from './notify.ts';
import type { Store, UserCtx } from './store.ts';

export type JobName = 'morning' | 'midday' | 'preclose' | 'eod' | 'weekly' | 'test';

export interface JobDeps {
  store: Store;
  notifier: Notifier;
  fetchSnapshot: (symbols: string[]) => Promise<Snapshot>;
  now?: () => Date;
  log?: (m: string) => void;
  /** Optional AI rewording of the weekly summary. Must keep every number; falls back to the template. */
  reword?: (text: string) => Promise<string | null>;
  testEmail?: string;
}

export interface RunReport { ok: boolean; errors: string[]; notified: number; suppressed: number; users: number }

const fmt0 = (v: number) => Math.round(v).toLocaleString('en-PK');
const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '-' : '');

export async function runJob(job: JobName, deps: JobDeps): Promise<RunReport> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? console.log;
  const { store } = deps;
  const report: RunReport = { ok: true, errors: [], notified: 0, suppressed: 0, users: 0 };
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
    } else {
      report.ok = false;
      prices = await store.latestPrices(symbols);
      idx = await store.latestIndex();
      log(`PSX data unavailable this run: ${snap.errors.slice(0, 3).join(' | ')}`);
    }
    const today = pktDate(now);
    // Only raise market/holding alerts if PSX actually traded today (skips weekends and holidays).
    const tradedToday = usable && !!idx && pktDate(new Date(idx.ts)) === today;
    log(`job=${job} users=${users.length} symbols=${symbols.length} usable=${usable} tradedToday=${tradedToday} newAnnouncements=${newAnns.length}`);

    for (const u of users) {
      try {
        await processUser(u, { job, deps, now, today, prices, idx, usable, tradedToday, newAnns, report });
      } catch (e) {
        report.errors.push(`user ${u.id.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    return report;
  } catch (e) {
    report.ok = false;
    report.errors.push((e as Error).message);
    return report;
  } finally {
    await store.finishRun(runId, report.ok, report.errors.slice(0, 50)).catch((e) => log(`heartbeat finish failed: ${e.message}`));
  }
}

interface Ctx {
  job: JobName; deps: JobDeps; now: Date; today: string; prices: PriceMap; idx: IndexSnapshot | null;
  usable: boolean; tradedToday: boolean; newAnns: Announcement[]; report: RunReport;
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
    cands.push({
      kind: `announcement_${a.kind}`, symbol: a.symbol, urgent: false, url: '/#/news', dedupe_key: `ann:${a.id}`,
      title: `${a.symbol}: ${a.kind.replace('_', ' ')}`, message: `${a.symbol}: ${a.title}`,
    });
  }
  if (c.job === 'morning' && c.idx) cands.unshift(morningBrief(u, view, c));
  if (c.job === 'eod' && c.tradedToday && c.idx) cands.unshift(dailySummary(view, c));
  if (c.job === 'weekly') {
    const w = await weeklyPlan(u, c);
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
// Summaries (template wording)
// ---------------------------------------------------------------------------
function morningBrief(u: UserCtx, view: ReturnType<typeof buildPortfolio>, c: Ctx): AlertCandidate {
  const i = c.idx!;
  const watch: string[] = [];
  const below = view.rows.filter((r) => r.flags.below_cost).map((r) => r.holding.symbol);
  if (below.length) watch.push(`${below.join(', ')} below cost`);
  const over = view.rows.filter((r) => r.flags.over_cap).map((r) => r.holding.symbol);
  if (over.length) watch.push(`${over.join(', ')} over cap`);
  const due = u.holdings.length ? null : 'add your holdings in the app';
  if (due) watch.push(due);
  return {
    kind: 'morning_brief', symbol: null, urgent: false, url: '/#/today', dedupe_key: `morning:${c.today}`,
    title: 'Morning brief',
    message: `Last close: KSE-100 ${fmt0(i.kse100)} (${sign(i.change_pct ?? 0)}${Math.abs(i.change_pct ?? 0).toFixed(1)}%). ` +
      `Portfolio ${'Rs ' + fmt0(view.total_value)}, P/L ${sign(view.total_pnl)}Rs ${fmt0(Math.abs(view.total_pnl))}. ` +
      (watch.length ? `Watch today: ${watch.join('; ')}.` : 'Nothing needs attention today.'),
  };
}

function dailySummary(view: ReturnType<typeof buildPortfolio>, c: Ctx): AlertCandidate {
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
      (movers.length ? `. Biggest moves: ${movers.join(', ')}.` : '.'),
  };
}

/**
 * Weekly plan (Sunday): reviews how past suggestions did, then reminds what is due this week.
 * A new monthly plan is saved only when there is none from the last 25 days, so tranche dates hold.
 */
async function weeklyPlan(u: UserCtx, c: Ctx): Promise<AlertCandidate | null> {
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
    const payload = { source: 'weekly_job', plan, text: planToText(plan) };
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

  let message = lines.join(' ');
  if (c.deps.reword) message = (await c.deps.reword(message).catch(() => null)) ?? message;
  return {
    kind: 'weekly_plan', symbol: null, urgent: false, url: '/#/plan', dedupe_key: `weekly:${isoWeek(c.today)}`,
    title: 'Weekly plan', message,
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

/** Rewords text with Gemini, but only accepts the result if every number survived unchanged. */
export function makeGeminiReword(apiKey: string, model = 'gemini-2.5-flash') {
  return async (text: string): Promise<string | null> => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Rewrite this weekly investing update in 2-3 short, friendly, plain sentences. Keep every number, date and stock symbol exactly as written. Add no advice and no new numbers.\n\n${text}` }] }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const out: string | undefined = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('').trim();
    if (!out) return null;
    const numbers = text.match(/\d[\d,.]*/g) ?? [];
    return numbers.every((n) => out.includes(n.replace(/[.,]$/, ''))) ? out : null;
  };
}
