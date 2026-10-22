import { describe, expect, it } from 'vitest';
import {
  CLOSE_LOOKBACK_DAYS, RECEIPT_MATCH_DAYS, benchmark, benchmarkReady, cashFlows, chargesSummary, closeOn, dividendsByTaxYear, expectedDividends,
  expectedYearlyIncome, heldAtBookClosure, receiptFrom, totalReturn, valueSeries, whtPct, xirr, type Flow,
} from './performance.ts';
import { costRates, tradeCosts } from './costs.ts';
import { addDays, daysBetween } from './time.ts';
import {
  DEFAULT_RULES, DEFAULT_SETTINGS, type Announcement, type DividendEvent, type DividendReceipt, type Holding, type IndexDay, type PortfolioDay,
  type Price, type PriceMap, type Rules, type Settings, type Txn,
} from './types.ts';

const TODAY = '2026-10-15'; // a Thursday; tax year 2026-27
const S = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...o });
const tx = (symbol: string, side: 'buy' | 'sell', shares: number, price: number, executed_on: string, extra: Partial<Txn> = {}): Txn =>
  ({ symbol, side, shares, price, amount: shares * price, executed_on, source: 'manual', ...extra });
/** A receipt at `wht_pct`: gross = shares x dps, net = gross less the tax. */
const receipt = (symbol: string, paid_on: string, shares: number, dps: number, wht_pct = 15, extra: Partial<DividendReceipt> = {}): DividendReceipt => {
  const gross = shares * dps;
  return { symbol, paid_on, shares, dps, gross, wht_pct, net: gross - (gross * wht_pct) / 100, ...extra };
};
const event = (id: string, symbol: string, book_closure_from: string | null, dps: number | null, extra: Partial<DividendEvent> = {}): DividendEvent => ({
  id, symbol, announced_on: book_closure_from ? addDays(book_closure_from, -14) : '2026-10-01', dps, dividend_type: 'interim',
  book_closure_from, book_closure_to: book_closure_from ? addDays(book_closure_from, 6) : null, verified: true, pdf_url: null, ...extra,
});
const day = (day: string, close: number): IndexDay => ({ day, close });
const price = (symbol: string, p: number | null, dividend_yield_pct: number | null): Price => ({
  symbol, name: null, sector: null, price: p, change: null, change_pct: null, volume: null, ldcp: null, high_52w: null, low_52w: null,
  dividend_yield_pct, pe: null, is_shariah: null, as_of: null,
});
const holding = (symbol: string, shares: number): Holding => ({ symbol, shares, avg_cost: 1, status: 'core', sector: null, is_shariah: false });
/** Net present value of `flows` at a yearly rate, days / 365 from the first flow: zero at the XIRR. */
const npvAt = (flows: Flow[], ratePct: number) => {
  const first = flows.map((f) => f.date).sort()[0];
  return flows.reduce((a, f) => a + f.amount / Math.pow(1 + ratePct / 100, daysBetween(first, f.date) / 365), 0);
};

describe('xirr', () => {
  it('a single buy of 100 worth 110 exactly one year later is 10.0', () => {
    // 2025-10-15 to 2026-10-15 is 365 days (no leap day): (1 + r)^1 = 110 / 100
    expect(xirr([{ date: '2025-10-15', amount: -100 }, { date: TODAY, amount: 110 }])).toBe(10);
    expect(xirr([{ date: TODAY, amount: 110 }, { date: '2025-10-15', amount: -100 }])).toBe(10); // order does not matter
  });

  it('three flows on exact anniversaries: 100 + 100 a year later worth 231 after two years is 10.0', () => {
    // 100 x 1.1^2 + 100 x 1.1 = 121 + 110 = 231; 2024-10-15 -> 2025-10-15 -> 2026-10-15 are 365 days each
    expect(xirr([{ date: '2024-10-15', amount: -100 }, { date: '2025-10-15', amount: -100 }, { date: TODAY, amount: 231 }])).toBe(10);
  });

  it('twelve monthly buys of 1,000 recover the rate the final value was built with', () => {
    const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const buys: Flow[] = months.map((m) => ({ date: `${m}-15`, amount: -1000 }));
    // worth today at 12% a year: each 1,000 grows by 1.12^(days to today / 365)
    const worth = buys.reduce((a, b) => a + 1000 * Math.pow(1.12, daysBetween(b.date, TODAY) / 365), 0);
    expect(xirr([...buys, { date: TODAY, amount: worth }])).toBe(12);
    expect(xirr([...buys, { date: TODAY, amount: 12000 }])).toBe(0); // got exactly the money back
    expect(xirr([...buys, { date: TODAY, amount: 11000 }])).toBeLessThan(0);
  });

  it('a loss worse than -99% a year and a one-day gain are both found (bisection, not just Newton)', () => {
    expect(xirr([{ date: '2025-10-15', amount: -100 }, { date: TODAY, amount: 0.5 }])).toBe(-99.5);
    // 1% in one day: 1.01^365 - 1 = 36.783 = 3,678.3%
    expect(xirr([{ date: '2026-10-14', amount: -100 }, { date: TODAY, amount: 101 }])).toBeCloseTo(3678.3, 0);
  });

  it('is null when there is nothing to solve: fewer than 2 flows, no sign change, one day, a bad date', () => {
    expect(xirr([])).toBeNull();
    expect(xirr([{ date: TODAY, amount: -100 }])).toBeNull();
    expect(xirr([{ date: '2025-10-15', amount: -100 }, { date: TODAY, amount: -50 }])).toBeNull(); // only money in
    expect(xirr([{ date: '2025-10-15', amount: 100 }, { date: TODAY, amount: 50 }])).toBeNull(); // only money out
    expect(xirr([{ date: TODAY, amount: -100 }, { date: TODAY, amount: 110 }])).toBeNull(); // no time passed
    expect(xirr([{ date: '2025-10-15', amount: -100 }, { date: 'yesterday', amount: 110 }])).toBeNull();
    expect(xirr([{ date: '2025-10-15', amount: -100 }, { date: TODAY, amount: 0 }])).toBeNull(); // a zero flow is no flow
  });
});

describe('cashFlows', () => {
  it('buys go out with their charges, sells come in net, dividends net, and the current value last', () => {
    // 100 KEL at 5.94 with no recorded charges: estimate 3.97 (see costs.test.ts) -> -(594 + 3.97) = -597.97
    // 10 MEBL at 548.11 with recorded charges 9 -> -(5481.10 + 9) = -5490.10; sold 5 at 560 with charges 4 -> +(2800 - 4) = +2796
    const txns = [
      tx('MEBL', 'sell', 5, 560, '2026-09-01', { charges: 4 }),
      tx('KEL', 'buy', 100, 5.94, '2026-08-03'),
      tx('MEBL', 'buy', 10, 548.11, '2026-08-03', { charges: 9 }),
    ];
    const flows = cashFlows(txns, [receipt('MEBL', '2026-09-01', 10, 7)], 6000, TODAY, S());
    expect(flows).toEqual([
      { date: '2026-08-03', amount: -597.97, kind: 'buy' },
      { date: '2026-08-03', amount: -5490.1, kind: 'buy' },
      { date: '2026-09-01', amount: 2796, kind: 'sell' },
      { date: '2026-09-01', amount: 59.5, kind: 'dividend' }, // 70 gross less 15% = 59.5
      { date: TODAY, amount: 6000, kind: 'value' },
    ]);
  });

  it('is real cash: match_nccpl does not strip the charges', () => {
    const txns = [tx('KEL', 'buy', 100, 5.94, '2026-08-03')];
    expect(cashFlows(txns, [], 0, TODAY, S({ match_nccpl: true }))[0].amount).toBe(-597.97);
  });

  it('leaves out what cannot be a flow and never makes one up', () => {
    const bad = [tx('KEL', 'buy', 0, 5.94, '2026-08-03'), tx('KEL', 'buy', 100, 0, '2026-08-03')];
    expect(cashFlows(bad, [{ ...receipt('KEL', '2026-09-01', 1, 1), net: NaN }], NaN, TODAY, S())).toEqual([]);
    expect(cashFlows([], [], 0, TODAY, S())).toEqual([{ date: TODAY, amount: 0, kind: 'value' }]);
  });
});

describe('totalReturn', () => {
  // buy 100 at 100 on 2025-10-15 with charges 50 -> invested 10,050 (100.50 a share)
  // sell 40 at 120 on 2026-04-15 with charges 30 -> proceeds 4,770 (119.25 a share)
  // dividend 100 x 2 = 200 gross on 2026-01-15, 15% withheld -> net 170
  // 60 shares left worth 130 = 7,800
  const txns = [tx('A', 'buy', 100, 100, '2025-10-15', { charges: 50 }), tx('A', 'sell', 40, 120, '2026-04-15', { charges: 30 })];
  const receipts = [receipt('A', '2026-01-15', 100, 2)];

  it('adds up invested, proceeds, costs, dividends and the value today', () => {
    const r = totalReturn(txns, receipts, 7800, TODAY, S());
    expect(r).toMatchObject({
      invested: 10050, proceeds: 4770, costs: 80, dividends_gross: 200, dividends_wht: 30, dividends_net: 170, current_value: 7800,
      first_date: '2025-10-15',
    });
    // price_pnl = 7,800 - 60 x 100.50 = 7,800 - 6,030 = 1,770; realized = 40 x (119.25 - 100.50) = 750
    // total = 7,800 + 4,770 + 170 - 10,050 = 2,690 = 1,770 + 750 + 170; 2,690 / 10,050 = 26.77% -> 26.8
    expect(r.price_pnl).toBe(1770);
    expect(r.realized_pnl).toBe(750);
    expect(r.total_return).toBe(2690);
    expect(r.total_return_pct).toBe(26.8);
    expect(r.price_pnl + r.realized_pnl + r.dividends_net).toBe(r.total_return);
  });

  it('the XIRR is the rate at which -10,050, +170 (92 days), +4,770 (182 days) and +7,800 (365 days) net to zero', () => {
    // at 34.87%: 170 / 1.3487^0.252 + 4,770 / 1.3487^0.4986 + 7,800 / 1.3487 = 157.65 + 4,109.0 + 5,783.3 = 10,049.95 -> 34.9
    expect(daysBetween('2025-10-15', '2026-01-15')).toBe(92);
    expect(daysBetween('2025-10-15', '2026-04-15')).toBe(182);
    const r = totalReturn(txns, receipts, 7800, TODAY, S());
    expect(r.xirr_pct).toBe(34.9);
    expect(Math.abs(npvAt(cashFlows(txns, receipts, 7800, TODAY, S()), 34.9))).toBeLessThan(10);
  });

  it('is real money: match_nccpl changes nothing here', () => {
    expect(totalReturn(txns, receipts, 7800, TODAY, S({ match_nccpl: true }))).toEqual(totalReturn(txns, receipts, 7800, TODAY, S()));
  });

  it('estimates charges when the transactions carry none', () => {
    // 100 KEL at 5.94, estimate 3.97 -> invested 597.97; worth 650 -> total 52.03; 52.03 / 597.97 = 8.70%
    const r = totalReturn([tx('KEL', 'buy', 100, 5.94, '2026-08-03')], [], 650, TODAY, S());
    expect(r).toMatchObject({ invested: 597.97, costs: 3.97, price_pnl: 52.03, realized_pnl: 0, total_return: 52.03, total_return_pct: 8.7 });
  });

  it('with nothing recorded everything is 0 and the percentages are null, not 0', () => {
    expect(totalReturn([], [], 0, TODAY, S())).toEqual({
      invested: 0, proceeds: 0, costs: 0, dividends_gross: 0, dividends_wht: 0, dividends_net: 0, current_value: 0, price_pnl: 0, realized_pnl: 0,
      total_return: 0, total_return_pct: null, xirr_pct: null, first_date: null,
    });
  });

  it('a sell with no recorded buy still counts as proceeds but carries no realized gain', () => {
    // sold 10 at 50 with charges 0: proceeds 500, invested 0 -> total 500, pct null (nothing invested); the lot book matched it at the sell price
    const r = totalReturn([tx('B', 'sell', 10, 50, '2026-09-01', { charges: 0 })], [], 0, TODAY, S());
    expect(r).toMatchObject({ invested: 0, proceeds: 500, total_return: 500, total_return_pct: null, realized_pnl: 0, price_pnl: 0 });
  });

  it('a partial sell across two lots with different cost bases: FIFO, each lot at its own cost', () => {
    // buy 100 at 100, charges 50 -> 100.50 a share (10,050); buy 100 at 120, charges 60 -> 120.60 a share (12,060); invested 22,110
    // sell 150 at 130, charges 45 -> proceeds 19,455 = 129.70 a share
    // FIFO: 100 from the first lot: 100 x (129.70 - 100.50) = 2,920; 50 from the second: 50 x (129.70 - 120.60) = 455; realized 3,375
    // 50 left at 120.60 = 6,030; worth 7,000 -> price_pnl 970
    // total = 7,000 + 19,455 - 22,110 = 4,345 = 970 + 3,375; 4,345 / 22,110 = 19.65% -> 19.7
    const two = [
      tx('A', 'buy', 100, 100, '2025-10-15', { charges: 50 }),
      tx('A', 'buy', 100, 120, '2026-01-15', { charges: 60 }),
      tx('A', 'sell', 150, 130, '2026-04-15', { charges: 45 }),
    ];
    const r = totalReturn(two, [], 7000, TODAY, S());
    expect(r).toMatchObject({
      invested: 22110, proceeds: 19455, costs: 155, dividends_net: 0, current_value: 7000, price_pnl: 970, realized_pnl: 3375,
      total_return: 4345, total_return_pct: 19.7, first_date: '2025-10-15',
    });
    expect(r.price_pnl + r.realized_pnl + r.dividends_net).toBe(r.total_return);
  });
});

describe('closeOn', () => {
  // Fri 2026-10-09, Mon 2026-10-12; the weekend in between has no close
  const index = [day('2026-10-12', 160000), day('2026-10-09', 158000), day('2026-10-08', 157000)]; // not sorted on purpose

  it('picks the previous trading day on a weekend and the day itself on a trading day', () => {
    expect(closeOn(index, '2026-10-10')).toEqual({ day: '2026-10-09', close: 158000 }); // Saturday
    expect(closeOn(index, '2026-10-11')).toEqual({ day: '2026-10-09', close: 158000 }); // Sunday
    expect(closeOn(index, '2026-10-12')).toEqual({ day: '2026-10-12', close: 160000 });
    expect(closeOn(index, '2026-10-09')).toEqual({ day: '2026-10-09', close: 158000 });
  });

  it('looks at most maxDaysBack days back (7 by default) and is null before the first day', () => {
    expect(CLOSE_LOOKBACK_DAYS).toBe(7);
    expect(closeOn(index, '2026-10-19')).toEqual({ day: '2026-10-12', close: 160000 }); // 7 days back: still in reach
    expect(closeOn(index, '2026-10-20')).toBeNull(); // 8 days back
    expect(closeOn(index, '2026-10-20', 8)).toEqual({ day: '2026-10-12', close: 160000 });
    expect(closeOn(index, '2026-10-07')).toBeNull();
    expect(closeOn([], '2026-10-12')).toBeNull();
  });

  it('ignores rows without a usable close: NaN, 0 or a negative level is no close', () => {
    expect(closeOn([day('2026-10-12', NaN), day('2026-10-09', 158000)], '2026-10-12')).toEqual({ day: '2026-10-09', close: 158000 });
    expect(closeOn([day('2026-10-09', 0)], '2026-10-10')).toBeNull();
    expect(closeOn([day('2026-10-12', 0), day('2026-10-09', 158000)], '2026-10-12')).toEqual({ day: '2026-10-09', close: 158000 });
    expect(closeOn([day('2026-10-12', -5), day('2026-10-09', 158000)], '2026-10-12')).toEqual({ day: '2026-10-09', close: 158000 });
  });
});

describe('benchmark', () => {
  // The index at 100, 110 and 121 on three exact anniversaries: it grows 10% a year.
  const INDEX = [day('2024-10-15', 100), day('2025-10-15', 110), day(TODAY, 121)];

  it('two buys into an index that grows 10% a year: units, value, return and XIRR by hand', () => {
    // 10,000 at 100 = 100 units; 11,000 at 110 = 100 units; 200 units x 121 = 24,200
    // index return (24,200 - 21,000) / 21,000 = 15.24% -> 15.2; index XIRR exactly 10.0 (the flows are a year apart)
    // my value 23,100: return 2,100 / 21,000 = 10.0%; XIRR: 23,100 x^2 - 11,000 x - 10,000 = 0 with x = 1/(1+r)
    //   -> x = (11,000 + sqrt(121e6 + 924e6)) / 46,200 = 43,326.46 / 46,200 = 0.93780 -> r = 6.63% -> 6.6
    const flows: Flow[] = [{ date: '2024-10-15', amount: -10000, kind: 'buy' }, { date: '2025-10-15', amount: -11000, kind: 'buy' }];
    const b = benchmark(flows, 23100, INDEX, TODAY);
    expect(b).toEqual({
      index_value: 24200, index_return_pct: 15.2, my_return_pct: 10, index_xirr_pct: 10, my_xirr_pct: 6.6, diff_pkr: -1100, diff_pct: -3.4,
      coverage: { from: '2024-10-15', uncovered_flows: 0, note: null }, index_latest: { day: TODAY, close: 121 },
    });
  });

  it('sells and dividends sell units at that day\'s close', () => {
    // 10,000 at 100 = 100 units; on 2025-10-15 at 110 a 550 dividend sells 5 units and a 2,200 sell 20 -> 75 units x 121 = 9,075
    // index return (9,075 + 2,750 - 10,000) / 10,000 = 18.25% -> 18.3; XIRR 10.0 again: 2,750 / 1.1 + 9,075 / 1.21 = 2,500 + 7,500
    const flows: Flow[] = [
      { date: '2024-10-15', amount: -10000, kind: 'buy' }, { date: '2025-10-15', amount: 550, kind: 'dividend' }, { date: '2025-10-15', amount: 2200, kind: 'sell' },
    ];
    const b = benchmark(flows, 9075, INDEX, TODAY);
    expect(b).toMatchObject({ index_value: 9075, index_return_pct: 18.3, index_xirr_pct: 10, my_return_pct: 18.3, my_xirr_pct: 10, diff_pkr: 0, diff_pct: 0 });
  });

  it('my_return_pct is totalReturn\'s total_return_pct when every flow is covered, and the final value flow from cashFlows is ignored', () => {
    const txns = [tx('A', 'buy', 100, 100, '2024-10-15', { charges: 0 }), tx('A', 'buy', 100, 110, '2025-10-15', { charges: 0 })];
    const all = cashFlows(txns, [], 23100, TODAY, S());
    expect(all[all.length - 1].kind).toBe('value');
    const withValue = benchmark(all, 23100, INDEX, TODAY);
    expect(withValue).toEqual(benchmark(all.filter((f) => f.kind !== 'value'), 23100, INDEX, TODAY));
    expect(withValue.my_return_pct).toBe(totalReturn(txns, [], 23100, TODAY, S()).total_return_pct);
    expect(withValue.my_xirr_pct).toBe(totalReturn(txns, [], 23100, TODAY, S()).xirr_pct);
  });

  const NO_CLOSE = (n: number, days = 7) => `${n === 1 ? '1 flow' : `${n} flows`} had no KSE-100 close within ${days} days (before the index history starts, or in a gap)`;
  const NEVER_BOUGHT = (n: number) => `${n === 1 ? '1 flow' : `${n} flows`} (a sell or dividend) came from shares the index side never bought (the buy was not recorded, or came before the index history)`;
  const UNFAIR = ', so there is no fair comparison yet: it needs a KSE-100 close for every buy, sell and dividend.';

  it('a flow with no close within 7 days is uncovered: counted, priced out of the index side, and my side is not compared', () => {
    // index history starts Mon 2026-01-05, next close Mon 2026-02-02 (a gap)
    const index = [day('2026-01-05', 100), day('2026-02-02', 200)];
    const flows: Flow[] = [
      { date: '2025-12-30', amount: -1000, kind: 'buy' }, // before the first index day
      { date: '2026-01-09', amount: -1000, kind: 'buy' }, // Friday, 4 days after 01-05: priced at 100 -> 10 units
      { date: '2026-01-20', amount: -1000, kind: 'buy' }, // 15 days after 01-05: out of reach
    ];
    const b = benchmark(flows, 1500, index, '2026-02-02');
    // index over the one covered flow: 10 units x 200 = 2,000, return 100%; doubling in 24 days is 2^(365/24) - 1 = 37,857.6x = 3,785,759.7% a year
    // my 1,500 holds what all three buys bought, so it cannot be set against the one covered flow: (1,500 - 1,000) / 1,000 = 50% would be invented
    expect(daysBetween('2026-01-09', '2026-02-02')).toBe(24);
    expect(b).toEqual({
      index_value: 2000, index_return_pct: 100, my_return_pct: null, index_xirr_pct: 3785759.7, my_xirr_pct: null, diff_pkr: null, diff_pct: null,
      coverage: { from: '2026-01-05', uncovered_flows: 2, note: NO_CLOSE(2) + UNFAIR }, index_latest: { day: '2026-02-02', close: 200 },
    });
    // with a 30-day reach the 01-20 buy is priced at 100 too: 20 units = 4,000; the 12-30 buy is still out, so my side is still not compared
    const wide = benchmark(flows, 1500, index, '2026-02-02', 30);
    expect(wide).toMatchObject({ index_value: 4000, index_return_pct: 100, my_return_pct: null, diff_pkr: null, diff_pct: null, coverage: { uncovered_flows: 1, note: NO_CLOSE(1, 30) + UNFAIR } });
  });

  it('the real case: an old buy before the index history starts, still held, gives null figures rather than a 1,100% return', () => {
    // index history starts 2026-10-01 at 150,000, latest 2026-10-15 at 160,000
    const index = [day('2026-10-01', 150000), day(TODAY, 160000)];
    const flows: Flow[] = [{ date: '2025-01-10', amount: -100000, kind: 'buy' }, { date: '2026-10-01', amount: -10000, kind: 'buy' }];
    // the covered 10,000 at 150,000 = 0.0666667 units x 160,000 = 10,666.67: the index is up 6.67% -> 6.7
    // my 120,000 holds the shares both buys paid for: (120,000 - 10,000) / 10,000 = 1,100% is not a return anyone earned
    const b = benchmark(flows, 120000, index, TODAY);
    expect(b).toEqual({
      index_value: 10666.67, index_return_pct: 6.7, my_return_pct: null, index_xirr_pct: b.index_xirr_pct, my_xirr_pct: null, diff_pkr: null, diff_pct: null,
      coverage: { from: '2026-10-01', uncovered_flows: 1, note: NO_CLOSE(1) + UNFAIR }, index_latest: { day: TODAY, close: 160000 },
    });
    expect(b.index_xirr_pct).toBeGreaterThan(0); // 6.67% in two weeks, annualised: a real but silly number, kept for the index side only
    expect(b.index_xirr_pct).toBeLessThan(1e6);
  });

  it('a sell or dividend beyond the index units held is not matched: never a negative index value', () => {
    const index = [day('2026-10-01', 150000), day(TODAY, 160000)];
    // the 50,000 buy is before the index history; the sell on 10-05 is priced at 10-01's 150,000 but the index side holds no units to sell
    const sold = benchmark([{ date: '2025-01-10', amount: -50000, kind: 'buy' }, { date: '2026-10-05', amount: 20000, kind: 'sell' }], 40000, index, TODAY);
    expect(sold).toEqual({
      index_value: 0, index_return_pct: null, my_return_pct: null, index_xirr_pct: null, my_xirr_pct: null, diff_pkr: null, diff_pct: null,
      coverage: { from: null, uncovered_flows: 2, note: `${NO_CLOSE(1)} and ${NEVER_BOUGHT(1)}${UNFAIR}` }, index_latest: { day: TODAY, close: 160000 },
    });
    // the same with a 3,000 dividend
    const paid = benchmark([{ date: '2025-01-10', amount: -50000, kind: 'buy' }, { date: '2026-10-05', amount: 3000, kind: 'dividend' }], 40000, index, TODAY);
    expect(paid).toMatchObject({ index_value: 0, index_xirr_pct: null, diff_pkr: null, coverage: { uncovered_flows: 2 } });
    // a sell with no buy recorded at all
    const orphan = benchmark([{ date: '2026-10-05', amount: 20000, kind: 'sell' }], 0, index, TODAY);
    expect(orphan).toMatchObject({ index_value: 0, index_xirr_pct: null, diff_pkr: null, coverage: { from: null, uncovered_flows: 1, note: NEVER_BOUGHT(1) + UNFAIR } });
    // a covered buy of 10,000 at 150,000 (0.0666667 units) then a 20,000 sell that would need 0.1333 units: the buy stays, the sell is out
    const over = benchmark([{ date: '2026-10-01', amount: -10000, kind: 'buy' }, { date: '2026-10-05', amount: 20000, kind: 'sell' }], 0, index, TODAY);
    expect(over).toMatchObject({ index_value: 10666.67, index_return_pct: 6.7, my_return_pct: null, diff_pkr: null, coverage: { from: '2026-10-01', uncovered_flows: 1, note: NEVER_BOUGHT(1) + UNFAIR } });
    // selling exactly everything is fine: 10,000 at 100 = 100 units, 11,000 at 110 sells all 100 -> 0 units, index return 10%, mine the same
    const all = benchmark([{ date: '2024-10-15', amount: -10000, kind: 'buy' }, { date: '2025-10-15', amount: 11000, kind: 'sell' }], 0, INDEX, TODAY);
    expect(all).toMatchObject({ index_value: 0, index_return_pct: 10, my_return_pct: 10, diff_pkr: 0, diff_pct: 0, coverage: { uncovered_flows: 0, note: null } });
    // flows are taken in date order whatever order they arrive in
    expect(benchmark([{ date: '2025-10-15', amount: 11000, kind: 'sell' }, { date: '2024-10-15', amount: -10000, kind: 'buy' }], 0, INDEX, TODAY)).toEqual(all);
  });

  it('a close of 0 is no close: the flow is uncovered or the latest day is the last positive one, never Infinity', () => {
    const buy: Flow[] = [{ date: '2026-10-09', amount: -1000, kind: 'buy' }];
    // the zero sits on the buy's day: nothing to price the buy with
    const onBuy = benchmark(buy, 1100, [day('2026-10-09', 0), day(TODAY, 160000)], TODAY);
    expect(onBuy).toEqual({
      index_value: 0, index_return_pct: null, my_return_pct: null, index_xirr_pct: null, my_xirr_pct: null, diff_pkr: null, diff_pct: null,
      coverage: { from: null, uncovered_flows: 1, note: NO_CLOSE(1) + UNFAIR }, index_latest: { day: TODAY, close: 160000 },
    });
    // the zero sits on today: the latest usable close is 10-09, so a buy today is priced there too and the index is flat
    // 1,000 / 160,000 = 0.00625 units x 160,000 = 1,000; my 1,100 is 10% up; same day, so no XIRR
    const onToday = benchmark([{ date: TODAY, amount: -1000, kind: 'buy' }], 1100, [day('2026-10-09', 160000), day(TODAY, 0)], TODAY);
    expect(onToday).toMatchObject({ index_value: 1000, index_return_pct: 0, my_return_pct: 10, index_xirr_pct: null, my_xirr_pct: null, diff_pkr: 100, diff_pct: 10, index_latest: { day: '2026-10-09', close: 160000 }, coverage: { from: '2026-10-09', uncovered_flows: 0 } });
    for (const v of Object.values(onToday)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
  });

  it('says so when there is nothing to compare, with 0 units and null rather than a made-up figure', () => {
    const flows: Flow[] = [{ date: '2026-01-09', amount: -1000, kind: 'buy' }];
    const empty = benchmark(flows, 1500, [], '2026-02-02');
    expect(empty).toMatchObject({ index_value: 0, index_return_pct: null, my_return_pct: null, index_xirr_pct: null, my_xirr_pct: null, diff_pkr: null, diff_pct: null, index_latest: null });
    expect(empty.coverage).toEqual({ from: null, uncovered_flows: 1, note: 'No KSE-100 history on or before today, so there is nothing to compare yet.' });
    expect(benchmark([], 0, [day('2026-01-05', 100)], '2026-02-02').coverage.note).toBe('No buys, sells or dividends to compare yet.');
    // every flow uncovered
    const none = benchmark([{ date: '2025-12-30', amount: -1000, kind: 'buy' }], 1500, [day('2026-01-05', 100)], '2026-02-02');
    expect(none).toMatchObject({ index_value: 0, diff_pkr: null, my_return_pct: null, coverage: { from: null, uncovered_flows: 1, note: NO_CLOSE(1) + UNFAIR } });
  });

  it('falls back to the simple returns for diff_pct when an XIRR is not known', () => {
    // one buy and the value on the same day: no time passed, so no XIRR; the simple returns still compare
    const flows: Flow[] = [{ date: TODAY, amount: -1000, kind: 'buy' }];
    const b = benchmark(flows, 1100, [day(TODAY, 100)], TODAY);
    expect(b).toMatchObject({ index_value: 1000, index_return_pct: 0, my_return_pct: 10, index_xirr_pct: null, my_xirr_pct: null, diff_pct: 10, diff_pkr: 100 });
  });
});

describe('whtPct', () => {
  it('is 15% for a filer and 30% for a non-filer by default, 7.5% / 15% for power companies', () => {
    expect(whtPct('COMMERCIAL BANKS', true)).toBe(15);
    expect(whtPct('COMMERCIAL BANKS', false)).toBe(30);
    expect(whtPct('POWER GENERATION & DISTRIBUTION', true)).toBe(7.5);
    expect(whtPct('POWER GENERATION & DISTRIBUTION', false)).toBe(15);
    expect(whtPct('power generation & distribution ', true)).toBe(7.5); // case and spaces do not matter
    expect(whtPct('REAL ESTATE INVESTMENT TRUST', true)).toBe(15);
    expect(whtPct(null, true)).toBe(15);
    expect(whtPct(undefined, false)).toBe(30);
    expect(whtPct('', true)).toBe(15);
  });

  it('reads the table from the rules passed in', () => {
    const rules = {
      ...DEFAULT_RULES,
      tax: { ...DEFAULT_RULES.tax, dividend_wht: { default: { filer_pct: 10, non_filer_pct: 20 }, banks: { filer_pct: 5, non_filer_pct: 9, sectors: ['COMMERCIAL BANKS'] } } },
    } as unknown as Rules;
    expect(whtPct('OIL & GAS', true, rules)).toBe(10);
    expect(whtPct('COMMERCIAL BANKS', false, rules)).toBe(9);
    expect(whtPct('POWER GENERATION & DISTRIBUTION', true, rules)).toBe(10); // no power entry in this table
  });
});

describe('expectedDividends and receiptFrom', () => {
  const SECTORS = { DCR: 'REAL ESTATE INVESTMENT TRUST', HUBC: 'POWER GENERATION & DISTRIBUTION' };
  // DCR: Rs 2 a share, book closure starts Sat 2026-10-17; HUBC: Rs 5, book closure from 2026-09-25
  const EVENTS = [event('dcr-1', 'DCR', '2026-10-17', 2, { announced_on: '2026-10-01' }), event('hubc-1', 'HUBC', '2026-09-25', 5)];
  const TXNS = [tx('DCR', 'buy', 100, 12, '2026-10-10'), tx('HUBC', 'buy', 26, 195.57, '2026-09-01')];

  it('lists what a holder at the day before book closure should receive, newest first, with the sector\'s WHT', () => {
    const out = expectedDividends(TXNS, EVENTS, [], SECTORS, S());
    expect(out).toEqual([
      // 100 x 2 = 200 gross; REIT 15% = 30; net 170
      { dividend_id: 'dcr-1', symbol: 'DCR', shares: 100, dps: 2, gross: 200, wht_pct: 15, wht: 30, net: 170, book_closure_from: '2026-10-17', announced_on: '2026-10-01', verified: true, basis: 'log' },
      // 26 x 5 = 130 gross; power 7.5% = 9.75; net 120.25
      { dividend_id: 'hubc-1', symbol: 'HUBC', shares: 26, dps: 5, gross: 130, wht_pct: 7.5, wht: 9.75, net: 120.25, book_closure_from: '2026-09-25', announced_on: '2026-09-11', verified: true, basis: 'log' },
    ]);
    expect(expectedDividends(TXNS, EVENTS, [], SECTORS, S({ tax_filer: false }))[0]).toMatchObject({ wht_pct: 30, wht: 60, net: 140 });
  });

  it('a non-holder at book closure gets nothing: bought on the day, or sold the day before', () => {
    expect(expectedDividends([tx('DCR', 'buy', 100, 12, '2026-10-17')], EVENTS, [], SECTORS, S())).toEqual([]);
    const soldOut = [tx('DCR', 'buy', 100, 12, '2026-10-10'), tx('DCR', 'sell', 100, 12, '2026-10-16')];
    expect(expectedDividends(soldOut, EVENTS, [], SECTORS, S())).toEqual([]);
    // sold only some: the rest still count
    const trimmed = [tx('DCR', 'buy', 100, 12, '2026-10-10'), tx('DCR', 'sell', 40, 12, '2026-10-16')];
    expect(expectedDividends(trimmed, EVENTS, [], SECTORS, S())).toMatchObject([{ symbol: 'DCR', shares: 60, gross: 120 }]);
  });

  it('drops events already received: by dividend_id, or the same symbol paid within 60 days of book closure', () => {
    expect(RECEIPT_MATCH_DAYS).toBe(60);
    const byId = [receipt('DCR', '2026-11-20', 100, 2, 15, { dividend_id: 'dcr-1' })];
    expect(expectedDividends(TXNS, EVENTS, byId, SECTORS, S()).map((e) => e.symbol)).toEqual(['HUBC']);
    const byWindow = [receipt('DCR', '2026-11-20', 100, 2)]; // 34 days after 2026-10-17, no id
    expect(expectedDividends(TXNS, EVENTS, byWindow, SECTORS, S()).map((e) => e.symbol)).toEqual(['HUBC']);
    const onTheDay = [receipt('DCR', '2026-10-17', 100, 2)];
    expect(expectedDividends(TXNS, EVENTS, onTheDay, SECTORS, S()).map((e) => e.symbol)).toEqual(['HUBC']);
    const tooLate = [receipt('DCR', '2026-12-17', 100, 2)]; // 61 days
    expect(expectedDividends(TXNS, EVENTS, tooLate, SECTORS, S()).map((e) => e.symbol)).toEqual(['DCR', 'HUBC']);
    const before = [receipt('DCR', '2026-10-16', 100, 2)]; // paid before book closure: a different dividend
    expect(expectedDividends(TXNS, EVENTS, before, SECTORS, S()).map((e) => e.symbol)).toEqual(['DCR', 'HUBC']);
    const otherId = [receipt('DCR', '2026-11-20', 100, 2, 15, { dividend_id: 'dcr-0' })]; // in the window but for another declared dividend
    expect(expectedDividends(TXNS, EVENTS, otherId, SECTORS, S()).map((e) => e.symbol)).toEqual(['DCR', 'HUBC']);
  });

  it('takes the matching window from rules.dividends.receipt_match_days when the rules carry it', () => {
    const rules = { ...DEFAULT_RULES, dividends: { ...DEFAULT_RULES.dividends, receipt_match_days: 10 } } as Rules;
    const byWindow = [receipt('DCR', '2026-11-20', 100, 2)]; // 34 days: outside a 10-day window
    expect(expectedDividends(TXNS, EVENTS, byWindow, SECTORS, S(), rules).map((e) => e.symbol)).toEqual(['DCR', 'HUBC']);
  });

  it('skips events without a dps or a book closure date, and matches symbols regardless of case', () => {
    const events = [event('x1', 'DCR', null, 2), event('x2', 'DCR', '2026-10-17', null), event('x3', 'dcr ', '2026-10-17', 2)];
    const out = expectedDividends([tx('Dcr', 'buy', 10, 12, '2026-10-10')], events, [], SECTORS, S());
    expect(out).toMatchObject([{ dividend_id: 'x3', symbol: 'DCR', shares: 10, gross: 20, wht_pct: 15 }]);
    expect(expectedDividends([], EVENTS, [], SECTORS, S())).toEqual([]);
  });

  it('receiptFrom builds the receipt row, paid on book closure unless told otherwise', () => {
    const e = expectedDividends(TXNS, EVENTS, [], SECTORS, S())[0];
    expect(receiptFrom(e)).toEqual({ symbol: 'DCR', paid_on: '2026-10-17', shares: 100, dps: 2, gross: 200, wht_pct: 15, net: 170, dividend_id: 'dcr-1', note: null });
    expect(receiptFrom(e, '2026-11-02').paid_on).toBe('2026-11-02');
    // the receipt then covers the event
    expect(expectedDividends(TXNS, EVENTS, [receiptFrom(e)], SECTORS, S()).map((x) => x.symbol)).toEqual(['HUBC']);
  });

  it('expected uses holdings when log has a gap', () => {
    // HUBC came in as a baseline (no logged buys); its book closure starts today
    const holdings = [holding('HUBC', 120), holding('DCR', 100)];
    const events = [event('hubc-2', 'HUBC', TODAY, 4)];
    const out = expectedDividends(TXNS.filter((t) => t.symbol === 'DCR'), events, [], SECTORS, S(), DEFAULT_RULES, { holdings });
    expect(out).toMatchObject([{ dividend_id: 'hubc-2', symbol: 'HUBC', shares: 120, gross: 480, basis: 'holdings' }]);
    // without the holdings the log alone still says nothing was held
    expect(expectedDividends(TXNS.filter((t) => t.symbol === 'DCR'), events, [], SECTORS, S())).toEqual([]);
    // a log that explains the holding keeps the log basis
    expect(expectedDividends(TXNS, EVENTS, [], SECTORS, S(), DEFAULT_RULES, { holdings: [holding('DCR', 100)] }).map((e) => e.basis)).toEqual(['log', 'log']);
  });

  it('expected excludes buys after cutoff', () => {
    // 150 OGDC held; only the 50 bought on book closure day are logged, so the log has a gap of 100
    const holdings = [holding('OGDC', 150)];
    const events = [event('ogdc-1', 'OGDC', '2026-10-12', 3)];
    const txns = [tx('OGDC', 'buy', 50, 200, '2026-10-12'), tx('OGDC', 'buy', 30, 200, '2026-10-14')];
    // 150 now - 80 bought on/after the cut-off = 70 at book closure; the log alone would say 0
    expect(expectedDividends(txns, events, [], {}, S(), DEFAULT_RULES, { holdings })).toMatchObject([{ shares: 70, gross: 210, basis: 'holdings' }]);
    // a sell after the cut-off adds back shares that were held then
    const sold = [...txns, tx('OGDC', 'sell', 20, 210, '2026-10-13')];
    expect(expectedDividends(sold, events, [], {}, S(), DEFAULT_RULES, { holdings })).toMatchObject([{ shares: 90, basis: 'holdings' }]);
  });

  it('expected takes book closure from announcement text', () => {
    const ann = (id: string, title: string, figures?: { label: string; value: string }[]): Announcement => ({
      id, symbol: 'DCR', kind: 'dividend', published_at: '2026-10-08', title, pdf_url: null, ai_figures: figures?.map((f) => ({ ...f, verified: true })) ?? null,
    });
    const events = [event('a-1', 'DCR', null, 2, { announced_on: '2026-10-08' })];
    const fromTitle = [ann('a-1', 'Cash dividend; book closure from October 17, 2026 to October 22, 2026')];
    expect(expectedDividends(TXNS, events, [], SECTORS, S(), DEFAULT_RULES, { announcements: fromTitle }))
      .toMatchObject([{ dividend_id: 'a-1', symbol: 'DCR', shares: 100, book_closure_from: '2026-10-17', basis: 'log' }]);
    const fromFigure = [ann('a-1', 'Dividend declared', [{ label: 'Book closure dates', value: '17-10-2026 to 22-10-2026' }])];
    expect(expectedDividends(TXNS, events, [], SECTORS, S(), DEFAULT_RULES, { announcements: fromFigure })).toMatchObject([{ book_closure_from: '2026-10-17' }]);
    // no matching notice, a notice without a book closure, or an implausible date: still skipped
    expect(expectedDividends(TXNS, events, [], SECTORS, S(), DEFAULT_RULES, { announcements: [ann('a-2', 'Book closure from October 17, 2026')] })).toEqual([]);
    expect(expectedDividends(TXNS, events, [], SECTORS, S(), DEFAULT_RULES, { announcements: [ann('a-1', 'Board meeting on October 17, 2026')] })).toEqual([]);
    expect(expectedDividends(TXNS, events, [], SECTORS, S(), DEFAULT_RULES, { announcements: [ann('a-1', 'Book closure from October 17, 2020')] })).toEqual([]);
  });
});

describe('heldAtBookClosure', () => {
  it('reads the log when it explains the holding, else the holdings less what moved on or after the cut-off', () => {
    const logged = [tx('DCR', 'buy', 100, 12, '2026-10-10'), tx('DCR', 'buy', 20, 12, '2026-10-17')];
    expect(heldAtBookClosure('DCR', '2026-10-17', logged, [holding('DCR', 120)])).toEqual({ shares: 100, basis: 'log' });
    expect(heldAtBookClosure('dcr', '2026-10-17', logged, [])).toEqual({ shares: 100, basis: 'log' }); // not held now: the log is all there is
    expect(heldAtBookClosure('DCR', '2026-10-17', [], [holding('DCR', 120)])).toEqual({ shares: 120, basis: 'holdings' });
    expect(heldAtBookClosure('DCR', '2026-10-17', [tx('DCR', 'buy', 20, 12, '2026-10-17')], [holding('DCR', 120)])).toEqual({ shares: 100, basis: 'holdings' });
    // never below 0
    expect(heldAtBookClosure('DCR', '2026-10-17', [tx('DCR', 'buy', 5, 12, '2026-10-20')], [holding('DCR', 10)])).toEqual({ shares: 5, basis: 'holdings' });
    expect(heldAtBookClosure('DCR', '2026-10-17', [tx('DCR', 'buy', 5, 12, '2026-10-20')], [holding('DCR', 4)]).shares).toBe(0);
  });
});

describe('chargesSummary', () => {
  it('charges summary on partial log', () => {
    // 100 DCR logged at Rs 300 with recorded charges; 50 HUBC came from a screenshot (implied price, charges inside);
    // MEBL is held with no log at all
    const txns = [
      tx('DCR', 'buy', 100, 300, '2026-10-01', { charges: 45.5 }),
      tx('HUBC', 'buy', 50, 200, '2026-10-02', { source: 'import' }),
      tx('DCR', 'sell', 20, 320, '2026-10-05'),
    ];
    const holdings: Holding[] = [{ ...holding('DCR', 80), avg_cost: 300.46 }, { ...holding('HUBC', 50), avg_cost: 200 }, { ...holding('MEBL', 100), avg_cost: 400 }];
    const rates = costRates(S());
    const sellCharges = tradeCosts(20, 320, rates).total;
    const c = chargesSummary(txns, holdings, {}, S());
    expect(c.logged).toBeCloseTo(45.5 + sellCharges, 2); // the screenshot buy adds nothing
    expect(c.logged_on).toBe(30000 + 6400); // the trades those charges were on
    expect(c.cost_basis).toBe(24036.8 + 10000 + 40000);
    // the estimate backs the buy charges out of each average cost (which already includes them)
    const inside = (shares: number, cost: number) => { const ch = tradeCosts(shares, cost, rates).total; return ch / (1 + ch / (shares * cost)); };
    expect(c.estimate_all).toBeCloseTo(inside(80, 300.46) + inside(50, 200) + inside(100, 400), 2);
    expect(c.estimate_all).toBeGreaterThan(c.cost_basis * 0.001);
    expect(c.estimate_all).toBeLessThan(c.cost_basis * 0.01);
    expect(c.implied_include_charges).toBe(true);
    expect(chargesSummary([], [], {}, S())).toEqual({ logged: 0, logged_on: 0, estimate_all: 0, cost_basis: 0, implied_include_charges: true });
  });
});

describe('benchmarkReady', () => {
  const snap = (day: string, value = 1000): PortfolioDay => ({ day, value, invested: 900 });
  it('benchmark hidden under 30 days', () => {
    expect(DEFAULT_RULES.performance.benchmark_min_days).toBe(30);
    expect(benchmarkReady([], TODAY)).toEqual({ ready: false, starts_on: null, ready_on: null });
    const snaps = [snap('2026-10-01'), snap('2026-09-20'), snap('2026-09-10', 0)]; // a zero value is no history
    expect(benchmarkReady(snaps, TODAY)).toEqual({ ready: false, starts_on: '2026-09-20', ready_on: '2026-10-20' });
    expect(benchmarkReady(snaps, '2026-10-20')).toEqual({ ready: true, starts_on: '2026-09-20', ready_on: '2026-10-20' });
    const rules = { ...DEFAULT_RULES, performance: { ...DEFAULT_RULES.performance, benchmark_min_days: 10 } } as Rules;
    expect(benchmarkReady(snaps, '2026-09-30', rules)).toEqual({ ready: true, starts_on: '2026-09-20', ready_on: '2026-09-30' });
    expect(benchmarkReady([snap('2026-10-20')], TODAY).starts_on).toBeNull(); // a snapshot after today does not count
  });
});

describe('dividendsByTaxYear', () => {
  it('splits receipts at 30 June / 1 July and sums gross, withheld and net per year and symbol, newest year first', () => {
    const receipts = [
      receipt('MEBL', '2026-06-30', 8, 7), // 56 gross, 8.40 withheld, 47.60 net: tax year 2025-26
      receipt('HUBC', '2026-07-01', 26, 5, 7.5), // 130 gross, 9.75 withheld, 120.25 net: 2026-27
      receipt('MEBL', '2026-09-10', 8, 7), // 56 / 8.40 / 47.60: 2026-27
    ];
    expect(dividendsByTaxYear(receipts)).toEqual([
      { year: '2026-27', gross: 186, wht: 18.15, net: 167.85, count: 2, by_symbol: [{ symbol: 'HUBC', net: 120.25 }, { symbol: 'MEBL', net: 47.6 }] },
      { year: '2025-26', gross: 56, wht: 8.4, net: 47.6, count: 1, by_symbol: [{ symbol: 'MEBL', net: 47.6 }] },
    ]);
  });

  it('is empty with no receipts and leaves out rows it cannot add up', () => {
    expect(dividendsByTaxYear([])).toEqual([]);
    expect(dividendsByTaxYear([{ ...receipt('MEBL', '2026-09-10', 8, 7), gross: NaN }, { ...receipt('MEBL', '', 8, 7) }])).toEqual([]);
  });

  it('takes the tax year start from the rules', () => {
    const april: Rules = { ...DEFAULT_RULES, tax: { ...DEFAULT_RULES.tax, tax_year_start_month: 4 } };
    expect(dividendsByTaxYear([receipt('MEBL', '2026-06-30', 8, 7)], april)[0].year).toBe('2026-27');
  });
});

describe('expectedYearlyIncome', () => {
  it('sums shares x price x yield for holdings with data and names the rest', () => {
    // MEBL 8 x 548.11 x 5% = 219.244; HUBC 26 x 195.57 x 10% = 508.482; total 727.726 -> 727.73
    const prices: PriceMap = { MEBL: price('MEBL', 548.11, 5), HUBC: price('HUBC', 195.57, 10), SYS: price('SYS', 1200, 0), LUCK: price('LUCK', null, 4) };
    const out = expectedYearlyIncome([holding('MEBL', 8), holding('HUBC', 26), holding('SYS', 5), holding('LUCK', 3), holding('EFERT', 10)], prices);
    expect(out).toEqual({ gross: 727.73, with_data: 2, without_data: ['SYS', 'LUCK', 'EFERT'] }); // 0 yield, no price, not in the map
    expect(expectedYearlyIncome([], prices)).toEqual({ gross: 0, with_data: 0, without_data: [] });
  });
});

describe('valueSeries', () => {
  // Mon 2026-01-05 to Fri 2026-01-09
  const INDEX = [day('2026-01-05', 90), day('2026-01-06', 100), day('2026-01-07', 110), day('2026-01-08', 120), day('2026-01-09', 130)];
  // buy 1,000 on 01-06 at 100 = 10 units; a 240 dividend on 01-08 at 120 sells 2 units -> 8
  const FLOWS: Flow[] = [{ date: '2026-01-06', amount: -1000, kind: 'buy' }, { date: '2026-01-08', amount: 240, kind: 'dividend' }];

  it('one point per index day from the first flow; my_value is null without snapshots', () => {
    const s = valueSeries(FLOWS, INDEX, [], '2026-01-09');
    expect(s).toEqual([
      { day: '2026-01-06', index_value: 1000, invested: 1000, my_value: null },
      { day: '2026-01-07', index_value: 1100, invested: 1000, my_value: null },
      { day: '2026-01-08', index_value: 960, invested: 760, my_value: null }, // 8 units x 120; 1,000 - 240 taken out
      { day: '2026-01-09', index_value: 1040, invested: 760, my_value: null },
    ]);
  });

  it('fills my_value from the snapshots that exist and stops at today', () => {
    const snaps = [{ day: '2026-01-07', value: 1050, invested: 1000 }, { day: '2026-01-09', value: 990, invested: 1000 }];
    const s = valueSeries(FLOWS, INDEX, snaps, '2026-01-08');
    expect(s.map((p) => [p.day, p.my_value])).toEqual([['2026-01-06', null], ['2026-01-07', 1050], ['2026-01-08', null]]);
  });

  it('a flow before the index history counts as invested but cannot be priced: index_value stays null until one can', () => {
    const flows: Flow[] = [{ date: '2025-12-20', amount: -500, kind: 'buy' }, ...FLOWS];
    const s = valueSeries(flows, INDEX, [], '2026-01-09');
    expect(s).toHaveLength(5);
    expect(s[0]).toEqual({ day: '2026-01-05', index_value: null, invested: 500, my_value: null });
    expect(s[1]).toEqual({ day: '2026-01-06', index_value: 1000, invested: 1500, my_value: null });
  });

  it('a weekend flow is priced at the last close and shows up on the next index day', () => {
    const index = [day('2026-01-09', 100), day('2026-01-12', 110)]; // Fri, Mon
    const s = valueSeries([{ date: '2026-01-10', amount: -1000, kind: 'buy' }], index, [], '2026-01-12'); // Saturday
    expect(s).toEqual([{ day: '2026-01-12', index_value: 1100, invested: 1000, my_value: null }]);
  });

  it('a sell beyond the units held is skipped on the index side (never below 0) but still counts as money taken out', () => {
    // a 500 sell on 01-06 with nothing bought: the index side has no units to sell; then 1,000 on 01-07 at 110 = 9.0909 units
    const flows: Flow[] = [{ date: '2026-01-06', amount: 500, kind: 'sell' }, { date: '2026-01-07', amount: -1000, kind: 'buy' }];
    expect(valueSeries(flows, INDEX, [], '2026-01-08')).toEqual([
      { day: '2026-01-06', index_value: null, invested: -500, my_value: null },
      { day: '2026-01-07', index_value: 1000, invested: 500, my_value: null },
      { day: '2026-01-08', index_value: 1090.91, invested: 500, my_value: null }, // 9.0909 x 120
    ]);
  });

  it('a day whose close is 0 is no index day: no point for it, and a flow on it cannot be priced', () => {
    const index = [day('2026-10-09', 0), day('2026-10-15', 160000)];
    expect(valueSeries([{ date: '2026-10-09', amount: -1000, kind: 'buy' }], index, [], '2026-10-15')).toEqual([
      { day: '2026-10-15', index_value: null, invested: 1000, my_value: null },
    ]);
  });

  it('ignores the final value flow and flows after today; empty without flows or index days', () => {
    const withValue = [...FLOWS, { date: '2026-01-09', amount: 5000, kind: 'value' as const }, { date: '2026-02-01', amount: -100, kind: 'buy' as const }];
    expect(valueSeries(withValue, INDEX, [], '2026-01-09')).toEqual(valueSeries(FLOWS, INDEX, [], '2026-01-09'));
    expect(valueSeries([], INDEX, [], '2026-01-09')).toEqual([]);
    expect(valueSeries(FLOWS, [], [], '2026-01-09')).toEqual([]);
  });
});

describe('logGaps', () => {
  it('names holdings whose older buys are missing from the log, so returns are not inflated', async () => {
    const { logGaps } = await import('./performance.ts');
    const t = (symbol: string, side: 'buy' | 'sell', shares: number) =>
      ({ symbol, side, shares, price: 100, amount: shares * 100, executed_on: '2026-10-06', source: 'manual' as const });
    const holdings = [{ symbol: 'MEBL', shares: 28 }, { symbol: 'SYS', shares: 118 }, { symbol: 'UBL', shares: 16 }];
    const txns = [t('MEBL', 'buy', 8), t('SYS', 'buy', 118), t('UBL', 'buy', 20), t('UBL', 'sell', 4)];
    expect(logGaps(txns, holdings)).toEqual([{ symbol: 'MEBL', held: 28, logged: 8 }]);
    expect(logGaps([], holdings).map((g) => g.symbol)).toEqual(['MEBL', 'SYS', 'UBL']);
  });
});

describe('benchmarkFromSnapshot', () => {
  it('uses the first nightly value as the opening position when the buy history is incomplete', async () => {
    const { benchmarkFromSnapshot } = await import('./performance.ts');
    const index = [{ day: '2026-10-15', close: 100 }, { day: '2026-10-20', close: 110 }];
    expect(benchmarkFromSnapshot([], [], [], 1000, index, '2026-10-20', DEFAULT_SETTINGS)).toBeNull();
    const r = benchmarkFromSnapshot([{ day: '2026-10-15', value: 1000, invested: 900 }], [], [], 1050, index, '2026-10-20', DEFAULT_SETTINGS)!;
    expect(r.start.day).toBe('2026-10-15');
    expect(r.bm.index_value).toBe(1100); // 10 units of the index at 100, worth 110 each
    expect(r.bm.my_return_pct).toBe(5);
    expect(r.bm.index_return_pct).toBe(10);
  });
});
