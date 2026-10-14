/**
 * Scheduled jobs.
 *   market: every 30 minutes while PSX trades. Refresh prices; send actionable alerts only (crash, dip,
 *           buy chances below your last buy, AI buy/trim calls, big moves). The last run before the
 *           close is labelled "Before close". AI suggestions refresh every few hours.
 *   night:  21:00 PKT. AI reads new filings (summaries + dividends), refreshes Discover picks, and sends
 *           one night digest: close, your portfolio, news, upcoming dividends, rebalance notes.
 *   test:   send a test crash alert to one account.
 * Every AI step is optional and isolated: if both AI providers fail, prices, rules and alerts still run.
 */
import { randomUUID } from 'node:crypto';
import { dividendLeaders, undervalued, upcomingDividends, type ScreenRow } from '../shared/discover.ts';
import { investedThisMonth } from '../shared/changes.ts';
import { dedupeFilings, tidyTitle } from '../shared/news.ts';
import type { LlmRouter } from '../shared/llm.ts';
import { buildPortfolio, screenSectors, type PortfolioView } from '../shared/portfolio.ts';
import { holdingAlerts, marketAlerts, planDelivery, todayBanner, type AlertCandidate, type AlertLevel } from '../shared/signals.ts';
import { addDays, daysBetween, isMarketOpen, isoWeek, minutesToClose, pktDate } from '../shared/time.ts';
import { DEFAULT_RULES, type Announcement, type DividendEvent, type IndexSnapshot, type PriceMap } from '../shared/types.ts';
import { discoverPicks, portfolioInsight, readAnnouncement, type GuardContext, type Insight, type InsightFacts } from './ai.ts';
import { FetchError, isUsable, toPrice, toScreenRows, type Snapshot } from './feed.ts';
import type { Notifier } from './notify.ts';
import type { Store, UserCtx } from './store.ts';

export type JobName = 'market' | 'night' | 'test';

export interface JobDeps {
  store: Store;
  notifier: Notifier;
  fetchSnapshot: (symbols: string[], opts?: { screener?: boolean }) => Promise<Snapshot>;
  fetchPdf?: (url: string) => Promise<Uint8Array>;
  ai?: LlmRouter;
  now?: () => Date;
  log?: (m: string) => void;
  testEmail?: string;
}

export interface RunReport {
  ok: boolean; errors: string[]; notified: number; suppressed: number; users: number;
  ai: { announcements_read: number; dividends: number; insights: number; picks: number; suggestions_dropped: number };
}

const rules = DEFAULT_RULES;
const fmt0 = (v: number) => Math.round(v).toLocaleString('en-PK');
const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '-' : '');
const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface RunCtx {
  job: JobName; deps: JobDeps; now: Date; today: string; prices: PriceMap; idx: IndexSnapshot | null;
  usable: boolean; tradedToday: boolean; preclose: boolean; news: Announcement[]; dividends: DividendEvent[];
  screen: ScreenRow[]; report: RunReport; aiBudget: { left: number };
}

export async function runJob(job: JobName, deps: JobDeps): Promise<RunReport> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? console.log;
  const { store } = deps;
  const report: RunReport = { ok: true, errors: [], notified: 0, suppressed: 0, users: 0, ai: { announcements_read: 0, dividends: 0, insights: 0, picks: 0, suggestions_dropped: 0 } };
  const runId = await store.startRun(job);
  try {
    const users = await store.loadUsers();
    report.users = users.length;
    if (job === 'test') {
      await sendTest(users, deps, now, report);
      return report;
    }
    const today = pktDate(now);
    const userSymbols = [...new Set(users.flatMap((u) => [...u.holdings.map((h) => h.symbol), ...u.watchlist.map((w) => w.symbol)]))];

    // ---- refresh market data once for everyone ----------------------
    let snap = await deps.fetchSnapshot(userSymbols);
    let screen = toScreenRows(snap.screener);
    let readSymbols = userSymbols;
    if (job === 'night' && screen.length) {
      // Also follow the top dividend payers, so Discover's dividend data fills up over time.
      const extra = dividendLeaders(screen, [], today).map((d) => d.symbol).filter((s) => !userSymbols.includes(s));
      if (extra.length) {
        const more = await deps.fetchSnapshot(extra, { screener: false });
        snap = { ...snap, quotes: { ...snap.quotes, ...more.quotes }, errors: [...snap.errors, ...more.errors] };
        readSymbols = [...userSymbols, ...extra];
      }
    }
    report.errors.push(...publicErrors(snap.errors, [...userSymbols, ...readSymbols]));
    const usable = isUsable(snap);
    let prices: PriceMap;
    let idx: IndexSnapshot | null;
    if (usable) {
      const fresh = Object.values(snap.quotes).filter((q) => q.price != null).map((q) => toPrice(q, snap.screener[q.symbol]));
      await store.savePrices(fresh);
      const asOf = Object.values(snap.quotes).map((q) => q.as_of).filter(Boolean).sort().at(-1) ?? snap.fetched_at;
      const k = snap.indices.KSE100!;
      idx = { ts: asOf as string, kse100: k.value as number, change: k.change, change_pct: k.change_pct };
      await store.saveIndex(idx);
      await store.saveNewAnnouncements(Object.values(snap.quotes).flatMap((q) => q.announcements));
      // Symbols that failed this run keep their last good price, never a made-up one.
      prices = { ...(await store.latestPrices(userSymbols)), ...Object.fromEntries(fresh.map((p) => [p.symbol, p])) };
      if (screen.length) await store.saveScreen(screen).catch((e) => report.errors.push(`screen: ${errMsg(e)}`));
    } else {
      report.ok = false;
      prices = await store.latestPrices(userSymbols);
      idx = await store.latestIndex();
      screen = [];
      log(`PSX data unavailable this run: ${snap.errors.slice(0, 3).join(' | ')}`);
    }
    // File holdings that still have no sector under PSX's own (price row, else the market screen): nobody is asked.
    const sectorMap = screenSectors(screen);
    const fills = users.flatMap((u) => u.holdings.filter((h) => !h.sector && h.id)
      .map((h) => ({ id: h.id as string, sector: prices[h.symbol]?.sector ?? sectorMap[h.symbol] ?? null }))
      .filter((f): f is { id: string; sector: string } => !!f.sector));
    if (fills.length) {
      await store.saveHoldingSectors(fills).catch((e) => report.errors.push(`sectors: ${errMsg(e)}`));
      for (const u of users) for (const h of u.holdings) { const f = fills.find((x) => x.id === h.id); if (f) h.sector = f.sector; }
    }
    const tradedToday = usable && !!idx && pktDate(new Date(idx.ts)) === today;
    const toClose = minutesToClose(now, rules.market_hours_pkt);
    const preclose = job === 'market' && tradedToday && toClose != null && toClose <= 40;

    // ---- AI reads filings (summaries + dividends) ---------------------
    if (deps.ai?.available && deps.fetchPdf) {
      await readFilings(readSymbols, today, job === 'night' ? rules.ai.announcements_per_night_run : rules.ai.announcements_per_market_run, deps, report);
    }
    const news = await store.recentAnnouncements(userSymbols, addDays(today, -14)).catch(() => [] as Announcement[]);
    const dividends = await store.dividends(null, addDays(today, -400)).catch(() => [] as DividendEvent[]);

    // ---- Discover picks (nightly, market-wide) ------------------------
    if (job === 'night' && deps.ai?.available && screen.length) await refreshPicks(screen, dividends, today, deps, report);

    log(`job=${job} users=${users.length} symbols=${userSymbols.length}+${readSymbols.length - userSymbols.length} usable=${usable} tradedToday=${tradedToday} preclose=${preclose} aiRead=${report.ai.announcements_read}`);
    const ctx: RunCtx = { job, deps, now, today, prices, idx, usable, tradedToday, preclose, news, dividends, screen, report, aiBudget: { left: rules.ai.max_users_per_run } };
    for (const u of users) {
      try {
        await processUser(u, ctx);
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

/** Feed errors without stock symbols (the repo and its run logs are public): per-stock failures become a count. */
export function publicErrors(errors: string[], symbols: string[]): string[] {
  const set = new Set(symbols);
  const perStock = errors.filter((e) => set.has(e.split(':')[0]));
  const rest = errors.filter((e) => !set.has(e.split(':')[0]));
  const reasons = [...new Set(perStock.map((e) => /HTTP \d+|no price|timeout|fetch failed/i.exec(e)?.[0] ?? 'error'))];
  return perStock.length ? [...rest, `${perStock.length} company page(s) failed (${reasons.join(', ')})`] : rest;
}

async function readFilings(symbols: string[], today: string, limit: number, deps: JobDeps, report: RunReport) {
  let toRead: Announcement[] = [];
  try {
    toRead = await deps.store.announcementsToRead(symbols, addDays(today, -rules.ai.announcement_max_age_days), limit);
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
      report.errors.push(`ai: filing ${a.id} pdf: ${errMsg(e)}`);
      continue;
    }
    try {
      const d = await readAnnouncement(deps.ai!, pdf, { symbol: a.symbol, title: a.title });
      await deps.store.saveAnnouncementDigest(a.id, { summary: d.summary, figures: d.figures, verified: d.verified });
      report.ai.announcements_read++;
      if (d.dividend) {
        await deps.store.saveDividend({
          id: a.id, symbol: a.symbol, announced_on: a.published_at, dps: d.dividend.dps, dividend_type: d.dividend.type,
          book_closure_from: d.dividend.book_closure_from, book_closure_to: d.dividend.book_closure_to, verified: d.dividend.verified, pdf_url: a.pdf_url,
        });
        report.ai.dividends++;
      }
    } catch (e) {
      report.errors.push(`ai: filing ${a.id}: ${errMsg(e)}`);
      if (/AI unavailable/.test(errMsg(e))) break; // both providers down or rate limited: try next run
    }
  }
}

async function refreshPicks(screen: ScreenRow[], dividends: DividendEvent[], today: string, deps: JobDeps, report: RunReport) {
  const uv = undervalued(screen).map((r) => ({ symbol: r.symbol, sector: r.sector, price: r.price, pe: r.pe, sector_pe: r.sector_pe, pe_discount_pct: r.discount_pct, dividend_yield_pct: r.dividend_yield_pct, change_1y_pct: r.change_1y_pct, shariah: r.is_shariah }));
  const dv = dividendLeaders(screen, dividends, today).map((d) => ({
    symbol: d.symbol, sector: d.sector, price: d.price, dividend_yield_pct: d.dividend_yield_pct, annual_dividend_per_share: d.annual_dps,
    last_declared_dps: d.last?.dps ?? null, last_declared_on: d.last?.announced_on ?? null, frequency_from_filings: d.frequency, shariah: d.is_shariah,
  }));
  for (const [kind, facts] of [['undervalued', uv], ['dividend', dv]] as const) {
    if (!facts.length) continue;
    try {
      const r = await discoverPicks(deps.ai!, kind, facts);
      if (r.items.length) { await deps.store.savePicks(kind, r.items, r.model); report.ai.picks++; }
    } catch (e) {
      report.errors.push(`ai: picks ${kind}: ${errMsg(e)}`);
    }
  }
}

async function processUser(u: UserCtx, c: RunCtx) {
  const { store, notifier } = c.deps;
  const recent = await store.recentAlerts(u.id, new Date(c.now.getTime() - 10 * 86400000).toISOString());
  const sentKeys = new Set(recent.map((r) => r.dedupe_key));
  const lastSent = (kind: string, symbol: string) =>
    recent.filter((r) => r.kind === kind && r.symbol === symbol && r.channel && r.channel !== 'none')
      .map((r) => pktDate(new Date(r.sent_at))).sort().at(-1) ?? null;
  const view = buildPortfolio(u.holdings, c.prices, u.settings, rules, screenSectors(c.screen));
  const mine = new Set([...u.holdings.map((h) => h.symbol), ...u.watchlist.map((w) => w.symbol)]);
  const night = c.job === 'night';
  const cands: AlertCandidate[] = [];

  // ---- AI second opinion: every few hours in market, always before close and at night ----
  let insight: Insight | null = null;
  if (c.deps.ai?.available && u.settings.ai_enabled && c.idx && c.aiBudget.left > 0 && (night || c.tradedToday)) {
    const last = await store.latestInsightAt(u.id).catch(() => null);
    const due = night || c.preclose || !last || c.now.getTime() - Date.parse(last) >= rules.ai.insight_every_minutes * 60000;
    if (due) {
      c.aiBudget.left--;
      try {
        insight = await makeInsight(u, view, mine, c);
        for (const s of insight.suggestions) {
          if (s.confidence !== 'high' || !['buy', 'add', 'trim', 'sell'].includes(s.action)) continue;
          cands.push({
            kind: 'ai_suggestion', symbol: s.symbol, level: night ? 'digest' : 'market', url: '/#/home',
            dedupe_key: `ai:${s.action}:${s.symbol ?? '-'}:${isoWeek(c.today)}`,
            title: `AI Assistant: ${s.action} ${s.symbol ?? ''}`.trim(), message: `AI Assistant suggests: ${s.text} (${s.why})`,
          });
        }
      } catch (e) {
        c.report.errors.push(`ai insight ${u.id.slice(0, 8)}: ${errMsg(e)}`);
      }
    }
  }

  if (!c.usable) {
    cands.push({
      kind: 'data_unavailable', symbol: null, level: 'market', url: '/#/home', dedupe_key: `nodata:${c.today}`,
      title: 'PSX data unavailable', message: "Couldn't read PSX prices. Check live prices in your broker app; the app shows the last good data.",
    });
  }
  if (c.tradedToday && !night) {
    cands.push(...marketAlerts(c.idx, u.settings, c.today), ...holdingAlerts(view, u.settings, c.today, insight, lastSent));
  }
  // At night only the digest goes out; buying chances wait for the next market check.
  if (night) cands.push(...holdingAlerts(view, u.settings, c.today, insight, lastSent).filter((a) => a.level === 'digest'));
  if (night) cands.push(...nightItems(view, mine, c, insight));

  const fresh = cands.filter((x, i) => !sentKeys.has(x.dedupe_key) && cands.findIndex((y) => y.dedupe_key === x.dedupe_key) === i);
  const todays = recent.filter((r) => pktDate(new Date(r.sent_at)) === c.today && r.batch_id && r.channel !== 'none');
  const digestBatches = new Set(todays.filter((r) => r.kind === 'night_digest').map((r) => r.batch_id));
  const sentToday = new Set(todays.filter((r) => !digestBatches.has(r.batch_id)).map((r) => r.batch_id)).size;
  const plan = planDelivery(fresh, {
    now: c.now, sentToday, quiet: u.settings.quiet_hours, enabled: u.settings.notifications_enabled,
    digestRun: night, titlePrefix: c.preclose ? 'Before close: ' : '',
  });

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

/** The night digest and what goes with it: news, upcoming dividends, rebalance (via holdingAlerts). */
function nightItems(view: PortfolioView, mine: Set<string>, c: RunCtx, insight: Insight | null): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const digest = (kind: string, symbol: string | null, key: string, title: string, message: string, url = '/#/news'): AlertCandidate =>
    ({ kind, symbol, level: 'digest' as AlertLevel, url, dedupe_key: key, title, message });

  const filings = c.news.filter((a) => mine.has(a.symbol) && a.kind !== 'other' && daysBetween(a.published_at, c.today) <= 3);
  for (const a of dedupeFilings(filings)) {
    out.push(digest(`announcement_${a.kind}`, a.symbol, `ann:${a.id}`, `${a.symbol}: ${a.kind.replace('_', ' ')}`, `${a.symbol}: ${a.ai_summary ?? tidyTitle(a.title, a.symbol)}`));
  }
  for (const d of upcomingDividends(c.dividends.filter((x) => mine.has(x.symbol)), c.today).filter((d) => d.days_left <= 10)) {
    out.push(digest('dividend_upcoming', d.symbol, `div:${d.id}`, `${d.symbol} dividend`,
      `${d.symbol}${d.dps != null ? ` Rs ${d.dps}/share` : ''} dividend: buy by ${d.buy_by} (book closure ${d.book_closure_from}).`, '/#/discover'));
  }
  if (c.idx && c.tradedToday) {
    const i = c.idx;
    const day = view.day_change;
    out.unshift(digest('night_digest', null, `night:${c.today}`, `Tonight: KSE-100 ${sign(i.change_pct ?? 0)}${Math.abs(i.change_pct ?? 0).toFixed(1)}%`,
      `KSE-100 closed at ${fmt0(i.kse100)}. Your portfolio Rs ${fmt0(view.total_value)}` +
      (day != null ? `, today ${sign(day)}Rs ${fmt0(Math.abs(day))}` : '') +
      `, total ${sign(view.total_pnl)}Rs ${fmt0(Math.abs(view.total_pnl))}.` + (insight ? ` AI: ${insight.headline}` : ''), '/#/home'));
  } else if (out.length) {
    out.unshift(digest('night_digest', null, `night:${c.today}`, 'Tonight', `${out.length} update${out.length > 1 ? 's' : ''} on your stocks.`, '/#/news'));
  }
  return out;
}


// ---------------------------------------------------------------------------
// AI facts: everything the model may use, rounded the way it will be quoted
// ---------------------------------------------------------------------------
export function buildFacts(u: UserCtx, view: PortfolioView, mine: Set<string>,
  c: Pick<RunCtx, 'today' | 'idx' | 'prices' | 'screen' | 'news' | 'dividends' | 'now'>, investedPkr: number) {
  const s = u.settings;
  const banner = todayBanner(c.idx, s);
  const metrics = (sym: string) => {
    const p = c.prices[sym];
    return {
      price: r2(p?.price), day_change_pct: r2(p?.change_pct), high_52w: r2(p?.high_52w), low_52w: r2(p?.low_52w),
      below_52w_high_pct: p?.price && p?.high_52w ? r1(((p.high_52w - p.price) / p.high_52w) * 100) : null,
      dividend_yield_pct: r2(p?.dividend_yield_pct), pe: r2(p?.pe), sector: p?.sector ?? null, is_shariah: p?.is_shariah ?? null,
    };
  };
  const candidates = undervalued(c.screen, { shariahOnly: s.shariah_only, exclude: mine }).slice(0, 5);
  const facts: InsightFacts = {
    date: c.today,
    market: { kse100: r2(c.idx?.kse100), change_pct: r2(c.idx?.change_pct), rules_say: banner.action, rules_reason: banner.reason, crash_level: s.crash_trigger_kse, market_open: isMarketOpen(c.now, rules.market_hours_pkt) },
    rules: { max_position_pct: s.max_position_pct, opportunity_below_last_buy_pct: s.drop_alert_pct, shariah_only: s.shariah_only, crash_fund_pkr: s.crash_fund_pkr },
    money: { monthly_budget_pkr: s.monthly_budget_pkr, invested_this_month_pkr: Math.round(investedPkr), cash_left_this_month_pkr: Math.max(0, Math.round(s.monthly_budget_pkr - investedPkr)) },
    portfolio: {
      total_value_pkr: Math.round(view.total_value), total_pnl_pct: r1(view.total_pnl_pct),
      sectors: view.sector_weights.map((w) => ({ sector: w.sector, pct: r1(w.pct)! })), rebalance_flags: view.rebalance.map((t) => t.text),
    },
    holdings: view.rows.map((r) => ({
      symbol: r.holding.symbol, status: r.holding.status, shares: r.holding.shares, avg_cost: r.holding.avg_cost,
      last_buy_price: r2(r.ref_price), vs_last_buy_pct: r1(r.vs_ref_pct), value_pkr: r.value == null ? null : Math.round(r.value),
      pnl_pct: r1(r.pnl_pct), weight_pct: r1(r.weight_pct), rules_call: r.call.call, ...metrics(r.holding.symbol), is_shariah: r.holding.is_shariah, note: r.holding.note ?? null,
    })),
    watchlist: u.watchlist.map((w) => ({ symbol: w.symbol, ...metrics(w.symbol) })),
    screen_candidates: candidates.map((o) => ({ symbol: o.symbol, sector: o.sector, price: o.price, pe: o.pe, sector_pe: o.sector_pe, dividend_yield_pct: o.dividend_yield_pct, is_shariah: o.is_shariah })),
    upcoming_dividends: upcomingDividends(c.dividends.filter((d) => mine.has(d.symbol)), c.today).slice(0, 5).map((d) => ({ symbol: d.symbol, dps: d.dps, buy_by: d.buy_by, book_closure_from: d.book_closure_from })),
    recent_news: dedupeFilings(c.news.filter((a) => mine.has(a.symbol) && a.ai_summary)).slice(0, 8).map((a) => ({ symbol: a.symbol, date: a.published_at, summary: a.ai_summary as string })),
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

async function makeInsight(u: UserCtx, view: PortfolioView, mine: Set<string>, c: RunCtx): Promise<Insight> {
  const txns = await c.deps.store.transactionsSince(u.id, `${c.today.slice(0, 7)}-01`).catch(() => []);
  const { facts, guard } = buildFacts(u, view, mine, c, investedThisMonth(txns, c.today));
  const res = await portfolioInsight(c.deps.ai!, facts, guard);
  await c.deps.store.saveInsight(u.id, {
    job: c.job, headline: res.insight.headline, stance: res.insight.stance, suggestions: res.insight.suggestions,
    holding_calls: res.insight.holding_calls, rebalance: res.insight.rebalance, cash_note: res.insight.cash_note,
    risks: res.insight.risks, model: res.model, dropped: res.dropped,
  }).catch((e) => c.report.errors.push(`ai: save insight: ${errMsg(e)}`));
  c.report.ai.insights++;
  c.report.ai.suggestions_dropped += res.dropped;
  if (res.reasons.length) c.deps.log?.(`ai guardrails dropped ${res.reasons.length} item(s)`); // no symbols: logs are public
  return res.insight;
}

async function sendTest(users: UserCtx[], deps: JobDeps, now: Date, report: RunReport) {
  if (!deps.testEmail) throw new Error('job=test needs an email (workflow input "email")');
  const id = await deps.store.findUserByEmail(deps.testEmail);
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error(`no account with email ${deps.testEmail}`);
  if (!u.subs.length && !u.telegram_chat_id) {
    report.errors.push('that account has no push subscription and no Telegram link yet: enable notifications in Settings first');
  }
  const alert: AlertCandidate = { kind: 'test', symbol: null, title: 'Test', message: 'Test alert', dedupe_key: `test:${now.toISOString()}`, level: 'urgent', url: '/#/home' };
  const n = {
    title: 'Test: crash alert', urgent: true, url: '/#/home', alerts: [alert],
    body: 'This is a test. A real crash alert looks like this: KSE-100 down 4%+, consider using part of your crash fund.',
  };
  const channel = await deps.notifier.send(u, n);
  await deps.store.logAlerts(u.id, [{ kind: 'test', symbol: null, message: n.body, dedupe_key: alert.dedupe_key, channel, sent_at: now.toISOString(), batch_id: null }]);
  if (channel === 'none') report.errors.push('test alert reached no channel');
  else report.notified++;
  report.ok = channel !== 'none';
}
