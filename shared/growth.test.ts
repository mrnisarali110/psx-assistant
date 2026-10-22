import { describe, expect, it } from 'vitest';
import { projection, projectWealth, realValue } from './growth.ts';
import { DEFAULT_SETTINGS, type Settings } from './types.ts';

const S = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...o });

describe('projection', () => {
  it('projection today money at 10% inflation', () => {
    // Rs 11.5M with nothing added and no growth: 11.5M / 1.1^10 = Rs 4.43M in today's money
    const p = projection(S({ monthly_budget_pkr: 0, inflation_pct: 10 }), 11_500_000, 10, 0);
    expect(p).toEqual({ nominal: 11_500_000, today_money: realValue(11_500_000, 10, 10), inflation_pct: 10 });
    expect(p.today_money).toBeGreaterThan(4_430_000);
    expect(p.today_money).toBeLessThan(4_440_000);
  });

  it('uses the monthly investment, its yearly increase and the inflation setting', () => {
    const s = S({ monthly_budget_pkr: 50_000, sip_step_up_pct: 5, inflation_pct: 8 });
    const p = projection(s, 56_000, 10, 12);
    const nominal = projectWealth({ start: 56_000, monthly: 50_000, annualReturnPct: 12, years: 10, stepUpPct: 5 }).final;
    expect(p).toEqual({ nominal, today_money: realValue(nominal, 8, 10), inflation_pct: 8 });
    // the default yearly return is the Steady scenario (15%)
    expect(projection(s, 56_000, 10).nominal).toBe(projectWealth({ start: 56_000, monthly: 50_000, annualReturnPct: 15, years: 10, stepUpPct: 5 }).final);
  });

  it('falls back to the rules.json inflation when the setting is missing or not a number', () => {
    const broken = { ...S({ monthly_budget_pkr: 0 }), inflation_pct: Number.NaN };
    expect(projection(broken, 1_000_000, 1, 0)).toEqual({ nominal: 1_000_000, today_money: realValue(1_000_000, DEFAULT_SETTINGS.inflation_pct, 1), inflation_pct: DEFAULT_SETTINGS.inflation_pct });
  });
});
