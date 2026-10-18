import { describe, expect, it } from 'vitest';
import { evaluateTrend, marketBreadth, rateChanges, rateCycles, rateOn, rateState, regimePeriods, type PolicyRate, type RegimeDay } from './regime.ts';
import { addDays } from './time.ts';
import type { ScreenRow } from './discover.ts';
import sbp from './sbp-policy-rates.json' with { type: 'json' };

const RATES = sbp as PolicyRate[];
const pr = (decided_on: string, policy_rate: number): PolicyRate => ({ decided_on, policy_rate, ceiling: null, floor: null, source: 'test' });

describe('policy rate', () => {
  it('reads the State Bank history snapshot: 11.5% after the April 2026 hike', () => {
    const s = rateState(RATES, '2026-10-18')!;
    expect(s.rate).toBe(11.5);
    expect(s.decided_on).toBe('2026-04-28');
    expect(s.last_change_pct).toBe(1);
    expect(s.direction).toBe('tightening');
    expect(s.cycle).toBe('tightening'); // 5 months: not yet "on hold"
    expect(rateState(RATES, '2027-02-01')!.cycle).toBe('on_hold'); // 9 months on
  });

  it('groups moves into easing and tightening cycles that run until the first move the other way', () => {
    const cycles = rateCycles([pr('2023-01-01', 17), pr('2023-03-01', 20), pr('2023-06-27', 22), pr('2024-06-11', 20.5), pr('2024-12-17', 13), pr('2026-04-28', 11.5)], '2026-10-18');
    expect(cycles.map((c) => [c.cycle, c.from, c.to, c.start_rate, c.end_rate, c.changes])).toEqual([
      ['tightening', '2023-03-01', '2024-06-11', 17, 22, 2],
      ['easing', '2024-06-11', null, 22, 11.5, 3],
    ]);
  });

  it('a hike after cuts starts a tightening cycle; unchanged meetings are not changes', () => {
    const rates = [pr('2025-05-06', 11), pr('2025-12-16', 10.5), pr('2026-04-28', 11.5), pr('2026-09-14', 11.5)];
    expect(rateChanges(rates)).toHaveLength(3);
    const c = rateCycles(rates, '2026-10-18');
    expect(c.at(-1)).toMatchObject({ cycle: 'tightening', from: '2026-04-28', to: null, days: 173 });
    expect(rateOn(rates, '2026-01-01')).toBe(10.5);
    expect(rateOn(rates, '2025-01-01')).toBeNull();
  });
});

const row = (symbol: string, market_cap: number, change_1y_pct: number | null, pe: number | null, dy: number | null, listed = ['KSE100']): ScreenRow =>
  ({ symbol, listed_in: listed, sector: null, price: 100, change_pct: 0, change_1y_pct, pe, dividend_yield_pct: dy, market_cap, is_shariah: null });

describe('market breadth from PSX screener rows', () => {
  it('weights the 1-year change, earnings yield and dividend yield by market cap, index stocks only', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`S${i}`, 100, 50, 10, 5));
    rows.push(row('BIG', 1000, 0, 5, 10), row('OUT', 99999, 900, 1, 50, ['KMIALLSHR']));
    const b = marketBreadth(rows);
    expect(b.members).toBe(11);
    // now 2000; a year ago 10 * 100 / 1.5 + 1000 = 1666.7, so +20%
    expect(b.change_1y_pct).toBe(20);
    expect(b.earnings_yield_pct).toBe(15); // (100 + 200) / 2000
    expect(b.dividend_yield_pct).toBe(7.5);
  });

  it('is unknown when fewer than half the index has the figure', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`S${i}`, 100, i < 5 ? 10 : null, null, null));
    expect(marketBreadth(rows)).toMatchObject({ change_1y_pct: null, earnings_yield_pct: null });
  });
});

const series = (start: string, values: number[]) => values.map((close, i) => ({ day: addDays(start, i), close }));

describe('bull market ON/OFF', () => {
  it('turns ON on a 20% year with too little history for an average, and says so', () => {
    const t = evaluateTrend({ today: '2026-10-18', closes: series('2026-10-01', [160000, 162000]), close: 166000, change_1y_pct: 41 }, null);
    expect(t.on).toBe(true);
    expect(t.ma).toBeNull();
    expect(t.reasons.join(' ')).toMatch(/\+41\.0% on a year/);
    expect(t.reasons.join(' ')).toMatch(/needs 120 days/);
  });

  it('keeps its state in between (no flicker), turns OFF after a 20% fall from the high', () => {
    const closes = series('2026-01-01', Array.from({ length: 200 }, (_, i) => 100 + i)); // up to 299
    const mid = evaluateTrend({ today: '2026-07-20', closes, close: 290, change_1y_pct: 5 }, true);
    expect(mid.on).toBe(true); // a 5% year is neither an ON nor an OFF signal
    expect(mid.flipped).toBe(false);
    const fall = evaluateTrend({ today: '2026-07-20', closes, close: 230, change_1y_pct: 5 }, true);
    expect(fall.on).toBe(false);
    expect(fall.flipped).toBe(true);
    expect(fall.drawdown_pct).toBeLessThanOrEqual(-20);
  });

  it('OFF below the average with a negative year; ON again only above the average', () => {
    const closes = series('2026-01-01', Array.from({ length: 150 }, () => 100));
    expect(evaluateTrend({ today: '2026-06-01', closes, close: 95, change_1y_pct: -3 }, true).on).toBe(false);
    expect(evaluateTrend({ today: '2026-06-01', closes, close: 97, change_1y_pct: 25 }, false).on).toBe(false); // 3% under the average, more than the band
    expect(evaluateTrend({ today: '2026-06-01', closes, close: 101, change_1y_pct: 25 }, false).on).toBe(true);
  });

  it('with no close, or no clear signal and no earlier state, it is unknown', () => {
    expect(evaluateTrend({ today: '2026-10-18', closes: [], close: 160000, change_1y_pct: 5 }, null).on).toBeNull();
    expect(evaluateTrend({ today: '2026-10-18', closes: [], close: null, change_1y_pct: null }, null).on).toBeNull();
  });

  it('lists ON and OFF stretches with their length', () => {
    const d = (day: string, bull: boolean): RegimeDay => ({ day, bull, close: null, ma: null, change_1y_pct: null, drawdown_pct: null, earnings_yield_pct: null, policy_rate: null, reasons: [] });
    expect(regimePeriods([d('2026-10-01', true), d('2026-10-02', true), d('2026-10-05', false), d('2026-10-08', true)], '2026-10-18')).toEqual([
      { bull: true, from: '2026-10-01', to: '2026-10-05', days: 4 },
      { bull: false, from: '2026-10-05', to: '2026-10-08', days: 3 },
      { bull: true, from: '2026-10-08', to: null, days: 10 },
    ]);
  });
});
