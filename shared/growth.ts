/**
 * Wealth growth projection: today's portfolio plus a monthly SIP, compounded monthly at an assumed
 * yearly return. An illustration of the arithmetic, not a forecast: real PSX returns vary a lot year to year.
 */
import type { Settings } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';

export interface GrowthPoint { year: number; value: number; invested: number }

export interface Growth { points: GrowthPoint[]; final: number; invested: number; gain: number }

export const GROWTH_SCENARIOS = [
  { id: 'cautious', label: 'Cautious', rate: 10 },
  { id: 'steady', label: 'Steady', rate: 15 },
  { id: 'strong', label: 'Strong', rate: 20 },
] as const;

export function projectWealth(o: { start: number; monthly: number; annualReturnPct: number; years: number; stepUpPct?: number }): Growth {
  const years = Math.max(1, Math.min(40, Math.round(o.years)));
  const rm = Math.pow(1 + o.annualReturnPct / 100, 1 / 12) - 1;
  let value = Math.max(0, o.start);
  let invested = Math.max(0, o.start);
  let monthly = Math.max(0, o.monthly);
  const points: GrowthPoint[] = [{ year: 0, value, invested }];
  for (let y = 1; y <= years; y++) {
    for (let m = 0; m < 12; m++) {
      value = value * (1 + rm) + monthly; // contribution at month end
      invested += monthly;
    }
    points.push({ year: y, value: Math.round(value), invested: Math.round(invested) });
    monthly *= 1 + (o.stepUpPct ?? 0) / 100; // optional yearly SIP increase
  }
  const final = Math.round(value);
  return { points, final, invested: Math.round(invested), gain: Math.round(value - invested) };
}

/** Value in today's rupees after `years` of inflation. */
export const realValue = (nominal: number, inflationPct: number, years: number) => Math.round(nominal / Math.pow(1 + inflationPct / 100, years));

/** The yearly return projection() assumes when none is given: the Steady scenario. */
const STEADY_PCT = GROWTH_SCENARIOS.find((g) => g.id === 'steady')!.rate;

/**
 * Where `start` plus the monthly investment (rising by sip_step_up_pct a year) could be in `years`, in future
 * rupees and in today's money at settings.inflation_pct (the rules.json default when the setting is missing).
 * The yearly return defaults to the Steady scenario.
 */
export function projection(settings: Settings, start: number, years: number, annualReturnPct: number = STEADY_PCT):
  { nominal: number; today_money: number; inflation_pct: number } {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const inflation_pct = ok(settings.inflation_pct) ? settings.inflation_pct : DEFAULT_SETTINGS.inflation_pct;
  const g = projectWealth({
    start, monthly: ok(settings.monthly_budget_pkr) ? settings.monthly_budget_pkr : 0, annualReturnPct, years,
    stepUpPct: ok(settings.sip_step_up_pct) ? settings.sip_step_up_pct : 0,
  });
  const span = g.points.length - 1; // projectWealth keeps years within 1..40
  return { nominal: g.final, today_money: realValue(g.final, inflation_pct, span), inflation_pct };
}
