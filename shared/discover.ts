/**
 * Discover tab logic over the KSE-100 screen: undervalued names, dividend leaders, upcoming dividends.
 * Rules pick the candidates (with real numbers); the AI only ranks and explains them.
 */
import type { DividendEvent, QuarterEarnings, Rules } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { addDays } from './time.ts';
import { dedupeBySymbol } from './symbols.ts';
import { missingNum, oneOffYield, payoutFrequency, payoutOf, peOutlier, regularDividend } from './quality.ts';
import { sectorNote, sectorStats, type PeFigure } from './valuation.ts';
import { buyByDate, tradingCalendar, type TradingCalendar } from './calendar.ts';

export interface ScreenRow {
  symbol: string;
  ex?: string | null; // PSX marker stripped from the symbol (XD ex-dividend, XB ex-bonus, XR ex-right)
  listed_in?: string[] | null; // PSX index codes (blue-chip size check)
  avg_volume_30d?: number | null; // PSX's 30-day average volume (blue-chip liquidity check)
  mcap_rank?: number | null; // 1 = largest market cap among all listed stocks
  sector: string | null;
  price: number | null;
  change_pct: number | null;
  change_1y_pct?: number | null;
  pe: number | null;
  dividend_yield_pct: number | null;
  market_cap: number | null;
  is_shariah: boolean | null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export interface Undervalued extends ScreenRow {
  sector_pe: number | null; // null when the sector cannot be compared (sector_note says why)
  discount_pct: number | null;
  score: number;
  reason: string; // "P/E 6.6 · sector 14.5 · 5.0% yield · 1y -12%", with "sector too mixed to compare" in place of the sector figure
  sector_note: string | null; // 'sector too mixed to compare' | 'too few sector peers to compare' | null
  pe_label: string | null; // basis of the P/E (valuation.peFor label) when `opts.pe` was given
}

/**
 * Profitable KSE-100 stocks priced well below their sector's typical P/E (or cheap outright), still paying dividends.
 * One row per company (PSX's XD/XB/XR spellings are merged). A P/E outside rules.undervalued.pe_outlier_min..max is
 * not evidence of value (AHCL's 1.5 came from unconsolidated investment gains), so such rows are left out here and
 * out of the sector medians; the Dividends list still shows them with a "check figures" chip. 0 and blank are missing.
 * The sector figure comes from valuation.sectorStats: no comparison (discount_pct null) when the sector has too few
 * trusted peers or is too mixed. `opts.pe` (valuation.peMap) swaps in the filing-based P/E the stock page shows.
 */
export function undervalued(screen: ScreenRow[], opts: { shariahOnly?: boolean; exclude?: Set<string>; pe?: Record<string, PeFigure> } = {},
  rules: Rules = DEFAULT_RULES): Undervalued[] {
  const u = rules.undervalued;
  const rows = dedupeBySymbol(screen).map((r) => (opts.pe?.[r.symbol] ? { ...r, pe: opts.pe[r.symbol].pe } : r));
  const trusted = (r: ScreenRow) => !missingNum(r.pe) && !peOutlier(r.pe, rules).outlier;
  const stats = sectorStats(rows, rules);
  return rows
    .filter((r) => !missingNum(r.price) && trusted(r) && !missingNum(r.dividend_yield_pct) && (r.dividend_yield_pct as number) >= u.min_dividend_yield_pct
      && (!opts.shariahOnly || r.is_shariah === true) && !opts.exclude?.has(r.symbol))
    .map((r) => {
      const stat = r.sector ? stats[r.sector] : undefined;
      const sectorPe = stat?.comparable ? stat.median : null;
      const note = sectorNote(stat, rules);
      const discount = sectorPe ? (1 - (r.pe as number) / sectorPe) * 100 : null;
      const cheap = (sectorPe != null && (r.pe as number) <= sectorPe * u.sector_discount) || (r.pe as number) <= u.max_pe * 0.6;
      const fell = r.change_1y_pct != null && r.change_1y_pct < 0 ? Math.min(30, -r.change_1y_pct) / 10 : 0;
      const score = (discount ?? 0) / 10 + (u.max_pe - Math.min(u.max_pe, r.pe as number)) + (r.dividend_yield_pct ?? 0) / 2 + fell;
      const parts = [`P/E ${(r.pe as number).toFixed(1)}`];
      if (sectorPe != null) parts.push(`sector ${sectorPe.toFixed(1)}`);
      else if (note) parts.push(note);
      parts.push(`${(r.dividend_yield_pct ?? 0).toFixed(1)}% yield`);
      if (r.change_1y_pct != null) parts.push(`1y ${r.change_1y_pct > 0 ? '+' : ''}${r.change_1y_pct.toFixed(0)}%`);
      return {
        ...r, sector_pe: sectorPe == null ? null : r1(sectorPe), discount_pct: discount == null ? null : r1(discount), score, reason: parts.join(' · '),
        sector_note: note, pe_label: opts.pe?.[r.symbol]?.label ?? null, cheap,
      };
    })
    .filter((r) => r.cheap && r.pe! <= u.max_pe * 1.5)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, u.candidates)
    .map(({ cheap: _c, ...r }) => r);
}

// ---------------------------------------------------------------------------
// Sorting (the lists always show the strongest value first; the AI's order is one option, not the default)
// ---------------------------------------------------------------------------
type AiMark = { ai?: { n: number; frequency?: string | null } | null };
const aiRank = (r: AiMark) => (r.ai ? r.ai.n : 99);
const bySymbol = (a: { symbol: string }, b: { symbol: string }) => a.symbol.localeCompare(b.symbol);

export type UvSort = 'score' | 'discount' | 'pe' | 'yield' | 'ai';
export const UV_SORTS: { value: UvSort; label: string }[] = [
  { value: 'discount', label: 'Most undervalued' }, { value: 'pe', label: 'Lowest P/E' },
  { value: 'yield', label: 'Highest yield' }, { value: 'ai', label: 'AI picks first' },
];
export function sortUndervalued<T extends Undervalued & AiMark>(rows: T[], by: UvSort): T[] {
  const cmp: Record<UvSort, (a: T, b: T) => number> = {
    score: (a, b) => b.score - a.score,
    discount: (a, b) => (b.discount_pct ?? -1e9) - (a.discount_pct ?? -1e9),
    pe: (a, b) => (a.pe ?? 1e9) - (b.pe ?? 1e9),
    yield: (a, b) => (b.dividend_yield_pct ?? 0) - (a.dividend_yield_pct ?? 0),
    ai: (a, b) => aiRank(a) - aiRank(b),
  };
  return [...rows].sort((a, b) => cmp[by](a, b) || b.score - a.score || bySymbol(a, b));
}

export type DvSort = 'yield' | 'dps' | 'frequency' | 'price' | 'ai';
export const DV_SORTS: { value: DvSort; label: string }[] = [
  { value: 'yield', label: 'Highest yield' }, { value: 'dps', label: 'Most per share' }, { value: 'frequency', label: 'Pays most often' },
  { value: 'price', label: 'Cheapest share' }, { value: 'ai', label: 'AI picks first' },
];
const FREQ_RANK: Record<string, number> = { Quarterly: 3, 'Half-yearly': 2, Yearly: 1 };
/** Payout frequency from filings, else the AI's estimate (never "Irregular"). */
export const effectiveFrequency = (d: { frequency: Frequency | null } & AiMark) =>
  d.frequency ?? (d.ai?.frequency && d.ai.frequency !== 'Irregular' ? (d.ai.frequency as Frequency) : null);
export function sortDividends<T extends DividendLeader & AiMark>(rows: T[], by: DvSort): T[] {
  const cmp: Record<DvSort, (a: T, b: T) => number> = {
    yield: (a, b) => b.dividend_yield_pct - a.dividend_yield_pct,
    dps: (a, b) => b.annual_dps - a.annual_dps,
    frequency: (a, b) => (FREQ_RANK[effectiveFrequency(b) ?? ''] ?? 0) - (FREQ_RANK[effectiveFrequency(a) ?? ''] ?? 0),
    price: (a, b) => a.price - b.price,
    ai: (a, b) => aiRank(a) - aiRank(b),
  };
  const suspect = (r: T) => Number((r as { suspect?: boolean }).suspect === true);
  return [...rows].sort((a, b) => suspect(a) - suspect(b) || cmp[by](a, b) || b.dividend_yield_pct - a.dividend_yield_pct || bySymbol(a, b));
}

export type UpSort = 'soonest' | 'dps';
export const UP_SORTS: { value: UpSort; label: string }[] = [{ value: 'soonest', label: 'Soonest to buy' }, { value: 'dps', label: 'Biggest dividend' }];
export function sortUpcoming(rows: UpcomingDividend[], by: UpSort): UpcomingDividend[] {
  return [...rows].sort((a, b) => (by === 'dps' ? (b.dps ?? 0) - (a.dps ?? 0) : 0) || a.buy_by.localeCompare(b.buy_by) || bySymbol(a, b));
}

// ---------------------------------------------------------------------------
// Dividends
// ---------------------------------------------------------------------------
export type Frequency = 'Quarterly' | 'Half-yearly' | 'Yearly';

/** How often a company paid, from cash dividends declared in the last 12 months. */
export function frequencyOf(events: DividendEvent[], symbol: string, today: string): { label: Frequency | null; count: number } {
  const since = addDays(today, -366);
  const n = new Set(events.filter((e) => e.symbol === symbol && e.dps != null && e.announced_on >= since).map((e) => e.announced_on.slice(0, 7))).size;
  return { label: n >= 4 ? 'Quarterly' : n >= 2 ? 'Half-yearly' : n === 1 ? 'Yearly' : null, count: n };
}

export interface DividendLeader {
  symbol: string;
  ex?: string | null;
  sector: string | null;
  price: number;
  pe: number | null;
  /** The yield the list is ranked on: PSX's trailing yield, or the regular (non-special) yield from filings when a one-off is in it. */
  dividend_yield_pct: number;
  psx_yield_pct: number; // PSX's own figure, specials included
  yield_from: 'psx' | 'filings';
  annual_dps: number; // dividend per share behind the ranked yield
  last: DividendEvent | null; // most recent declared cash dividend we have read
  special: DividendEvent | null; // a one-off in the last 12 months, when filings show one
  high_yield_hint: boolean; // PSX yield above rules.dividends.special_yield_hint_pct with no filings to check it against
  frequency: Frequency | null;
  frequency_enough: boolean; // at least 2 cash dividend filings behind `frequency`
  outlier: string | null; // why the P/E is not to be trusted, else null
  payout_pct: number | null; // quality.payoutOf: last 12 months of filings, else PSX yield x price, as % of earnings
  /** Over rules.dividends.suspect_payout_pct of profit on PSX's figure, with no filing showing which part is a one-off: ranked after the rest. */
  suspect: boolean;
  /** The trailing yield will not repeat (quality.oneOffYield): a special in it, or the latest full-year results paid none. */
  one_off: boolean;
  pe_label: string | null; // basis of the P/E (valuation.peFor label) when `opts.pe` was given
  is_shariah: boolean | null;
}

/**
 * The highest-yielding KSE-100 stocks, one row per company. A one-off yield (a special dividend in the last 12 months,
 * or latest full-year results with no dividend: quality.oneOffYield) is ranked on the regular payout from the last 12
 * months of filings instead, so a single special cannot carry a stock to the top; the row says `one_off` and names the
 * special. Missing PSX figures (0, blank) are never treated as values. `opts.pe` (valuation.peMap) gives the P/E shown
 * and the EPS the payout is measured against; `opts.earnings` lets a skipped final dividend count as a one-off.
 */
export function dividendLeaders(screen: ScreenRow[], events: DividendEvent[], today: string,
  opts: { shariahOnly?: boolean; pe?: Record<string, PeFigure>; earnings?: QuarterEarnings[] } = {}, rules: Rules = DEFAULT_RULES): DividendLeader[] {
  const d = rules.dividends;
  return dedupeBySymbol(screen)
    .filter((r) => !missingNum(r.price) && !missingNum(r.dividend_yield_pct) && (!opts.shariahOnly || r.is_shariah === true))
    .map((r) => {
      const price = r.price as number;
      const psxYield = r.dividend_yield_pct as number;
      const regular = regularDividend(r.symbol, events, today, price, rules);
      const special = regular?.specials[0] ?? null;
      const oneOff = oneOffYield(r.symbol, events, today, opts.earnings, rules);
      const fromFilings = oneOff && !!regular && regular.yield_pct != null;
      const yieldPct = fromFilings ? (regular.yield_pct as number) : psxYield;
      const mine = events.filter((e) => e.symbol === r.symbol && e.dps != null).sort((a, b) => b.announced_on.localeCompare(a.announced_on));
      const freq = payoutFrequency(r.symbol, events, today, rules);
      const fig = opts.pe?.[r.symbol];
      const pe = fig ? fig.pe : missingNum(r.pe) ? null : (r.pe as number);
      const annualDps = fromFilings ? regular.annual_dps : Math.round((psxYield * price) / 100 * 100) / 100;
      // The payout every screen shows (quality.payoutOf): filings first, then PSX's yield x price.
      const pay = payoutOf(r.symbol, events, today, { price, psxYieldPct: psxYield, eps: fig ? fig.eps : undefined, pe }, rules);
      return {
        symbol: r.symbol, ex: r.ex ?? null, sector: r.sector, price, pe,
        dividend_yield_pct: yieldPct, psx_yield_pct: psxYield, yield_from: fromFilings ? 'filings' as const : 'psx' as const,
        annual_dps: annualDps,
        last: mine[0] ?? null, special,
        high_yield_hint: !regular && psxYield > d.special_yield_hint_pct,
        frequency: freq.enough ? freq.label : null, frequency_enough: freq.enough,
        outlier: pe == null ? null : peOutlier(pe, rules).reason,
        payout_pct: pay.pct,
        suspect: pay.suspect,
        one_off: oneOff,
        pe_label: fig?.label ?? null,
        is_shariah: r.is_shariah,
      };
    })
    .filter((r) => r.dividend_yield_pct >= d.min_yield_pct)
    .sort((a, b) => b.dividend_yield_pct - a.dividend_yield_pct || a.symbol.localeCompare(b.symbol))
    .slice(0, d.candidates)
    // Suspect payouts stay on the list but go to the bottom (sortDividends keeps them there in every order).
    .sort((a, b) => Number(a.suspect) - Number(b.suspect));
}

/** Working day (Mon–Fri) `n` days before an ISO date, ignoring holidays. Prefer calendar.ts, which knows PSX's holidays and trading days. */
export function workingDaysBefore(iso: string, n: number): string {
  let d = iso;
  let left = n;
  while (left > 0) {
    d = addDays(d, -1);
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

export interface UpcomingDividend extends DividendEvent { buy_by: string; days_left: number }

/**
 * Dividends whose book closure hasn't started yet, with the last day to buy (book closure start minus
 * rules.dividends.buy_by_working_days trading days under T+1 settlement, skipping weekends and PSX holidays;
 * confirm with the broker), soonest first. Pass a calendar built with the index's trading days when you have them.
 */
export function upcomingDividends(events: DividendEvent[], today: string, rules: Rules = DEFAULT_RULES, cal: TradingCalendar = tradingCalendar(rules)): UpcomingDividend[] {
  return events
    .filter((e) => e.book_closure_from && e.book_closure_from > today)
    .map((e) => {
      const buyBy = buyByDate(e.book_closure_from as string, cal, rules);
      return { ...e, buy_by: buyBy, days_left: Math.round((Date.parse(buyBy) - Date.parse(today)) / 86400000) };
    })
    .filter((e) => e.days_left >= 0)
    .sort((a, b) => a.buy_by.localeCompare(b.buy_by) || a.symbol.localeCompare(b.symbol));
}
