import { describe, expect, it } from 'vitest';
import {
  aiTextMatches, dividendCut, impliedEps, isSpecial, missingNum, payoutFrequency, payoutRatio, peOutlier, qualityChips, regularDividend, todayState,
} from './quality.ts';
import { DEFAULT_RULES, type DividendEvent, type Rules } from './types.ts';

const TODAY = '2026-10-15';
const ev = (id: string, symbol: string, announced_on: string, dps: number | null, dividend_type: DividendEvent['dividend_type'] = 'interim'): DividendEvent =>
  ({ id, symbol, announced_on, dps, dividend_type, book_closure_from: null, book_closure_to: null, verified: true, pdf_url: null });

// ABC in the 365 days ending 2026-10-15 (the window starts after 2025-10-15): a, b, c, d. e is older.
const ABC: DividendEvent[] = [
  ev('a', 'ABC', '2026-08-10', 4, 'interim'),
  ev('b', 'ABC', '2026-04-20', 4, 'interim'),
  ev('c', 'ABC', '2026-06-15', 12, 'special'),
  ev('d', 'ABC', '2025-12-10', 5, 'final'),
  ev('e', 'ABC', '2025-09-01', 4, 'interim'),
];

describe('missing figures', () => {
  it('treats null, NaN, 0, negatives and infinity as missing; any positive number is usable', () => {
    for (const v of [null, undefined, NaN, 0, -1, Infinity]) expect(missingNum(v)).toBe(true);
    for (const v of [0.01, 1.46, 150]) expect(missingNum(v)).toBe(false);
  });
});

describe('P/E outliers', () => {
  it('flags AHCL P/E 1.46 as too low to trust, with the reason for a check-figures badge', () => {
    const r = peOutlier(1.46);
    expect(r.outlier).toBe(true);
    expect(r.reason).toMatch(/P\/E 1\.46 is below 2/);
    expect(r.reason).toMatch(/check the figures/);
  });
  it('flags a P/E above 100 and a missing P/E; BAFL P/E 0 is a gap, not a figure', () => {
    expect(peOutlier(150).reason).toMatch(/P\/E 150 is above 100/);
    expect(peOutlier(0)).toEqual({ outlier: true, reason: 'PSX shows P/E 0: no figure, or the company made a loss' });
    expect(missingNum(0)).toBe(true);
    expect(peOutlier(null)).toEqual({ outlier: true, reason: 'No P/E from PSX' });
    expect(peOutlier(undefined).outlier).toBe(true);
    expect(peOutlier(NaN).outlier).toBe(true);
    expect(peOutlier(-3.2).reason).toMatch(/P\/E -3\.2: the company is loss-making/);
  });
  it('accepts a normal P/E, including the bounds themselves, and takes the bounds from rules', () => {
    expect(peOutlier(8.3)).toEqual({ outlier: false, reason: null });
    expect(peOutlier(2).outlier).toBe(false);
    expect(peOutlier(100).outlier).toBe(false);
    const rules: Rules = { ...DEFAULT_RULES, undervalued: { ...DEFAULT_RULES.undervalued, pe_outlier_min: 5 } };
    expect(peOutlier(4, rules).reason).toMatch(/below 5/);
  });
});

describe('implied EPS and payout ratio', () => {
  it('divides price by P/E: MEBL 548.11 / 6.6 = 83.05; 100 / 8 = 12.5', () => {
    expect(impliedEps(548.11, 6.6)).toBe(83.05);
    expect(impliedEps(100, 8)).toBe(12.5);
  });
  it('gives null when either figure is missing or the P/E is not positive', () => {
    expect(impliedEps(100, 0)).toBeNull();
    expect(impliedEps(100, -2)).toBeNull();
    expect(impliedEps(null, 8)).toBeNull();
    expect(impliedEps(0, 8)).toBeNull();
    expect(impliedEps(100, null)).toBeNull();
  });
  it('payout 12 / 10 = 120% is unsustainable; 6 / 10 = 60% is fine; exactly 100% is not flagged', () => {
    expect(payoutRatio(12, 10)).toEqual({ pct: 120, unsustainable: true });
    expect(payoutRatio(6, 10)).toEqual({ pct: 60, unsustainable: false });
    expect(payoutRatio(10, 10)).toEqual({ pct: 100, unsustainable: false });
    expect(payoutRatio(1, 3)).toEqual({ pct: 33.3, unsustainable: false }); // 33.333.. to 1 dp
  });
  it('payout is null without a dps or without earnings; a dps of 0 is a real 0%', () => {
    expect(payoutRatio(null, 10)).toEqual({ pct: null, unsustainable: false });
    expect(payoutRatio(6, 0)).toEqual({ pct: null, unsustainable: false });
    expect(payoutRatio(6, null)).toEqual({ pct: null, unsustainable: false });
    expect(payoutRatio(0, 10)).toEqual({ pct: 0, unsustainable: false });
  });
});

describe('special dividends', () => {
  it('a filing typed special is special', () => {
    expect(isSpecial(ABC[2], ABC)).toBe(true);
  });
  it('an untyped 12 against other dps 4, 4, 5, 4 (median 4, bar 2 x 4 = 8) is special; the usual 4 is not', () => {
    const big = ev('f', 'ABC', '2026-07-01', 12, 'interim');
    expect(isSpecial(big, [...ABC, big])).toBe(true);
    expect(isSpecial(ABC[0], ABC)).toBe(false); // 4 > 8? no
    const rules: Rules = { ...DEFAULT_RULES, dividends: { ...DEFAULT_RULES.dividends, special_multiple_of_median: 3.5 } };
    expect(isSpecial(big, [...ABC, big], rules)).toBe(false); // bar 3.5 x 4 = 14
  });
  it('needs at least 2 other filings, ignores typed specials in the median, and never flags a missing dps', () => {
    const x = ev('x', 'ONE', '2026-05-01', 20);
    expect(isSpecial(x, [x, ev('y', 'ONE', '2025-11-01', 2)])).toBe(false);
    // Others 4 and 4 plus a typed special 30: median stays 4, so 9 > 8 is special
    const nine = ev('n', 'TWO', '2026-09-01', 9);
    const two = [nine, ev('p', 'TWO', '2026-03-01', 4), ev('q', 'TWO', '2025-11-20', 4), ev('s', 'TWO', '2026-01-10', 30, 'special')];
    expect(isSpecial(nine, two)).toBe(true);
    expect(isSpecial(ev('z', 'ABC', '2026-09-30', null), ABC)).toBe(false);
  });
  it('a notice posted twice is not one of the "others": 8 against 2 and 5 (median 3.5, bar 7) is special even with its copy in the list', () => {
    // With the copy counted the others would be 2, 5, 8 (median 5, bar 10) and the 8 would pass as regular
    const dup = [ev('a', 'DUP', '2025-12-01', 2), ev('b', 'DUP', '2026-03-01', 5), ev('e1', 'DUP', '2026-07-01', 8), ev('e2', 'DUP', '2026-07-01', 8)];
    expect(isSpecial(dup[2], dup)).toBe(true);
    expect(isSpecial(dup[3], dup)).toBe(true);
  });
});

describe('regular dividend and yield from filings', () => {
  it('sums the last 12 months without the special: 4 + 4 + 5 = 13 a share, 13.0% at Rs 100, 6.5% at Rs 200', () => {
    const r = regularDividend('ABC', ABC, TODAY, 100)!;
    expect(r.annual_dps).toBe(13);
    expect(r.yield_pct).toBe(13);
    expect(r.specials.map((e) => e.id)).toEqual(['c']);
    expect(r.count).toBe(4);
    expect(regularDividend('ABC', ABC, TODAY, 200)!.yield_pct).toBe(6.5);
  });
  it('gives null yield without a price, and null overall when the company has no filings', () => {
    expect(regularDividend('ABC', ABC, TODAY, null)!.yield_pct).toBeNull();
    expect(regularDividend('ABC', ABC, TODAY, 0)!.yield_pct).toBeNull();
    expect(regularDividend('NONE', ABC, TODAY, 100)).toBeNull();
    expect(regularDividend('ABC', [], TODAY, 100)).toBeNull();
  });
  it('window boundary: a filing exactly 365 days ago is out, one day later is in; future-dated filings are out', () => {
    const edge = [ev('old', 'EDG', '2025-10-15', 3), ev('in', 'EDG', '2025-10-16', 2), ev('fut', 'EDG', '2026-10-16', 9)];
    const r = regularDividend('EDG', edge, TODAY, 100)!;
    expect(r.annual_dps).toBe(2);
    expect(r.count).toBe(1);
  });
  it('a year of only specials is a 0 regular dividend, not null', () => {
    const r = regularDividend('SPC', [ev('s1', 'SPC', '2026-03-01', 10, 'special')], TODAY, 100)!;
    expect(r).toMatchObject({ annual_dps: 0, yield_pct: 0, count: 1 });
    expect(r.specials).toHaveLength(1);
  });
  it('an untyped one-off is left out by the 2 x median rule: 4 + 4 + 5 = 13 a share, the 12 reported as special', () => {
    // Others 4, 4, 5, 4 (median 4, bar 8): the untyped 12 is special; u4 is older than a year so count is 4
    const U = [ev('u1', 'U', '2026-08-10', 4), ev('u2', 'U', '2026-04-20', 4), ev('u3', 'U', '2025-12-10', 5, 'final'), ev('u4', 'U', '2025-09-01', 4), ev('big', 'U', '2026-06-15', 12, null)];
    const r = regularDividend('U', U, TODAY, 100)!;
    expect(r.annual_dps).toBe(13);
    expect(r.yield_pct).toBe(13);
    expect(r.specials.map((e) => e.id)).toEqual(['big']);
    expect(r.count).toBe(4);
  });
  it('a notice PSX posted twice counts once: final 4 (two ids, same day) + interim 4 = 8 a share, 8% at Rs 100, 2 filings', () => {
    const dup = [ev('bm', 'D', '2026-08-10', 4, 'final'), ev('fr', 'D', '2026-08-10', 4, 'final'), ev('x', 'D', '2025-12-10', 4, 'interim')];
    expect(regularDividend('D', dup, TODAY, 100)).toEqual({ annual_dps: 8, yield_pct: 8, specials: [], count: 2 });
    // A same-day filing of a different type is a different dividend: final 4 + interim 4 on one day = 8
    const twoKinds = [ev('f', 'K', '2026-08-10', 4, 'final'), ev('i', 'K', '2026-08-10', 4, 'interim')];
    expect(regularDividend('K', twoKinds, TODAY, 100)!.annual_dps).toBe(8);
  });
  it('of two copies the verified one is kept, else the higher id', () => {
    const v = [{ ...ev('z', 'V', '2026-06-15', 12, 'special'), verified: false }, ev('a', 'V', '2026-06-15', 12, 'special')];
    expect(regularDividend('V', v, TODAY, 100)!.specials.map((e) => e.id)).toEqual(['a']);
    const w = [ev('bm', 'W', '2026-06-15', 12, 'special'), ev('fr', 'W', '2026-06-15', 12, 'special')];
    expect(regularDividend('W', w, TODAY, 100)!.specials.map((e) => e.id)).toEqual(['fr']);
  });
});

describe('payout frequency', () => {
  const quarterly = [ev('q1', 'Q', '2026-09-20', 2), ev('q2', 'Q', '2026-06-20', 2), ev('q3', 'Q', '2026-03-20', 2), ev('q4', 'Q', '2025-12-20', 2), ev('q5', 'Q', '2025-09-20', 2)];
  it('four months with a payout in the last year is Quarterly; ABC (Aug, Apr, Dec) is Half-yearly', () => {
    expect(payoutFrequency('Q', quarterly, TODAY)).toEqual({ label: 'Quarterly', count: 4, enough: true }); // q5 is older than a year
    expect(payoutFrequency('ABC', ABC, TODAY)).toEqual({ label: 'Half-yearly', count: 3, enough: true }); // the special is left out
  });
  it('fewer than 2 filings is not enough: one gives a Yearly guess, none gives null', () => {
    expect(payoutFrequency('ONE', [ev('o', 'ONE', '2026-02-01', 5, 'final')], TODAY)).toEqual({ label: 'Yearly', count: 1, enough: false });
    expect(payoutFrequency('NONE', ABC, TODAY)).toEqual({ label: null, count: 0, enough: false });
    expect(payoutFrequency('ONE', [ev('o', 'ONE', '2025-02-01', 5, 'final')], TODAY).label).toBeNull(); // stopped paying
  });
  it('looks only at the last rules.dividends.frequency_filings filings, and two in one month count as one month', () => {
    const rules: Rules = { ...DEFAULT_RULES, dividends: { ...DEFAULT_RULES.dividends, frequency_filings: 2 } };
    expect(payoutFrequency('Q', quarterly, TODAY, rules)).toEqual({ label: 'Half-yearly', count: 2, enough: true });
    const sameMonth = [ev('m1', 'M', '2026-09-20', 2), ev('m2', 'M', '2026-09-21', 1)];
    expect(payoutFrequency('M', sameMonth, TODAY)).toEqual({ label: 'Yearly', count: 2, enough: true });
  });
  it('a notice posted twice is one filing: final 4 (two ids) + interim 4 is 2 filings in 2 months, Half-yearly', () => {
    const dup = [ev('bm', 'D', '2026-08-10', 4, 'final'), ev('fr', 'D', '2026-08-10', 4, 'final'), ev('x', 'D', '2025-12-10', 4, 'interim')];
    expect(payoutFrequency('D', dup, TODAY)).toEqual({ label: 'Half-yearly', count: 2, enough: true });
  });
  it('a filing dated after today is not one of the last N: with N = 2, Jun and Mar still count (Half-yearly), not the misdated one', () => {
    const rules: Rules = { ...DEFAULT_RULES, dividends: { ...DEFAULT_RULES.dividends, frequency_filings: 2 } };
    const fu = [ev('f1', 'FU', '2026-10-16', 2), ev('f2', 'FU', '2026-06-01', 2), ev('f3', 'FU', '2026-03-01', 2)];
    expect(payoutFrequency('FU', fu, TODAY, rules)).toEqual({ label: 'Half-yearly', count: 2, enough: true }); // not { Yearly, 1 }
  });
});

describe('dividend cut', () => {
  it('interim 4 then 3 is a cut (25% lower); 4 then 3.8 is not (5%); exactly 10% lower is not', () => {
    expect(dividendCut('C', [ev('1', 'C', '2026-04-01', 4), ev('2', 'C', '2026-08-01', 3)])).toEqual({ cut: true, latest: 3, previous: 4 });
    expect(dividendCut('C', [ev('1', 'C', '2026-04-01', 4), ev('2', 'C', '2026-08-01', 3.8)])).toEqual({ cut: false, latest: 3.8, previous: 4 });
    expect(dividendCut('C', [ev('1', 'C', '2026-04-01', 4), ev('2', 'C', '2026-08-01', 3.6)]).cut).toBe(false);
  });
  it('compares like with like: an interim is measured against the previous interim, not a final in between', () => {
    const mixed = [ev('1', 'C', '2026-01-10', 4, 'interim'), ev('2', 'C', '2026-03-15', 10, 'final'), ev('3', 'C', '2026-08-20', 3.8, 'interim')];
    expect(dividendCut('C', mixed)).toEqual({ cut: false, latest: 3.8, previous: 4 });
    const finals = [ev('1', 'C', '2025-03-15', 10, 'final'), ev('2', 'C', '2026-03-15', 8, 'final')];
    expect(dividendCut('C', finals)).toEqual({ cut: true, latest: 8, previous: 10 }); // 20% lower
  });
  it('the cut percentage is a parameter: at 25%, 4 to 3 is not a cut; at 20% it is', () => {
    const e = [ev('1', 'C', '2026-04-01', 4), ev('2', 'C', '2026-08-01', 3)];
    expect(dividendCut('C', e, 25).cut).toBe(false);
    expect(dividendCut('C', e, 20).cut).toBe(true);
  });
  it('no previous of the same type, a special, or an untyped latest gives no cut', () => {
    expect(dividendCut('C', [ev('1', 'C', '2026-04-01', 4)])).toEqual({ cut: false, latest: 4, previous: null });
    expect(dividendCut('C', [ev('1', 'C', '2026-04-01', 4), ev('2', 'C', '2026-08-01', 20, 'special')])).toEqual({ cut: false, latest: 4, previous: null });
    expect(dividendCut('C', [ev('1', 'C', '2026-04-01', 4), ev('2', 'C', '2026-08-01', 3, null)])).toEqual({ cut: false, latest: 3, previous: null });
    expect(dividendCut('C', [])).toEqual({ cut: false, latest: null, previous: null });
    expect(dividendCut('C', ABC)).toEqual({ cut: false, latest: null, previous: null }); // other company
  });
  it('a notice posted twice is not its own "previous": final 5 then final 4 (two ids) is a 20% cut; with no earlier final there is no previous', () => {
    const cut = [ev('p', 'D', '2025-08-10', 5, 'final'), ev('bm', 'D', '2026-08-10', 4, 'final'), ev('fr', 'D', '2026-08-10', 4, 'final')];
    expect(dividendCut('D', cut)).toEqual({ cut: true, latest: 4, previous: 5 });
    const dup = [ev('bm', 'D', '2026-08-10', 4, 'final'), ev('fr', 'D', '2026-08-10', 4, 'final'), ev('x', 'D', '2025-12-10', 4, 'interim')];
    expect(dividendCut('D', dup)).toEqual({ cut: false, latest: 4, previous: null });
  });
});

describe('quality chips', () => {
  const keys = (c: { key: string }[]) => c.map((x) => x.key);
  it('AHCL: P/E 1.46 gets a check-figures chip and the 1y fall a red trend chip; payout 4 / 34.25 = 11.7% is fine', () => {
    const chips = qualityChips({ pe: 1.46, price: 50, dividend_yield_pct: 8, change_1y_pct: -20 }, [], TODAY);
    expect(keys(chips)).toEqual(['trend', 'outlier']);
    expect(chips[0]).toEqual({ key: 'trend', label: '1y -20%', tone: 'red' });
    expect(chips[1]).toEqual({ key: 'outlier', label: 'P/E 1.46: check figures', tone: 'amber' });
  });
  it('P/E 0 with a price is "loss or no P/E"; a negative P/E is loss-making; no payout or outlier chip from a missing P/E', () => {
    expect(qualityChips({ pe: 0, price: 100, dividend_yield_pct: 5 }, [], TODAY)).toEqual([{ key: 'loss', label: 'Loss or no P/E', tone: 'red' }]);
    expect(qualityChips({ pe: null, price: 100, dividend_yield_pct: 5 }, [], TODAY)).toEqual([{ key: 'loss', label: 'Loss or no P/E', tone: 'red' }]);
    expect(qualityChips({ pe: -3, price: 100, dividend_yield_pct: 0 }, [], TODAY)).toEqual([
      { key: 'loss', label: 'Loss-making', tone: 'red' }, { key: 'missing', label: 'No yield', tone: 'slate' },
    ]);
  });
  it('a negative P/E without a price is loss-making and only the price and yield are missing; a 0 P/E without a price is a gap', () => {
    expect(qualityChips({ pe: -3, price: null, dividend_yield_pct: null }, [], TODAY)).toEqual([
      { key: 'loss', label: 'Loss-making', tone: 'red' }, { key: 'missing', label: 'No price, yield', tone: 'slate' },
    ]);
    expect(qualityChips({ pe: 0, price: null, dividend_yield_pct: null }, [], TODAY)).toEqual([{ key: 'missing', label: 'No price, P/E, yield', tone: 'slate' }]);
  });
  it('payout from PSX figures when there are no filings: yield 12% x P/E 10 = 120% of profit', () => {
    const chips = qualityChips({ pe: 10, price: 100, dividend_yield_pct: 12 }, [], TODAY);
    expect(chips).toEqual([{ key: 'payout', label: 'Pays out 120% of profit', tone: 'amber' }]);
    expect(qualityChips({ pe: 10, price: 100, dividend_yield_pct: 9 }, [], TODAY)).toEqual([]); // 90%
  });
  it('filings beat PSX\'s yield for the payout, and a one-off in the last year gets a special chip', () => {
    // Regular 3 + 3 = 6 a share against earnings 100 / 10 = 10: 60%, so no payout chip even though PSX says 12% yield
    const filings = [ev('i1', 'F', '2026-08-01', 3), ev('i2', 'F', '2026-02-01', 3), ev('i3', 'F', '2025-08-01', 3)];
    expect(qualityChips({ symbol: 'F', pe: 10, price: 100, dividend_yield_pct: 12 }, filings, TODAY)).toEqual([]);
    const withSpecial = [...filings, ev('sp', 'F', '2026-05-01', 15, 'special')];
    expect(qualityChips({ symbol: 'F', pe: 10, price: 100, dividend_yield_pct: 21 }, withSpecial, TODAY)).toEqual([{ key: 'special', label: 'Special dividend', tone: 'amber' }]);
    // The symbol on the row keeps other companies' filings out
    expect(keys(qualityChips({ symbol: 'ABC', pe: 10, price: 100, dividend_yield_pct: 21 }, withSpecial, TODAY))).toEqual(['payout']); // 21 x 10 = 210%
  });
  it('without a symbol on the row, filings are used only when they all belong to one company; a mixed list is ignored, not guessed from', () => {
    const filings = [ev('i1', 'F', '2026-08-01', 3), ev('i2', 'F', '2026-02-01', 3), ev('sp', 'F', '2026-05-01', 15, 'special')];
    // One company: these are this row's filings, as the spec's row shape intends (regular 6 / eps 10 = 60%, plus the one-off)
    expect(qualityChips({ pe: 10, price: 100, dividend_yield_pct: 21 }, filings, TODAY)).toEqual([{ key: 'special', label: 'Special dividend', tone: 'amber' }]);
    // F and ABC together with no symbol: PSX's own figures decide (21 x 100 / 100 / 10 = 210%), no special chip from a company we cannot name
    expect(qualityChips({ pe: 10, price: 100, dividend_yield_pct: 21 }, [...filings, ...ABC], TODAY)).toEqual([{ key: 'payout', label: 'Pays out 210% of profit', tone: 'amber' }]);
  });
  it('an untyped one-off found by the 2 x median rule gets the special chip: regular 13 against earnings 100 / 5 = 20 is 65%, no payout chip', () => {
    const U = [ev('u1', 'U', '2026-08-10', 4), ev('u2', 'U', '2026-04-20', 4), ev('u3', 'U', '2025-12-10', 5, 'final'), ev('u4', 'U', '2025-09-01', 4), ev('big', 'U', '2026-06-15', 12, null)];
    expect(qualityChips({ symbol: 'U', pe: 5, price: 100, dividend_yield_pct: 25 }, U, TODAY)).toEqual([{ key: 'special', label: 'Special dividend', tone: 'amber' }]);
  });
  it('a notice posted twice does not inflate the payout: final 4 (two ids) + interim 4 = 8 against earnings 100 / 10 = 10 is 80%', () => {
    const dup = [ev('bm', 'D', '2026-08-10', 4, 'final'), ev('fr', 'D', '2026-08-10', 4, 'final'), ev('x', 'D', '2025-12-10', 4, 'interim')];
    expect(qualityChips({ symbol: 'D', pe: 10, price: 100, dividend_yield_pct: 12 }, dup, TODAY)).toEqual([]); // counted twice it would read 120%
  });
  it('lists the missing fields when PSX gave nothing, and shows nothing for a clean row but its trend', () => {
    expect(qualityChips({ pe: null, price: null, dividend_yield_pct: null }, [], TODAY)).toEqual([{ key: 'missing', label: 'No price, P/E, yield', tone: 'slate' }]);
    expect(qualityChips({ pe: 8, price: 100, dividend_yield_pct: 5, change_1y_pct: 10.4 }, [], TODAY)).toEqual([{ key: 'trend', label: '1y +10%', tone: 'green' }]);
    expect(qualityChips({ pe: 8, price: 100, dividend_yield_pct: 5, change_1y_pct: 0 }, [], TODAY)[0]).toMatchObject({ label: '1y 0%', tone: 'slate' });
    expect(qualityChips({ pe: 8, price: 100, dividend_yield_pct: 5 }, [], TODAY)).toEqual([]);
  });
});

describe('AI text grounded in the numbers shown', () => {
  it('passes "P/E 6.6 vs 14.5" against the chips, fails a sentence quoting other figures', () => {
    expect(aiTextMatches('P/E 6.6 vs 14.5', { pe: 6.6, sector_pe: 14.5 })).toBe(true);
    expect(aiTextMatches('sector 16.7 (60.8% discount)', { pe: 6.6, sector_pe: 14.5, discount: 54.5 })).toBe(false);
  });
  it('allows rounding, dates and counts, ignores unknown values, and passes a sentence with no numbers', () => {
    expect(aiTextMatches('P/E 6.63, 3 banks in 2026', { pe: 6.6 })).toBe(true);
    expect(aiTextMatches('Rs 1,234 a year', { income: 1234, pe: null, yield: undefined })).toBe(true);
    expect(aiTextMatches('cheap against its sector', {})).toBe(true);
    expect(aiTextMatches('yield 8.1%', { yield: 6.2 })).toBe(false);
  });
  it('a small whole number that is plainly a figure (a %, a P/E, rupees) must match too, not pass as a count', () => {
    expect(aiTextMatches('P/E 5 vs sector 12', { pe: 6.6, sector_pe: 14.5 })).toBe(false);
    expect(aiTextMatches('yield 9%', { dividend_yield_pct: 4.1 })).toBe(false);
    expect(aiTextMatches('down 25% in a year', { change_1y_pct: -3.2 })).toBe(false);
    expect(aiTextMatches('Rs 2 a share', { dps: 4 })).toBe(false);
    expect(aiTextMatches('PE ratio: 3', { pe: 6.6 })).toBe(false);
  });
  it('rounded figures still pass: P/E 7 for 6.6, 15% for 14.5, -20% for a 1y change of -20, Rs 2 for a dps of 2', () => {
    expect(aiTextMatches('P/E 7, yield 15%', { pe: 6.6, yield: 14.5 })).toBe(true);
    expect(aiTextMatches('1y -20%, pays Rs 2 a share', { change_1y: -20, dps: 2 })).toBe(true);
    expect(aiTextMatches('P/E of 6.63 and 3 banks in 2026', { pe: 6.6 })).toBe(true);
  });
});

describe('today state', () => {
  it('any broken rule means review, whatever the stance or cash', () => {
    expect(todayState({ stance: 'Buy', cash_left: 50000, attention: 2, addable: ['SYS'] })).toEqual({ state: 'review', headline: 'Review first: 2 of your rules are broken' });
    expect(todayState({ stance: 'Hold', cash_left: 0, attention: 1, addable: [] }).headline).toBe('Review first: one of your rules is broken');
  });
  it('Buy with cash and somewhere to put it means add, naming the money and up to three names', () => {
    expect(todayState({ stance: 'Buy', cash_left: 40500, attention: 0, addable: ['SYS', 'MEBL'] })).toEqual({ state: 'add', headline: 'Add money: Rs 40,500 left for SYS or MEBL' });
    expect(todayState({ stance: 'Buy', cash_left: 40500, attention: 0, addable: ['SYS'] }).headline).toBe('Add money: Rs 40,500 left for SYS');
    expect(todayState({ stance: 'Buy', cash_left: 40500, attention: 0, addable: ['SYS', 'MEBL', 'UBL', 'DCR', 'LUCK'] }).headline).toBe('Add money: Rs 40,500 left for SYS, MEBL, UBL or 2 more');
  });
  it('otherwise hold, with a reason', () => {
    expect(todayState({ stance: 'Buy', cash_left: 0, attention: 0, addable: ['SYS'] })).toEqual({ state: 'hold', headline: "Hold: this month's money is all invested" });
    expect(todayState({ stance: 'Buy', cash_left: 9000, attention: 0, addable: [] })).toEqual({ state: 'hold', headline: 'Hold: nothing qualifies for more money today' });
    expect(todayState({ stance: 'Wait', cash_left: 9000, attention: 0, addable: ['SYS'] })).toEqual({ state: 'hold', headline: 'Hold: the market says wait today' });
    expect(todayState({ stance: 'Hold', cash_left: 9000, attention: 0, addable: ['SYS'] })).toEqual({ state: 'hold', headline: 'Hold: nothing to do today' });
  });
  it('never says hold with a headline that suggests buying', () => {
    for (const stance of ['Buy', 'Hold', 'Wait'] as const) {
      for (const cash_left of [0, 1000]) {
        for (const addable of [[], ['SYS']]) {
          const r = todayState({ stance, cash_left, attention: 0, addable });
          if (r.state === 'hold') expect(r.headline).not.toMatch(/buy|add|top up|put money|more money in/i);
          else expect(r.state).toBe('add');
        }
      }
    }
  });
});
