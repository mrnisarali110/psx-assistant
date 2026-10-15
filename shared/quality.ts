/**
 * Data trust and quality signals for Discover (ISSUE-01/03/04/05/10, FEATURE-04/05/06): is PSX's figure
 * believable, is a dividend regular or a one-off, is the payout sustainable, does an AI sentence match the
 * numbers shown beside it, and which of the three Home states we are in. Pure logic; every threshold comes
 * from rules.json. Nothing here invents data: a missing input gives null or an explicit flag, never a guess.
 */
import type { DividendEvent, Rules } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { addDays } from './time.ts';
import { rs } from './format.ts';
import { numberSet, numbersGrounded } from './grounding.ts';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
/** 1.46 -> "1.46", 150 -> "150": a number as people write it, at most 2 decimals. */
const fmt = (v: number) => String(r2(v));
const median = (xs: number[]): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/** Newest filing first; same day: higher announcement id first. */
const newestFirst = (a: DividendEvent, b: DividendEvent) => b.announced_on.localeCompare(a.announced_on) || b.id.localeCompare(a.id);
/**
 * PSX often posts the same notice twice and the worker saves one event per announcement id, so two events
 * with the same symbol, day, dps and type are one dividend. A same-day filing of a different type is kept:
 * it may be a different dividend.
 */
const filingKey = (e: DividendEvent) => `${e.symbol}|${e.announced_on}|${e.dps}|${e.dividend_type ?? ''}`;
/** One event per filing: the verified copy wins, then the higher id. Survivors keep the input order. */
const dedupeFilings = (events: DividendEvent[]): DividendEvent[] => {
  const kept = new Map<string, DividendEvent>();
  for (const e of events) {
    const k = filingKey(e);
    const cur = kept.get(k);
    if (!cur || (e.verified && !cur.verified) || (e.verified === cur.verified && e.id.localeCompare(cur.id) > 0)) kept.set(k, e);
  }
  return [...kept.values()];
};
/** This company's cash dividend filings, one per dividend: a known dps above zero, duplicate postings collapsed. */
const cashDividends = (events: DividendEvent[], symbol: string) =>
  dedupeFilings(events.filter((e) => e.symbol === symbol && e.dps != null && Number.isFinite(e.dps) && e.dps > 0));
/** The one company whose filings these are, or null when the list is empty or mixes companies. */
const onlySymbol = (events: DividendEvent[]): string | null => {
  const symbols = new Set(events.map((e) => e.symbol));
  return symbols.size === 1 ? events[0].symbol : null;
};
/** The 365 days ending today: announced after `today - 365` and not after today. */
const inLastYear = (e: DividendEvent, today: string) => e.announced_on > addDays(today, -365) && e.announced_on <= today;

/**
 * True when a figure cannot be used: null, undefined, NaN, Infinity, 0 or negative. PSX prints 0 or leaves
 * the cell blank when it has no figure (BAFL's P/E shows 0 while the bank is profitable), and a yield or
 * P/E below zero is not a usable number for the screens.
 */
export function missingNum(v: number | null | undefined): boolean {
  return v == null || !Number.isFinite(v) || v <= 0;
}

/**
 * P/E outside rules.undervalued.pe_outlier_min..max (inclusive bounds are fine), or missing. The reason is
 * the text for a "check figures" badge; null when the figure is believable.
 */
export function peOutlier(pe: number | null | undefined, rules: Rules = DEFAULT_RULES): { outlier: boolean; reason: string | null } {
  const { pe_outlier_min: min, pe_outlier_max: max } = rules.undervalued;
  if (pe == null || !Number.isFinite(pe)) return { outlier: true, reason: 'No P/E from PSX' };
  if (pe === 0) return { outlier: true, reason: 'PSX shows P/E 0: no figure, or the company made a loss' };
  if (pe < 0) return { outlier: true, reason: `P/E ${fmt(pe)}: the company is loss-making` };
  if (pe < min) return { outlier: true, reason: `P/E ${fmt(pe)} is below ${fmt(min)}: too low to trust, check the figures` };
  if (pe > max) return { outlier: true, reason: `P/E ${fmt(pe)} is above ${fmt(max)}: earnings near zero or a stale figure, check the figures` };
  return { outlier: false, reason: null };
}

/** Earnings per share implied by PSX's own figures: price / pe, 2 dp. Null when either is missing or pe <= 0. */
export function impliedEps(price: number | null | undefined, pe: number | null | undefined): number | null {
  if (missingNum(price) || missingNum(pe)) return null;
  return r2((price as number) / (pe as number));
}

/**
 * Dividend paid as a share of earnings: annual_dps / eps x 100, 1 dp. Null when eps is missing (nothing to
 * divide by) or annual_dps is unknown; a dps of 0 is a real 0% payout, not missing. Over 100% is flagged
 * unsustainable: the company pays out more than it earns.
 */
export function payoutRatio(annualDps: number | null | undefined, eps: number | null | undefined): { pct: number | null; unsustainable: boolean } {
  if (annualDps == null || !Number.isFinite(annualDps) || annualDps < 0 || missingNum(eps)) return { pct: null, unsustainable: false };
  const pct = r1((annualDps / (eps as number)) * 100);
  return { pct, unsustainable: pct > 100 };
}

/**
 * A declared dividend is "special" when its type says so, or when its dps is more than
 * rules.dividends.special_multiple_of_median x the median dps of the symbol's other filings in `events`
 * (at least 2 others needed; filings typed 'special' are left out of that median so one-offs do not raise
 * the bar for the next one). A missing dps is never special.
 */
export function isSpecial(e: DividendEvent, events: DividendEvent[], rules: Rules = DEFAULT_RULES): boolean {
  if (e.dividend_type === 'special') return true;
  if (e.dps == null || !Number.isFinite(e.dps) || e.dps <= 0) return false;
  // Left out by filing, not by id, so a duplicate posting of `e` cannot stand in as one of the "others".
  const others = cashDividends(events, e.symbol).filter((x) => filingKey(x) !== filingKey(e) && x.dividend_type !== 'special').map((x) => x.dps as number);
  if (others.length < 2) return false;
  return e.dps > rules.dividends.special_multiple_of_median * (median(others) as number);
}

/**
 * Regular (non-special) dividend per share declared in the last 12 months (the 365 days ending `today`) and
 * the yield it implies at `price` (2 dp; null without a price). `specials` are the one-offs in that window,
 * newest first, and `count` is every cash dividend filing in it, specials included. Null when the window
 * has no filings at all: the caller then has no filing-based figure and must say so.
 */
export function regularDividend(symbol: string, events: DividendEvent[], today: string, price: number | null, rules: Rules = DEFAULT_RULES):
  { annual_dps: number; yield_pct: number | null; specials: DividendEvent[]; count: number } | null {
  const recent = cashDividends(events, symbol).filter((e) => inLastYear(e, today)).sort(newestFirst);
  if (!recent.length) return null;
  const specials = recent.filter((e) => isSpecial(e, events, rules));
  const annual = r2(recent.filter((e) => !specials.includes(e)).reduce((a, e) => a + (e.dps as number), 0));
  return { annual_dps: annual, yield_pct: missingNum(price) ? null : r2((annual / (price as number)) * 100), specials, count: recent.length };
}

/**
 * How often the company pays, from its last rules.dividends.frequency_filings cash dividends (specials left out)
 * over up to rules.dividends.frequency_years years: for each 12-month window ending today, a year ago, two years
 * ago..., count the distinct months with a payout; the busiest year decides (4+ Quarterly, 2-3 Half-yearly,
 * 1 Yearly, none null). Filings the worker has not read only lower a year's count, so the best-covered year is the
 * truest picture (MCB pays quarterly even when only one of this year's notices has been read). `enough` = at
 * least 2 filings in total. A filing dated after `today` (a misread date) does not count.
 */
export function payoutFrequency(symbol: string, events: DividendEvent[], today: string, rules: Rules = DEFAULT_RULES):
  { label: 'Quarterly' | 'Half-yearly' | 'Yearly' | null; count: number; enough: boolean } {
  const years = (rules.dividends as { frequency_years?: number }).frequency_years ?? 1;
  const since = addDays(today, -365 * years);
  const recent = cashDividends(events, symbol)
    .filter((e) => e.dividend_type !== 'special' && e.announced_on <= today && e.announced_on > since)
    .sort(newestFirst)
    .slice(0, rules.dividends.frequency_filings);
  let months = 0;
  for (let y = 0; y < years; y++) {
    const end = addDays(today, -365 * y);
    const start = addDays(end, -365);
    months = Math.max(months, new Set(recent.filter((e) => e.announced_on > start && e.announced_on <= end).map((e) => e.announced_on.slice(0, 7))).size);
  }
  return { label: months >= 4 ? 'Quarterly' : months >= 2 ? 'Half-yearly' : months === 1 ? 'Yearly' : null, count: recent.length, enough: recent.length >= 2 };
}

/**
 * Latest declared dps against the previous filing of the same kind (interim vs interim, final vs final;
 * specials never count): a cut when it is lower by more than `cutPct` percent (default 10, so 4 -> 3.8 is not
 * a cut and 4 -> 3 is). `previous` is null, and `cut` false, when the latest filing has no type or no earlier
 * filing of its type exists.
 */
export function dividendCut(symbol: string, events: DividendEvent[], cutPct = 10): { cut: boolean; latest: number | null; previous: number | null } {
  const mine = cashDividends(events, symbol).filter((e) => e.dividend_type !== 'special').sort(newestFirst);
  const latest = mine[0];
  if (!latest) return { cut: false, latest: null, previous: null };
  const prev = latest.dividend_type ? mine.slice(1).find((e) => e.dividend_type === latest.dividend_type) : undefined;
  if (!prev) return { cut: false, latest: latest.dps, previous: null };
  const drop = (((prev.dps as number) - (latest.dps as number)) / (prev.dps as number)) * 100;
  return { cut: drop > cutPct + 1e-9, latest: latest.dps, previous: prev.dps };
}

export interface QualityChip { key: 'loss' | 'payout' | 'trend' | 'special' | 'outlier' | 'missing'; label: string; tone: 'green' | 'red' | 'amber' | 'slate' }

/**
 * Small chips for a Discover card, in this order when they apply:
 * - loss (red): only a P/E below zero, "Loss-making". A 0 or blank P/E is missing data (BAFL is profitable but
 *   PSX leaves its P/E blank), so it gets the slate "No P/E figure" chip and is never hidden as loss-making.
 * - payout (amber): regular dividend over 100% of earnings. Dividend per share comes from the last 12 months
 *   of filings when there are any, else from PSX's yield x price; earnings from price / P/E.
 * - trend (green up, red down, slate flat): "1y +12%" from change_1y_pct when known.
 * - special (amber): a one-off dividend in the last 12 months (the yield is inflated by it).
 * - outlier (amber): a positive P/E outside rules.undervalued.pe_outlier_min..max, "check figures".
 * - missing (slate): "No price, yield" for the fields PSX did not give: a blank or 0 P/E only when there is
 *   no price either (with a price it is the loss chip above); a negative P/E is a figure, never a gap.
 * `events` are this company's dividend filings. When the list holds several companies, `symbol` on the row
 * says which are this company's; without it such a list is ignored (PSX's own figures decide the chips)
 * rather than guessed from.
 */
export function qualityChips(row: { symbol?: string; pe: number | null; price: number | null; dividend_yield_pct: number | null; change_1y_pct?: number | null },
  events: DividendEvent[], today: string, rules: Rules = DEFAULT_RULES): QualityChip[] {
  const chips: QualityChip[] = [];
  const symbol = row.symbol ?? onlySymbol(events);
  const havePrice = !missingNum(row.price);
  const peNumber = row.pe != null && Number.isFinite(row.pe) ? row.pe : null;
  const peGap = peNumber == null || peNumber === 0; // PSX leaves the cell blank or prints 0 when it has no figure

  if (peNumber != null && peNumber < 0) chips.push({ key: 'loss', label: 'Loss-making', tone: 'red' });

  const eps = impliedEps(row.price, row.pe);
  const regular = symbol ? regularDividend(symbol, events, today, row.price, rules) : null;
  const dps = regular ? regular.annual_dps : havePrice && !missingNum(row.dividend_yield_pct) ? r2(((row.dividend_yield_pct as number) * (row.price as number)) / 100) : null;
  const payout = payoutRatio(dps, eps);
  if (payout.unsustainable) chips.push({ key: 'payout', label: `Pays out ${fmt(payout.pct as number)}% of profit`, tone: 'amber' });

  const t = row.change_1y_pct;
  if (t != null && Number.isFinite(t)) {
    const n = Math.round(t);
    chips.push({ key: 'trend', label: `1y ${n > 0 ? '+' : ''}${n}%`, tone: n > 0 ? 'green' : n < 0 ? 'red' : 'slate' });
  }

  if (regular && regular.specials.length) chips.push({ key: 'special', label: 'Special dividend', tone: 'amber' });

  if (peNumber != null && peNumber > 0 && peOutlier(peNumber, rules).outlier) chips.push({ key: 'outlier', label: `P/E ${fmt(peNumber)}: check figures`, tone: 'amber' });

  const gaps: string[] = [];
  if (!havePrice) gaps.push('price');
  if (peGap) gaps.push('P/E');
  if (missingNum(row.dividend_yield_pct)) gaps.push('yield');
  if (gaps.length) chips.push({ key: 'missing', label: gaps.length === 1 && gaps[0] === 'P/E' ? 'No P/E figure' : `No ${gaps.join(', ')}`, tone: 'slate' });

  return chips;
}

/**
 * Numbers that are unmistakably figures, not dates or counts: a percentage ("9%", "-20 %"), a P/E
 * ("P/E 7", "P/E of 6.63", "PE ratio: 5") and rupees ("Rs 1,234", "PKR 12"). Commas are stripped.
 */
const FIGURE_RES = [
  /(-?\d[\d,]*(?:\.\d+)?)\s?%/g,
  /\bP\/?E\b\s*(?:ratio\s*)?(?:of|at|is|:|=)?\s*(-?\d[\d,]*(?:\.\d+)?)/gi,
  /\b(?:Rs\.?|PKR)\s*(\d[\d,]*(?:\.\d+)?)/gi,
];
const figuresIn = (text: string): number[] =>
  FIGURE_RES.flatMap((re) => [...text.matchAll(re)].map((m) => Number(m[1].replace(/,/g, '')))).filter(Number.isFinite);
/** The tolerance grounding.numbersGrounded uses: within 0.05, or 0.5% of the known figure, whichever is wider. */
const isKnown = (n: number, known: number[]) => known.some((k) => Math.abs(k - n) <= Math.max(0.05, Math.abs(k) * 0.005));

/**
 * ISSUE-05: an AI sentence may be shown only when every number in it matches a number displayed beside it
 * (within rounding: "P/E 7" matches 6.6). grounding.numbersGrounded waves small integers and years through
 * as dates and counts ("3 banks in 2026"); a small integer that is plainly a figure (a percentage, a P/E,
 * rupees) must match too, so "yield 9%" beside a 4.1% chip is not shown. Null and undefined values in
 * `shown` are simply not known numbers.
 */
export function aiTextMatches(text: string, shown: Record<string, number | null | undefined>): boolean {
  const known = numberSet(shown);
  return numbersGrounded(text, known).ok && figuresIn(text).every((n) => isKnown(n, known));
}

const nameList = (symbols: string[]) => {
  const head = symbols.slice(0, 3);
  const rest = symbols.length - head.length;
  if (rest > 0) return `${head.join(', ')} or ${rest} more`;
  return head.length > 1 ? `${head.slice(0, -1).join(', ')} or ${head[head.length - 1]}` : head[0];
};

/**
 * Three clear Home states (ISSUE-09), never "Hold" with an add suggestion:
 * - 'review' when any rule is broken (`attention` > 0: caps, trim, review due), whatever the stance;
 * - 'add' when the stance is Buy, `cash_left` is above zero and at least one holding or candidate in
 *   `addable` may take money;
 * - 'hold' otherwise, with a headline that says why and never suggests buying.
 */
export function todayState(o: { stance: 'Buy' | 'Hold' | 'Wait'; cash_left: number; attention: number; addable: string[]; trims?: { symbol: string; reason: string }[] }):
  { state: 'hold' | 'add' | 'review' | 'trim'; headline: string } {
  if (o.attention > 0) {
    return { state: 'review', headline: o.attention === 1 ? 'Review first: one of your rules is broken' : `Review first: ${o.attention} of your rules are broken` };
  }
  // A trim from your own rules comes first and always says why; never under a "Hold".
  if (o.trims?.length) {
    const [t] = o.trims;
    return { state: 'trim', headline: o.trims.length === 1 ? `Trim ${t.symbol}: ${t.reason}` : `Trim ${nameList(o.trims.map((x) => x.symbol))}; first ${t.symbol}: ${t.reason}` };
  }
  if (o.stance === 'Buy' && o.cash_left > 0 && o.addable.length > 0) {
    return { state: 'add', headline: `Add money: ${rs(o.cash_left)} left for ${nameList(o.addable)}` };
  }
  if (o.stance === 'Wait') return { state: 'hold', headline: 'Hold: the market says wait today' };
  if (o.stance === 'Buy' && o.cash_left <= 0) return { state: 'hold', headline: "Hold: this month's money is all invested" };
  if (o.stance === 'Buy') return { state: 'hold', headline: 'Hold: nothing qualifies for more money today' };
  return { state: 'hold', headline: 'Hold: nothing to do today' };
}
