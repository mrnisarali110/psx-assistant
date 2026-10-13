/**
 * Wealth growth projection: today's portfolio plus a monthly SIP, compounded monthly at an assumed
 * yearly return. An illustration of the arithmetic, not a forecast: real PSX returns vary a lot year to year.
 */
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
