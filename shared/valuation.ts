/**
 * One P/E per stock, the same on every screen and in every rule (owner review 2026-10-23, A2 and A9).
 *
 * The P/E is price over a full year of earnings per share from the company's own filings when we have them:
 * consolidated first, then unconsolidated, then a filing whose basis is not stated. "Full year" is the sum of the last
 * four single-quarter EPS when all four are stored and newer than the latest annual figure, else the latest 12-month
 * EPS (half-year and nine-month figures are cumulative and never count as a year). Without filings it is PSX's
 * screener P/E, labelled "basis not stated". A basis whose newest full-year figure is older than
 * rules.valuation.eps_max_age_months gives way to the next one (an old year is not this year's earnings). A loss
 * (EPS at or below zero, or PSX's negative P/E) has no P/E.
 *
 * Sector P/E is the median of the sector's trusted P/Es (not missing, not an outlier), only when there are
 * `sector_min_peers` of them and they are not too spread out (interquartile range at most `sector_max_iqr_ratio` x
 * the median). Pure logic; every threshold in rules.json.
 */
import type { EpsBasis, QuarterEarnings, Rules } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { missingNum, peOutlier } from './quality.ts';
import { daysBetween, pktDate } from './time.ts';

export interface PeFigure {
  pe: number | null; // null when there is no figure or the company made a loss
  basis: EpsBasis | 'psx'; // 'psx' = PSX's screener figure
  eps: number | null; // full-year EPS behind the P/E (implied from PSX's P/E on the 'psx' basis)
  label: string; // "consolidated, last 4 quarters", "PSX figure, basis not stated"
  outlier: boolean; // outside rules.undervalued.pe_outlier_min..max: shown with a "check figures" marker
  loss: boolean;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-06-30" -> "Jun 2026": the month a financial year or quarter ends. */
const monthYear = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const BASES: EpsBasis[] = ['consolidated', 'unconsolidated', 'not_stated'];
const BASIS_WORD: Record<EpsBasis, string> = { consolidated: 'consolidated', unconsolidated: 'unconsolidated', not_stated: 'basis not stated' };
/** Four quarter ends in a row span 9 months (Dec, Mar, Jun, Sep); anything wider has a quarter missing. */
const FOUR_QUARTERS_MAX_DAYS = 280;

type Eps = { eps: number; period_end: string; period_months: number; verified: boolean };

/**
 * One EPS per period of one basis (a notice posted twice is one figure; the verified copy wins), newest first. A row
 * with an EPS but no basis counts as 'not_stated'.
 */
function epsRows(symbol: string, earnings: QuarterEarnings[], basis: EpsBasis, months: number): Eps[] {
  const by = new Map<string, Eps>();
  for (const e of earnings) {
    if (e.symbol !== symbol || (e.eps_basis ?? 'not_stated') !== basis || e.period_months !== months || e.eps == null || !Number.isFinite(e.eps)) continue;
    const cur = by.get(e.period_end);
    if (!cur || (e.verified && !cur.verified)) by.set(e.period_end, { eps: e.eps, period_end: e.period_end, period_months: months, verified: e.verified });
  }
  return [...by.values()].sort((a, b) => b.period_end.localeCompare(a.period_end));
}

/** The full-year EPS of one basis: the last four quarters when they are newest and complete, else the latest year. `end` is the period it runs to. */
function fullYear(symbol: string, earnings: QuarterEarnings[], basis: EpsBasis): { eps: number; label: string; end: string } | null {
  const quarters = epsRows(symbol, earnings, basis, 3).slice(0, 4);
  const year = epsRows(symbol, earnings, basis, 12)[0];
  const fourInARow = quarters.length === 4 && daysBetween(quarters[3].period_end, quarters[0].period_end) <= FOUR_QUARTERS_MAX_DAYS;
  if (fourInARow && (!year || quarters[0].period_end >= year.period_end)) {
    return { eps: r2(quarters.reduce((s, q) => s + q.eps, 0)), label: `${BASIS_WORD[basis]}, last 4 quarters`, end: quarters[0].period_end };
  }
  return year ? { eps: year.eps, label: `${BASIS_WORD[basis]}, year to ${monthYear(year.period_end)}`, end: year.period_end } : null;
}

/** "2026-10-23" minus 15 months -> "2025-07-23" (a day past the month's end still compares correctly as text). */
function monthsBefore(iso: string, months: number): string {
  const t = Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1 - months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}${iso.slice(7)}`;
}

/**
 * The P/E shown for a stock and used by the rules: see the file comment for the order of bases. A basis whose full-year
 * figure ends more than rules.valuation.eps_max_age_months before `today` is too old to price on and is skipped.
 */
export function peFor(symbol: string, price: number | null, earnings: QuarterEarnings[], screenPe: number | null, rules: Rules = DEFAULT_RULES,
  today: string = pktDate(new Date())): PeFigure {
  const outlier = (pe: number | null) => pe != null && peOutlier(pe, rules).outlier;
  const oldest = monthsBefore(today, (rules as { valuation?: { eps_max_age_months?: number } }).valuation?.eps_max_age_months ?? 15);
  for (const basis of BASES) {
    const fy = fullYear(symbol, earnings, basis);
    if (!fy || fy.end < oldest) continue;
    const loss = fy.eps <= 0;
    const pe = loss || missingNum(price) ? null : r2((price as number) / fy.eps);
    return { pe, basis, eps: fy.eps, label: fy.label, outlier: outlier(pe), loss };
  }
  const label = 'PSX figure, basis not stated';
  if (screenPe == null || !Number.isFinite(screenPe) || screenPe === 0) return { pe: null, basis: 'psx', eps: null, label, outlier: false, loss: false };
  if (screenPe < 0) return { pe: null, basis: 'psx', eps: null, label, outlier: false, loss: true };
  return { pe: screenPe, basis: 'psx', eps: missingNum(price) ? null : r2((price as number) / screenPe), label, outlier: outlier(screenPe), loss: false };
}

/** peFor for many stocks at once (screen rows or prices), keyed by symbol. */
export function peMap(rows: { symbol: string; price: number | null; pe: number | null }[], earnings: QuarterEarnings[], rules: Rules = DEFAULT_RULES,
  today: string = pktDate(new Date())): Record<string, PeFigure> {
  const mine = new Map<string, QuarterEarnings[]>();
  for (const e of earnings) mine.set(e.symbol, [...(mine.get(e.symbol) ?? []), e]);
  return Object.fromEntries(rows.map((r) => [r.symbol, peFor(r.symbol, r.price, mine.get(r.symbol) ?? [], r.pe, rules, today)]));
}

export interface SectorStat { median: number; peers: number; comparable: boolean }

/** Linear-interpolation quantile of sorted numbers (the spreadsheet QUARTILE rule). */
const quantile = (s: number[], p: number) => {
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};

/**
 * Typical P/E per sector from trusted P/Es: each peer's filing-based P/E from `pe` when given (a loss there leaves the
 * peer out), PSX's figure otherwise. `comparable` is false with fewer than rules.undervalued.sector_min_peers peers, or
 * when the interquartile range is wider than sector_max_iqr_ratio x the median ("sector too mixed to compare").
 */
export function sectorStats(rows: { symbol?: string; sector: string | null; pe: number | null }[], rules: Rules = DEFAULT_RULES,
  pe?: Record<string, { pe: number | null }>): Record<string, SectorStat> {
  const u = rules.undervalued;
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const v = r.symbol && pe?.[r.symbol] ? pe[r.symbol].pe : r.pe;
    if (r.sector && !missingNum(v) && !peOutlier(v, rules).outlier) by.set(r.sector, [...(by.get(r.sector) ?? []), v as number]);
  }
  const out: Record<string, SectorStat> = {};
  for (const [sector, xs] of by) {
    const s = [...xs].sort((a, b) => a - b);
    const median = quantile(s, 0.5);
    const iqr = quantile(s, 0.75) - quantile(s, 0.25);
    out[sector] = { median: r2(median), peers: s.length, comparable: s.length >= u.sector_min_peers && iqr <= u.sector_max_iqr_ratio * median };
  }
  return out;
}

/** Why a sector has no comparison figure, in plain words; null when it is comparable. */
export function sectorNote(stat: SectorStat | undefined, rules: Rules = DEFAULT_RULES): string | null {
  if (stat?.comparable) return null;
  if (!stat || stat.peers < rules.undervalued.sector_min_peers) return 'too few sector peers to compare';
  return 'sector too mixed to compare';
}
