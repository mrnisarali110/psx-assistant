/**
 * Capital gains tax on PSX shares the way NCCPL computes it (Section 37A): FIFO lots per symbol, gains and losses
 * netted across all stocks within the tax year (1 Jul-30 Jun), losses carried forward up to 3 tax years for filers,
 * only realized results count, dividends are not capital gains. The rate comes from the rules.tax.cgt band that
 * holds the lot's BUY date. Also the Sell Planner: what a planned sale does to this year's CGT and which losing
 * holdings would cut it. Every rate is a setting or a rule; money is rupees rounded to the paisa.
 */
import type { Rules, Settings, Txn } from './types.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS } from './types.ts';
import { costRates, tradeCosts, txnCharges } from './costs.ts';
import { addDays } from './time.ts';
import { rs, signedRs } from './format.ts';

const r2 = (v: number) => {
  const x = Math.round(v * 100) / 100;
  return x === 0 ? 0 : x; // never -0
};
const positive = (v: number) => Number.isFinite(v) && v > 0;
/** A rupee figure from a saved settings map may be missing or NaN: count it as 0. */
const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pad2 = (n: number) => String(n).padStart(2, '0');
const sym = (s: string) => s.trim().toUpperCase();
const filerOf = (s: Settings) => s.tax_filer ?? DEFAULT_SETTINGS.tax_filer;
const matchOf = (s: Settings) => s.match_nccpl === true;

// ---------------------------------------------------------------------------
// Tax years
// ---------------------------------------------------------------------------

/** '2026-27' for the tax year that starts in calendar year `start`. */
const yearLabel = (start: number) => `${start}-${pad2((start + 1) % 100)}`;
/** The calendar year a tax year label starts in: '2026-27' -> 2026. */
const yearStart = (label: string) => Number(label.slice(0, 4));

/**
 * The tax year a date falls in, labelled by its start year and the last two digits of its end year:
 * '2026-10-15' -> '2026-27', '2026-06-30' -> '2025-26'. A tax year starts on the first day of
 * rules.tax.tax_year_start_month (July) and ends the day before the next one.
 */
export function taxYear(date: string, rules: Rules = DEFAULT_RULES): string {
  const [y, m] = date.split('-').map(Number);
  return yearLabel(m >= rules.tax.tax_year_start_month ? y : y - 1);
}

/** First and last day of a tax year: '2026-27' -> 2026-07-01..2027-06-30. */
export function taxYearBounds(year: string, rules: Rules = DEFAULT_RULES): { from: string; to: string } {
  const start = yearStart(year);
  const mm = pad2(rules.tax.tax_year_start_month);
  return { from: `${start}-${mm}-01`, to: addDays(`${start + 1}-${mm}-01`, -1) };
}

/** The `n` tax years before `year`, most recent first: previousTaxYears('2026-27', 3) -> ['2025-26', '2024-25', '2023-24']. */
export function previousTaxYears(year: string, n: number): string[] {
  const start = yearStart(year);
  return Array.from({ length: Math.max(0, Math.floor(n)) }, (_, i) => yearLabel(start - 1 - i));
}

// ---------------------------------------------------------------------------
// CGT rate
// ---------------------------------------------------------------------------

/** One band of rules.tax.cgt: flat filer / non-filer rates, or a slab by full years held. */
interface CgtBand {
  bought_from: string;
  bought_to: string;
  filer_pct?: number;
  non_filer_pct?: number;
  by_holding_years?: boolean;
  filer_slab_pct?: number[];
  non_filer_slab_pct?: number[];
}

/** Full years between two dates by anniversary: 2023-01-15 to 2024-01-14 is 0, to 2024-01-15 is 1. Never negative. */
function fullYearsHeld(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const years = ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0);
  return Math.max(0, years);
}

/**
 * CGT rate (%) for a lot bought on `buyDate` and sold on `sellDate`, from the rules.tax.cgt band that holds the
 * BUY date. A flat band gives its filer or non-filer rate. The 2022-07-01..2024-06-30 band is a slab indexed by
 * full years held between buy and sell (anniversary to anniversary, 0 = under a year); past the last slab the last
 * rate applies. 0 when no band holds the buy date (the shipped table covers every date).
 */
export function cgtRatePct(buyDate: string, sellDate: string, filer: boolean, rules: Rules = DEFAULT_RULES): number {
  const bands: CgtBand[] = rules.tax.cgt;
  const band = bands.find((b) => buyDate >= b.bought_from && buyDate <= b.bought_to);
  if (!band) return 0;
  if (band.by_holding_years) {
    const slab = (filer ? band.filer_slab_pct : band.non_filer_slab_pct) ?? [];
    return slab.length ? slab[Math.min(slab.length - 1, fullYearsHeld(buyDate, sellDate))] : 0;
  }
  return (filer ? band.filer_pct : band.non_filer_pct) ?? 0;
}

// ---------------------------------------------------------------------------
// FIFO lots
// ---------------------------------------------------------------------------

export interface Lot {
  symbol: string;
  bought_on: string;
  shares: number; // still open
  cost_per_share: number; // includes the buy's charges unless settings.match_nccpl; not rounded (round when displaying)
  txn_id?: string;
  estimated_costs?: boolean; // the charges inside cost_per_share were estimated from the rates (never with match_nccpl)
}

export interface Realized {
  symbol: string;
  bought_on: string;
  sold_on: string;
  shares: number;
  cost_per_share: number; // as on the lot; not rounded
  proceeds_per_share: number; // sell price less the sell's charges per share, unless match_nccpl; not rounded
  gain: number; // shares x (proceeds_per_share - cost_per_share), rupees to the paisa; negative = loss
  rate_pct: number; // cgtRatePct for this lot's buy date and the sell date
  tax_year: string; // of the sell date
  estimated_costs: boolean; // the gain relies on charges estimated from the rates (never with match_nccpl)
}

export interface LotBook {
  open: Lot[];
  realized: Realized[];
  warnings: string[]; // e.g. "Sold 20 SYS on 2026-09-01 but only 10 were held: the extra shares were matched at the sell price (add the missing buy)"
}

/** Oldest first; on the same day buys before sells, then by id. */
const txnOrder = (a: Txn, b: Txn) =>
  a.executed_on.localeCompare(b.executed_on)
  || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1)
  || (a.id ?? '').localeCompare(b.id ?? '');

interface Sale { symbol: string; shares: number; price: number; date: string; charges: number; estimated: boolean }

/**
 * Sell `sale.shares` out of `open` FIFO (oldest lot of the symbol first). `open` is not mutated: the lots that
 * remain come back in their original order. Shares beyond what is held are matched at the sell price (zero gain)
 * as one extra realized row with bought_on = the sell date; `unmatched` says how many.
 */
function sellFifo(open: Lot[], sale: Sale, filer: boolean, match: boolean, rules: Rules): { open: Lot[]; realized: Realized[]; unmatched: number } {
  const pps = match ? sale.price : (sale.shares * sale.price - sale.charges) / sale.shares;
  const tax_year = taxYear(sale.date, rules);
  const realized: Realized[] = [];
  const taken = new Map<Lot, number>();
  let left = sale.shares;
  const mine = open.filter((l) => l.symbol === sale.symbol).sort((a, b) => a.bought_on.localeCompare(b.bought_on));
  for (const lot of mine) {
    if (left <= 0) break;
    const take = Math.min(lot.shares, left);
    left -= take;
    taken.set(lot, take);
    realized.push({
      symbol: sale.symbol, bought_on: lot.bought_on, sold_on: sale.date, shares: take,
      cost_per_share: lot.cost_per_share, proceeds_per_share: pps, gain: r2(take * (pps - lot.cost_per_share)),
      rate_pct: cgtRatePct(lot.bought_on, sale.date, filer, rules), tax_year,
      estimated_costs: !match && (sale.estimated || lot.estimated_costs === true),
    });
  }
  if (left > 0) {
    realized.push({
      symbol: sale.symbol, bought_on: sale.date, sold_on: sale.date, shares: left, cost_per_share: pps, proceeds_per_share: pps,
      gain: 0, rate_pct: cgtRatePct(sale.date, sale.date, filer, rules), tax_year, estimated_costs: false,
    });
  }
  const next = open.flatMap((l) => {
    const t = taken.get(l);
    if (t == null) return [l];
    return l.shares - t > 0 ? [{ ...l, shares: l.shares - t }] : [];
  });
  return { open: next, realized, unmatched: left };
}

const heldIn = (open: Lot[], symbol: string) => open.reduce((a, l) => (l.symbol === symbol ? a + l.shares : a), 0);

/**
 * Replay transactions oldest first (tie: buys before sells, then id) into FIFO lots per symbol. Each transaction's
 * charges come from costs.txnCharges() (recorded when known, else estimated and flagged); with settings.match_nccpl
 * the cost basis and the proceeds ignore charges, as NCCPL does. Sells beyond what is held are matched at the sell
 * price (zero gain) and reported in `warnings`, never thrown; a transaction without positive shares and price is
 * skipped with a warning. Symbols are trimmed and upper-cased.
 */
export function buildLots(txns: Txn[], settings: Settings, rules: Rules = DEFAULT_RULES): LotBook {
  const rates = costRates(settings, rules);
  const filer = filerOf(settings);
  const match = matchOf(settings);
  let open: Lot[] = [];
  const realized: Realized[] = [];
  const warnings: string[] = [];
  for (const t of [...txns].sort(txnOrder)) {
    const symbol = sym(t.symbol);
    if (!positive(t.shares) || !positive(t.price)) {
      warnings.push(`Ignored a ${t.side} of ${symbol} on ${t.executed_on}: shares or price missing.`);
      continue;
    }
    const { charges, estimated } = match ? { charges: 0, estimated: false } : txnCharges(t, rates);
    if (t.side === 'buy') {
      open.push({
        symbol, bought_on: t.executed_on, shares: t.shares, cost_per_share: (t.shares * t.price + charges) / t.shares,
        ...(t.id ? { txn_id: t.id } : {}), estimated_costs: estimated,
      });
      continue;
    }
    const held = heldIn(open, symbol);
    const r = sellFifo(open, { symbol, shares: t.shares, price: t.price, date: t.executed_on, charges, estimated }, filer, match, rules);
    open = r.open;
    realized.push(...r.realized);
    if (r.unmatched > 0) {
      warnings.push(`Sold ${t.shares} ${symbol} on ${t.executed_on} but ${held > 0 ? `only ${held} were` : 'none were'} held: the extra shares were matched at the sell price (add the missing buy)`);
    }
  }
  return { open, realized, warnings };
}

/** Shares of `symbol` held at the end of `date` (buys minus sells executed on or before it), never below 0. For "shares held at book closure". */
export function sharesHeldOn(txns: Txn[], symbol: string, date: string): number {
  const s = sym(symbol);
  let n = 0;
  for (const t of txns) {
    if (sym(t.symbol) !== s || t.executed_on > date || !positive(t.shares)) continue;
    n += t.side === 'buy' ? t.shares : -t.shares;
  }
  return Math.max(0, n);
}

// ---------------------------------------------------------------------------
// Tax year ledger
// ---------------------------------------------------------------------------

export interface TaxYearLedger {
  year: string;
  gains: number; // sum of the positive realized gains
  losses: number; // sum of the realized losses, as a positive number
  net: number; // gains - losses
  carry_forward_in: number; // prior years' losses still unused on the first day of the year (filers only): settings.loss_carry_forward less what the years in between set off, see carryIn
  carry_used: number; // how much of carry_forward_in this year's net gain uses up: min(carry_forward_in, max(0, net))
  carry_left: number; // carry_forward_in - carry_used: unused after this year (the oldest year's share lapses once its 3 years are up)
  taxable: number; // max(0, net - carry_forward_in)
  cgt_estimate: number; // see taxYearLedger
  cgt_paid: number; // settings.cgt_paid[year] ?? 0
  cgt_due: number; // cgt_estimate - cgt_paid; negative = refund due
  by_symbol: { symbol: string; gain: number; shares: number }[]; // biggest gain first
  rates_used: number[]; // distinct rates on the lots with a non-zero gain, ascending
  mixed_rates: boolean; // more than one rate: cgt_estimate is an estimate (see taxYearLedger)
  loss_to_carry: number; // this year's net loss a filer can carry into the next 3 tax years (0 for a gain or a non-filer)
}

/**
 * Prior years' losses still unused on the first day of `year`, keyed by the tax year of the loss (filer or not is
 * the caller's check). settings.loss_carry_forward holds each year's net loss as carryForwardFrom() reported it,
 * recorded once at year end; a negative, missing or NaN figure counts as nothing. Each loss is set off against the
 * positive net of the years that follow it, as the lot book shows them, oldest loss first (it lapses first), and
 * only within rules.tax.loss_carry_forward_years years of the loss: what those years used up is not there for
 * `year`. A gain the log shows in the loss year itself does not eat that year's recorded loss (the recorded figure
 * is already the year's net). Losses the lot book shows for a prior year are not added here: the app records them
 * in settings when the year closes, so nothing counts twice.
 */
function carryIn(book: LotBook, year: string, settings: Settings, rules: Rules): Map<string, number> {
  const n = rules.tax.loss_carry_forward_years;
  const target = yearStart(year);
  const pool = new Map<number, number>(); // start year of the loss -> rupees still unused
  for (const [label, v] of Object.entries(settings.loss_carry_forward ?? {})) {
    const start = yearStart(label);
    const loss = Math.max(0, money(v));
    if (label !== yearLabel(start) || start >= target || loss === 0) continue;
    pool.set(start, loss);
  }
  if (pool.size) {
    const netOf = new Map<string, number>();
    for (const r of book.realized) netOf.set(r.tax_year, (netOf.get(r.tax_year) ?? 0) + r.gain);
    const lossYears = [...pool.keys()].sort((a, b) => a - b);
    for (let z = lossYears[0] + 1; z < target; z++) {
      let gain = r2(netOf.get(yearLabel(z)) ?? 0);
      for (const y of lossYears) {
        if (gain <= 0) break;
        if (y >= z || y < z - n) continue; // the loss year itself, or a loss that had lapsed by then
        const used = Math.min(pool.get(y)!, gain);
        pool.set(y, pool.get(y)! - used);
        gain -= used;
      }
    }
  }
  const out = new Map<string, number>();
  for (const y of previousTaxYears(year, n)) {
    const left = pool.get(yearStart(y));
    if (left) out.set(y, r2(left));
  }
  return out;
}

/**
 * The ledger for one tax year from the lot book. CGT: positive gains are grouped by rate; the losses of the year
 * plus the carry-forward offset the gains at the HIGHEST rate first; what is left of each group pays its own
 * rate. When every lot shares one rate this is exactly max(0, net - carry_forward_in) x rate. With mixed rates it
 * is an estimate (NCCPL's own netting order is not published), flagged by `mixed_rates`. Losses carry forward and
 * carry-forward is deducted for filers only; carry_forward_in is what the years in between left unused (see
 * carryIn), and carry_used / carry_left say how much of it this year takes and what remains. Lots with a zero gain
 * (including shares matched at the sell price) count in by_symbol but not in rates_used.
 */
export function taxYearLedger(book: LotBook, year: string, settings: Settings, rules: Rules = DEFAULT_RULES): TaxYearLedger {
  const filer = filerOf(settings);
  const rows = book.realized.filter((r) => r.tax_year === year);
  const gains = r2(rows.reduce((a, r) => a + Math.max(0, r.gain), 0));
  const losses = r2(rows.reduce((a, r) => a - Math.min(0, r.gain), 0));
  const net = r2(gains - losses);
  const carry_forward_in = filer ? r2([...carryIn(book, year, settings, rules).values()].reduce((a, v) => a + v, 0)) : 0;
  const carry_used = r2(Math.min(carry_forward_in, Math.max(0, net)));
  const carry_left = r2(carry_forward_in - carry_used);
  const taxable = r2(Math.max(0, net - carry_forward_in));

  const byRate = new Map<number, number>();
  for (const r of rows) if (r.gain > 0) byRate.set(r.rate_pct, (byRate.get(r.rate_pct) ?? 0) + r.gain);
  let offset = losses + carry_forward_in;
  let cgt = 0;
  for (const [rate, gain] of [...byRate].sort((a, b) => b[0] - a[0])) {
    const used = Math.min(gain, offset);
    offset -= used;
    cgt += ((gain - used) * rate) / 100;
  }
  const cgt_estimate = r2(cgt);
  const cgt_paid = r2(money(settings.cgt_paid?.[year]));

  const bySym = new Map<string, { gain: number; shares: number }>();
  for (const r of rows) {
    const s = bySym.get(r.symbol) ?? { gain: 0, shares: 0 };
    s.gain += r.gain;
    s.shares += r.shares;
    bySym.set(r.symbol, s);
  }
  const by_symbol = [...bySym]
    .map(([symbol, s]) => ({ symbol, gain: r2(s.gain), shares: s.shares }))
    .sort((a, b) => b.gain - a.gain || a.symbol.localeCompare(b.symbol));
  const rates_used = [...new Set(rows.filter((r) => r.gain !== 0).map((r) => r.rate_pct))].sort((a, b) => a - b);

  return {
    year, gains, losses, net, carry_forward_in, carry_used, carry_left, taxable, cgt_estimate, cgt_paid, cgt_due: r2(cgt_estimate - cgt_paid),
    by_symbol, rates_used, mixed_rates: rates_used.length > 1, loss_to_carry: filer && net < 0 ? -net : 0,
  };
}

/**
 * The net loss of a year a filer can carry into the next 3 tax years: what to record under
 * settings.loss_carry_forward[year] once, when the year closes. Later years' ledgers work out how much of it they
 * use from the lot book (carry_forward_in, carry_used, carry_left), so the recorded figure is never edited down.
 */
export const carryForwardFrom = (ledger: TaxYearLedger): number => ledger.loss_to_carry;

// ---------------------------------------------------------------------------
// Sell Planner
// ---------------------------------------------------------------------------

export interface PlannedSale { symbol: string; shares: number; price: number }

export interface SalePlanLine {
  symbol: string;
  shares: number;
  price: number;
  proceeds: number; // shares x price, before charges
  cost: number; // cost basis of the lots sold (with the buys' charges unless match_nccpl)
  gain: number; // the taxable gain NCCPL would see: sum of the lots' gains
  lots: Realized[]; // one row per lot taken, oldest first; a last row for shares not in the log (zero gain)
  rate_pct: number; // one rate when all lots share it, else the shares-weighted average (2 dp); each lot carries its own
  costs: number; // sell-side charges estimated from the rates (a plan has no contract note)
  estimated_costs: boolean; // the gain relies on those estimated charges: true unless match_nccpl
  warning?: string;
}

export interface SalePlan {
  lines: SalePlanLine[];
  net_gain: number; // this plan
  year_before: TaxYearLedger;
  year_after: TaxYearLedger;
  cgt_change: number; // year_after.cgt_estimate - year_before.cgt_estimate
  cgt_next_month: number; // cash NCCPL will take next month for this plan: max(0, after.cgt_due) - max(0, before.cgt_due), floor 0
  proceeds_net: number; // cash you receive after charges: sum of proceeds - costs
}

/**
 * Simulate selling `plan` on `today` out of the current lot book, FIFO, at the given prices, with the user's cost
 * and tax settings. The book is not changed. Lines keep the plan's order; a line whose shares or price is not
 * positive is all zeros with a warning. Shares beyond what the log holds are matched at the sell price (zero
 * gain) with a warning, as buildLots does.
 */
export function planSales(book: LotBook, plan: PlannedSale[], today: string, settings: Settings, rules: Rules = DEFAULT_RULES): SalePlan {
  const rates = costRates(settings, rules);
  const filer = filerOf(settings);
  const match = matchOf(settings);
  const year = taxYear(today, rules);
  const year_before = taxYearLedger(book, year, settings, rules);
  let open = book.open;
  const realized: Realized[] = [];
  const lines: SalePlanLine[] = [];
  for (const p of plan) {
    const symbol = sym(p.symbol);
    if (!positive(p.shares) || !positive(p.price)) {
      lines.push({
        symbol, shares: p.shares, price: p.price, proceeds: 0, cost: 0, gain: 0, lots: [], rate_pct: 0, costs: 0, estimated_costs: false,
        warning: `Shares or price missing for ${symbol}.`,
      });
      continue;
    }
    const costs = tradeCosts(p.shares, p.price, rates).total;
    const held = heldIn(open, symbol);
    const r = sellFifo(open, { symbol, shares: p.shares, price: p.price, date: today, charges: costs, estimated: true }, filer, match, rules);
    open = r.open;
    realized.push(...r.realized);
    const line: SalePlanLine = {
      symbol, shares: p.shares, price: p.price, proceeds: r2(p.shares * p.price),
      cost: r2(r.realized.reduce((a, l) => a + l.shares * l.cost_per_share, 0)),
      gain: r2(r.realized.reduce((a, l) => a + l.gain, 0)),
      lots: r.realized,
      rate_pct: r2(r.realized.reduce((a, l) => a + l.shares * l.rate_pct, 0) / p.shares),
      costs, estimated_costs: !match,
    };
    if (r.unmatched > 0) {
      const where = held > 0 ? `Only ${held} of the ${p.shares} ${symbol} planned are in the transaction log` : `No ${symbol} buys are in the transaction log`;
      line.warning = `${where}: the ${r.unmatched} unmatched shares count at the sell price (zero gain). Add the missing buy.`;
    }
    lines.push(line);
  }
  const after: LotBook = { open, realized: [...book.realized, ...realized], warnings: book.warnings };
  const year_after = taxYearLedger(after, year, settings, rules);
  return {
    lines,
    net_gain: r2(lines.reduce((a, l) => a + l.gain, 0)),
    year_before,
    year_after,
    cgt_change: r2(year_after.cgt_estimate - year_before.cgt_estimate),
    cgt_next_month: r2(Math.max(0, Math.max(0, year_after.cgt_due) - Math.max(0, year_before.cgt_due))),
    proceeds_net: r2(lines.reduce((a, l) => a + l.proceeds - l.costs, 0)),
  };
}

export interface OffsetSuggestion {
  symbol: string;
  shares: number;
  price: number;
  loss: number; // negative
  cgt_saved: number;
  text: string; // "Selling LUCK (-Rs 3,000) as well would cut CGT by Rs 450."
}

/**
 * Loss-making holdings NOT in the plan whose sale would cut the year's CGT after this plan. `candidates` is the
 * caller's list of holdings it is willing to suggest (already filtered to review status / thesis broken / trim
 * calls: tax alone must not drive a sale). Each candidate is simulated on its own on top of the plan (the savings
 * of several do not simply add up). Only candidates whose FIFO gain at `price` is a loss and that save something
 * are returned, sorted by cgt_saved desc (tie: bigger loss first). Nothing when the CGT after the plan is already 0.
 */
export function suggestOffsets(
  book: LotBook, plan: PlannedSale[], candidates: { symbol: string; shares: number; price: number }[], today: string,
  settings: Settings, rules: Rules = DEFAULT_RULES,
): OffsetSuggestion[] {
  const base = planSales(book, plan, today, settings, rules);
  if (base.year_after.cgt_estimate <= 0) return [];
  const seen = new Set(plan.map((p) => sym(p.symbol)));
  const out: OffsetSuggestion[] = [];
  for (const c of candidates) {
    const symbol = sym(c.symbol);
    if (seen.has(symbol) || !positive(c.shares) || !positive(c.price)) continue;
    seen.add(symbol);
    const withIt = planSales(book, [...plan, { symbol, shares: c.shares, price: c.price }], today, settings, rules);
    const line = withIt.lines[withIt.lines.length - 1];
    if (line.gain >= 0) continue;
    const cgt_saved = r2(base.year_after.cgt_estimate - withIt.year_after.cgt_estimate);
    if (cgt_saved <= 0) continue;
    out.push({
      symbol, shares: c.shares, price: c.price, loss: line.gain, cgt_saved,
      text: `Selling ${symbol} (${signedRs(line.gain)}) as well would cut CGT by ${rs(cgt_saved)}.`,
    });
  }
  return out.sort((a, b) => b.cgt_saved - a.cgt_saved || a.loss - b.loss || a.symbol.localeCompare(b.symbol));
}
