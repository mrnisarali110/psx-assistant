import { describe, expect, it } from 'vitest';
import { watchFacts } from './Portfolio.tsx';
import { peFor } from '../../shared/valuation.ts';
import type { Price, QuarterEarnings } from '../../shared/types.ts';

const live = (pe: number | null, dividend_yield_pct: number | null = 5): Price => ({
  symbol: 'AAA', name: null, sector: 'CEMENT', price: 60, change: null, change_pct: null, volume: null, ldcp: null, high_52w: null, low_52w: null,
  dividend_yield_pct, pe, is_shariah: true, as_of: '2026-10-23T10:00:00Z',
});
const year = (eps: number): QuarterEarnings =>
  ({ id: 'fy', symbol: 'AAA', period_end: '2026-06-30', profit_after_tax: 1, verified: true, eps, eps_basis: 'consolidated', period_months: 12 });

describe('watchFacts', () => {
  it('shows the filing-based P/E the stock page shows, not PSX raw figure', () => {
    const p = live(9.9);
    expect(watchFacts(p, peFor('AAA', 60, [year(10)], p.pe))).toBe('Yield 5.0% · P/E 6.0');
  });
  it('says "n/a (loss)" for a loss-making company instead of a missing or negative P/E', () => {
    const p = live(-3);
    expect(watchFacts(p, peFor('AAA', 60, [], p.pe))).toBe('Yield 5.0% · P/E n/a (loss)');
    expect(watchFacts(live(4), peFor('AAA', 60, [year(-2)], 4))).toBe('Yield 5.0% · P/E n/a (loss)');
  });
  it('marks an unusual P/E from the same figure', () => {
    expect(watchFacts(live(5), peFor('AAA', 60, [year(0.3)], 5))).toBe('Yield 5.0% · P/E 200.0 (unusual, check)');
  });
  it('keeps n/a for a missing yield or P/E and waits for a price when there is none', () => {
    expect(watchFacts(live(null, null), peFor('AAA', 60, [], null))).toBe('Yield n/a · P/E n/a');
    expect(watchFacts(undefined, undefined)).toBe('Price after the next market check');
  });
});
