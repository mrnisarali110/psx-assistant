/**
 * Trading costs on one side of a PSX trade (a buy or a sell): broker commission with the per-share minimum,
 * sales tax on it, the exchange fee, the SECP levy and the CDC charge.
 * Every rate comes from the user's settings or rules.json; nothing is a constant in code.
 * Money is rupees, each line rounded to the paisa.
 * A price that is missing or not positive gives null from the per-price helpers, never a made-up figure.
 */
import type { Rules, Settings, Txn } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { rs2 } from './format.ts';

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
/** A rate from a saved settings blob may be missing (older versions) or NaN; fall back to the rule default. */
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** A usable quantity or price: a positive finite number. null, undefined, 0, NaN, Infinity and negatives are not. */
const positive = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export interface CostRates {
  commission_pct: number; // broker commission, % of trade value per side
  min_commission_per_share: number; // rupees per share per side; applies when it is more than the % commission
  sales_tax_pct: number; // provincial sales tax on the commission, %
  psx_fee_pct: number; // exchange trading fee, % of value
  secp_levy_pct: number; // SECP levy, % of value
  cdc_per_share: number; // CDC charge, rupees per share
}

/** Rates from the user's settings (commission, minimum, sales tax), fixed exchange fees from rules.json. */
export function costRates(
  settings: Pick<Settings, 'commission_pct' | 'min_commission_per_share' | 'sales_tax_pct'>,
  rules: Rules = DEFAULT_RULES,
): CostRates {
  const c = rules.costs;
  return {
    commission_pct: num(settings.commission_pct, c.commission_pct),
    min_commission_per_share: num(settings.min_commission_per_share, c.min_commission_per_share),
    sales_tax_pct: num(settings.sales_tax_pct, c.sales_tax_pct),
    psx_fee_pct: c.psx_fee_pct,
    secp_levy_pct: c.secp_levy_pct,
    cdc_per_share: c.cdc_per_share,
  };
}

export interface TradeCosts {
  value: number; // shares x price
  commission: number;
  sales_tax: number;
  psx_fee: number;
  secp_levy: number;
  cdc: number;
  total: number; // sum of the five lines above
  pct: number; // total / value x 100, 2 dp (0 when value is 0)
}

/** The five cost lines before rounding, for one side of `shares` at `price`. Zero when shares or price is not positive. */
function rawCosts(shares: number, price: number, rates: CostRates) {
  if (!positive(shares) || !positive(price)) return { value: 0, commission: 0, sales_tax: 0, psx_fee: 0, secp_levy: 0, cdc: 0 };
  const value = shares * price;
  const commission = Math.max((rates.commission_pct / 100) * value, rates.min_commission_per_share * shares);
  return {
    value,
    commission,
    sales_tax: (rates.sales_tax_pct / 100) * commission,
    psx_fee: (rates.psx_fee_pct / 100) * value,
    secp_levy: (rates.secp_levy_pct / 100) * value,
    cdc: rates.cdc_per_share * shares,
  };
}

/**
 * Costs on one side (a buy or a sell) of `shares` at `price`.
 * commission = max(commission_pct% x value, min_commission_per_share x shares); sales tax is charged on the commission.
 * Each line is rounded to the paisa and `total` is the sum of the rounded lines, so the parts always add up as
 * they would on a contract note. Shares or price that are not positive give all zeros (nothing traded).
 */
export function tradeCosts(shares: number, price: number, rates: CostRates): TradeCosts {
  const raw = rawCosts(shares, price, rates);
  const value = r2(raw.value);
  const commission = r2(raw.commission);
  const sales_tax = r2(raw.sales_tax);
  const psx_fee = r2(raw.psx_fee);
  const secp_levy = r2(raw.secp_levy);
  const cdc = r2(raw.cdc);
  const total = r2(commission + sales_tax + psx_fee + secp_levy + cdc);
  return { value, commission, sales_tax, psx_fee, secp_levy, cdc, total, pct: value > 0 ? r2((total / value) * 100) : 0 };
}

/** What the shares really cost you: value + costs. `per_share` is total / shares to 4 dp (0 when no shares). */
export function buyCostBasis(shares: number, price: number, rates: CostRates): { total: number; per_share: number; costs: TradeCosts } {
  const costs = tradeCosts(shares, price, rates);
  const total = r2(costs.value + costs.total);
  return { total, per_share: positive(shares) ? r4(total / shares) : 0, costs };
}

/** What you really receive: value - costs. `per_share` is total / shares to 4 dp (0 when no shares). */
export function sellProceeds(shares: number, price: number, rates: CostRates): { total: number; per_share: number; costs: TradeCosts } {
  const costs = tradeCosts(shares, price, rates);
  const total = r2(costs.value - costs.total);
  return { total, per_share: positive(shares) ? r4(total / shares) : 0, costs };
}

/** The per-share minimum commission as a % of a positive price. */
const minCommissionPct = (price: number, rates: CostRates) => (rates.min_commission_per_share / price) * 100;

/**
 * Commission % per side before sales tax, as it really applies at this price:
 * max(commission_pct, min_commission_per_share / price x 100), 2 dp.
 * Null when the price is missing or not positive: the per-share minimum cannot be expressed as a % of no price,
 * so there is no honest figure (show "no data").
 */
export function effectiveCommissionPct(price: number | null | undefined, rates: CostRates): number | null {
  if (!positive(price)) return null;
  return r2(Math.max(rates.commission_pct, minCommissionPct(price, rates)));
}

/**
 * Buy + sell costs as % of value for one share at this price (commission at the effective rate, sales tax, PSX fee,
 * SECP levy and CDC), 2 dp. Both sides cost the same at the same price, so this is twice one side.
 * Null when the price is missing or not positive (the per-share parts cannot be expressed as a % of no price).
 */
export function roundTripPct(price: number | null | undefined, rates: CostRates): number | null {
  if (!positive(price)) return null;
  const c = rawCosts(1, price, rates);
  return r2(((2 * (c.commission + c.sales_tax + c.psx_fee + c.secp_levy + c.cdc)) / price) * 100);
}

/**
 * Null, or a one-line warning when a buy and sell at this price would cost more than rules.costs.round_trip_warn_pct
 * of the trade (cheap shares, where the per-share minimum commission bites). The 2 dp figure that is shown is what
 * is compared, so a round trip that reads exactly as the threshold is not a warning. Null when the price is missing
 * or not positive.
 */
export function cheapShareWarning(price: number | null | undefined, rates: CostRates, rules: Rules = DEFAULT_RULES): string | null {
  if (!positive(price)) return null;
  const trip = roundTripPct(price, rates);
  if (trip == null || trip <= rules.costs.round_trip_warn_pct) return null;
  let why = '';
  if (minCommissionPct(price, rates) > rates.commission_pct && rates.commission_pct > 0) {
    const breakEven = (rates.min_commission_per_share / rates.commission_pct) * 100; // the price where % and minimum meet
    why = `, as the ${rs2(rates.min_commission_per_share)}/share minimum commission bites below ${rs2(breakEven)}`;
  }
  return `Cheap share: a buy and sell at ${rs2(price)} costs about ${trip.toFixed(2)}% in charges${why}.`;
}

/**
 * The charges to use for a transaction: its recorded `charges` when known (even 0), else an estimate from the rates
 * for that side (flagged `estimated`). A recorded value that is not a finite number counts as unknown.
 * `Txn` requires positive shares and price; for a row outside that contract (0, NaN or negative) no estimate is
 * possible, so the estimate is 0 and still flagged `estimated`. The shape stays `{ charges: number }` because the
 * tax and performance modules add `charges` straight into money; a caller that must tell "no charges" from
 * "could not estimate" checks `shares > 0 && price > 0` on the transaction first.
 */
export function txnCharges(t: Pick<Txn, 'shares' | 'price' | 'charges'>, rates: CostRates): { charges: number; estimated: boolean } {
  if (typeof t.charges === 'number' && Number.isFinite(t.charges)) return { charges: r2(t.charges), estimated: false };
  return { charges: tradeCosts(t.shares, t.price, rates).total, estimated: true };
}
