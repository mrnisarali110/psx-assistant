import { describe, expect, it } from 'vitest';
import { moneyIn, rangeChange, seriesFor } from './PortfolioChart.tsx';
import { DEFAULT_SETTINGS, type Txn } from '../../shared/types.ts';

const now = new Date('2026-10-23T10:00:00Z'); // Fri 15:00 PKT

describe('seriesFor', () => {
  it('returns nothing for an empty account (every range)', () => {
    for (const r of ['1D', '1W', '1M', 'YTD', 'All'] as const) expect(seriesFor(r, [], [], now)).toEqual([]);
  });

  it('one current value alone is a single point, not a line', () => {
    expect(seriesFor('1M', [], [], now, { day: '2026-10-23', value: 56279 })).toEqual([{ t: '2026-10-23', v: 56279 }]);
  });

  it('1D keeps only the latest PKT day of ticks, in time order', () => {
    const ticks = [
      { ts: '2026-10-23T05:15:00Z', value: 101 },
      { ts: '2026-10-22T10:00:00Z', value: 90 },
      { ts: '2026-10-23T04:45:00Z', value: 100 },
      { ts: '2026-10-22T20:00:00Z', value: 95 }, // 01:00 PKT on the 23rd
    ];
    expect(seriesFor('1D', ticks, [], now).map((p) => p.v)).toEqual([95, 100, 101]);
  });

  it('1D ignores ticks from the future and broken values', () => {
    const ticks = [{ ts: '2026-10-23T04:45:00Z', value: 100 }, { ts: '2026-10-23T11:00:00Z', value: 200 }, { ts: '2026-10-23T05:00:00Z', value: Number.NaN }];
    expect(seriesFor('1D', ticks, [], now).map((p) => p.v)).toEqual([100]);
  });

  it('daily ranges add today and cut to the range from the latest point', () => {
    const daily = Array.from({ length: 40 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, value: 100 + i, invested: 100 }))
      .filter((d) => d.day <= '2026-09-30');
    daily.push({ day: '2026-10-22', value: 140, invested: 100 });
    const pts = seriesFor('1W', [], daily, now, { day: '2026-10-23', value: 150 });
    expect(pts.map((p) => p.t)).toEqual(['2026-10-22', '2026-10-23']);
    expect(seriesFor('All', [], daily, now, { day: '2026-10-23', value: 150 }).length).toBe(32);
  });

  it("today's value replaces the stored row of the same day", () => {
    const daily = [{ day: '2026-10-22', value: 100, invested: 90 }, { day: '2026-10-23', value: 105, invested: 90 }];
    expect(seriesFor('1M', [], daily, now, { day: '2026-10-23', value: 110 }).map((p) => p.v)).toEqual([100, 110]);
  });

  it('drops zero-value days (before the first import) instead of drawing from zero', () => {
    const daily = [{ day: '2026-10-20', value: 0, invested: 0 }, { day: '2026-10-21', value: 100, invested: 100 }, { day: '2026-10-22', value: 102, invested: 100 }];
    expect(seriesFor('1M', [], daily, now).map((p) => p.v)).toEqual([100, 102]);
  });
});

describe('rangeChange', () => {
  it('is null with fewer than two points', () => {
    expect(rangeChange([])).toBeNull();
    expect(rangeChange([{ t: '2026-10-23', v: 1 }])).toBeNull();
  });
  it('gives rupees and percent when no money moved', () => {
    const c = rangeChange([{ t: '2026-10-21', v: 100 }, { t: '2026-10-22', v: 110 }]);
    expect(c).toEqual({ gain: 10, pct: 10, added: 0 });
  });
  it('does not count money added as a gain, and gives no percent then', () => {
    const c = rangeChange([{ t: '2026-10-21', v: 100 }, { t: '2026-10-22', v: 160 }], [{ date: '2026-10-22', amount: 50 }]);
    expect(c).toEqual({ gain: 10, pct: null, added: 50 });
  });
  it('a sale at a profit with no price move is no gain and no loss: the proceeds are money taken out', () => {
    // Held Rs 1,000,000 (cost Rs 500,000); sold half for Rs 500,000 on the 22nd, prices flat.
    const c = rangeChange([{ t: '2026-10-21', v: 1_000_000 }, { t: '2026-10-22', v: 500_000 }], [{ date: '2026-10-22', amount: -500_000 }]);
    expect(c).toEqual({ gain: 0, pct: null, added: -500_000 });
  });
  it("money moved on the first point's day is already in that close, and later money is not yet", () => {
    const pts = [{ t: '2026-10-21', v: 100 }, { t: '2026-10-22', v: 110 }];
    expect(rangeChange(pts, [{ date: '2026-10-21', amount: 40 }, { date: '2026-10-23', amount: 70 }])).toEqual({ gain: 10, pct: 10, added: 0 });
  });
});

describe('moneyIn', () => {
  const t = (side: Txn['side'], amount: number, charges: number, executed_on = '2026-10-22'): Txn =>
    ({ symbol: 'OGDC', side, shares: 100, price: amount / 100, amount, executed_on, source: 'manual', charges });
  it('a buy puts in its amount plus charges, a sale takes out its proceeds net of charges', () => {
    expect(moneyIn([t('buy', 10_000, 50), t('sell', 20_000, 80, '2026-10-23')], DEFAULT_SETTINGS))
      .toEqual([{ date: '2026-10-22', amount: 10_050 }, { date: '2026-10-23', amount: -19_920 }]);
  });
});

describe('1D against the previous close', () => {
  const prev = [{ day: '2026-10-21', value: 900, invested: 800 }, { day: '2026-10-22', value: 1000, invested: 800 }];
  const ticks = [{ ts: '2026-10-23T04:45:00Z', value: 1010 }, { ts: '2026-10-23T05:15:00Z', value: 1040 }];

  it("starts from the last close before the session and ends at today's value, so the headline is the day change", () => {
    const pts = seriesFor('1D', ticks, prev, now, { day: '2026-10-23', ts: '2026-10-23T09:55:00Z', value: 1050, prev_close: 1000 });
    expect(pts.map((p) => p.v)).toEqual([1000, 1010, 1040, 1050]);
    expect(pts[0].close).toBe(true);
    expect(rangeChange(pts)?.gain).toBe(50); // = the header's day change (1050 − 1000)
  });

  it("a buy during the day is money put in, not a gain", () => {
    const after = [ticks[0], { ts: '2026-10-23T05:15:00Z', value: 1520 }]; // bought Rs 500 of shares at 10:00 PKT
    const pts = seriesFor('1D', after, prev, now);
    expect(pts.map((p) => p.v)).toEqual([1000, 1010, 1520]);
    expect(rangeChange(pts, [{ date: '2026-10-23', amount: 500 }])).toEqual({ gain: 20, pct: null, added: 500 });
  });

  it("with no close stored before today, starts from today's holdings at the previous close and never subtracts today's buys", () => {
    // First day: the holdings were imported today (recorded as buys), so no close exists before the session.
    const pts = seriesFor('1D', ticks, [], now, { day: '2026-10-23', ts: '2026-10-23T09:55:00Z', value: 1050, prev_close: 1000 });
    expect(pts.map((p) => p.v)).toEqual([1000, 1010, 1040, 1050]);
    expect(rangeChange(pts, [{ date: '2026-10-23', amount: 1000 }])?.gain).toBe(50);
  });

  it("a value older than the last market check is not added after it", () => {
    const pts = seriesFor('1D', ticks, prev, now, { day: '2026-10-23', ts: '2026-10-23T05:00:00Z', value: 999, prev_close: 1000 });
    expect(pts.map((p) => p.v)).toEqual([1000, 1010, 1040]);
  });

  it("no market checks yet: the previous close and today's value still make a line", () => {
    const pts = seriesFor('1D', [], prev, now, { day: '2026-10-23', ts: '2026-10-23T09:55:00Z', value: 1050, prev_close: 1000 });
    expect(pts.map((p) => p.v)).toEqual([1000, 1050]);
  });
});
