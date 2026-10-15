/**
 * How the account has really done: total return with charges and dividends, the money-weighted yearly return
 * (XIRR), "what if every rupee had gone into the KSE-100 instead", and the dividend side: withholding tax,
 * dividends declared on shares held at book closure, income per tax year, expected yearly income, and the series
 * for the Performance chart. Pure logic: no DOM, no network. Every rate comes from the settings or rules.json;
 * money is rupees to the paisa, percentages to 1 dp; a missing input gives null or an explicit count, never a
 * made-up figure.
 */
import type { DividendEvent, DividendReceipt, Holding, IndexDay, PortfolioDay, PriceMap, Rules, Settings, Txn } from './types.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS } from './types.ts';
import { costRates, txnCharges } from './costs.ts';
import { buildLots, sharesHeldOn, taxYear } from './tax.ts';
import { addDays, daysBetween } from './time.ts';

const r2 = (v: number) => {
  const x = Math.round(v * 100) / 100;
  return x === 0 ? 0 : x; // never -0
};
const r1 = (v: number) => {
  const x = Math.round(v * 10) / 10;
  return x === 0 ? 0 : x;
};
const positive = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sym = (s: string) => s.trim().toUpperCase();
const filerOf = (s: Settings) => s.tax_filer ?? DEFAULT_SETTINGS.tax_filer;

/**
 * How far back a flow may look for a KSE-100 close (calendar days): a buy on a Saturday or the day after a holiday
 * is priced at the last close. The spec fixes 7; rules.json has no slot for it yet, so it is a named default here
 * that benchmark(), valueSeries() and closeOn() all take as an optional parameter.
 */
export const CLOSE_LOOKBACK_DAYS = 7;
/**
 * A receipt with no dividend_id is taken to be the declared dividend of the same symbol when it was paid within this
 * many days after book closure started. The spec fixes 60; expectedDividends() reads `rules.dividends.receipt_match_days`
 * when the rules carry it and falls back to this.
 */
export const RECEIPT_MATCH_DAYS = 60;
/** The spec's day count for XIRR: days / 365. */
const DAYS_PER_YEAR = 365;

// ---------------------------------------------------------------------------
// Cash flows and XIRR
// ---------------------------------------------------------------------------

export type FlowKind = 'buy' | 'sell' | 'dividend' | 'value';

/** One cash flow of the account. negative = money in (buys), positive = money out (sells, dividends, the final value). */
export interface Flow {
  date: string; // YYYY-MM-DD
  amount: number;
  kind?: FlowKind; // set by cashFlows(); 'value' marks the final "worth today" flow, which benchmark() and valueSeries() skip
}

const dayNumber = (date: string) => Date.parse(date + 'T00:00:00Z') / 86400000;

/**
 * Money-weighted yearly return in %, 1 dp (XIRR): the rate r at which the flows discount to zero, with each flow
 * at (days since the first flow) / 365 years. Newton from 10% a year, then bisection between -99.9999% and a very
 * high rate when Newton does not land on a root. Null when fewer than 2 non-zero flows, when the flows do not change
 * sign (no money in, or no money out), when every flow is on one day, when a date does not parse, or when no rate
 * fits. Order does not matter.
 */
export function xirr(flows: Flow[]): number | null {
  const rows = flows.filter((f) => finite(f.amount) && f.amount !== 0);
  if (rows.length < 2) return null;
  if (!rows.some((f) => f.amount > 0) || !rows.some((f) => f.amount < 0)) return null;
  const days = rows.map((f) => dayNumber(f.date));
  if (days.some((d) => !Number.isFinite(d))) return null;
  const t0 = Math.min(...days);
  const t = days.map((d) => (d - t0) / DAYS_PER_YEAR);
  if (Math.max(...t) === 0) return null; // everything on one day: no time for a yearly rate
  const amounts = rows.map((f) => f.amount);
  const scale = amounts.reduce((a, v) => a + Math.abs(v), 0);
  const npv = (r: number) => amounts.reduce((a, v, i) => a + v / Math.pow(1 + r, t[i]), 0);
  const slope = (r: number) => amounts.reduce((a, v, i) => a - (t[i] * v) / Math.pow(1 + r, t[i] + 1), 0);
  const isRoot = (r: number) => r > -1 && Math.abs(npv(r)) <= scale * 1e-9;
  const pct = (r: number) => r1(r * 100);

  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const f = npv(r);
    const d = slope(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -1) break;
    const done = Math.abs(next - r) < 1e-12 * Math.max(1, Math.abs(r));
    r = next;
    if (done) break;
  }
  if (isRoot(r)) return pct(r);

  // Bisection. Near -100% the latest flow dominates the NPV; at a huge rate the first flow does, so a sign change
  // sits between them whenever a yearly rate exists.
  let lo = -0.999999;
  while (!Number.isFinite(npv(lo)) && lo < -0.5) lo = -(1 - (1 + lo) * 10); // move away from -100% until the NPV is finite
  let hi = 1;
  let flo = npv(lo);
  let fhi = npv(hi);
  while (Number.isFinite(fhi) && flo * fhi > 0 && hi < 1e9) {
    hi *= 2;
    fhi = npv(hi);
  }
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300 && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (fm === 0) return pct(mid);
    if (flo * fm < 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  const root = (lo + hi) / 2;
  return isRoot(root) || hi - lo <= 1e-9 ? pct(root) : null;
}

/** The money a transaction moved before charges: its recorded amount, else shares x price. Null when nothing was traded. */
const tradeValue = (t: Txn): number | null =>
  !positive(t.shares) || !positive(t.price) ? null : positive(t.amount) ? t.amount : t.shares * t.price;

const KIND_ORDER: Record<FlowKind, number> = { buy: 0, sell: 1, dividend: 2, value: 3 };
const flowOrder = (a: Flow, b: Flow) => a.date.localeCompare(b.date) || KIND_ORDER[a.kind ?? 'buy'] - KIND_ORDER[b.kind ?? 'buy'];

/**
 * The cash flows of the account, oldest first: each buy as -(amount + charges), each sell as +(amount - charges),
 * each dividend receipt as +net, and the current value on `today` as a final inflow tagged kind 'value'. Charges
 * come from costs.txnCharges() with costRates(settings) (recorded when the transaction has them, else estimated).
 * Real cash is what matters here, so settings.match_nccpl is ignored. A transaction without positive shares and
 * price, a receipt without a finite net, and a current value that is not a finite number are left out.
 */
export function cashFlows(txns: Txn[], receipts: DividendReceipt[], currentValue: number, today: string, settings: Settings, rules: Rules = DEFAULT_RULES): Flow[] {
  const rates = costRates(settings, rules);
  const out: Flow[] = [];
  for (const t of txns) {
    const value = tradeValue(t);
    if (value == null) continue;
    const { charges } = txnCharges(t, rates);
    out.push(t.side === 'buy' ? { date: t.executed_on, amount: -(value + charges), kind: 'buy' } : { date: t.executed_on, amount: value - charges, kind: 'sell' });
  }
  for (const r of receipts) if (typeof r.paid_on === 'string' && finite(r.net)) out.push({ date: r.paid_on, amount: r.net, kind: 'dividend' });
  if (finite(currentValue)) out.push({ date: today, amount: currentValue, kind: 'value' });
  return out.sort(flowOrder);
}

// ---------------------------------------------------------------------------
// Total return
// ---------------------------------------------------------------------------

export interface TotalReturn {
  invested: number; // every buy: amount + its charges
  proceeds: number; // every sell: amount - its charges
  costs: number; // all charges, both sides
  dividends_gross: number;
  dividends_wht: number; // gross - net over the receipts: what was withheld
  dividends_net: number;
  current_value: number; // as passed in
  price_pnl: number; // current_value - cost of the lots still open (see totalReturn)
  realized_pnl: number; // gains and losses on the lots sold, net of both sides' charges (see totalReturn)
  total_return: number; // current_value + proceeds + dividends_net - invested
  total_return_pct: number | null; // total_return / invested x 100, 1 dp; null when nothing was invested
  xirr_pct: number | null; // xirr(cashFlows(...))
  first_date: string | null; // the earliest transaction or receipt date
}

/**
 * The account's return in rupees and %. `price_pnl` is exactly current_value minus the cost of the lots still
 * open: the buy price plus that buy's charges, matched FIFO per symbol by tax.buildLots(), ALWAYS with charges
 * (settings.match_nccpl is ignored here, this is real money). `realized_pnl` is the sum of the gains on the lots
 * sold (proceeds net of the sell's charges minus the same cost basis). When every sell is covered by recorded
 * buys, price_pnl + realized_pnl + dividends_net = total_return; shares sold beyond what the log holds carry a
 * zero realized gain, so their proceeds then show up only in total_return. Percentages are 1 dp.
 */
export function totalReturn(txns: Txn[], receipts: DividendReceipt[], currentValue: number, today: string, settings: Settings, rules: Rules = DEFAULT_RULES): TotalReturn {
  const rates = costRates(settings, rules);
  let invested = 0;
  let proceeds = 0;
  let costs = 0;
  let first: string | null = null;
  const earlier = (d: string) => { if (typeof d === 'string' && d && (first == null || d < first)) first = d; };
  for (const t of txns) {
    const value = tradeValue(t);
    if (value == null) continue;
    const { charges } = txnCharges(t, rates);
    costs += charges;
    if (t.side === 'buy') invested += value + charges;
    else proceeds += value - charges;
    earlier(t.executed_on);
  }
  let gross = 0;
  let net = 0;
  for (const r of receipts) {
    if (!finite(r.gross) || !finite(r.net)) continue;
    gross += r.gross;
    net += r.net;
    earlier(r.paid_on);
  }
  const book = buildLots(txns, { ...settings, match_nccpl: false }, rules);
  const openCost = book.open.reduce((a, l) => a + l.shares * l.cost_per_share, 0);
  const value = finite(currentValue) ? currentValue : 0;
  const total_return = r2(value + proceeds + net - invested);
  return {
    invested: r2(invested),
    proceeds: r2(proceeds),
    costs: r2(costs),
    dividends_gross: r2(gross),
    dividends_wht: r2(gross - net),
    dividends_net: r2(net),
    current_value: r2(value),
    price_pnl: r2(value - openCost),
    realized_pnl: r2(book.realized.reduce((a, l) => a + l.gain, 0)),
    total_return,
    total_return_pct: invested > 0 ? r1((total_return / invested) * 100) : null,
    xirr_pct: xirr(cashFlows(txns, receipts, value, today, settings, rules)),
    first_date: first,
  };
}

// ---------------------------------------------------------------------------
// KSE-100 benchmark
// ---------------------------------------------------------------------------

/** The usable index days, oldest first. A close that is 0, negative, NaN or missing is no close (the index never reads 0). */
const sortedIndex = (index: IndexDay[]): IndexDay[] =>
  index.filter((d) => typeof d.day === 'string' && positive(d.close)).sort((a, b) => a.day.localeCompare(b.day));

/** Position of the last day on or before `date` in a sorted index, or -1. */
function lastOnOrBefore(sorted: IndexDay[], date: string): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].day <= date) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function closeAt(sorted: IndexDay[], date: string, maxDaysBack: number): { day: string; close: number } | null {
  const i = lastOnOrBefore(sorted, date);
  if (i < 0) return null;
  const d = sorted[i];
  return daysBetween(d.day, date) <= maxDaysBack ? { day: d.day, close: d.close } : null;
}

/** Closing level on or before `date`, at most `maxDaysBack` calendar days back (default 7), else null. `index` need not be sorted. */
export function closeOn(index: IndexDay[], date: string, maxDaysBack: number = CLOSE_LOOKBACK_DAYS): { day: string; close: number } | null {
  return closeAt(sortedIndex(index), date, maxDaysBack);
}

export interface Benchmark {
  index_value: number; // what the covered flows into the index would be worth today (0 when nothing could be priced)
  index_return_pct: number | null; // (index_value + money out - money in) / money in, over the covered flows
  my_return_pct: number | null; // the same formula with my value = totalReturn().total_return_pct; null unless EVERY flow is covered (see benchmark)
  index_xirr_pct: number | null; // XIRR of the covered flows and index_value today
  my_xirr_pct: number | null; // XIRR of the flows and my value today; null unless every flow is covered
  diff_pkr: number | null; // my value - index value; null unless every flow is covered
  diff_pct: number | null; // my_xirr - index_xirr when both known, else my_return - index_return; null unless every flow is covered
  coverage: {
    from: string | null; // earliest index day used to price a flow
    uncovered_flows: number; // flows the index side could not take: no close within maxDaysBack (before the index history starts, or in a gap), or a sell / dividend beyond the index units the covered buys gave
    note: string | null;
  };
  index_latest: { day: string; close: number } | null; // the last close on or before today
}

/** Slack for "sold every unit": a sell whose units match the holding to within this fraction empties it rather than failing. */
const UNIT_SLACK = 1e-9;

/**
 * Units of the index a flow moves at `close`, applied to `units`: money in (negative amount) buys amount / close
 * units, money out sells that many. Null when the flow would sell more units than are held (allowing UNIT_SLACK):
 * the index side never bought them, because the buy was not recorded or could not be priced, so this flow cannot
 * be matched to the index. Selling everything leaves exactly 0, never a floating-point crumb.
 */
function applyFlow(units: number, amount: number, close: number): number | null {
  const next = units - amount / close;
  if (next < 0) return next >= -UNIT_SLACK * Math.max(1, units) ? 0 : null;
  return next;
}

/**
 * "What if every rupee had gone into the KSE-100 instead". Each buy buys amount / close units of the index on its
 * date (the last close on or before it, at most `maxDaysBack` calendar days back, default 7); sells and dividends
 * sell amount / close units at that day's close; the result is units x the latest close on or before `today`.
 * Pass the flows from cashFlows(): its final 'value' flow is ignored here.
 *
 * A flow the index side cannot take is uncovered: one with no close in reach (before the index history starts, or
 * in a gap), or a sell / dividend that would sell more index units than the covered buys gave (the buy was not
 * recorded, or came before the index history), which would otherwise leave the index side holding a negative
 * value. The index figures (index_value, index_return_pct, index_xirr_pct) are computed over the covered flows
 * only. `myValue` cannot be split the same way: it includes the shares the uncovered money bought (or excludes the
 * ones an uncovered sell sold), so comparing it with the covered flows would invent a return. When ANY flow is
 * uncovered, my_return_pct, my_xirr_pct, diff_pkr and diff_pct are therefore null and `coverage.note` says why;
 * when every flow is covered, my_return_pct equals totalReturn().total_return_pct. With no index close on or
 * before today, or no covered flow, there is nothing to compare: index_value is 0 (no units), the rest null.
 */
export function benchmark(flows: Flow[], myValue: number, index: IndexDay[], today: string, maxDaysBack: number = CLOSE_LOOKBACK_DAYS): Benchmark {
  const sorted = sortedIndex(index);
  const latestI = lastOnOrBefore(sorted, today);
  const index_latest = latestI >= 0 ? { day: sorted[latestI].day, close: sorted[latestI].close } : null;
  const real = flows.filter((f) => f.kind !== 'value' && finite(f.amount) && typeof f.date === 'string').sort(flowOrder);

  let units = 0;
  let unpriced = 0; // no close within reach
  let unmatched = 0; // a sell or dividend beyond the index units held
  let from: string | null = null;
  const covered: Flow[] = [];
  for (const f of real) {
    const c = index_latest ? closeAt(sorted, f.date, maxDaysBack) : null;
    if (!c) {
      unpriced++;
      continue;
    }
    const next = applyFlow(units, f.amount, c.close);
    if (next == null) {
      unmatched++;
      continue;
    }
    units = next;
    covered.push(f);
    if (from == null || c.day < from) from = c.day;
  }
  const priced = index_latest != null && covered.length > 0;
  const fair = priced && unpriced === 0 && unmatched === 0; // every flow is on both sides, so my value may be compared
  const index_value = priced ? r2(units * index_latest.close) : 0;
  const moneyIn = covered.reduce((a, f) => a + (f.amount < 0 ? -f.amount : 0), 0);
  const moneyOut = covered.reduce((a, f) => a + (f.amount > 0 ? f.amount : 0), 0);
  const returnPct = (finalValue: number) => (moneyIn > 0 ? r1(((finalValue + moneyOut - moneyIn) / moneyIn) * 100) : null);
  const my = finite(myValue) ? myValue : 0;
  const index_return_pct = priced ? returnPct(index_value) : null;
  const my_return_pct = fair ? returnPct(my) : null;
  const index_xirr_pct = priced ? xirr([...covered, { date: today, amount: index_value, kind: 'value' }]) : null;
  const my_xirr_pct = fair ? xirr([...covered, { date: today, amount: my, kind: 'value' }]) : null;
  const diff_pct = my_xirr_pct != null && index_xirr_pct != null
    ? r1(my_xirr_pct - index_xirr_pct)
    : my_return_pct != null && index_return_pct != null ? r1(my_return_pct - index_return_pct) : null;

  let note: string | null = null;
  if (!index_latest) note = 'No KSE-100 history on or before today, so there is nothing to compare yet.';
  else if (!real.length) note = 'No buys, sells or dividends to compare yet.';
  else if (unpriced > 0 || unmatched > 0) {
    const n = (k: number) => (k === 1 ? '1 flow' : `${k} flows`);
    const why: string[] = [];
    if (unpriced > 0) why.push(`${n(unpriced)} had no KSE-100 close within ${maxDaysBack} days (before the index history starts, or in a gap)`);
    if (unmatched > 0) why.push(`${n(unmatched)} (a sell or dividend) came from shares the index side never bought (the buy was not recorded, or came before the index history)`);
    note = `${why.join(' and ')}, so there is no fair comparison yet: it needs a KSE-100 close for every buy, sell and dividend.`;
  }

  return {
    index_value,
    index_return_pct,
    my_return_pct,
    index_xirr_pct,
    my_xirr_pct,
    diff_pkr: fair ? r2(my - index_value) : null,
    diff_pct,
    coverage: { from, uncovered_flows: unpriced + unmatched, note },
    index_latest,
  };
}

// ---------------------------------------------------------------------------
// Dividends
// ---------------------------------------------------------------------------

interface WhtEntry { filer_pct: number; non_filer_pct: number; sectors?: string[] }

/**
 * Withholding tax % on a cash dividend (Section 150) for a company in this PSX sector: the entry of
 * rules.tax.dividend_wht whose `sectors` list holds the sector (case does not matter), else `default`;
 * the filer or non-filer rate as asked. An unknown or missing sector gets the default.
 */
export function whtPct(sector: string | null | undefined, filer: boolean, rules: Rules = DEFAULT_RULES): number {
  const table = rules.tax.dividend_wht as unknown as Record<string, WhtEntry>;
  const want = sector ? sym(sector) : null;
  let entry = table.default;
  if (want) {
    for (const [key, e] of Object.entries(table)) {
      if (key === 'default' || !e.sectors) continue;
      if (e.sectors.some((s) => sym(s) === want)) {
        entry = e;
        break;
      }
    }
  }
  return filer ? entry.filer_pct : entry.non_filer_pct;
}

export interface ExpectedDividend {
  dividend_id: string; // the declaring announcement's id
  symbol: string;
  shares: number; // held at the end of the day before book closure started
  dps: number;
  gross: number; // shares x dps
  wht_pct: number;
  wht: number;
  net: number;
  book_closure_from: string;
  announced_on: string;
  verified: boolean; // the AI's figures were checked against the PDF
}

const receiptMatchDays = (rules: Rules) => {
  const v = (rules.dividends as unknown as { receipt_match_days?: unknown }).receipt_match_days;
  return finite(v) && v >= 0 ? v : RECEIPT_MATCH_DAYS;
};

/**
 * Declared cash dividends (events with a positive dps and a book_closure_from) on shares the user held at the end
 * of the day before book closure started (tax.sharesHeldOn), that are not yet in `receipts`. A receipt covers an
 * event when its dividend_id is the event's id, or, when it has no dividend_id, when it is the same symbol and was
 * paid 0..`receipt_match_days` days (rules.dividends, default RECEIPT_MATCH_DAYS) after book closure started.
 * Withholding tax from whtPct() with the symbol's sector in `sectors` and settings.tax_filer. Future book closures
 * are listed too (they are still "expected"); the caller filters by date when it wants only what is due. Newest
 * book closure first.
 */
export function expectedDividends(
  txns: Txn[], events: DividendEvent[], receipts: DividendReceipt[], sectors: Record<string, string | null | undefined>, settings: Settings, rules: Rules = DEFAULT_RULES,
): ExpectedDividend[] {
  const filer = filerOf(settings);
  const window = receiptMatchDays(rules);
  const covered = (e: DividendEvent, symbol: string, from: string) =>
    receipts.some((r) => {
      if (r.dividend_id) return r.dividend_id === e.id;
      if (sym(r.symbol) !== symbol || typeof r.paid_on !== 'string') return false;
      const gap = daysBetween(from, r.paid_on);
      return gap >= 0 && gap <= window;
    });
  const out: ExpectedDividend[] = [];
  for (const e of events) {
    if (!positive(e.dps) || !e.book_closure_from) continue;
    const symbol = sym(e.symbol);
    const shares = sharesHeldOn(txns, symbol, addDays(e.book_closure_from, -1));
    if (shares <= 0 || covered(e, symbol, e.book_closure_from)) continue;
    const gross = r2(shares * e.dps);
    const wht_pct = whtPct(sectors[symbol] ?? sectors[e.symbol], filer, rules);
    const wht = r2((gross * wht_pct) / 100);
    out.push({
      dividend_id: e.id, symbol, shares, dps: e.dps, gross, wht_pct, wht, net: r2(gross - wht),
      book_closure_from: e.book_closure_from, announced_on: e.announced_on, verified: e.verified === true,
    });
  }
  return out.sort((a, b) => b.book_closure_from.localeCompare(a.book_closure_from) || b.announced_on.localeCompare(a.announced_on) || a.symbol.localeCompare(b.symbol));
}

/** A receipt row from an expected dividend, ready to save once the credit shows up. paid_on defaults to book_closure_from. */
export function receiptFrom(e: ExpectedDividend, paidOn?: string): DividendReceipt {
  return {
    symbol: e.symbol, paid_on: paidOn ?? e.book_closure_from, shares: e.shares, dps: e.dps, gross: e.gross, wht_pct: e.wht_pct, net: e.net,
    dividend_id: e.dividend_id, note: null,
  };
}

/**
 * Dividends received per tax year (1 Jul-30 Jun, by paid_on), newest year first: gross, withheld (gross - net),
 * net, how many, and the net per symbol (biggest first). A receipt without a paid_on or without finite gross and
 * net is left out.
 */
export function dividendsByTaxYear(receipts: DividendReceipt[], rules: Rules = DEFAULT_RULES): { year: string; gross: number; wht: number; net: number; count: number; by_symbol: { symbol: string; net: number }[] }[] {
  const years = new Map<string, { gross: number; net: number; count: number; bySym: Map<string, number> }>();
  for (const r of receipts) {
    if (typeof r.paid_on !== 'string' || !r.paid_on || !finite(r.gross) || !finite(r.net)) continue;
    const year = taxYear(r.paid_on, rules);
    const y = years.get(year) ?? { gross: 0, net: 0, count: 0, bySym: new Map<string, number>() };
    y.gross += r.gross;
    y.net += r.net;
    y.count += 1;
    const s = sym(r.symbol);
    y.bySym.set(s, (y.bySym.get(s) ?? 0) + r.net);
    years.set(year, y);
  }
  return [...years]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, y]) => ({
      year, gross: r2(y.gross), wht: r2(y.gross - y.net), net: r2(y.net), count: y.count,
      by_symbol: [...y.bySym].map(([symbol, net]) => ({ symbol, net: r2(net) })).sort((a, b) => b.net - a.net || a.symbol.localeCompare(b.symbol)),
    }));
}

/**
 * Gross dividend income a year from today's holdings at today's yields: sum of shares x price x dividend_yield_pct
 * for every holding with a positive price and yield; `with_data` counts them and `without_data` lists the symbols
 * that have no price or no yield (PSX shows 0 for missing, so 0 counts as no data). Before withholding tax.
 */
export function expectedYearlyIncome(holdings: Holding[], prices: PriceMap): { gross: number; with_data: number; without_data: string[] } {
  let gross = 0;
  let with_data = 0;
  const without_data: string[] = [];
  for (const h of holdings) {
    const p = prices[h.symbol] ?? prices[sym(h.symbol)];
    if (!p || !positive(p.price) || !positive(p.dividend_yield_pct) || !finite(h.shares)) {
      without_data.push(h.symbol);
      continue;
    }
    gross += (h.shares * p.price * p.dividend_yield_pct) / 100;
    with_data++;
  }
  return { gross: r2(gross), with_data, without_data };
}

// ---------------------------------------------------------------------------
// Performance chart
// ---------------------------------------------------------------------------

/**
 * Series for the Performance chart, oldest first, one point per index day from the first flow's date to `today`:
 * `index_value` is the KSE-100-equivalent value of the flows so far (units bought and sold as in benchmark(), at
 * that day's close; null until the first flow that could be priced; a sell or dividend beyond the units held is
 * skipped on the index side, as in benchmark(), so the curve never goes below 0), `invested` is the net money in
 * so far (buys less sells and dividends taken out, every flow counted whether or not the index covered it), and
 * `my_value` is the portfolio snapshot of that day when one exists, else null. The final 'value' flow from
 * cashFlows() and flows after today are ignored. A day whose close is not a positive number is no index day.
 * Empty when there are no flows or no usable index days.
 */
export function valueSeries(flows: Flow[], index: IndexDay[], snapshots: PortfolioDay[], today: string, maxDaysBack: number = CLOSE_LOOKBACK_DAYS): { day: string; index_value: number | null; invested: number; my_value: number | null }[] {
  const sorted = sortedIndex(index);
  const real = flows
    .filter((f) => f.kind !== 'value' && finite(f.amount) && typeof f.date === 'string' && f.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!real.length || !sorted.length) return [];
  const first = real[0].date;
  const mine = new Map<string, number>();
  for (const s of snapshots) if (finite(s.value)) mine.set(s.day, s.value);
  const out: { day: string; index_value: number | null; invested: number; my_value: number | null }[] = [];
  let units = 0;
  let invested = 0;
  let priced = false;
  let i = 0;
  for (const d of sorted) {
    if (d.day < first) continue;
    if (d.day > today) break;
    while (i < real.length && real[i].date <= d.day) {
      const f = real[i++];
      invested -= f.amount;
      const c = closeAt(sorted, f.date, maxDaysBack);
      const next = c ? applyFlow(units, f.amount, c.close) : null;
      if (next != null) {
        units = next;
        priced = true;
      }
    }
    out.push({ day: d.day, index_value: priced ? r2(units * d.close) : null, invested: r2(invested), my_value: mine.get(d.day) ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Is the transaction log complete?
// ---------------------------------------------------------------------------

/**
 * Holdings the transaction log does not fully explain: the log's net shares (buys minus sells) for the symbol are
 * fewer than the holding's shares. Older buys made before the app (or a first screenshot import recorded without
 * transactions) leave such gaps. While any gap exists, total return, XIRR and the KSE-100 comparison would treat
 * those shares as free, so callers must fall back to the price-only figures from the average cost.
 */
export function logGaps(txns: Txn[], holdings: Pick<Holding, 'symbol' | 'shares'>[]): { symbol: string; held: number; logged: number }[] {
  const out: { symbol: string; held: number; logged: number }[] = [];
  for (const h of holdings) {
    const logged = sharesHeldOn(txns, h.symbol, '9999-12-31');
    if (logged < h.shares) out.push({ symbol: sym(h.symbol), held: h.shares, logged });
  }
  return out;
}

/**
 * KSE-100 comparison when the buy history is incomplete: the first nightly snapshot (`portfolio_daily`) is the opening
 * position, as if that day's value had been invested in both. Buys, sells and dividends after that day are added on
 * both sides, as in benchmark(). Null until the night job has stored a snapshot. The figures cover only the days since
 * `start`.
 */
export function benchmarkFromSnapshot(snapshots: PortfolioDay[], txns: Txn[], receipts: DividendReceipt[], myValue: number,
  index: IndexDay[], today: string, settings: Settings, rules: Rules = DEFAULT_RULES): { start: PortfolioDay; bm: Benchmark } | null {
  const start = [...snapshots].filter((s) => finite(s.value) && s.value > 0 && s.day <= today).sort((a, b) => a.day.localeCompare(b.day))[0];
  if (!start) return null;
  const later = cashFlows(txns, receipts, myValue, today, settings, rules).filter((f) => f.kind !== 'value' && f.date > start.day);
  const flows: Flow[] = [{ date: start.day, amount: -start.value, kind: 'buy' }, ...later];
  return { start, bm: benchmark(flows, myValue, index, today) };
}

/** Net dividends received in total (all receipts), for "total return = price profit/loss + dividends". */
export const dividendsReceivedNet = (receipts: DividendReceipt[]) => r2(receipts.reduce((a, r) => a + (finite(r.net) ? r.net : 0), 0));

/**
 * The one headline return the app shows everywhere (Home, Portfolio, Performance): profit/loss of what you hold on
 * your average cost plus every dividend received (net of tax), as % of that cost. Price-only is the same minus dividends.
 */
export function headlineReturn(view: { total_pnl: number; total_cost: number; total_pnl_pct: number | null }, receipts: DividendReceipt[]):
  { total: number; pct: number | null; dividends: number; price_only: number; price_only_pct: number | null } {
  const dividends = dividendsReceivedNet(receipts);
  const total = r2(view.total_pnl + dividends);
  return { total, pct: view.total_cost > 0 ? r1((total / view.total_cost) * 100) : null, dividends, price_only: r2(view.total_pnl), price_only_pct: view.total_pnl_pct };
}
