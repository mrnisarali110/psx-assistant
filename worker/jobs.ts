/**
 * Scheduled jobs.
 *   market: every 30 minutes while PSX trades. Refresh prices; send actionable alerts only (crash, dip,
 *           buy chances below your last buy, AI buy/trim calls, big moves). The last run before the
 *           close is labelled "Before close". AI suggestions refresh every few hours.
 *           Each check also stores your portfolio's value (the 1D chart; 10 days kept).
 *   night:  21:00 PKT. AI reads new filings (summaries, dividends, EPS) and a few older results filings of your stocks
 *           that have no EPS yet, refreshes Discover picks, stores each stock's close for the day, and sends
 *           one night digest: close, your portfolio, news, upcoming dividends, rebalance notes.
 *           Also the Market Compass (value, shares vs safe yield, trend; SBP/PBS/PSX figures) with alerts when its
 *           advice or the trend changes, or the State Bank moves its rate.
 *   test:   send a test crash alert to one account.
 * Every AI step is optional and isolated: if both AI providers fail, prices, rules and alerts still run.
 */
import { randomUUID } from 'node:crypto';
import { dividendLeaders, undervalued, upcomingDividends, type ScreenRow } from '../shared/discover.ts';
import { investedThisMonth } from '../shared/changes.ts';
import { dedupeFilings, tidyTitle } from '../shared/news.ts';
import type { LlmRouter } from '../shared/llm.ts';
import { buildPortfolio, screenSectors, sectorPeMap, type PortfolioView } from '../shared/portfolio.ts';
import { peFor, peMap, type PeFigure } from '../shared/valuation.ts';
import { dividendCut, missingNum, oneOffYield, payoutOf } from '../shared/quality.ts';
import { holdingAlerts, marketAlerts, planDelivery, todayBanner, type AlertCandidate, type AlertLevel } from '../shared/signals.ts';
import { addDays, daysBetween, isMarketOpen, isoWeek, minutesToClose, pktDate } from '../shared/time.ts';
import { DEFAULT_RULES, type Announcement, type DividendEvent, type IndexSnapshot, type PriceDay, type PriceMap, type QuarterEarnings } from '../shared/types.ts';
import { marketBreadth, rateState, type PolicyRate, type RegimeDay } from '../shared/regime.ts';
import { compass, type Compass } from '../shared/compass.ts';
import type { MacroReading } from './macro.ts';
import { annualsFromPage, auditOpinion, reportYear, runBluechip } from './bluechip.ts';
import { discoverPicks, NO_METRICS, pdfText, portfolioInsight, readAnnouncement, type AnnouncementDigest, type GuardContext, type Insight, type InsightFacts, type PickCandidate } from './ai.ts';
import { FetchError, isUsable, toPrice, toScreenRows, type Snapshot } from './feed.ts';
import type { Notifier } from './notify.ts';
import type { Store, UserCtx } from './store.ts';

/** refresh: the owner's "Refresh latest" button: everything the night job gathers, plus fresh AI suggestions and a
 *  blue-chip recheck of your own stocks, right now; it sends no notifications. */
export type JobName = 'market' | 'night' | 'test' | 'refresh';

export interface JobDeps {
  store: Store;
  notifier: Notifier;
  fetchSnapshot: (symbols: string[], opts?: { screener?: boolean }) => Promise<Snapshot>;
  fetchPdf?: (url: string) => Promise<Uint8Array>;
  /** The State Bank's policy rate history and current rate (worker/sbp.ts); nightly. */
  fetchPolicyRates?: () => Promise<{ rates: PolicyRate[]; errors: string[] }>;
  /** SBP T-bills/PIB/reserves/PKR/KIBOR, PBS CPI and PSX's KSE-100 1-year change (worker/macro.ts); nightly. */
  fetchMacro?: () => Promise<{ readings: MacroReading[]; errors: string[] }>;
  ai?: LlmRouter;
  now?: () => Date;
  log?: (m: string) => void;
  testEmail?: string;
  /** Waits between a failed PSX read and the retry (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunReport {
  ok: boolean; errors: string[]; notified: number; suppressed: number; users: number;
  ai: { announcements_read: number; dividends: number; insights: number; picks: number; suggestions_dropped: number; eps_backfill: number };
  skipped?: true; // the same job finished fine minutes ago (a duplicate tick), so nothing was done
}

/** A second start within this many minutes of a successful run is a duplicate tick (Cloudflare's cron and GitHub's late cron). */
export const REPEAT_GUARD_MIN: Partial<Record<JobName, number>> = { market: 20, night: 360, refresh: 5 };

const rules = DEFAULT_RULES;
const fmt0 = (v: number) => Math.round(v).toLocaleString('en-PK');
const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '-' : '');
const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Days of intraday portfolio values kept for the 1D chart (migration 0012). */
const TICKS_KEEP_DAYS = (rules.data as { ticks_keep_days?: number }).ticks_keep_days ?? 10;
/** How old a results filing may be and still count as a company's "latest results" for the AI. */
const RESULTS_FACT_DAYS = (rules.ai as { results_fact_days?: number }).results_fact_days ?? 400;

/** The latest results filing read per company: its date and profit change vs a year earlier (from the News card figures). */
export type ResultsMap = Record<string, { on: string; profit_change_pct: number | null }>;

interface RunCtx {
  job: JobName; deps: JobDeps; now: Date; today: string; prices: PriceMap; idx: IndexSnapshot | null;
  usable: boolean; outage: boolean; tradedToday: boolean; preclose: boolean; news: Announcement[]; dividends: DividendEvent[];
  screen: ScreenRow[]; report: RunReport; aiBudget: { left: number }; earnings: QuarterEarnings[]; bc: Record<string, string>;
  market: MarketNews;
  /** The P/E the app shows for each stock (rulesPe), the sector medians built from it, and the latest results per company. */
  pe: Record<string, PeFigure>; sectorPe: Record<string, number>; results: ResultsMap;
}

/** What changed tonight in the market-wide readings (each sends one alert to everyone). */
interface MarketNews {
  trend: { from: string; to: string; day: string; reasons: string[] } | null;
  action: { key: string; title: string; detail: string; day: string; gap: string | null } | null;
  rate: { from: number; to: number; on: string } | null;
}

export async function runJob(job: JobName, deps: JobDeps): Promise<RunReport> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? console.log;
  const { store } = deps;
  const report: RunReport = { ok: true, errors: [], notified: 0, suppressed: 0, users: 0, ai: { announcements_read: 0, dividends: 0, insights: 0, picks: 0, suggestions_dropped: 0, eps_backfill: 0 } };
  const guard = REPEAT_GUARD_MIN[job];
  const last = await store.lastRun(job).catch(() => null);
  if (guard) {
    const age = last ? now.getTime() - Date.parse(last.started_at) : NaN;
    if (last?.ok && age >= 0 && age < guard * 60_000) {
      log(`job=${job} already ran at ${last.started_at}: duplicate tick, nothing to do`);
      return { ...report, skipped: true };
    }
  }
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
    // A short network blip between GitHub's runners and PSX fails every request at once; one retry a minute later
    // almost always works (seen 2026-10-19..21: the next run was fine each time).
    if (!isUsable(snap)) {
      log(`PSX unreadable on the first try; trying again in ${rules.data.retry_wait_seconds}s`);
      await (deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(rules.data.retry_wait_seconds * 1000);
      snap = await deps.fetchSnapshot(userSymbols);
    }
    let screen = toScreenRows(snap.screener);
    let readSymbols = userSymbols;
    const deep = job === 'night' || job === 'refresh'; // the full data pass
    if (deep && screen.length) {
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
    let previousScreen: ScreenRow[] = [];
    let idx: IndexSnapshot | null;
    if (usable) {
      const fresh = Object.values(snap.quotes).filter((q) => q.price != null).map((q) => toPrice(q, snap.screener[q.symbol]));
      await store.savePrices(fresh);
      const asOf = Object.values(snap.quotes).map((q) => q.as_of).filter(Boolean).sort().at(-1) ?? snap.fetched_at;
      const k = snap.indices.KSE100!;
      idx = { ts: asOf as string, kse100: k.value as number, change: k.change, change_pct: k.change_pct };
      await store.saveIndex(idx);
      // The day's close for the benchmark: every tick overwrites it, so the last run after the close wins.
      if (pktDate(new Date(idx.ts)) === today) await store.saveIndexDay({ day: today, close: idx.kse100 }).catch((e) => report.errors.push(`index day: ${errMsg(e)}`));
      await store.saveNewAnnouncements(Object.values(snap.quotes).flatMap((q) => q.announcements));
      // Symbols that failed this run keep their last good price, never a made-up one.
      prices = { ...(await store.latestPrices(userSymbols)), ...Object.fromEntries(fresh.map((p) => [p.symbol, p])) };
      previousScreen = await store.screenRows().catch(() => [] as ScreenRow[]); // last reading, to detect index changes
      if (screen.length) await store.saveScreen(screen).catch((e) => report.errors.push(`screen: ${errMsg(e)}`));
      // PSX's annual profit table from the company pages fetched anyway (blue-chip profit check).
      await store.saveAnnuals(Object.values(snap.quotes).flatMap((q) => annualsFromPage(q.symbol, q.annual_profits))).catch((e) => report.errors.push(`annuals: ${errMsg(e)}`));
      // Each stock's close for the trading day (stock page chart, sparklines); history builds from now on.
      if (deep) await store.savePriceDays(priceDays(screen, snap.quotes, pktDate(new Date(idx.ts)))).catch((e) => report.errors.push(`price days: ${errMsg(e)}`));
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

    let newFilings = new Set<string>();
    // ---- AI reads filings (summaries + dividends) ---------------------
    if (deps.ai?.available && deps.fetchPdf) {
      newFilings = await readFilings(readSymbols, today, deep ? rules.ai.announcements_per_night_run : rules.ai.announcements_per_market_run, deps, report);
      // Older results filings of your stocks that have no EPS yet: a few a night, inside the night's filing budget.
      const room = Math.min(rules.ai.eps_backfill_per_night, rules.ai.announcements_per_night_run - report.ai.announcements_read);
      if (job === 'night' && room > 0) await backfillEps(userSymbols, today, room, deps, report, log);
    }
    const news = await store.recentAnnouncements(userSymbols, addDays(today, -14)).catch(() => [] as Announcement[]);
    const dividends = await store.dividends(null, addDays(today, -1100)).catch(() => [] as DividendEvent[]);
    const earnings = await store.earnings(userSymbols, addDays(today, -1100)).catch(() => [] as QuarterEarnings[]);
    // One P/E per stock, the one the app shows: the rules, the alerts and the AI all use it (owner decision, A2).
    const pe = rulesPe(screen, prices, earnings, today);
    const sectorPe = sectorPeMap(screen, rules, pe);
    const results = latestResults(await store.resultsFilings([...new Set([...readSymbols, ...screen.map((r) => r.symbol)])], addDays(today, -RESULTS_FACT_DAYS)).catch(() => []));
    if (job === 'market') {
      await store.prunePortfolioTicks(new Date(now.getTime() - TICKS_KEEP_DAYS * 86400000).toISOString()).catch((e) => report.errors.push(`ticks: ${errMsg(e)}`));
    }

    // ---- Discover picks (nightly, market-wide) ------------------------
    if (deep && deps.ai?.available && screen.length) await refreshPicks(screen, deps, report, { today, pe, earnings, dividends, results });

    // ---- Blue-chip recheck (nightly; each company only when due) ------
    if (deep && usable && screen.length) {
      try {
        const bcDivs = await store.dividends(null, addDays(today, -365 * (rules.bluechip.dividend_years_window + 1))).catch(() => dividends);
        const bc = await runBluechip({ today, screen, previousScreen, userSymbols, newFilingSymbols: newFilings, dividends: bcDivs, force: job === 'refresh' ? new Set(userSymbols) : undefined }, { store, fetchSnapshot: deps.fetchSnapshot, log });
        log(`bluechip: checked ${bc.checked}, pages ${bc.pages}`);
      } catch (e) {
        report.errors.push(`bluechip: ${errMsg(e)}`);
      }
    }

    // ---- Market Compass: rates, macro figures, value, trend (nightly) ----
    const market: MarketNews = deep ? await updateMarket({ today, idx, screen, deps, report, log }) : { trend: null, action: null, rate: null };

    const bcMap = Object.fromEntries((await store.bluechipStates().catch(() => [])).map((b) => [b.symbol, b.status]));
    log(`job=${job} users=${users.length} symbols=${userSymbols.length}+${readSymbols.length - userSymbols.length} usable=${usable} tradedToday=${tradedToday} preclose=${preclose} aiRead=${report.ai.announcements_read}`);
    // Tell people only when PSX stays unreadable: this run and the one before failed, while PSX is trading.
    const outage = !usable && last?.ok === false && isMarketOpen(now, rules.market_hours_pkt);
    const ctx: RunCtx = {
      job, deps, now, today, prices, idx, usable, outage, tradedToday, preclose, news, dividends, screen, report, aiBudget: { left: rules.ai.max_users_per_run },
      earnings, bc: bcMap, market, pe, sectorPe, results,
    };
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

/** Reads new filings; returns the companies with a results or dividend filing read (their blue-chip check is due). */
async function readFilings(symbols: string[], today: string, limit: number, deps: JobDeps, report: RunReport): Promise<Set<string>> {
  const read = new Set<string>();
  let toRead: Announcement[] = [];
  try {
    toRead = await deps.store.announcementsToRead(symbols, addDays(today, -rules.ai.announcement_max_age_days), limit);
  } catch (e) {
    report.errors.push(`ai: cannot list announcements (${errMsg(e)})`);
    return read;
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
    // An annual report is long: no AI, just the auditor's opinion from its text (blue-chip red-flag check).
    if (/annual report/i.test(a.title)) {
      const opinion = auditOpinion(await pdfText(pdf));
      if (opinion) await deps.store.saveAudit({ symbol: a.symbol, year: reportYear(a.title, a.published_at), qualified: opinion.qualified, filing_id: a.id }).catch((e) => report.errors.push(`audit: ${errMsg(e)}`));
      await deps.store.saveAnnouncementDigest(a.id, { summary: null, figures: null, verified: null }).catch(() => {});
      read.add(a.symbol);
      continue;
    }
    try {
      const d = await readAnnouncement(deps.ai!, pdf, { symbol: a.symbol, title: a.title, published_at: a.published_at });
      if (a.kind === 'results' || a.kind === 'dividend') read.add(a.symbol);
      await saveResults(a, d, deps, report);
      await deps.store.saveAnnouncementDigest(a.id, { summary: d.summary, figures: d.figures, verified: d.verified, date_note: d.date_note, metrics: d.metrics });
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
  return read;
}

/** A results filing's profit and EPS rows: the quarter's (3 months), and the year's (12 months) when it reports a full year. */
export function filingEarnings(a: Announcement, d: Pick<AnnouncementDigest, 'earnings' | 'annual'>): QuarterEarnings[] {
  const rows: QuarterEarnings[] = [];
  if (d.earnings) rows.push({ id: a.id, symbol: a.symbol, ...d.earnings, pdf_url: a.pdf_url });
  if (d.annual) {
    const y = d.annual;
    // One row per filing id; a filing that also reports its last quarter keeps that row under the plain id.
    rows.push({ id: d.earnings ? `${a.id}:fy` : a.id, symbol: a.symbol, period_end: y.period_end, profit_after_tax: y.profit_after_tax, verified: y.verified, pdf_url: a.pdf_url, eps: y.eps, eps_basis: y.eps_basis, period_months: 12 });
  }
  return rows;
}

/** Store what a results filing says about profit: the year (blue-chip profit check) and the earnings rows with EPS (P/E). */
async function saveResults(a: Announcement, d: AnnouncementDigest, deps: JobDeps, report: RunReport) {
  if (d.annual) {
    await deps.store.saveAnnuals([{ symbol: a.symbol, year: d.annual.year, profit_after_tax: d.annual.profit_after_tax, consolidated: d.annual.consolidated, source: 'filing', filing_id: a.id }])
      .catch((e) => report.errors.push(`annuals: ${errMsg(e)}`));
  }
  for (const e of filingEarnings(a, d)) await deps.store.saveEarnings(e).catch((err) => report.errors.push(`earnings: ${errMsg(err)}`));
}

/** "Financial Results for the Year Ended ..." (not the half year), or an annual/full-year result. */
const FULL_YEAR = /(?<!half[- ])year ended|\bannual\b|full[- ]year/i;

/**
 * Which older results filings to read for EPS (owner review A2): for each company in turn, its latest full-year result
 * and its 3 newest other results, the ones read before EPS was stored (checked, no figures yet), up to `limit` in all.
 * An annual report is long and has no AI read; older filings are not worth one.
 */
export function epsBackfillPlan(filings: (Announcement & { ai_checked_at?: string | null })[], symbols: string[], limit: number): Announcement[] {
  const out: Announcement[] = [];
  for (const sym of symbols) {
    const mine = filings.filter((a) => a.symbol === sym && a.kind === 'results' && a.pdf_url && !/annual report/i.test(a.title))
      .sort((a, b) => b.published_at.localeCompare(a.published_at));
    const year = mine.find((a) => FULL_YEAR.test(a.title));
    const quarters = mine.filter((a) => !FULL_YEAR.test(a.title)).slice(0, 3);
    for (const a of [year, ...quarters]) if (a && a.ai_checked_at && a.ai_metrics == null && out.length < limit) out.push(a);
  }
  return out;
}

/** Reads the planned older results filings for EPS; keeps the summary people already saw. Never throws. */
async function backfillEps(symbols: string[], today: string, limit: number, deps: JobDeps, report: RunReport, log: (m: string) => void) {
  const { store } = deps;
  try {
    const since = addDays(today, -rules.ai.announcement_max_age_days);
    // A company needs older filings until its P/E comes from them (a full year, recent enough): one stored quarter is not.
    const stored = await store.earnings(symbols, since);
    const need = symbols.filter((s) => peFor(s, null, stored.filter((e) => e.symbol === s), null, rules, today).basis === 'psx');
    if (!need.length) return;
    const plan = epsBackfillPlan(await store.resultsFilings(need, since), need, limit);
    for (const a of plan) {
      let pdf: Uint8Array;
      try {
        pdf = await deps.fetchPdf!(a.pdf_url!);
      } catch (e) {
        if (e instanceof FetchError) await store.saveAnnouncementMetrics(a.id, NO_METRICS).catch(() => {}); // gone: do not try again
        report.errors.push(`ai: eps backfill ${a.id} pdf: ${errMsg(e)}`);
        continue;
      }
      try {
        const d = await readAnnouncement(deps.ai!, pdf, { symbol: a.symbol, title: a.title, published_at: a.published_at });
        await saveResults(a, d, deps, report);
        await store.saveAnnouncementMetrics(a.id, d.metrics);
        report.ai.eps_backfill++;
      } catch (e) {
        report.errors.push(`ai: eps backfill ${a.id}: ${errMsg(e)}`);
        if (/AI unavailable/.test(errMsg(e))) break; // both providers down or rate limited: this filing is tried again
        // The filing itself cannot be read: mark it, so it does not take one of the night's few slots every night.
        await store.saveAnnouncementMetrics(a.id, NO_METRICS).catch(() => {});
      }
    }
    if (plan.length) log(`eps backfill: read ${report.ai.eps_backfill} of ${plan.length} older filing(s)`); // no symbols: logs are public
  } catch (e) {
    report.errors.push(`eps backfill: ${errMsg(e)}`);
  }
}

/**
 * One close per stock for the trading day `day`: the KSE-100 screener rows, then the company pages read this run (held,
 * watched, followed), which win. A page whose price is from another day is left out.
 */
export function priceDays(screen: ScreenRow[], quotes: Snapshot['quotes'], day: string): PriceDay[] {
  const out = new Map<string, PriceDay>();
  for (const r of screen) if (!missingNum(r.price)) out.set(r.symbol, { symbol: r.symbol, day, close: r.price as number, change_pct: r.change_pct ?? null });
  for (const q of Object.values(quotes)) {
    if (missingNum(q.price) || (q.as_of && pktDate(new Date(q.as_of)) !== day)) continue;
    out.set(q.symbol, { symbol: q.symbol, day, close: q.price as number, change_pct: q.change_pct ?? null });
  }
  return [...out.values()];
}

/**
 * One P/E per stock, built the way the app builds it (src/components/HoldingActions.tsx): the screen's rows, with live
 * prices winning for the stocks you hold or watch, through valuation.peMap on the stored results filings.
 */
export function rulesPe(screen: ScreenRow[], prices: PriceMap, earnings: QuarterEarnings[], today?: string): Record<string, PeFigure> {
  const rows = new Map(screen.map((r) => [r.symbol, { symbol: r.symbol, price: r.price, pe: r.pe }]));
  for (const p of Object.values(prices)) rows.set(p.symbol, { symbol: p.symbol, price: p.price, pe: p.pe ?? rows.get(p.symbol)?.pe ?? null });
  return peMap([...rows.values()], earnings, rules, today);
}

/** Metrics with no figure at all (NO_METRICS: the PDF is gone, or nothing could be read from it). */
const noFigures = (m: Announcement['ai_metrics']) => !m || Object.values(m).every((v) => v == null);

/**
 * The newest results filing with News card figures per company. A filing with no figures at all (NO_METRICS) is
 * skipped, so a filing whose PDF is gone does not hide an older filing's profit change.
 */
export function latestResults(filings: Announcement[]): ResultsMap {
  const out: ResultsMap = {};
  for (const a of [...filings].sort((x, y) => y.published_at.localeCompare(x.published_at))) {
    if (a.kind !== 'results' || noFigures(a.ai_metrics) || out[a.symbol]) continue;
    out[a.symbol] = { on: a.published_at, profit_change_pct: a.ai_metrics?.profit_change_pct ?? null };
  }
  return out;
}

/**
 * The Market Compass reading, nightly: the State Bank's policy rate (history PDF), SBP/PBS/PSX figures (T-bills, PIB,
 * CPI, reserves, PKR, KSE-100 1-year), then the three lights and the action from the stored KSE-100 closes and PSX's
 * screener; saves one row per trading day. Returns what changed since the last reading. Never throws.
 */
async function updateMarket(o: { today: string; idx: IndexSnapshot | null; screen: ScreenRow[]; deps: JobDeps; report: RunReport; log: (m: string) => void }): Promise<MarketNews> {
  const out: MarketNews = { trend: null, action: null, rate: null };
  const { store } = o.deps;
  try {
    const before = await store.policyRates().catch(() => [] as PolicyRate[]);
    let rates = before;
    if (o.deps.fetchPolicyRates) {
      try {
        const r = await o.deps.fetchPolicyRates();
        o.report.errors.push(...r.errors);
        await store.savePolicyRates(r.rates);
        rates = await store.policyRates();
        const was = rateState(before, o.today), now = rateState(rates, o.today);
        if (was && now && now.decided_on > was.decided_on && now.rate !== was.rate) out.rate = { from: was.rate, to: now.rate, on: now.decided_on };
      } catch (e) {
        o.report.errors.push(`sbp: ${errMsg(e)}`);
      }
    }
    if (o.deps.fetchMacro) {
      try {
        const m = await o.deps.fetchMacro();
        o.report.errors.push(...m.errors);
        await store.saveMacro(m.readings);
      } catch (e) {
        o.report.errors.push(`macro: ${errMsg(e)}`);
      }
    }
    if (!o.idx) return out;
    // The reading belongs to the last trading day (a weekend Refresh latest stores Friday's).
    const mday = pktDate(new Date(o.idx.ts));
    const c = rules.regime;
    const closes = (await store.indexCloses(addDays(mday, -c.lookback_days))).filter((d) => d.day < mday);
    const prev = (await store.regimeDays(addDays(mday, -400))).filter((d) => d.day < mday).at(-1) ?? null;
    const screen = o.screen.length ? o.screen : await store.screenRows().catch(() => [] as ScreenRow[]);
    const macro = await store.macroReadings(addDays(o.today, -800)).catch(() => []);
    const k = compass({ today: o.today, closes, close: o.idx.kse100, breadth: marketBreadth(screen, rules), macro, rates }, rules);
    if (!k.trend.state) return out;
    const day: RegimeDay = {
      day: mday, bull: k.trend.state === 'up', close: o.idx.kse100, ma: k.trend.ma, change_1y_pct: k.trend.one_year_pct, drawdown_pct: k.trend.drawdown_pct,
      earnings_yield_pct: k.value.earnings_yield_pct, policy_rate: k.rates.policy?.rate ?? null, reasons: k.trend.reasons,
      trend: k.trend.state, pe: k.value.pe, dividend_yield_pct: k.value.dividend_yield_pct, value_state: k.value.state, action: k.action.key,
      compass: {
        spread_pct: k.gap.spread_pct, gap: k.gap.state, pib_10y: k.gap.pib_10y?.value ?? null, tbill_3m: k.gap.tbill_3m?.value ?? null,
        cpi: k.rates.cpi?.value ?? null, real_rate_pct: k.rates.real_rate_pct, money_market_pct: k.rates.money_market_pct, title: k.action.title,
        // What the gap compares with (owner decision A7); rows saved before it have none and read "vs 10-year bond".
        gap_basis: k.gap.basis, pib_spread_pct: k.gap.pib_spread_pct,
      },
    };
    await store.saveRegimeDay(day);
    // Older rows (before the compass) only know ON/OFF: ON was "up", OFF compares as "not up".
    const prevTrend = prev?.trend ?? (prev ? (prev.bull ? 'up' : null) : null);
    if (prev && prevTrend && prevTrend !== k.trend.state) out.trend = { from: prevTrend, to: k.trend.state, day: mday, reasons: k.trend.reasons };
    if (prev?.action && prev.action !== k.action.key) out.action = { key: k.action.key, title: k.action.title, detail: k.action.detail, day: mday, gap: gapLine(k) };
    o.log(`market: trend=${k.trend.state} value=${k.value.state ?? 'n/a'} pe=${k.value.pe ?? 'n/a'} gap=${k.gap.spread_pct ?? 'n/a'} action=${k.action.key} rate=${k.rates.policy?.rate ?? 'n/a'} cpi=${k.rates.cpi?.value ?? 'n/a'}${out.trend ? ' (trend changed)' : ''}${out.action ? ' (action changed)' : ''}`);
  } catch (e) {
    o.report.errors.push(`market compass: ${errMsg(e)}`);
  }
  return out;
}

/** "Shares earn 9.1% on their price against about 10.5% in a money-market fund (estimate)." The gap the advice acts on. */
export function gapLine(k: Pick<Compass, 'value' | 'gap' | 'rates'>): string | null {
  const ey = k.value.earnings_yield_pct;
  if (ey == null || k.gap.spread_pct == null) return null;
  const vs = k.gap.basis === 'pib' ? `${k.gap.pib_10y?.value.toFixed(2)}% on the 10-year government bond`
    : `about ${k.rates.money_market_pct}% in a money-market fund (estimate)`;
  return `Shares earn ${ey}% on their price against ${vs}.`;
}

/** What the facts for the AI need besides the price screen. */
interface StockCtx { today: string; dividends: DividendEvent[]; earnings?: QuarterEarnings[]; results?: ResultsMap }

/**
 * Facts about one stock that the price screen does not show (owner review A8, A10), worked out the way every screen
 * does: payout of profit (quality.payoutOf; the P/E shown gives the EPS), a yield that will not repeat, a suspect payout,
 * a dividend cut, and the latest results' profit change vs a year earlier.
 */
export function stockExtras(symbol: string, price: number | null, psxYieldPct: number | null, fig: PeFigure | undefined, c: StockCtx) {
  const oneOff = oneOffYield(symbol, c.dividends, c.today, c.earnings ?? [], rules);
  // The payout the app shows (quality.payoutOf): filings first, then PSX's yield x price, against the P/E's EPS.
  const pay = payoutOf(symbol, c.dividends, c.today, { price, psxYieldPct, eps: fig?.eps ?? null }, rules);
  const cut = dividendCut(symbol, c.dividends);
  const res = c.results?.[symbol];
  return {
    payout_pct: pay.pct, suspect: pay.suspect, one_off: oneOff,
    dividend_cut: cut.cut, dividend_latest_dps: cut.latest, dividend_previous_dps: cut.previous,
    results_profit_change_pct: res?.profit_change_pct ?? null, results_on: res?.on ?? null,
  };
}

/**
 * Discover candidates for the AI: what each card already shows (`on_card`) and what it does not (`more`). Dividend
 * stocks with a suspect payout are left out (owner review A8): the AI may not pick them.
 */
export function pickCandidates(screen: ScreenRow[], x: StockCtx & { pe: Record<string, PeFigure> }): { undervalued: PickCandidate[]; dividend: PickCandidate[] } {
  const more = (symbol: string, price: number | null, yieldPct: number | null) => stockExtras(symbol, price, yieldPct, x.pe[symbol], x);
  const uv = undervalued(screen, { pe: x.pe }).map((r) => ({
    symbol: r.symbol, sector: r.sector,
    on_card: { price: r.price, pe: r.pe, sector_pe: r.sector_pe, pe_discount_pct: r.discount_pct, dividend_yield_pct: r.dividend_yield_pct, change_1y_pct: r.change_1y_pct, shariah: r.is_shariah },
    more: { pe_basis: r.pe_label, ...more(r.symbol, r.price, r.dividend_yield_pct) },
  }));
  const dv = dividendLeaders(screen, x.dividends, x.today, { pe: x.pe, earnings: x.earnings }).filter((d) => !d.suspect).map((d) => ({
    symbol: d.symbol, sector: d.sector,
    on_card: {
      price: d.price, pe: d.pe, dividend_yield_pct: d.dividend_yield_pct, annual_dividend_per_share: d.annual_dps,
      last_declared_dps: d.last?.dps ?? null, frequency_from_filings: d.frequency, shariah: d.is_shariah,
    },
    more: {
      ...more(d.symbol, d.price, d.psx_yield_pct), payout_pct: d.payout_pct, suspect: d.suspect, one_off: d.one_off,
      special_dps: d.special?.dps ?? null, last_declared_on: d.last?.announced_on ?? null,
    },
  }));
  return { undervalued: uv, dividend: dv };
}

async function refreshPicks(screen: ScreenRow[], deps: JobDeps, report: RunReport, x: StockCtx & { pe: Record<string, PeFigure> }) {
  const c = pickCandidates(screen, x);
  for (const [kind, facts] of [['undervalued', c.undervalued], ['dividend', c.dividend]] as const) {
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
  const view = buildPortfolio(u.holdings, c.prices, u.settings, rules, screenSectors(c.screen), { today: c.today, sectorPe: c.sectorPe, dividends: c.dividends, earnings: c.earnings, pe: c.pe });
  const mine = new Set([...u.holdings.map((h) => h.symbol), ...u.watchlist.map((w) => w.symbol)]);
  const night = c.job === 'night';
  const refresh = c.job === 'refresh';
  const cands: AlertCandidate[] = [];

  // ---- AI second opinion: every few hours in market, always before close and at night ----
  let insight: Insight | null = null;
  if (c.deps.ai?.available && u.settings.ai_enabled && c.idx && c.aiBudget.left > 0 && (night || refresh || c.tradedToday)) {
    const last = await store.latestInsightAt(u.id).catch(() => null);
    const due = night || refresh || c.preclose || !last || c.now.getTime() - Date.parse(last) >= rules.ai.insight_every_minutes * 60000;
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

  if (c.outage) {
    cands.push({
      kind: 'data_unavailable', symbol: null, level: 'market', url: '/#/home', dedupe_key: `nodata:${c.today}`,
      title: 'PSX data unavailable', message: "Couldn't read PSX prices for the last two checks. Check live prices in your broker app; the app shows the last good data.",
    });
  }
  if (c.tradedToday && !night) {
    cands.push(...marketAlerts(c.idx, u.settings, c.today), ...holdingAlerts(view, u.settings, c.today, insight, lastSent));
  }
  // At night only the digest goes out; buying chances wait for the next market check.
  if (night) cands.push(...holdingAlerts(view, u.settings, c.today, insight, lastSent).filter((a) => a.level === 'digest'));
  if (night) cands.push(...nightItems(view, mine, c, insight));
  if (night) cands.push(...marketItems(c));
  // One value per trading day, so Performance and Home can draw your money (and against the KSE-100) from now on.
  // Refresh latest writes it too, for the last trading day (a weekend refresh stores Friday's).
  const day = night ? (c.tradedToday ? c.today : null) : refresh && c.usable && c.idx ? pktDate(new Date(c.idx.ts)) : null;
  if (day && view.rows.length) {
    await store.savePortfolioDay(u.id, { day, value: r2(view.total_value) as number, invested: r2(view.total_cost) as number })
      .catch((e) => c.report.errors.push(`portfolio day: ${errMsg(e)}`));
  }
  // Your portfolio's value at this check (Home's 1D chart).
  if (c.job === 'market' && c.tradedToday && c.idx && view.rows.length && view.total_value > 0) {
    await store.savePortfolioTick(u.id, { ts: c.idx.ts, value: r2(view.total_value) as number }).catch((e) => c.report.errors.push(`portfolio tick: ${errMsg(e)}`));
  }

  if (refresh) return; // a manual refresh updates the data and suggestions; it never pushes alerts
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

/** The Market Compass changed its advice, the trend turned, or the State Bank moved its rate: one line each, night digest. */
function marketItems(c: RunCtx): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const { trend, action, rate } = c.market;
  const item = (kind: string, key: string, title: string, message: string): AlertCandidate => ({ kind, symbol: null, level: 'digest', url: '/#/market', dedupe_key: key, title, message });
  if (action) {
    out.push(item('market_compass', `compass:${action.key}:${action.day}`, `Market Compass: ${action.title}`,
      `${action.title}. ${action.detail}${action.gap ? ` ${action.gap}` : ''} A rule of thumb, not advice.`));
  }
  if (trend) {
    const word = (t: string) => (t === 'up' ? 'up' : t === 'down' ? 'down' : 'sideways');
    out.push(item('market_trend', `trend:${trend.to}:${trend.day}`, `KSE-100 trend now ${word(trend.to)}`,
      `KSE-100 trend turned ${word(trend.to)} (was ${word(trend.from)}): ${trend.reasons.slice(0, 2).join('; ')}. Your monthly investment stays on.`));
  }
  if (rate) {
    const verb = rate.to < rate.from ? 'cut' : 'raised';
    out.push(item('policy_rate', `rate:${rate.on}`, `State Bank ${verb} the policy rate to ${rate.to}%`,
      `State Bank ${verb} the policy rate from ${rate.from}% to ${rate.to}% (decision of ${rate.on}). Savings and money-market returns follow it.`));
  }
  return out;
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
  c: Pick<RunCtx, 'today' | 'idx' | 'prices' | 'screen' | 'news' | 'dividends' | 'now'> & { bc?: Record<string, string> } & Partial<Pick<RunCtx, 'pe' | 'earnings' | 'results'>>,
  investedPkr: number) {
  const s = u.settings;
  const banner = todayBanner(c.idx, s);
  const metrics = (sym: string) => {
    const p = c.prices[sym];
    // The P/E the app shows (filings first), so the AI never quotes a second figure for the same stock (owner review A2).
    const fig = c.pe?.[sym] ?? peFor(sym, p?.price ?? null, (c.earnings ?? []).filter((e) => e.symbol === sym), p?.pe ?? null, rules, c.today);
    return {
      price: r2(p?.price), day_change_pct: r2(p?.change_pct), high_52w: r2(p?.high_52w), low_52w: r2(p?.low_52w),
      below_52w_high_pct: p?.price && p?.high_52w ? r1(((p.high_52w - p.price) / p.high_52w) * 100) : null,
      dividend_yield_pct: r2(p?.dividend_yield_pct), pe: fig.pe, pe_basis: fig.label, pe_unusual: fig.outlier, loss_making: fig.loss,
      sector: p?.sector ?? null, is_shariah: p?.is_shariah ?? null, blue_chip: c.bc?.[sym] ?? 'not_checked',
      ...stockExtras(sym, p?.price ?? null, p?.dividend_yield_pct ?? null, fig, c),
    };
  };
  const candidates = undervalued(c.screen, { shariahOnly: s.shariah_only, exclude: mine, pe: c.pe }).slice(0, 5);
  const facts: InsightFacts = {
    date: c.today,
    market: { kse100: r2(c.idx?.kse100), change_pct: r2(c.idx?.change_pct), rules_say: banner.action, rules_reason: banner.reason, crash_level: s.crash_trigger_kse, market_open: isMarketOpen(c.now, rules.market_hours_pkt) },
    rules: { max_position_pct: s.max_position_pct, opportunity_below_last_buy_pct: s.drop_alert_pct, shariah_only: s.shariah_only, crash_fund_pkr: s.crash_fund_pkr },
    money: { monthly_budget_pkr: s.monthly_budget_pkr, invested_this_month_pkr: Math.round(investedPkr), cash_left_this_month_pkr: Math.max(0, Math.round(s.monthly_budget_pkr - investedPkr)) },
    portfolio: {
      total_value_pkr: Math.round(view.total_value), pnl_since_bought_pct: r1(view.total_pnl_pct),
      day_change_pct: view.day_change != null && view.total_value > view.day_change ? r1((view.day_change / (view.total_value - view.day_change)) * 100) : null,
      sectors: view.sector_weights.map((w) => ({ sector: w.sector, pct: r1(w.pct)! })), rebalance_flags: view.rebalance.map((t) => t.text),
    },
    holdings: view.rows.map((r) => ({
      symbol: r.holding.symbol, status: r.holding.status, shares: r.holding.shares, avg_cost: r.holding.avg_cost,
      last_buy_price: r2(r.ref_price), vs_last_buy_pct: r1(r.vs_ref_pct), value_pkr: r.value == null ? null : Math.round(r.value),
      pnl_pct: r1(r.pnl_pct), weight_pct: r1(r.weight_pct), rules_call: r.call.call, ...metrics(r.holding.symbol), is_shariah: r.holding.is_shariah, note: r.holding.note ?? null,
    })),
    watchlist: u.watchlist.map((w) => ({ symbol: w.symbol, ...metrics(w.symbol) })),
    screen_candidates: candidates.map((o) => ({ symbol: o.symbol, sector: o.sector, price: o.price, pe: o.pe, sector_pe: o.sector_pe, dividend_yield_pct: o.dividend_yield_pct, is_shariah: o.is_shariah, blue_chip: c.bc?.[o.symbol] ?? 'not_checked' })),
    upcoming_dividends: upcomingDividends(c.dividends.filter((d) => mine.has(d.symbol)), c.today).slice(0, 5).map((d) => ({ symbol: d.symbol, dps: d.dps, buy_by: d.buy_by, book_closure_from: d.book_closure_from })),
    recent_news: dedupeFilings(c.news.filter((a) => mine.has(a.symbol) && a.ai_summary)).slice(0, 8).map((a) => ({ symbol: a.symbol, date: a.published_at, summary: a.ai_summary as string })),
  };
  const guard: GuardContext = {
    holdings: view.rows.map((r) => ({ symbol: r.holding.symbol, status: r.holding.status, weight_pct: r.weight_pct, is_shariah: r.holding.is_shariah, rules_call: r.call.call })),
    universe: new Set([...mine, ...candidates.map((o) => o.symbol)]),
    shariahOf: (sym) => u.holdings.find((h) => h.symbol === sym)?.is_shariah ?? c.prices[sym]?.is_shariah ?? candidates.find((o) => o.symbol === sym)?.is_shariah ?? null,
    maxPositionPct: s.max_position_pct,
    shariahOnly: s.shariah_only,
    rulesSay: banner.action,
    blueChipOf: (sym: string) => c.bc?.[sym] ?? 'not_checked',
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
