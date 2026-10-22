import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Discover } from './Discover.tsx';
import { DemoSource } from '../lib/data.ts';
import type { ScreenRow } from '../../shared/discover.ts';
import type { Price, QuarterEarnings } from '../../shared/types.ts';

const row = (symbol: string, price: number, pe: number): ScreenRow => ({
  symbol, sector: 'CEMENT', price, change_pct: null, pe, dividend_yield_pct: 6, market_cap: null, is_shariah: true,
});
const live = (symbol: string, price: number, pe: number): Price => ({
  symbol, name: null, sector: 'CEMENT', price, change: null, change_pct: null, volume: null, ldcp: null, high_52w: null, low_52w: null,
  dividend_yield_pct: 6, pe, is_shariah: true, as_of: '2026-10-23T10:00:00Z',
});
const year = (symbol: string, eps: number): QuarterEarnings =>
  ({ id: `${symbol}-fy`, symbol, period_end: '2026-06-30', profit_after_tax: 1, verified: true, eps, eps_basis: 'consolidated', period_months: 12 });
/** Rendered text with React's text-node separators taken out. */
const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Discover P/E', () => {
  it('shows the same P/E as the stock page: the live price wins over the screener price for a watched stock', async () => {
    const base = await new DemoSource().load();
    // The screener read Rs 50 (P/E 5.0 on EPS 10); the live market check reads Rs 60, so the stock page says 6.0.
    const data = {
      ...base, holdings: [], watchlist: [{ id: 'w1', symbol: 'AAA' }], dividends: [], bluechip: {}, picks: { undervalued: null, dividend: null },
      screen: [row('AAA', 50, 5)], prices: { AAA: live('AAA', 60, 6) }, earnings: [year('AAA', 10)],
      settings: { ...base.settings, shariah_only: false },
    };
    const out = text(renderToString(createElement(Discover, { data, source: new DemoSource(), reload: async () => {}, go: () => {} })));
    expect(out).toContain('P/E 6.0');
    expect(out).not.toContain('P/E 5.0');
    // The price on the card is the one that P/E is worked out on.
    expect(out).toContain('Rs 60.00');
    expect(out).not.toContain('Rs 50.00');
  });
  it('keeps the screener figures for a stock you neither hold nor watch', async () => {
    const base = await new DemoSource().load();
    const data = {
      ...base, holdings: [], watchlist: [], dividends: [], bluechip: {}, picks: { undervalued: null, dividend: null },
      screen: [row('AAA', 50, 5)], prices: {}, earnings: [year('AAA', 10)], settings: { ...base.settings, shariah_only: false },
    };
    const out = text(renderToString(createElement(Discover, { data, source: new DemoSource(), reload: async () => {}, go: () => {} })));
    expect(out).toContain('P/E 5.0');
    expect(out).toContain('Rs 50.00');
  });
});
