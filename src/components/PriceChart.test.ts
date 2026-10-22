import { describe, expect, it } from 'vitest';
import { cutRange, priceSeries, rangesFor } from './PriceChart.tsx';
import type { PriceDay } from '../../shared/types.ts';

const now = new Date('2026-10-23T10:00:00Z'); // Fri 15:00 PKT
const pd = (day: string, close: number, symbol = 'MEBL'): PriceDay => ({ symbol, day, close, change_pct: null });

describe('priceSeries', () => {
  it('returns nothing for a brand-new stock (empty price_daily), with or without the live price', () => {
    expect(priceSeries([], 'MEBL', now)).toEqual([]);
    expect(priceSeries([], 'MEBL', now, { day: '2026-10-23', close: 400 })).toEqual([{ day: '2026-10-23', close: 400 }]);
  });

  it('keeps only this symbol, oldest first, one close per day, nothing after today or broken', () => {
    const days = [pd('2026-10-22', 410), pd('2026-10-21', 405), pd('2026-10-22', 412), pd('2026-10-21', 90, 'OGDC'),
      pd('2026-10-24', 500), pd('2026-10-20', 0), pd('2026-10-19', Number.NaN)];
    expect(priceSeries(days, 'MEBL', now)).toEqual([{ day: '2026-10-21', close: 405 }, { day: '2026-10-22', close: 412 }]);
  });

  it('the live price replaces today\'s stored close or extends the line, never an older day', () => {
    const days = [pd('2026-10-21', 405), pd('2026-10-22', 410)];
    expect(priceSeries(days, 'MEBL', now, { day: '2026-10-22', close: 411 }).at(-1)).toEqual({ day: '2026-10-22', close: 411 });
    expect(priceSeries(days, 'MEBL', now, { day: '2026-10-23', close: 415 })).toHaveLength(3);
    expect(priceSeries(days, 'MEBL', now, { day: '2026-10-20', close: 1 })).toHaveLength(2);
  });
});

describe('rangesFor', () => {
  it('offers only All until the history is longer than a month', () => {
    expect(rangesFor([])).toEqual(['All']);
    const week = ['2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map((day) => ({ day, close: 1 }));
    expect(rangesFor(week)).toEqual(['All']);
  });

  it('offers 1M and 3M once 100 days are stored, not 6M or 1Y', () => {
    const pts = [{ day: '2026-07-15', close: 1 }, { day: '2026-10-23', close: 2 }];
    expect(rangesFor(pts)).toEqual(['1M', '3M', 'All']);
    expect(cutRange(pts, '1M')).toEqual([{ day: '2026-10-23', close: 2 }]);
    expect(cutRange(pts, 'All')).toHaveLength(2);
  });
});
