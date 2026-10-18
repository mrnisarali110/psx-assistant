import { describe, expect, it } from 'vitest';
import { compass, latest, trendOf, type CompassFacts, type MacroReading } from './compass.ts';
import type { MarketBreadth, PolicyRate } from './regime.ts';
import { addDays } from './time.ts';
import sbp from './sbp-policy-rates.json' with { type: 'json' };

const RATES = sbp as PolicyRate[];
const TODAY = '2026-10-18';
const m = (series: string, as_of: string, value: number): MacroReading => ({ series, as_of, value, source: 'https://www.sbp.org.pk/assets/document/test.pdf' });
// Live figures seen on 2026-10-18 (SBP auctions, PBS, PSX): used here as test data only.
const MACRO = [
  m('pib_10y', '2026-10-07', 12.85), m('tbill_3m', '2026-10-14', 11.9999), m('tbill_12m', '2026-10-14', 12.4999),
  m('cpi_yoy', '2026-09-01', 10.3), m('kse100_1y_pct', '2026-10-16', 1.2),
  m('fx_reserves_total', '2026-09-11', 25000), m('fx_reserves_total', '2026-10-09', 26863.3),
  m('pkr_usd', '2026-09-16', 280), m('pkr_usd', '2026-10-16', 276.9115),
];
const breadth = (earnings_yield_pct: number | null, change_1y_pct: number | null = -5): MarketBreadth => ({ members: 100, change_1y_pct, earnings_yield_pct, dividend_yield_pct: 5.4 });
const facts = (o: Partial<CompassFacts> = {}): CompassFacts => ({ today: TODAY, closes: [], close: 166420, breadth: breadth(12.4), macro: MACRO, rates: RATES, ...o });

describe('Market Compass', () => {
  it('today: fair value, bonds pay a little more than shares earn, sideways trend: park extra, keep the SIP', () => {
    const c = compass(facts());
    expect(c.value).toMatchObject({ state: 'fair', pe: 8.1 });
    expect(c.gap).toMatchObject({ state: 'safe', spread_pct: -0.4 });
    expect(c.trend).toMatchObject({ state: 'sideways', one_year_pct: 1.2, one_year_source: 'psx' }); // PSX's own figure wins over the index-stock estimate
    expect(c.rates.policy?.rate).toBe(11.5);
    expect(c.rates.real_rate_pct).toBe(1.2); // 11.5 - 10.3
    expect(c.rates.money_market_pct).toBe(11); // 3M T-bill 12.0 - 1% fees
    expect(c.rates.savings_pct).toBe(10);
    expect(c.macro.fx_reserves?.change_pct).toBe(7.5);
    expect(c.macro.pkr_usd?.change_pct).toBe(-1.1);
    expect(c.action.key).toBe('park_extra');
    expect(c.action.title).toBe('Safe yield pays more: park extra cash');
    expect(c.action.detail).toMatch(/^Keep your monthly investment/);
    expect(c.action.extra_multiplier).toBe(0);
  });

  it('cheap shares: add extra; cheap but in a 20% fall: buy in steps', () => {
    expect(compass(facts({ breadth: breadth(18) })).action.key).toBe('add_extra'); // P/E 5.6x
    const closes = Array.from({ length: 150 }, (_, i) => ({ day: addDays('2026-04-01', i), close: 200000 }));
    const c = compass(facts({ breadth: breadth(18), closes, close: 150000 }));
    expect(c.trend.state).toBe('down');
    expect(c.action.key).toBe('buy_in_steps');
    expect(c.action.mix.stocks).toBe(50);
  });

  it('expensive shares: park extra even when the trend is up', () => {
    const macro = MACRO.map((x) => (x.series === 'kse100_1y_pct' ? { ...x, value: 35 } : x));
    const c = compass(facts({ breadth: breadth(8.5), macro })); // P/E 11.8x
    expect(c.trend.state).toBe('up');
    expect(c.value.state).toBe('expensive');
    expect(c.action.key).toBe('park_extra');
    expect(c.action.title).toMatch(/expensive/);
  });

  it('fair value with shares out-earning bonds: stick to the plan', () => {
    const c = compass(facts({ breadth: breadth(14) })); // P/E 7.1x, spread +1.2
    expect(c.gap.state).toBe('even');
    expect(c.action.key).toBe('on_schedule');
    expect(c.action.extra_multiplier).toBe(1);
  });

  it('missing data stays unknown: no P/E, no PIB, no 1-year figure', () => {
    const c = compass(facts({ breadth: breadth(null, null), macro: [] }));
    expect(c.value.state).toBeNull();
    expect(c.gap.state).toBeNull();
    expect(c.trend.state).toBeNull();
    expect(c.action.key).toBe('on_schedule');
    expect(c.action.title).toBe('Not enough data: stick to the plan');
    expect(c.rates.cpi).toBeNull();
    expect(c.rates.money_market_pct).toBe(10.8); // falls back to the policy rate estimate
  });

  it('old readings are marked stale; a stale PSX 1-year figure gives way to the index-stock estimate', () => {
    expect(latest(MACRO, 'cpi_yoy', '2026-12-15')?.stale).toBe(true);
    expect(latest(MACRO, 'cpi_yoy', TODAY)?.stale).toBe(false);
    expect(trendOf(facts({ today: '2026-11-20' })).one_year_source).toBe('index stocks');
  });
});
