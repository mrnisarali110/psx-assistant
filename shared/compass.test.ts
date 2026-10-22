import { describe, expect, it } from 'vitest';
import { compass, GAP_WORD, latest, trendOf, type CompassFacts, type MacroReading } from './compass.ts';
import { DEFAULT_RULES } from './types.ts';
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
  it('today: fair value, shares out-earn the money-market estimate, sideways trend: stick to the plan, keep the SIP', () => {
    const c = compass(facts());
    expect(c.value).toMatchObject({ state: 'fair', pe: 8.1 });
    // 12.4% earnings yield against money market 11.0% (3M T-bill 12.0 - 1% fees): +1.4. The 10-year PIB (-0.4) is information only.
    expect(c.gap).toMatchObject({ basis: 'money_market', state: 'even', spread_pct: 1.4, pib_spread_pct: -0.4 });
    expect(c.trend).toMatchObject({ state: 'sideways', one_year_pct: 1.2, one_year_source: 'psx' }); // PSX's own figure wins over the index-stock estimate
    expect(c.rates.policy?.rate).toBe(11.5);
    expect(c.rates.real_rate_pct).toBe(1.2); // 11.5 - 10.3
    expect(c.rates.money_market_pct).toBe(11); // 3M T-bill 12.0 - 1% fees
    expect(c.rates.savings_pct).toBe(10);
    expect(c.macro.fx_reserves?.change_pct).toBe(7.5);
    expect(c.macro.pkr_usd?.change_pct).toBe(-1.1);
    expect(c.action.key).toBe('on_schedule');
    expect(c.action.title).toBe('Fair value: stick to the plan');
    expect(c.action.detail).toMatch(/^Keep your monthly investment/);
    expect(c.action.extra_multiplier).toBe(1);
  });

  it('park extra only when the money-market estimate pays clearly more: a -0.35 point gap is inside the neutral band', () => {
    const near = compass(facts({ breadth: breadth(10.65) })); // P/E 9.4x, fair; 10.65 - 11.0 = -0.35
    expect(near.gap.state).toBe('even');
    expect(near.action.key).toBe('on_schedule');
    const below = compass(facts({ breadth: breadth(9.5) })); // P/E 10.5x, fair; 9.5 - 11.0 = -1.5
    expect(below.gap).toMatchObject({ state: 'safe', spread_pct: -1.5 });
    expect(below.action.key).toBe('park_extra');
    expect(below.action.title).toBe('Safe yield pays more: park extra cash');
    expect(below.action.extra_multiplier).toBe(0);
  });

  it('gap band edges', () => {
    // Money market 11.0: earnings yield 10.0 is exactly -1.0, 12.0 exactly +1.0. Both are inside the band.
    for (const ey of [10, 12]) {
      const c = compass(facts({ breadth: breadth(ey) }));
      expect(c.gap.state).toBe('even');
      expect(c.gap.neutral).toBe(true);
      expect(c.action.key).toBe('on_schedule');
    }
    const under = compass(facts({ breadth: breadth(9.9) })); // -1.1
    expect(under.gap).toMatchObject({ state: 'safe', neutral: false });
    expect(under.action.key).toBe('park_extra');
    const over = compass(facts({ breadth: breadth(12.1) })); // +1.1: outside the band, under the +2 "shares" line
    expect(over.gap).toMatchObject({ state: 'even', neutral: false });
    expect(compass(facts({ breadth: breadth(13) })).gap.state).toBe('shares'); // +2.0
  });

  it('gap uses money market', () => {
    const c = compass(facts({ breadth: breadth(10.5) })); // vs money market 11.0: -0.5; vs PIB 12.85: -2.35, shown as -2.3
    expect(c.gap).toMatchObject({ basis: 'money_market', spread_pct: -0.5, pib_spread_pct: -2.3, state: 'even' });
    expect(c.gap.reasons[0]).toMatch(/money-market/);
    expect(c.gap.reasons.join(' ')).toMatch(/10-year government bond pays 12\.85%/);
    // The basis is a setting: against the PIB the same market reads "safe".
    const rules = { ...DEFAULT_RULES, compass: { ...DEFAULT_RULES.compass, gap_basis: 'pib' } };
    expect(compass(facts({ breadth: breadth(10.5) }), rules).gap).toMatchObject({ basis: 'pib', spread_pct: -2.3, state: 'safe' });
    // Without a T-bill the money-market estimate comes from the policy rate (11.5 - 0.75 = 10.75).
    const noBill = compass(facts({ breadth: breadth(10.5), macro: MACRO.filter((x) => x.series !== 'tbill_3m') }));
    expect(noBill.gap).toMatchObject({ spread_pct: -0.3, state: 'even' });
    expect(GAP_WORD.safe).toBe('Safe yield pays more');
  });

  it('trend provisional flag', () => {
    const short = trendOf(facts({ closes: Array.from({ length: 30 }, (_, i) => ({ day: addDays('2026-09-01', i), close: 160000 })) }));
    expect(short.provisional).toBe(true);
    expect(short.ma).toBeNull();
    expect(short.reasons).toContain('200-day average (needs 120 stored closes; 30 so far)');
    const long = trendOf(facts({ closes: Array.from({ length: 150 }, (_, i) => ({ day: addDays('2026-04-01', i), close: 160000 })) }));
    expect(long.provisional).toBe(false);
    expect(long.ma).toBe(160000);
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

  it('fair value with shares out-earning the money market: stick to the plan', () => {
    const c = compass(facts({ breadth: breadth(12.5) })); // P/E 8.0x, spread +1.5
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
