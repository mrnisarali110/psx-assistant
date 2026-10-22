import { describe, expect, it } from 'vitest';
import { ruleChecks } from './Stock.tsx';
import { buildPortfolio, type RuleContext } from '../../shared/portfolio.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS, type Holding, type Price, type QuarterEarnings } from '../../shared/types.ts';

const price = (symbol: string, sector: string, px: number, pe: number | null = 5): Price => ({
  symbol, name: null, sector, price: px, change: null, change_pct: null, volume: null, ldcp: null, high_52w: px * 1.5, low_52w: px * 0.8,
  dividend_yield_pct: null, pe, is_shariah: true, as_of: '2026-10-23T10:00:00Z',
});
const holding = (symbol: string, shares: number, avg: number, last?: number): Holding =>
  ({ symbol, shares, avg_cost: avg, status: 'core', sector: null, is_shariah: true, last_buy_price: last ?? null });

const prices = {
  MEBL: price('MEBL', 'COMMERCIAL BANKS', 100),
  OGDC: price('OGDC', 'OIL & GAS EXPLORATION COMPANIES', 100),
  HUBC: price('HUBC', 'POWER GENERATION & DISTRIBUTION', 100),
  LUCK: price('LUCK', 'CEMENT', 100, -3),
};
const holdings = [holding('MEBL', 10, 110, 106.5), holding('OGDC', 50, 90), holding('HUBC', 40, 95)];
const settings = { ...DEFAULT_SETTINGS };
const ctx: RuleContext = { today: '2026-10-23', sectorPe: { 'COMMERCIAL BANKS': 6 }, dividends: [], earnings: [] };
const view = buildPortfolio(holdings, prices, settings, DEFAULT_RULES, {}, ctx);
const rowOf = (s: string) => view.rows.find((r) => r.holding.symbol === s);
const checks = (symbol: string, extra: Partial<Parameters<typeof ruleChecks>[0]> = {}) => {
  const row = rowOf(symbol);
  const p = prices[symbol as keyof typeof prices];
  return Object.fromEntries(ruleChecks({ symbol, row, price: p, sector: p.sector, settings, ctx, view, shariah: true, ...extra }).map((c) => [c.key, c]));
};

describe('ruleChecks', () => {
  it('buy more passes when far enough below the last buy, cheap on P/E and not blocked', () => {
    const c = checks('MEBL');
    expect(c.buy_more.state).toBe('pass');
    expect(c.buy_more.text).toContain('below your last buy (Rs 106.50)');
    expect(c.stock_cap.state).toBe('pass');
    expect(c.value.state).toBe('pass');
    expect(c.trim.state).toBe('pass');
  });

  it('a holding over the hard stock cap is flagged on the cap and the trim rules', () => {
    const c = checks('OGDC');
    expect(c.stock_cap.state).toBe('flag');
    expect(c.stock_cap.text).toContain('over your 30% hard cap');
    expect(c.trim.state).toBe('flag');
    expect(c.buy_more.state).toBe('no'); // above average cost
  });

  it('a stock you do not hold gets the first-buy checks only, and a loss is no value check', () => {
    const c = checks('LUCK');
    expect(c.buy_more).toBeUndefined();
    expect(c.stock_cap).toBeUndefined();
    expect(c.trim).toBeUndefined();
    expect(c.sector_cap.text).toBe('You hold nothing in Cement yet; new money stops at 30%');
    expect(c.value).toMatchObject({ state: 'no', text: 'P/E n/a (loss): no value check' });
  });

  it('loss quarters: off when both rules are 0, flagged at the review threshold', () => {
    expect(checks('MEBL', { settings: { ...settings, review_after_loss_quarters: 0, sell_after_loss_quarters: 0 } }).losses.state).toBe('na');
    const q = (period_end: string, p: number): QuarterEarnings => ({ id: period_end, symbol: 'MEBL', period_end, profit_after_tax: p, verified: true, period_months: 3 });
    const earnings = [q('2026-03-31', 5), q('2026-06-30', -1), q('2026-09-30', -2)];
    expect(checks('MEBL', { ctx: { ...ctx, earnings } }).losses).toMatchObject({ state: 'flag', text: expect.stringContaining('review after 2') });
  });

  it('Shariah only appears when your rules ask for it', () => {
    expect(checks('MEBL').shariah).toBeUndefined();
    expect(checks('MEBL', { settings: { ...settings, shariah_only: true }, shariah: false }).shariah.state).toBe('flag');
  });

  it('no blue-chip state yet reads "not checked", never a fail', () => {
    expect(checks('MEBL').bluechip.state).toBe('na');
  });
});
