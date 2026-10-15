import { describe, expect, it } from 'vitest';
import {
  buildLots, carryForwardFrom, cgtRatePct, planSales, previousTaxYears, sharesHeldOn, suggestOffsets, taxYear, taxYearBounds, taxYearLedger,
} from './tax.ts';
import { addDays } from './time.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS, type Rules, type Settings, type Txn } from './types.ts';

const TODAY = '2026-10-15'; // tax year 2026-27
const S = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...o });
const NCCPL = S({ match_nccpl: true, tax_filer: true }); // cost basis without charges: the figures NCCPL shows
const tx = (symbol: string, side: 'buy' | 'sell', shares: number, price: number, executed_on: string, extra: Partial<Txn> = {}): Txn =>
  ({ symbol, side, shares, price, amount: shares * price, executed_on, source: 'manual', ...extra });

// The research doc's example: five holdings bought after 1 Jul 2025 (15% for a filer), 100 shares each at Rs 100.
// Selling at these prices gives A +8,000, B +4,000, C -3,000, D -2,000, E -1,500.
const PRICE: Record<string, number> = { A: 180, B: 140, C: 70, D: 80, E: 85 };
const BUYS = Object.keys(PRICE).map((s) => tx(s, 'buy', 100, 100, '2025-08-01', { id: `buy-${s}` }));
const sells = (...syms: string[]) => syms.map((s) => tx(s, 'sell', 100, PRICE[s], TODAY, { id: `sell-${s}` }));
const sale = (symbol: string, shares = 100) => ({ symbol, shares, price: PRICE[symbol] });

describe('taxYear, taxYearBounds, previousTaxYears', () => {
  it('labels a date by the tax year it falls in (1 Jul-30 Jun)', () => {
    expect(taxYear('2026-10-15')).toBe('2026-27');
    expect(taxYear('2026-06-30')).toBe('2025-26');
    expect(taxYear('2026-07-01')).toBe('2026-27');
    expect(taxYear('2027-01-01')).toBe('2026-27');
    expect(taxYear('2027-06-30')).toBe('2026-27');
  });

  it('takes the start month from the rules', () => {
    const april: Rules = { ...DEFAULT_RULES, tax: { ...DEFAULT_RULES.tax, tax_year_start_month: 4 } };
    expect(taxYear('2026-03-31', april)).toBe('2025-26');
    expect(taxYear('2026-04-01', april)).toBe('2026-27');
    expect(taxYearBounds('2026-27', april)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });

  it('gives the first and last day of a tax year, and they round-trip through taxYear', () => {
    expect(taxYearBounds('2026-27')).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    expect(taxYearBounds('2023-24')).toEqual({ from: '2023-07-01', to: '2024-06-30' });
    for (const y of ['2024-25', '2026-27', '2099-00']) {
      const b = taxYearBounds(y);
      expect(taxYear(b.from)).toBe(y);
      expect(taxYear(b.to)).toBe(y);
      expect(taxYear(addDays(b.from, -1))).not.toBe(y);
      expect(taxYear(addDays(b.to, 1))).not.toBe(y);
    }
  });

  it('lists the prior tax years most recent first', () => {
    expect(previousTaxYears('2026-27', 3)).toEqual(['2025-26', '2024-25', '2023-24']);
    expect(previousTaxYears('2026-27', 0)).toEqual([]);
    expect(previousTaxYears('2001-02', 2)).toEqual(['2000-01', '1999-00']);
  });
});

describe('cgtRatePct', () => {
  it('reads the flat bands by the buy date, filer and non-filer', () => {
    expect(cgtRatePct('2025-08-01', TODAY, true)).toBe(15);
    expect(cgtRatePct('2025-08-01', TODAY, false)).toBe(15);
    expect(cgtRatePct('2024-10-01', TODAY, true)).toBe(15);
    expect(cgtRatePct('2024-10-01', TODAY, false)).toBe(30);
    expect(cgtRatePct('2020-03-02', TODAY, true)).toBe(12.5);
    expect(cgtRatePct('2020-03-02', TODAY, false)).toBe(25);
    expect(cgtRatePct('2010-01-01', TODAY, true)).toBe(0);
    expect(cgtRatePct('2010-01-01', TODAY, false)).toBe(0);
  });

  it('switches band on the exact boundary dates', () => {
    expect(cgtRatePct('2013-06-30', TODAY, true)).toBe(0);
    expect(cgtRatePct('2013-07-01', TODAY, true)).toBe(12.5);
    expect(cgtRatePct('2022-06-30', TODAY, true)).toBe(12.5);
    expect(cgtRatePct('2022-07-01', TODAY, true)).toBe(5); // slab: 4 full years held to 2026-10-15 -> [15, 12.5, 10, 7.5, 5, ...][4]
    expect(cgtRatePct('2024-06-30', TODAY, true)).toBe(10); // 2 full years -> 10
    expect(cgtRatePct('2024-07-01', TODAY, true)).toBe(15);
  });

  it('2022-07-01..2024-06-30 buys: the slab steps down on each anniversary of the buy', () => {
    const b = '2023-01-15';
    expect(cgtRatePct(b, '2024-01-14', true)).toBe(15); // under a year
    expect(cgtRatePct(b, '2024-01-15', true)).toBe(12.5); // 1 full year
    expect(cgtRatePct(b, '2025-01-15', true)).toBe(10);
    expect(cgtRatePct(b, '2026-01-14', true)).toBe(10);
    expect(cgtRatePct(b, '2026-01-15', true)).toBe(7.5);
    expect(cgtRatePct(b, '2027-01-15', true)).toBe(5);
    expect(cgtRatePct(b, '2028-01-15', true)).toBe(2.5);
    expect(cgtRatePct(b, '2029-01-15', true)).toBe(0);
    expect(cgtRatePct(b, '2040-01-15', true)).toBe(0); // past the last slab the last rate applies
    expect(cgtRatePct(b, '2022-12-31', true)).toBe(15); // a sell before the buy (bad data) counts as under a year, not negative
    expect(cgtRatePct(b, '2024-01-15', false)).toBe(12.5); // the non-filer slab is the same in the shipped table
  });

  it('takes the table from the rules passed in', () => {
    const flat: Rules = {
      ...DEFAULT_RULES,
      tax: { ...DEFAULT_RULES.tax, cgt: [{ bought_from: '0001-01-01', bought_to: '9999-12-31', filer_pct: 7, non_filer_pct: 14 }] },
    };
    expect(cgtRatePct('2025-08-01', TODAY, true, flat)).toBe(7);
    expect(cgtRatePct('2025-08-01', TODAY, false, flat)).toBe(14);
    const none: Rules = { ...DEFAULT_RULES, tax: { ...DEFAULT_RULES.tax, cgt: [] } };
    expect(cgtRatePct('2025-08-01', TODAY, true, none)).toBe(0);
  });
});

describe('buildLots', () => {
  it('100 KEL at 5.94 sold at 6.50: charges go into the cost basis and come off the proceeds', () => {
    // buy: value 594 + charges 3.97 (see costs.test.ts) = 597.97 -> 5.9797 a share
    // sell: value 650; commission max(0.15% x 650 = 0.975, 0.03 x 100 = 3) = 3; SST 0.45; PSX 0.0035% x 650 = 0.02; SECP 0.00; CDC 0.50 -> 3.97
    // proceeds 646.03 -> 6.4603 a share; gain 646.03 - 597.97 = 48.06
    const book = buildLots([tx('KEL', 'buy', 100, 5.94, '2026-08-03', { id: 'b1' }), tx('KEL', 'sell', 100, 6.5, '2026-09-01')], S());
    expect(book.open).toEqual([]);
    expect(book.realized).toHaveLength(1);
    const r = book.realized[0];
    expect(r).toMatchObject({
      symbol: 'KEL', bought_on: '2026-08-03', sold_on: '2026-09-01', shares: 100, gain: 48.06, rate_pct: 15, tax_year: '2026-27', estimated_costs: true,
    });
    expect(r.cost_per_share).toBeCloseTo(5.9797, 10);
    expect(r.proceeds_per_share).toBeCloseTo(6.4603, 10);
    expect(book.warnings).toEqual([]);
  });

  it('uses recorded charges when the transaction has them; the gain is an estimate unless both sides are recorded', () => {
    // basis 594 + 5 = 599; proceeds 650 - 4 = 646; gain 47
    const both = buildLots([tx('KEL', 'buy', 100, 5.94, '2026-08-03', { charges: 5 }), tx('KEL', 'sell', 100, 6.5, '2026-09-01', { charges: 4 })], S());
    expect(both.realized[0]).toMatchObject({ gain: 47, estimated_costs: false });
    // buy recorded (599), sell estimated (646.03): 47.03, still an estimate
    const half = buildLots([tx('KEL', 'buy', 100, 5.94, '2026-08-03', { charges: 5 }), tx('KEL', 'sell', 100, 6.5, '2026-09-01')], S());
    expect(half.realized[0]).toMatchObject({ gain: 47.03, estimated_costs: true });
  });

  it('with match_nccpl the charges are ignored on both sides, as on the NCCPL statement', () => {
    // 650 - 594 = 56
    const book = buildLots([tx('KEL', 'buy', 100, 5.94, '2026-08-03', { charges: 5 }), tx('KEL', 'sell', 100, 6.5, '2026-09-01')], NCCPL);
    expect(book.realized[0]).toMatchObject({ cost_per_share: 5.94, proceeds_per_share: 6.5, gain: 56, estimated_costs: false });
  });

  it('open lots carry the cost a share with charges, the buy id and whether the charges were estimated', () => {
    const book = buildLots([tx('KEL', 'buy', 100, 5.94, '2026-08-03', { id: 'b1' })], S());
    expect(book.open).toHaveLength(1);
    expect(book.open[0]).toMatchObject({ symbol: 'KEL', bought_on: '2026-08-03', shares: 100, txn_id: 'b1', estimated_costs: true });
    expect(book.open[0].cost_per_share).toBeCloseTo(5.9797, 10);
    expect(book.realized).toEqual([]);
    expect(buildLots([tx('KEL', 'buy', 100, 5.94, '2026-08-03')], NCCPL).open[0]).toMatchObject({ cost_per_share: 5.94, estimated_costs: false });
  });

  it('a partial sell takes the oldest lot first and leaves the rest of the newer one open', () => {
    // lot 1: 100 SYS at 50 bought 2020-03-02 (2013-22 band, 12.5%); lot 2: 100 at 80 bought 2024-10-01 (2024-25 band, 15%)
    // sell 150 at 100 on 2026-10-15: 100 from lot 1 -> +5,000 at 12.5%; 50 from lot 2 -> +1,000 at 15%; 50 at 80 stay open
    const book = buildLots([tx('SYS', 'buy', 100, 50, '2020-03-02'), tx('SYS', 'buy', 100, 80, '2024-10-01'), tx('SYS', 'sell', 150, 100, TODAY)], NCCPL);
    expect(book.realized).toEqual([
      { symbol: 'SYS', bought_on: '2020-03-02', sold_on: TODAY, shares: 100, cost_per_share: 50, proceeds_per_share: 100, gain: 5000, rate_pct: 12.5, tax_year: '2026-27', estimated_costs: false },
      { symbol: 'SYS', bought_on: '2024-10-01', sold_on: TODAY, shares: 50, cost_per_share: 80, proceeds_per_share: 100, gain: 1000, rate_pct: 15, tax_year: '2026-27', estimated_costs: false },
    ]);
    expect(book.open).toEqual([{ symbol: 'SYS', bought_on: '2024-10-01', shares: 50, cost_per_share: 80, estimated_costs: false }]);
    expect(book.warnings).toEqual([]);
  });

  it('replays oldest first, buys before sells on the same day, then by id, whatever the input order', () => {
    const txns = [
      tx('SYS', 'sell', 100, 120, '2026-09-01', { id: 's1' }),
      tx('SYS', 'buy', 100, 110, '2026-09-01', { id: 'b2' }), // same day as the sell: the buy comes first, so nothing is missing
      tx('SYS', 'buy', 100, 100, '2026-08-01', { id: 'b1' }),
    ];
    const book = buildLots(txns, NCCPL);
    expect(book.warnings).toEqual([]);
    expect(book.realized).toHaveLength(1);
    expect(book.realized[0]).toMatchObject({ bought_on: '2026-08-01', cost_per_share: 100, gain: 2000 }); // FIFO: the August lot goes, not the same-day one
    expect(book.open).toEqual([{ symbol: 'SYS', bought_on: '2026-09-01', shares: 100, cost_per_share: 110, txn_id: 'b2', estimated_costs: false }]);
    // two sells on one day: ids decide the order (s1 at 130 first, then s2 at 120 finds nothing held)
    const twice = buildLots([
      tx('SYS', 'buy', 10, 100, '2026-08-01'), tx('SYS', 'sell', 10, 120, '2026-09-01', { id: 's2' }), tx('SYS', 'sell', 10, 130, '2026-09-01', { id: 's1' }),
    ], NCCPL);
    expect(twice.realized.map((r) => [r.proceeds_per_share, r.gain])).toEqual([[130, 300], [120, 0]]);
    expect(twice.warnings).toHaveLength(1);
  });

  it('a sell beyond what is held is matched at the sell price, with a warning, never thrown', () => {
    const book = buildLots([tx('SYS', 'buy', 10, 100, '2026-08-01'), tx('SYS', 'sell', 20, 120, '2026-09-01')], NCCPL);
    expect(book.warnings).toEqual(['Sold 20 SYS on 2026-09-01 but only 10 were held: the extra shares were matched at the sell price (add the missing buy)']);
    expect(book.realized).toEqual([
      expect.objectContaining({ bought_on: '2026-08-01', shares: 10, gain: 200 }),
      expect.objectContaining({ bought_on: '2026-09-01', sold_on: '2026-09-01', shares: 10, cost_per_share: 120, proceeds_per_share: 120, gain: 0, rate_pct: 15, estimated_costs: false }),
    ]);
    expect(book.open).toEqual([]);
    const none = buildLots([tx('SYS', 'sell', 5, 120, '2026-09-01')], NCCPL);
    expect(none.warnings).toEqual(['Sold 5 SYS on 2026-09-01 but none were held: the extra shares were matched at the sell price (add the missing buy)']);
    expect(none.realized[0]).toMatchObject({ shares: 5, gain: 0 });
  });

  it('skips a transaction without shares or price, with a warning; an empty log gives an empty book', () => {
    expect(buildLots([], S())).toEqual({ open: [], realized: [], warnings: [] });
    const book = buildLots([tx('SYS', 'buy', 0, 100, '2026-08-01'), tx('SYS', 'buy', 10, NaN, '2026-08-02')], S());
    expect(book.open).toEqual([]);
    expect(book.warnings).toEqual([
      'Ignored a buy of SYS on 2026-08-01: shares or price missing.',
      'Ignored a buy of SYS on 2026-08-02: shares or price missing.',
    ]);
  });

  it('treats " sys " and "SYS" as the same symbol', () => {
    const book = buildLots([tx(' sys ', 'buy', 10, 100, '2026-08-01'), tx('SYS', 'sell', 10, 120, '2026-09-01')], NCCPL);
    expect(book.warnings).toEqual([]);
    expect(book.realized[0]).toMatchObject({ symbol: 'SYS', gain: 200 });
  });
});

describe('sharesHeldOn', () => {
  it('counts buys minus sells up to and including the date, per symbol, never below zero', () => {
    const txns = [
      tx('SYS', 'buy', 100, 100, '2026-08-01'), tx('SYS', 'sell', 30, 120, '2026-09-01'), tx('SYS', 'buy', 20, 110, '2026-10-01'),
      tx('MEBL', 'buy', 50, 300, '2026-08-01'),
    ];
    expect(sharesHeldOn(txns, 'SYS', '2026-07-31')).toBe(0);
    expect(sharesHeldOn(txns, 'SYS', '2026-08-01')).toBe(100); // the buy day counts
    expect(sharesHeldOn(txns, 'SYS', '2026-08-31')).toBe(100);
    expect(sharesHeldOn(txns, 'SYS', '2026-09-01')).toBe(70);
    expect(sharesHeldOn(txns, 'sys', '2026-10-15')).toBe(90);
    expect(sharesHeldOn(txns, 'MEBL', '2026-10-15')).toBe(50);
    expect(sharesHeldOn([tx('SYS', 'sell', 30, 120, '2026-09-01')], 'SYS', '2026-10-15')).toBe(0); // a sell without its buy is not a negative holding
    expect(sharesHeldOn([], 'SYS', '2026-10-15')).toBe(0);
  });
});

describe('taxYearLedger: the research doc example (filer, 15%)', () => {
  const ledgerAfterSelling = (...syms: string[]) => taxYearLedger(buildLots([...BUYS, ...sells(...syms)], NCCPL), '2026-27', NCCPL);

  it('A + B: net 12,000, CGT 1,800', () => {
    const l = ledgerAfterSelling('A', 'B');
    expect(l).toMatchObject({
      year: '2026-27', gains: 12000, losses: 0, net: 12000, carry_forward_in: 0, carry_used: 0, carry_left: 0, taxable: 12000, cgt_estimate: 1800, cgt_paid: 0, cgt_due: 1800,
      rates_used: [15], mixed_rates: false, loss_to_carry: 0,
    });
    expect(l.by_symbol).toEqual([{ symbol: 'A', gain: 8000, shares: 100 }, { symbol: 'B', gain: 4000, shares: 100 }]);
  });

  it('A + B + C: the loss nets off, 9,000 / 1,350', () => {
    expect(ledgerAfterSelling('A', 'B', 'C')).toMatchObject({ gains: 12000, losses: 3000, net: 9000, taxable: 9000, cgt_estimate: 1350 });
  });

  it('all five: 5,500 / 825', () => {
    const l = ledgerAfterSelling('A', 'B', 'C', 'D', 'E');
    expect(l).toMatchObject({ gains: 12000, losses: 6500, net: 5500, taxable: 5500, cgt_estimate: 825, cgt_due: 825 });
    expect(l.by_symbol.map((s) => s.symbol)).toEqual(['A', 'B', 'E', 'D', 'C']); // biggest gain first
  });

  it('C + D + E: a net loss of 6,500, no CGT, and the loss is there to carry forward (filers only)', () => {
    const l = ledgerAfterSelling('C', 'D', 'E');
    expect(l).toMatchObject({ gains: 0, losses: 6500, net: -6500, taxable: 0, cgt_estimate: 0, cgt_due: 0, loss_to_carry: 6500 });
    expect(carryForwardFrom(l)).toBe(6500);
    const nf = taxYearLedger(buildLots([...BUYS, ...sells('C', 'D', 'E')], NCCPL), '2026-27', S({ ...NCCPL, tax_filer: false }));
    expect(nf).toMatchObject({ net: -6500, cgt_estimate: 0, loss_to_carry: 0 });
    expect(carryForwardFrom(nf)).toBe(0);
  });

  it('carry-forward from the 3 prior years cuts the taxable amount, for a filer only', () => {
    const book = buildLots([...BUYS, ...sells('A', 'B')], NCCPL);
    // last year's 6,500 loss: 12,000 - 6,500 = 5,500 -> 825; all of it is used, nothing is left
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2025-26': 6500 } })))
      .toMatchObject({ net: 12000, carry_forward_in: 6500, carry_used: 6500, carry_left: 0, taxable: 5500, cgt_estimate: 825 });
    // three years back still counts (2023-24), four years back does not (2022-23): 12,000 - 1,000 = 11,000 -> 1,650
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2023-24': 1000, '2022-23': 5000 } })))
      .toMatchObject({ carry_forward_in: 1000, taxable: 11000, cgt_estimate: 1650 });
    // more loss than gain: taxable 0, never negative; the 8,000 not needed stays for next year
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2025-26': 20000 } })))
      .toMatchObject({ carry_forward_in: 20000, carry_used: 12000, carry_left: 8000, taxable: 0, cgt_estimate: 0 });
    // a non-filer gets none of it (this band charges non-filers 15% too)
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, tax_filer: false, loss_carry_forward: { '2025-26': 6500 } })))
      .toMatchObject({ carry_forward_in: 0, carry_used: 0, carry_left: 0, taxable: 12000, cgt_estimate: 1800 });
    // a bad value in the saved map counts as nothing: NaN, or a loss written as a negative number
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2025-26': NaN } }))).toMatchObject({ carry_forward_in: 0 });
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2025-26': -6500 } }))).toMatchObject({ carry_forward_in: 0, cgt_estimate: 1800 });
    // the number of years comes from the rules
    const oneYear: Rules = { ...DEFAULT_RULES, tax: { ...DEFAULT_RULES.tax, loss_carry_forward_years: 1 } };
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2025-26': 500, '2024-25': 700 } }), oneYear)).toMatchObject({ carry_forward_in: 500 });
  });

  it('CGT already deducted by NCCPL turns a due into a refund', () => {
    const book = buildLots([...BUYS, ...sells('A', 'B')], NCCPL);
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, cgt_paid: { '2026-27': 2000 } }))).toMatchObject({ cgt_estimate: 1800, cgt_paid: 2000, cgt_due: -200 });
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, cgt_paid: { '2026-27': 500, '2025-26': 999 } }))).toMatchObject({ cgt_paid: 500, cgt_due: 1300 });
  });

  it('mixed rates: losses offset the highest-rate gains first (an estimate, flagged)', () => {
    // +5,000 at 12.5% (bought 2020) and +1,000 at 15% (bought 2024-25): 625 + 150 = 775
    const two = [tx('SYS', 'buy', 100, 50, '2020-03-02'), tx('SYS', 'buy', 100, 80, '2024-10-01'), tx('SYS', 'sell', 150, 100, TODAY)];
    expect(taxYearLedger(buildLots(two, NCCPL), '2026-27', NCCPL)).toMatchObject({ gains: 6000, net: 6000, cgt_estimate: 775, rates_used: [12.5, 15], mixed_rates: true });
    // a 600 loss (LUCK 100 at 100 -> 94) offsets the 15% gain first: 5,000 x 12.5% + (1,000 - 600) x 15% = 625 + 60 = 685
    // (offsetting the 12.5% gain first would give 4,400 x 12.5% + 150 = 700)
    const withLoss = [...two, tx('LUCK', 'buy', 100, 100, '2025-09-01'), tx('LUCK', 'sell', 100, 94, '2026-09-01')];
    expect(taxYearLedger(buildLots(withLoss, NCCPL), '2026-27', NCCPL)).toMatchObject({ gains: 6000, losses: 600, net: 5400, cgt_estimate: 685, mixed_rates: true });
    // a loss bigger than the 15% gain spills into the 12.5% gain: loss 1,600 -> the 1,000 at 15% is gone, 4,400 x 12.5% = 550
    const bigLoss = [...two, tx('LUCK', 'buy', 100, 100, '2025-09-01'), tx('LUCK', 'sell', 100, 84, '2026-09-01')];
    expect(taxYearLedger(buildLots(bigLoss, NCCPL), '2026-27', NCCPL)).toMatchObject({ losses: 1600, net: 4400, cgt_estimate: 550 });
    // carry-forward offsets the same way: 600 carried in instead of the loss -> 685 too
    expect(taxYearLedger(buildLots(two, NCCPL), '2026-27', S({ ...NCCPL, loss_carry_forward: { '2024-25': 600 } }))).toMatchObject({ carry_forward_in: 600, cgt_estimate: 685 });
  });

  it('files a sell by its tax year: 30 Jun is last year, 1 Jul is this year', () => {
    const txns = [tx('SYS', 'buy', 200, 100, '2025-08-01'), tx('SYS', 'sell', 100, 150, '2026-06-30'), tx('SYS', 'sell', 100, 160, '2026-07-01')];
    const book = buildLots(txns, NCCPL);
    expect(book.realized.map((r) => r.tax_year)).toEqual(['2025-26', '2026-27']);
    expect(taxYearLedger(book, '2025-26', NCCPL)).toMatchObject({ gains: 5000, cgt_estimate: 750 });
    expect(taxYearLedger(book, '2026-27', NCCPL)).toMatchObject({ gains: 6000, cgt_estimate: 900 });
    expect(taxYearLedger(book, '2024-25', NCCPL)).toMatchObject({
      gains: 0, losses: 0, net: 0, carry_forward_in: 0, carry_used: 0, carry_left: 0, taxable: 0, cgt_estimate: 0, cgt_due: 0,
      by_symbol: [], rates_used: [], mixed_rates: false, loss_to_carry: 0,
    });
    expect(planSales(buildLots(BUYS, NCCPL), [sale('A')], '2026-06-30', NCCPL).year_after.year).toBe('2025-26');
  });

  it('shares matched at the sell price (zero gain) count in by_symbol but do not make the rates look mixed', () => {
    const book = buildLots([tx('SYS', 'buy', 100, 50, '2020-03-02'), tx('SYS', 'sell', 150, 100, TODAY)], NCCPL);
    const l = taxYearLedger(book, '2026-27', NCCPL);
    expect(l).toMatchObject({ gains: 5000, cgt_estimate: 625, rates_used: [12.5], mixed_rates: false });
    expect(l.by_symbol).toEqual([{ symbol: 'SYS', gain: 5000, shares: 150 }]);
  });

  // 300 A at 100 bought 2024-08-01 (2024-25 band: filer 15%, non-filer 30%); 100 sold at 120 in 2025-26 (+2,000), 100 at 150 in 2026-27 (+5,000)
  const CARRY_TXNS = [tx('A', 'buy', 300, 100, '2024-08-01'), tx('A', 'sell', 100, 120, '2025-10-01'), tx('A', 'sell', 100, 150, '2026-10-01')];

  it('a loss carried in is used up: what one year sets off is not there for the next', () => {
    const book = buildLots(CARRY_TXNS, NCCPL);
    const s = S({ ...NCCPL, loss_carry_forward: { '2024-25': 5000 } });
    // 2025-26 uses 2,000 of the 5,000: nothing to pay, 3,000 left
    expect(taxYearLedger(book, '2025-26', s)).toMatchObject({ net: 2000, carry_forward_in: 5000, carry_used: 2000, carry_left: 3000, taxable: 0, cgt_estimate: 0, loss_to_carry: 0 });
    // 2026-27 gets the 3,000 that is left, not the 5,000 again, and uses all of it: 5,000 - 3,000 = 2,000 -> 300
    expect(taxYearLedger(book, '2026-27', s)).toMatchObject({ net: 5000, carry_forward_in: 3000, carry_used: 3000, carry_left: 0, taxable: 2000, cgt_estimate: 300 });
    expect(taxYearLedger(book, '2027-28', s)).toMatchObject({ carry_forward_in: 0 });
    // with only the first sell in the log the 3,000 is untouched in 2026-27 and still there in 2027-28, the third and last year it can be used; by 2028-29 it has lapsed
    const once = buildLots(CARRY_TXNS.slice(0, 2), NCCPL);
    expect(taxYearLedger(once, '2026-27', s)).toMatchObject({ net: 0, carry_forward_in: 3000, carry_used: 0, carry_left: 3000, cgt_estimate: 0 });
    expect(taxYearLedger(once, '2027-28', s)).toMatchObject({ net: 0, carry_forward_in: 3000, carry_used: 0, carry_left: 3000 });
    expect(taxYearLedger(once, '2028-29', s)).toMatchObject({ carry_forward_in: 0, carry_left: 0 });
    // the planner sees the same: selling 100 A at 150 in 2026-27 on top of that log is taxed on 2,000
    const p = planSales(once, [{ symbol: 'A', shares: 100, price: 150 }], '2026-10-01', s);
    expect(p.year_before).toMatchObject({ carry_forward_in: 3000, carry_used: 0, carry_left: 3000, cgt_estimate: 0 });
    expect(p.year_after).toMatchObject({ carry_forward_in: 3000, carry_used: 3000, carry_left: 0, taxable: 2000, cgt_estimate: 300 });
    expect(p.cgt_change).toBe(300);
  });

  it('the oldest loss is set off first, a lapsed loss is not touched, and a gain in the loss year does not eat its own loss', () => {
    const book = buildLots(CARRY_TXNS, NCCPL);
    // losses 1,000 (2023-24) and 5,000 (2024-25): 2025-26's 2,000 takes the older 1,000 first, then 1,000 of 2024-25 -> 4,000 comes into 2026-27
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2024-25': 5000, '2023-24': 1000 } })))
      .toMatchObject({ carry_forward_in: 4000, carry_used: 4000, carry_left: 0, taxable: 1000, cgt_estimate: 150 });
    // a 2021-22 loss could be used in 2022-23..2024-25 only, so 2025-26's gain ate the 2024-25 loss instead: 3,000 left
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2021-22': 9000, '2024-25': 5000 } })))
      .toMatchObject({ carry_forward_in: 3000, cgt_estimate: 300 });
    // a loss recorded for 2025-26 while the log shows +2,000 that year: the recorded figure is the year's net, so all 6,500 comes in
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2025-26': 6500 } })))
      .toMatchObject({ carry_forward_in: 6500, carry_used: 5000, carry_left: 1500, taxable: 0, cgt_estimate: 0 });
    // a key that is not a tax year label is ignored
    expect(taxYearLedger(book, '2026-27', S({ ...NCCPL, loss_carry_forward: { '2024': 5000, 'last year': 5000 } }))).toMatchObject({ carry_forward_in: 0 });
    // a non-filer carries nothing, whatever the log says: 5,000 at this band's 30%
    const nf = S({ ...NCCPL, tax_filer: false, loss_carry_forward: { '2024-25': 5000 } });
    expect(taxYearLedger(buildLots(CARRY_TXNS, nf), '2026-27', nf)).toMatchObject({ carry_forward_in: 0, carry_used: 0, carry_left: 0, taxable: 5000, cgt_estimate: 1500 });
  });

  it('a non-filer pays each band\'s non-filer rate, netted the same way, with no carry-forward', () => {
    // 100 SYS at 50 bought 2020-03-02 (2013-22 band: 25%) and 100 at 80 bought 2024-10-01 (2024-25 band: 30%); 150 sold at 100 on 2026-10-15
    // +5,000 x 25% + 1,000 x 30% = 1,250 + 300 = 1,550. The rate is fixed when the book is built, so the book must be built as a non-filer too.
    const nf = S({ ...NCCPL, tax_filer: false });
    const two = [tx('SYS', 'buy', 100, 50, '2020-03-02'), tx('SYS', 'buy', 100, 80, '2024-10-01'), tx('SYS', 'sell', 150, 100, TODAY)];
    const book = buildLots(two, nf);
    expect(book.realized.map((r) => [r.gain, r.rate_pct])).toEqual([[5000, 25], [1000, 30]]);
    expect(taxYearLedger(book, '2026-27', nf)).toMatchObject({ gains: 6000, net: 6000, taxable: 6000, cgt_estimate: 1550, rates_used: [25, 30], mixed_rates: true });
    // a 600 loss (LUCK, bought 2025-09-01: 15% for a non-filer too) comes off the 30% gain first: 1,250 + 400 x 30% = 1,370
    const withLoss = [...two, tx('LUCK', 'buy', 100, 100, '2025-09-01'), tx('LUCK', 'sell', 100, 94, '2026-09-01')];
    expect(taxYearLedger(buildLots(withLoss, nf), '2026-27', nf)).toMatchObject({ losses: 600, net: 5400, cgt_estimate: 1370, rates_used: [15, 25, 30] });
    // last year's loss does not help a non-filer: still 1,550
    expect(taxYearLedger(book, '2026-27', S({ ...nf, loss_carry_forward: { '2025-26': 6000 } }))).toMatchObject({ carry_forward_in: 0, taxable: 6000, cgt_estimate: 1550 });
    // the same sale planned today: each lot keeps its rate, the line shows (100 x 25 + 50 x 30) / 150 = 26.67
    const p = planSales(buildLots(two.slice(0, 2), nf), [{ symbol: 'SYS', shares: 150, price: 100 }], TODAY, nf);
    expect(p.lines[0].lots.map((l) => l.rate_pct)).toEqual([25, 30]);
    expect(p.lines[0].rate_pct).toBe(26.67);
    expect(p).toMatchObject({ net_gain: 6000, cgt_change: 1550 });
    expect(p.year_after).toMatchObject({ cgt_estimate: 1550, mixed_rates: true });
  });

  it('a 2022-24 buy is taxed on the slab for the full years held, counted to the day it is sold', () => {
    // 100 at 100 bought 2023-01-15, sold at 150: +5,000. On 2026-10-15 that is 3 full years -> 7.5% -> 375
    const buy = tx('SYS', 'buy', 100, 100, '2023-01-15');
    const book = buildLots([buy, tx('SYS', 'sell', 100, 150, TODAY)], NCCPL);
    expect(book.realized[0]).toMatchObject({ gain: 5000, rate_pct: 7.5, tax_year: '2026-27' });
    expect(taxYearLedger(book, '2026-27', NCCPL)).toMatchObject({ taxable: 5000, cgt_estimate: 375, rates_used: [7.5], mixed_rates: false });
    // the planner counts the years to the planned day: the day before the third anniversary it is still 10% (500), on it 7.5% (375)
    const open = buildLots([buy], NCCPL);
    const sell = [{ symbol: 'SYS', shares: 100, price: 150 }];
    const dayBefore = planSales(open, sell, '2026-01-14', NCCPL);
    expect(dayBefore.lines[0]).toMatchObject({ gain: 5000, rate_pct: 10 });
    expect(dayBefore).toMatchObject({ cgt_change: 500 });
    const anniversary = planSales(open, sell, '2026-01-15', NCCPL);
    expect(anniversary.lines[0]).toMatchObject({ gain: 5000, rate_pct: 7.5 });
    expect(anniversary).toMatchObject({ cgt_change: 375 });
    expect(anniversary.year_after.year).toBe('2025-26');
    // the shipped table has the same slab for a non-filer
    expect(planSales(open, sell, '2026-01-15', S({ ...NCCPL, tax_filer: false })).year_after.cgt_estimate).toBe(375);
  });
});

describe('planSales', () => {
  const BOOK = buildLots(BUYS, NCCPL);

  it('A + B: the lines, the sell charges and the year after', () => {
    const p = planSales(BOOK, [sale('A'), sale('B')], TODAY, NCCPL);
    // A: 100 x 180 = 18,000; sell charges: commission max(0.15% x 18,000 = 27, 3) = 27; SST 4.05; PSX 0.63; SECP 0.117 -> 0.12; CDC 0.50 -> 32.30
    // B: 14,000; commission 21; SST 3.15; PSX 0.49; SECP 0.091 -> 0.09; CDC 0.50 -> 25.23
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0]).toMatchObject({ symbol: 'A', shares: 100, price: 180, proceeds: 18000, cost: 10000, gain: 8000, rate_pct: 15, costs: 32.3, estimated_costs: false });
    expect(p.lines[0].lots).toEqual([expect.objectContaining({ bought_on: '2025-08-01', sold_on: TODAY, shares: 100, gain: 8000, rate_pct: 15, tax_year: '2026-27' })]);
    expect(p.lines[0].warning).toBeUndefined();
    expect(p.lines[1]).toMatchObject({ symbol: 'B', proceeds: 14000, cost: 10000, gain: 4000, costs: 25.23 });
    expect(p.net_gain).toBe(12000);
    expect(p.year_before).toMatchObject({ net: 0, cgt_estimate: 0 });
    expect(p.year_after).toMatchObject({ net: 12000, cgt_estimate: 1800, cgt_due: 1800 });
    expect(p.cgt_change).toBe(1800);
    expect(p.cgt_next_month).toBe(1800);
    expect(p.proceeds_net).toBe(31942.47); // 18,000 - 32.30 + 14,000 - 25.23
  });

  it('the other combinations from the research doc', () => {
    expect(planSales(BOOK, [sale('A'), sale('B'), sale('C')], TODAY, NCCPL)).toMatchObject({ net_gain: 9000, cgt_change: 1350 });
    expect(planSales(BOOK, ['A', 'B', 'C', 'D', 'E'].map((s) => sale(s)), TODAY, NCCPL)).toMatchObject({ net_gain: 5500, cgt_change: 825 });
    const loss = planSales(BOOK, [sale('C'), sale('D'), sale('E')], TODAY, NCCPL);
    expect(loss).toMatchObject({ net_gain: -6500, cgt_change: 0, cgt_next_month: 0 });
    expect(loss.year_after).toMatchObject({ net: -6500, cgt_estimate: 0, loss_to_carry: 6500 });
    expect(carryForwardFrom(loss.year_after)).toBe(6500);
  });

  it('with charges on (match_nccpl off) the gain is after both sides\' charges and flagged as an estimate', () => {
    // buy 100 at 100: value 10,000; commission 15; SST 2.25; PSX 0.35; SECP 0.065 -> 0.07; CDC 0.50 -> 18.17; basis 10,018.17
    // sell at 180: proceeds 18,000 - 32.30 = 17,967.70; gain 17,967.70 - 10,018.17 = 7,949.53; 15% = 1,192.43
    const p = planSales(buildLots(BUYS, S()), [sale('A')], TODAY, S());
    expect(p.lines[0]).toMatchObject({ proceeds: 18000, cost: 10018.17, gain: 7949.53, costs: 32.3, estimated_costs: true });
    expect(p.lines[0].lots[0].estimated_costs).toBe(true);
    expect(p.year_after.cgt_estimate).toBe(1192.43);
    expect(p.proceeds_net).toBe(17967.7);
  });

  it('cgt_next_month is the extra cash NCCPL takes, after what is already paid', () => {
    // B was sold in August (+4,000 -> 600 CGT) and NCCPL took the 600
    const book = buildLots([...BUYS, tx('B', 'sell', 100, 140, '2026-08-03')], NCCPL);
    const paid = S({ ...NCCPL, cgt_paid: { '2026-27': 600 } });
    const p = planSales(book, [sale('A')], TODAY, paid);
    expect(p.year_before).toMatchObject({ cgt_estimate: 600, cgt_paid: 600, cgt_due: 0 });
    expect(p.year_after).toMatchObject({ cgt_estimate: 1800, cgt_due: 1200 });
    expect(p).toMatchObject({ cgt_change: 1200, cgt_next_month: 1200 });
    // over-deducted earlier: the refund due covers the plan's tax, so nothing more is taken
    const over = planSales(book, [sale('A')], TODAY, S({ ...NCCPL, cgt_paid: { '2026-27': 2000 } }));
    expect(over.year_before.cgt_due).toBe(-1400);
    expect(over.year_after.cgt_due).toBe(-200);
    expect(over).toMatchObject({ cgt_change: 1200, cgt_next_month: 0 });
    // a loss plan cuts the year's CGT and never gives a negative cash figure: 4,000 - 3,000 = 1,000 -> 150
    expect(planSales(book, [sale('C')], TODAY, paid)).toMatchObject({ cgt_change: -450, cgt_next_month: 0 });
  });

  it('FIFO across lots with different rates: each lot keeps its rate, the line shows the shares-weighted one', () => {
    const book = buildLots([tx('SYS', 'buy', 100, 50, '2020-03-02'), tx('SYS', 'buy', 100, 80, '2024-10-01')], NCCPL);
    const p = planSales(book, [{ symbol: 'SYS', shares: 150, price: 100 }], TODAY, NCCPL);
    const line = p.lines[0];
    expect(line.lots.map((l) => [l.bought_on, l.shares, l.gain, l.rate_pct])).toEqual([['2020-03-02', 100, 5000, 12.5], ['2024-10-01', 50, 1000, 15]]);
    expect(line).toMatchObject({ cost: 9000, gain: 6000, rate_pct: 13.33 }); // (100 x 12.5 + 50 x 15) / 150 = 13.333
    expect(p.year_after).toMatchObject({ cgt_estimate: 775, mixed_rates: true });
    expect(book.open.map((l) => l.shares)).toEqual([100, 100]); // the book itself is untouched
  });

  it('selling more than the log holds: the extra shares count at the sell price with a warning', () => {
    const p = planSales(BOOK, [{ symbol: 'A', shares: 150, price: 180 }], TODAY, NCCPL);
    const line = p.lines[0];
    expect(line).toMatchObject({ shares: 150, proceeds: 27000, cost: 19000, gain: 8000, rate_pct: 15 }); // cost 100 x 100 + 50 x 180
    expect(line.lots.map((l) => [l.shares, l.gain])).toEqual([[100, 8000], [50, 0]]);
    expect(line.warning).toBe('Only 100 of the 150 A planned are in the transaction log: the 50 unmatched shares count at the sell price (zero gain). Add the missing buy.');
    const unknown = planSales(BOOK, [{ symbol: 'XYZ', shares: 10, price: 50 }], TODAY, NCCPL);
    expect(unknown.lines[0]).toMatchObject({ proceeds: 500, cost: 500, gain: 0 });
    expect(unknown.lines[0].warning).toBe('No XYZ buys are in the transaction log: the 10 unmatched shares count at the sell price (zero gain). Add the missing buy.');
  });

  it('a line without shares or a price is zeros with a warning; the plan still runs', () => {
    const p = planSales(BOOK, [{ symbol: 'A', shares: 0, price: 180 }, sale('B')], TODAY, NCCPL);
    expect(p.lines[0]).toMatchObject({ symbol: 'A', proceeds: 0, cost: 0, gain: 0, lots: [], costs: 0, warning: 'Shares or price missing for A.' });
    expect(p.lines[1].gain).toBe(4000);
    expect(p.net_gain).toBe(4000);
    expect(planSales(BOOK, [], TODAY, NCCPL)).toMatchObject({ lines: [], net_gain: 0, cgt_change: 0, cgt_next_month: 0, proceeds_net: 0 });
  });

  it('does not change the book and gives the same answer every time; the same symbol twice draws from the same lots in turn', () => {
    const before = JSON.stringify(BOOK);
    const a = planSales(BOOK, [sale('A'), sale('B')], TODAY, NCCPL);
    const b = planSales(BOOK, [sale('A'), sale('B')], TODAY, NCCPL);
    expect(JSON.stringify(BOOK)).toBe(before);
    expect(b).toEqual(a);
    const twice = planSales(BOOK, [{ symbol: 'A', shares: 60, price: 180 }, { symbol: 'a', shares: 60, price: 180 }], TODAY, NCCPL);
    expect(twice.lines[0]).toMatchObject({ gain: 4800 }); // 60 x 80
    expect(twice.lines[1]).toMatchObject({ symbol: 'A', gain: 3200 }); // 40 x 80, 20 unmatched
    expect(twice.lines[1].warning).toMatch(/^Only 40 of the 60 A planned/);
  });
});

describe('suggestOffsets', () => {
  const BOOK = buildLots(BUYS, NCCPL);
  const CANDIDATES = ['C', 'D', 'E'].map((s) => sale(s));

  it('after A + B, selling C saves 450, D 300, E 225, biggest saving first', () => {
    const s = suggestOffsets(BOOK, [sale('A'), sale('B')], CANDIDATES, TODAY, NCCPL);
    expect(s.map((o) => [o.symbol, o.loss, o.cgt_saved])).toEqual([['C', -3000, 450], ['D', -2000, 300], ['E', -1500, 225]]);
    expect(s[0]).toMatchObject({ shares: 100, price: 70, text: 'Selling C (-Rs 3,000) as well would cut CGT by Rs 450.' });
  });

  it('nothing when the year owes no CGT after the plan', () => {
    expect(suggestOffsets(BOOK, [sale('C'), sale('D')], [sale('E')], TODAY, NCCPL)).toEqual([]);
    expect(suggestOffsets(BOOK, [], CANDIDATES, TODAY, NCCPL)).toEqual([]);
  });

  it('skips symbols in the plan, winners, unknown symbols and bad rows; each symbol once', () => {
    const cands = [sale('B'), sale('A'), { symbol: 'XYZ', shares: 10, price: 5 }, { symbol: 'C', shares: 0, price: 70 }, { symbol: 'c', shares: 100, price: 70 }, sale('C')];
    const s = suggestOffsets(BOOK, [sale('B')], cands, TODAY, NCCPL); // B alone: 4,000 -> 600
    expect(s.map((o) => [o.symbol, o.cgt_saved])).toEqual([['C', 450]]);
    expect(suggestOffsets(BOOK, [sale('B')], [], TODAY, NCCPL)).toEqual([]);
  });

  it('a loss bigger than the gain saves only the CGT there is', () => {
    // plan A: 8,000 -> 1,200. LOSER bought at 200, now 100: -10,000. Net -2,000: CGT 0, so the saving is 1,200, not 1,500
    const book = buildLots([...BUYS, tx('LOSER', 'buy', 100, 200, '2025-08-01')], NCCPL);
    const s = suggestOffsets(book, [sale('A')], [{ symbol: 'LOSER', shares: 100, price: 100 }], TODAY, NCCPL);
    expect(s).toEqual([{ symbol: 'LOSER', shares: 100, price: 100, loss: -10000, cgt_saved: 1200, text: 'Selling LOSER (-Rs 10,000) as well would cut CGT by Rs 1,200.' }]);
  });

  it('with charges on, the loss and the saving include the estimated charges', () => {
    // C at 70: charges commission max(10.5, 3) = 10.5; SST 1.575 -> 1.58; PSX 0.245 -> 0.25; SECP 0.0455 -> 0.05; CDC 0.50 -> 12.88
    // proceeds 7,000 - 12.88 = 6,987.12; basis 10,018.17 -> loss 3,031.05
    // A + B after charges: 7,949.53 + (13,974.77 - 10,018.17 = 3,956.60) = 11,906.13 -> 1,785.92; with C 8,875.08 -> 1,331.26; saved 454.66
    const book = buildLots(BUYS, S());
    const s = suggestOffsets(book, [sale('A'), sale('B')], [sale('C')], TODAY, S());
    expect(s[0]).toMatchObject({ loss: -3031.05, cgt_saved: 454.66 });
    expect(s[0].text).toBe('Selling C (-Rs 3,031) as well would cut CGT by Rs 455.');
  });
});

describe('planSales with holdings bought before the log', () => {
  it('uses the average cost (an estimate) instead of a zero gain, and sell charges still reduce it', () => {
    const empty = buildLots([], NCCPL);
    const nc = planSales(empty, [{ symbol: 'DCR', shares: 170, price: 38.76, avg_cost: 36.94 }], TODAY, NCCPL);
    expect(nc.lines[0]).toMatchObject({ from_average_cost: 170, gain: 309.4 }); // 170 x (38.76 - 36.94)
    expect(nc.lines[0].warning).toMatch(/average cost of Rs 36\.94 \(an estimate\)/);
    const withCharges = planSales(empty, [{ symbol: 'DCR', shares: 170, price: 38.76, avg_cost: 36.94 }], TODAY, S({ match_nccpl: false }));
    expect(withCharges.lines[0].gain).toBeLessThan(309.4); // sell charges come off the proceeds
    const noAvg = planSales(empty, [{ symbol: 'DCR', shares: 170, price: 38.76 }], TODAY, NCCPL);
    expect(noAvg.lines[0].gain).toBe(0); // nothing to estimate from: zero gain with a warning, as before
  });

  it('skips offset hints that save less than rules.tax.min_offset_saving_pkr', () => {
    const book = buildLots([...BUYS, tx('F', 'buy', 100, 100, '2025-08-01', { id: 'buy-F' })], NCCPL);
    const tiny = suggestOffsets(book, [sale('A')], [{ symbol: 'F', shares: 100, price: 99.9 }], TODAY, NCCPL); // loss Rs 10 saves Rs 1.50
    expect(tiny).toEqual([]);
  });
});
