import { describe, expect, it } from 'vitest';
import {
  buyCostBasis, cheapShareWarning, costRates, effectiveCommissionPct, roundTripPct, sellProceeds, tradeCosts, txnCharges, type CostRates,
} from './costs.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS, type Rules } from './types.ts';

// Defaults: 0.15% commission, Rs 0.03/share minimum, 15% sales tax, PSX 0.0035%, SECP 0.00065%, CDC Rs 0.005/share.
const RATES = costRates(DEFAULT_SETTINGS);
const ZERO: CostRates = { commission_pct: 0, min_commission_per_share: 0, sales_tax_pct: 0, psx_fee_pct: 0, secp_levy_pct: 0, cdc_per_share: 0 };
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Every way a price can be missing or unusable. */
const NO_PRICE = [null, undefined, 0, -1, NaN, Infinity];

describe('costRates', () => {
  it('takes commission, minimum and sales tax from settings and the exchange fees from rules.json', () => {
    expect(RATES).toEqual({
      commission_pct: 0.15, min_commission_per_share: 0.03, sales_tax_pct: 15, psx_fee_pct: 0.0035, secp_levy_pct: 0.00065, cdc_per_share: 0.005,
    });
    const mine = costRates({ commission_pct: 0.1, min_commission_per_share: 0.02, sales_tax_pct: 13 });
    expect(mine).toMatchObject({ commission_pct: 0.1, min_commission_per_share: 0.02, sales_tax_pct: 13, psx_fee_pct: 0.0035 });
  });

  it('falls back to the rule defaults when an old saved settings blob lacks a rate', () => {
    const old = { commission_pct: undefined, min_commission_per_share: NaN, sales_tax_pct: null } as unknown as Pick<
      typeof DEFAULT_SETTINGS, 'commission_pct' | 'min_commission_per_share' | 'sales_tax_pct'
    >;
    expect(costRates(old)).toEqual(RATES);
  });

  it('reads the fees from the rules passed in, not a constant', () => {
    const rules: Rules = { ...DEFAULT_RULES, costs: { ...DEFAULT_RULES.costs, psx_fee_pct: 0.01, cdc_per_share: 0.02 } };
    expect(costRates(DEFAULT_SETTINGS, rules)).toMatchObject({ psx_fee_pct: 0.01, cdc_per_share: 0.02, secp_levy_pct: 0.00065 });
  });
});

describe('tradeCosts', () => {
  it('100 KEL at Rs 5.94: the per-share minimum beats the % commission', () => {
    // value 594; commission max(0.15% x 594 = 0.891, 0.03 x 100 = 3.00) = 3.00; SST 15% x 3.00 = 0.45;
    // PSX 0.0035% x 594 = 0.0208 -> 0.02; SECP 0.00065% x 594 = 0.0039 -> 0.00; CDC 0.005 x 100 = 0.50;
    // total 3.00 + 0.45 + 0.02 + 0.00 + 0.50 = 3.97; pct 3.97 / 594 x 100 = 0.668 -> 0.67
    expect(tradeCosts(100, 5.94, RATES)).toEqual({
      value: 594, commission: 3, sales_tax: 0.45, psx_fee: 0.02, secp_levy: 0, cdc: 0.5, total: 3.97, pct: 0.67,
    });
  });

  it('10 MEBL at Rs 548.11: the % commission beats the minimum', () => {
    // value 5481.10; commission max(0.15% x 5481.10 = 8.22165, 0.03 x 10 = 0.30) = 8.22; SST 15% x 8.22165 = 1.2332 -> 1.23;
    // PSX 0.0035% x 5481.10 = 0.1918 -> 0.19; SECP 0.00065% x 5481.10 = 0.0356 -> 0.04; CDC 0.005 x 10 = 0.05;
    // total 8.22 + 1.23 + 0.19 + 0.04 + 0.05 = 9.73; pct 9.73 / 5481.10 x 100 = 0.1775 -> 0.18
    expect(tradeCosts(10, 548.11, RATES)).toEqual({
      value: 5481.1, commission: 8.22, sales_tax: 1.23, psx_fee: 0.19, secp_levy: 0.04, cdc: 0.05, total: 9.73, pct: 0.18,
    });
  });

  it('the total is the sum of its lines, as on a contract note', () => {
    for (const [shares, price] of [[100, 5.94], [10, 548.11], [333, 17.33], [1, 1234.56]] as const) {
      const c = tradeCosts(shares, price, RATES);
      expect(c.total).toBeCloseTo(c.commission + c.sales_tax + c.psx_fee + c.secp_levy + c.cdc, 10);
    }
  });

  it('switches from the minimum to the % commission at exactly Rs 20 (0.03 / 0.15% = 20)', () => {
    // 100 shares: at 19.99, 0.15% x 1999 = 2.9985 < 3.00 -> the minimum, 3.00; at 20 both rules give 3.00;
    // at 20.01, 0.15% x 2001 = 3.0015 > 3.00 -> the %, 3.00 to the paisa; at 21, 0.15% x 2100 = 3.15; at 30, 4.50
    expect(tradeCosts(100, 19.99, RATES).commission).toBe(3);
    expect(tradeCosts(100, 20, RATES).commission).toBe(3);
    expect(tradeCosts(100, 20.01, RATES).commission).toBe(3);
    expect(tradeCosts(100, 21, RATES).commission).toBe(3.15);
    expect(tradeCosts(100, 30, RATES).commission).toBe(4.5);
  });

  it('gives zeros, never NaN, when shares or price is missing, zero or negative', () => {
    const zero = { value: 0, commission: 0, sales_tax: 0, psx_fee: 0, secp_levy: 0, cdc: 0, total: 0, pct: 0 };
    expect(tradeCosts(0, 5.94, RATES)).toEqual(zero);
    expect(tradeCosts(100, 0, RATES)).toEqual(zero);
    expect(tradeCosts(-5, 5.94, RATES)).toEqual(zero);
    expect(tradeCosts(NaN, 5.94, RATES)).toEqual(zero);
    expect(tradeCosts(100, Infinity, RATES)).toEqual(zero);
  });

  it('every line comes from the rates: all-zero rates cost nothing, a fee-only broker charges only fees', () => {
    expect(tradeCosts(100, 5.94, ZERO)).toMatchObject({ value: 594, total: 0, pct: 0 });
    const feesOnly = { ...ZERO, psx_fee_pct: 0.0035, cdc_per_share: 0.005 };
    // PSX 0.0035% x 594 = 0.02; CDC 0.50 -> 0.52
    expect(tradeCosts(100, 5.94, feesOnly)).toMatchObject({ commission: 0, sales_tax: 0, psx_fee: 0.02, cdc: 0.5, total: 0.52 });
  });
});

describe('buyCostBasis and sellProceeds', () => {
  it('KEL: 594 + 3.97 to buy, 594 - 3.97 received on a sell', () => {
    const buy = buyCostBasis(100, 5.94, RATES);
    expect(buy.total).toBe(597.97);
    expect(buy.per_share).toBe(5.9797); // 597.97 / 100
    expect(buy.costs.total).toBe(3.97);
    const sell = sellProceeds(100, 5.94, RATES);
    expect(sell.total).toBe(590.03);
    expect(sell.per_share).toBe(5.9003); // 590.03 / 100
    // buying and selling at the same price loses exactly two sides of costs
    expect(buy.total - sell.total).toBeCloseTo(2 * 3.97, 10);
  });

  it('MEBL: 5481.10 + 9.73 to buy, 5481.10 - 9.73 received', () => {
    expect(buyCostBasis(10, 548.11, RATES)).toMatchObject({ total: 5490.83, per_share: 549.083 });
    expect(sellProceeds(10, 548.11, RATES)).toMatchObject({ total: 5471.37, per_share: 547.137 });
  });

  it('per share is 0, not NaN, when there are no shares', () => {
    expect(buyCostBasis(0, 5.94, RATES)).toMatchObject({ total: 0, per_share: 0 });
    expect(sellProceeds(0, 5.94, RATES)).toMatchObject({ total: 0, per_share: 0 });
  });
});

describe('effectiveCommissionPct', () => {
  it('is the headline 0.15% from Rs 20 up and the per-share minimum below it', () => {
    expect(effectiveCommissionPct(20, RATES)).toBe(0.15); // 0.03 / 20 x 100 = 0.15 exactly
    expect(effectiveCommissionPct(100, RATES)).toBe(0.15);
    expect(effectiveCommissionPct(548.11, RATES)).toBe(0.15);
    expect(effectiveCommissionPct(12.71, RATES)).toBe(0.24); // 0.03 / 12.71 x 100 = 0.236
    expect(effectiveCommissionPct(15.46, RATES)).toBe(0.19); // 0.03 / 15.46 x 100 = 0.194
    expect(effectiveCommissionPct(5.94, RATES)).toBe(0.51); // 0.03 / 5.94 x 100 = 0.505
  });

  it('is null, not the headline rate, when the price is missing or not positive', () => {
    // a Discover row with no price must show "no data", not 0.15% as if the minimum could never bite
    for (const p of NO_PRICE) expect(effectiveCommissionPct(p, RATES)).toBeNull();
  });
});

describe('roundTripPct', () => {
  it('KEL at Rs 5.94 costs about 1.3% to buy and sell', () => {
    // one side per share: commission max(0.15% x 5.94 = 0.0089, 0.03) = 0.03; SST 0.0045; PSX 0.000208; SECP 0.000039; CDC 0.005
    // = 0.039747; two sides 0.079493; / 5.94 x 100 = 1.338 -> 1.34
    expect(roundTripPct(5.94, RATES)).toBe(1.34);
  });

  it('MEBL at Rs 548.11 costs about 0.35% to buy and sell', () => {
    // % parts per side: 0.15 + 15% x 0.15 + 0.0035 + 0.00065 = 0.17665; CDC 0.005 / 548.11 x 100 = 0.000912 -> 0.177562
    // two sides 0.355124 -> 0.36
    expect(roundTripPct(548.11, RATES)).toBe(0.36);
  });

  it('at exactly Rs 20 both commission rules meet: 2 x (0.17665 + 0.025) = 0.4033 -> 0.40', () => {
    expect(roundTripPct(20, RATES)).toBe(0.4);
  });

  it('equals twice the one-side ratio of tradeCosts, rounded to 2 dp', () => {
    // Enough shares that paisa rounding of the lines is negligible, then compare the raw ratio (not the 2 dp pct,
    // which would only pin the answer to within 0.01 on each side).
    // 1000 MEBL at 548.11: value 548,110; lines 822.17 + 123.32 + 19.18 + 3.56 + 5.00 = 973.23;
    // 973.23 / 548,110 x 100 = 0.177561; x 2 = 0.355122 -> 0.36
    const mebl = tradeCosts(1000, 548.11, RATES);
    expect(mebl.total).toBe(973.23);
    expect(roundTripPct(548.11, RATES)).toBe(r2((2 * mebl.total / mebl.value) * 100));
    // 10,000 KEL at 5.94: value 59,400; lines 300 + 45 + 2.08 + 0.39 + 50 = 397.47;
    // 397.47 / 59,400 x 100 = 0.669141; x 2 = 1.338283 -> 1.34
    const kel = tradeCosts(10000, 5.94, RATES);
    expect(kel.total).toBe(397.47);
    expect(roundTripPct(5.94, RATES)).toBe(r2((2 * kel.total / kel.value) * 100));
  });

  it('is null when the price is missing or not positive, and a real 0 only when the rates are zero', () => {
    for (const p of NO_PRICE) expect(roundTripPct(p, RATES)).toBeNull();
    expect(roundTripPct(5.94, ZERO)).toBe(0);
  });
});

describe('cheapShareWarning', () => {
  it('warns for KEL (1.34% round trip, above the 0.6% rule) and names the minimum commission', () => {
    const w = cheapShareWarning(5.94, RATES);
    expect(w).toBe('Cheap share: a buy and sell at Rs 5.94 costs about 1.34% in charges, as the Rs 0.03/share minimum commission bites below Rs 20.00.');
    expect(w!.split('\n')).toHaveLength(1);
  });

  it('is quiet for MEBL (0.36%) and for a price exactly at the rule', () => {
    expect(cheapShareWarning(548.11, RATES)).toBeNull();
    // 0.6% round trip needs 0.3% per side: 0.17665 + (0.03 + 0.0045 + 0.005) / p x 100 ... = 0.3 -> p about 32 if the
    // minimum applied, but above Rs 20 only CDC is per share: 0.17665 + 0.5 / p = 0.3 -> never for p > 20. Rs 20 gives 0.40.
    expect(cheapShareWarning(20, RATES)).toBeNull();
  });

  it('warns at Rs 12.71 (0.63%) but not at Rs 15.46 (0.52%): the research-doc prices either side of the rule', () => {
    // Below Rs 20 the minimum applies, so one side per share is 0.03 + SST 0.0045 + CDC 0.005 = 0.0395 fixed plus
    // (0.0035% + 0.00065%) of the price. Round trip % = 2 x 0.0395 / p x 100 + 2 x 0.00415 = 7.9 / p + 0.0083.
    // 12.71: 7.9 / 12.71 = 0.62156 + 0.0083 = 0.62986 -> 0.63 > 0.6 -> warns
    // 15.46: 7.9 / 15.46 = 0.51100 + 0.0083 = 0.51930 -> 0.52 <= 0.6 -> quiet
    expect(roundTripPct(12.71, RATES)).toBe(0.63);
    expect(cheapShareWarning(12.71, RATES)).toBe('Cheap share: a buy and sell at Rs 12.71 costs about 0.63% in charges, as the Rs 0.03/share minimum commission bites below Rs 20.00.');
    expect(roundTripPct(15.46, RATES)).toBe(0.52);
    expect(cheapShareWarning(15.46, RATES)).toBeNull();
  });

  it('compares the 2 dp figure it shows: Rs 13.23 reads 0.61% and warns, Rs 13.24 reads 0.60% and does not', () => {
    // 7.9 / p + 0.0083 = 0.6 at p = 13.351, but the rule is applied to the rounded figure the user sees, so the
    // crossover is where that figure drops from 0.61 to 0.60:
    // 13.23: 7.9 / 13.23 = 0.59713 + 0.0083 = 0.60543 -> 0.61 -> warns
    // 13.24: 7.9 / 13.24 = 0.59668 + 0.0083 = 0.60498 -> 0.60 -> "costs about 0.60%, above 0.6%" would read wrong, so quiet
    expect(roundTripPct(13.23, RATES)).toBe(0.61);
    expect(cheapShareWarning(13.23, RATES)).toMatch(/^Cheap share: a buy and sell at Rs 13\.23 costs about 0\.61% in charges, as the Rs 0\.03\/share minimum commission bites below Rs 20\.00\.$/);
    expect(roundTripPct(13.24, RATES)).toBe(0.6);
    expect(cheapShareWarning(13.24, RATES)).toBeNull();
  });

  it('uses the threshold from the rules passed in', () => {
    const lax: Rules = { ...DEFAULT_RULES, costs: { ...DEFAULT_RULES.costs, round_trip_warn_pct: 2 } };
    expect(cheapShareWarning(5.94, RATES, lax)).toBeNull();
    const strict: Rules = { ...DEFAULT_RULES, costs: { ...DEFAULT_RULES.costs, round_trip_warn_pct: 0.3 } };
    expect(cheapShareWarning(548.11, RATES, strict)).toMatch(/^Cheap share: a buy and sell at Rs 548\.11 costs about 0\.36% in charges\.$/);
  });

  it('leaves out the minimum-commission reason when the minimum is not what bites', () => {
    const cdcHeavy = { ...ZERO, cdc_per_share: 0.05 }; // 2 x 0.05 / 5.94 x 100 = 1.68%
    expect(cheapShareWarning(5.94, cdcHeavy)).toBe('Cheap share: a buy and sell at Rs 5.94 costs about 1.68% in charges.');
  });

  it('is null when the price is missing or not positive', () => {
    for (const p of NO_PRICE) expect(cheapShareWarning(p, RATES)).toBeNull();
  });
});

describe('txnCharges', () => {
  it('uses the recorded figure when present, even 0', () => {
    expect(txnCharges({ shares: 100, price: 5.94, charges: 12.5 }, RATES)).toEqual({ charges: 12.5, estimated: false });
    expect(txnCharges({ shares: 100, price: 5.94, charges: 0 }, RATES)).toEqual({ charges: 0, estimated: false });
    expect(txnCharges({ shares: 100, price: 5.94, charges: 3.9749 }, RATES)).toEqual({ charges: 3.97, estimated: false });
  });

  it('estimates from the rates when the figure is missing and says so', () => {
    expect(txnCharges({ shares: 100, price: 5.94, charges: null }, RATES)).toEqual({ charges: 3.97, estimated: true });
    expect(txnCharges({ shares: 10, price: 548.11 }, RATES)).toEqual({ charges: 9.73, estimated: true });
    expect(txnCharges({ shares: 100, price: 5.94, charges: NaN }, RATES)).toEqual({ charges: 3.97, estimated: true });
  });

  it('keeps a recorded figure even when the row is outside the Txn contract, and cannot estimate for such a row', () => {
    // Txn requires positive shares and price. A recorded figure is still the truth for that row.
    expect(txnCharges({ shares: NaN, price: 5.94, charges: 4 }, RATES)).toEqual({ charges: 4, estimated: false });
    // With nothing recorded there is no estimate to make: 0 and flagged. The shape stays { charges: number } for the
    // tax and performance ledgers; a caller that needs to tell this apart checks shares > 0 && price > 0 first.
    expect(txnCharges({ shares: NaN, price: 5.94, charges: null }, RATES)).toEqual({ charges: 0, estimated: true });
    expect(txnCharges({ shares: 100, price: 0, charges: null }, RATES)).toEqual({ charges: 0, estimated: true });
    expect(txnCharges({ shares: 0, price: 5.94 }, RATES)).toEqual({ charges: 0, estimated: true });
  });
});
