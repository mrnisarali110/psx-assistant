/**
 * Discover tab logic over the KSE-100 screen: undervalued names, dividend leaders, upcoming dividends.
 * Rules pick the candidates (with real numbers); the AI only ranks and explains them.
 */
import type { DividendEvent, Rules } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { addDays } from './time.ts';

export interface ScreenRow {
  symbol: string;
  sector: string | null;
  price: number | null;
  change_pct: number | null;
  change_1y_pct?: number | null;
  pe: number | null;
  dividend_yield_pct: number | null;
  market_cap: number | null;
  is_shariah: boolean | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const r1 = (v: number) => Math.round(v * 10) / 10;

export interface Undervalued extends ScreenRow { sector_pe: number | null; discount_pct: number | null; score: number; reason: string }

/** Profitable KSE-100 stocks priced well below their sector's typical P/E (or cheap outright), still paying dividends. */
export function undervalued(screen: ScreenRow[], opts: { shariahOnly?: boolean; exclude?: Set<string> } = {}, rules: Rules = DEFAULT_RULES): Undervalued[] {
  const u = rules.undervalued;
  const bySector = new Map<string, number[]>();
  for (const r of screen) if (r.pe != null && r.pe > 0 && r.sector) bySector.set(r.sector, [...(bySector.get(r.sector) ?? []), r.pe]);
  return screen
    .filter((r) => r.price != null && r.pe != null && r.pe > 0 && (r.dividend_yield_pct ?? 0) >= u.min_dividend_yield_pct
      && (!opts.shariahOnly || r.is_shariah === true) && !opts.exclude?.has(r.symbol))
    .map((r) => {
      const peers = r.sector ? bySector.get(r.sector) ?? [] : [];
      const sectorPe = peers.length >= 3 ? median(peers) : null;
      const discount = sectorPe ? (1 - (r.pe as number) / sectorPe) * 100 : null;
      const cheap = (sectorPe != null && (r.pe as number) <= sectorPe * u.sector_discount) || (r.pe as number) <= u.max_pe * 0.6;
      const fell = r.change_1y_pct != null && r.change_1y_pct < 0 ? Math.min(30, -r.change_1y_pct) / 10 : 0;
      const score = (discount ?? 0) / 10 + (u.max_pe - Math.min(u.max_pe, r.pe as number)) + (r.dividend_yield_pct ?? 0) / 2 + fell;
      const parts = [`P/E ${(r.pe as number).toFixed(1)}`];
      if (sectorPe != null) parts.push(`sector ${sectorPe.toFixed(1)}`);
      parts.push(`${(r.dividend_yield_pct ?? 0).toFixed(1)}% yield`);
      if (r.change_1y_pct != null) parts.push(`1y ${r.change_1y_pct > 0 ? '+' : ''}${r.change_1y_pct.toFixed(0)}%`);
      return { ...r, sector_pe: sectorPe == null ? null : r1(sectorPe), discount_pct: discount == null ? null : r1(discount), score, reason: parts.join(' · '), cheap };
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
  { value: 'score', label: 'Most undervalued' }, { value: 'discount', label: 'Cheapest vs sector' }, { value: 'pe', label: 'Lowest P/E' },
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
  return [...rows].sort((a, b) => cmp[by](a, b) || b.dividend_yield_pct - a.dividend_yield_pct || bySymbol(a, b));
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
  sector: string | null;
  price: number;
  dividend_yield_pct: number;
  annual_dps: number; // trailing 12-month dividend per share implied by PSX's yield and price
  last: DividendEvent | null; // most recent declared cash dividend we have read
  frequency: Frequency | null;
  is_shariah: boolean | null;
}

export function dividendLeaders(screen: ScreenRow[], events: DividendEvent[], today: string,
  opts: { shariahOnly?: boolean } = {}, rules: Rules = DEFAULT_RULES): DividendLeader[] {
  return screen
    .filter((r) => r.price != null && (r.dividend_yield_pct ?? 0) >= rules.dividends.min_yield_pct && (!opts.shariahOnly || r.is_shariah === true))
    .sort((a, b) => (b.dividend_yield_pct ?? 0) - (a.dividend_yield_pct ?? 0))
    .slice(0, rules.dividends.candidates)
    .map((r) => {
      const mine = events.filter((e) => e.symbol === r.symbol && e.dps != null).sort((a, b) => b.announced_on.localeCompare(a.announced_on));
      return {
        symbol: r.symbol, sector: r.sector, price: r.price as number, dividend_yield_pct: r.dividend_yield_pct as number,
        annual_dps: Math.round(((r.dividend_yield_pct as number) * (r.price as number)) / 100 * 100) / 100,
        last: mine[0] ?? null, frequency: frequencyOf(events, r.symbol, today).label, is_shariah: r.is_shariah,
      };
    });
}

/** Working day (Mon–Fri) `n` days before an ISO date. PSX holidays are not known, so this can be a day late. */
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
 * Dividends whose book closure hasn't started yet, with the last day to buy (estimated as book closure
 * minus 3 working days under T+2 settlement; confirm with the broker), soonest first.
 */
export function upcomingDividends(events: DividendEvent[], today: string, rules: Rules = DEFAULT_RULES): UpcomingDividend[] {
  return events
    .filter((e) => e.book_closure_from && e.book_closure_from > today)
    .map((e) => {
      const buyBy = workingDaysBefore(e.book_closure_from as string, rules.dividends.buy_by_working_days);
      return { ...e, buy_by: buyBy, days_left: Math.round((Date.parse(buyBy) - Date.parse(today)) / 86400000) };
    })
    .filter((e) => e.days_left >= 0)
    .sort((a, b) => a.buy_by.localeCompare(b.buy_by) || a.symbol.localeCompare(b.symbol));
}
