/**
 * Building blocks for the Market Compass (shared/compass.ts): the KSE-100 trend reading, index breadth from PSX's
 * screener, and the State Bank interest-rate cycle. Real data only; every threshold in rules.json (`regime`).
 *
 * Market trend (KSE-100):
 *   ON  when the index is up `on_1y_pct` on a year (PSX's 1-year change of the index stocks, weighted by market cap)
 *       or `on_rise_pct` above its 12-month low (from the closes the worker stores), and not below its moving
 *       average by more than `band_pct`.
 *   OFF after a fall of `off_drawdown_pct` from the 12-month high, or below the average with the 1-year change under
 *       `off_1y_pct`. Between the two it keeps its last state, so it does not flicker.
 *   The average uses up to `ma_days` stored closes and is skipped until `min_days_for_ma` are stored.
 * Interest rate (State Bank of Pakistan policy rate): the cycle is easing after a cut, tightening after a hike, and
 *   on hold once the last change is `rate_hold_months` old.
 */
import type { ScreenRow } from './discover.ts';
import { addDays, daysBetween } from './time.ts';
import { DEFAULT_RULES, type IndexDay, type Rules } from './types.ts';

export type RegimeConfig = Rules['regime'];
export const regimeConfig = (rules: Rules = DEFAULT_RULES): RegimeConfig => rules.regime;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Interest rate
// ---------------------------------------------------------------------------
/** One State Bank decision: the policy (target) rate from that date, with the corridor when published. */
export interface PolicyRate { decided_on: string; policy_rate: number; ceiling: number | null; floor: number | null; source: string }
export type RateCycle = 'easing' | 'tightening' | 'on_hold';
export interface RatePeriod { cycle: 'easing' | 'tightening'; from: string; to: string | null; days: number; start_rate: number; end_rate: number; changes: number }
export interface RateState {
  rate: number; decided_on: string; cycle: RateCycle; direction: 'easing' | 'tightening' | null;
  last_change_pct: number | null; last_change_on: string | null; months_since_change: number | null; period: RatePeriod | null;
}

/** Decisions in date order with repeats (same rate) dropped, so each row is a real change. */
export function rateChanges(rates: PolicyRate[]): PolicyRate[] {
  const sorted = [...rates].sort((a, b) => a.decided_on.localeCompare(b.decided_on));
  return sorted.filter((r, i) => i === 0 || r.policy_rate !== sorted[i - 1].policy_rate);
}

/** Easing and tightening cycles: a run of moves in one direction, lasting until the first move the other way. */
export function rateCycles(rates: PolicyRate[], today: string): RatePeriod[] {
  const ch = rateChanges(rates);
  const out: RatePeriod[] = [];
  for (let i = 1; i < ch.length; i++) {
    const dir = ch[i].policy_rate < ch[i - 1].policy_rate ? 'easing' : 'tightening';
    const cur = out.at(-1);
    if (cur && cur.cycle === dir) {
      cur.end_rate = ch[i].policy_rate;
      cur.changes++;
      continue;
    }
    if (cur) { cur.to = ch[i].decided_on; cur.days = daysBetween(cur.from, cur.to); }
    out.push({ cycle: dir, from: ch[i].decided_on, to: null, days: 0, start_rate: ch[i - 1].policy_rate, end_rate: ch[i].policy_rate, changes: 1 });
  }
  const last = out.at(-1);
  if (last) last.days = daysBetween(last.from, today);
  return out;
}

const monthsBetween = (from: string, to: string) => Math.floor(daysBetween(from, to) / 30.44);

export function rateState(rates: PolicyRate[], today: string, rules: Rules = DEFAULT_RULES): RateState | null {
  const ch = rateChanges(rates.filter((r) => r.decided_on <= today));
  const latest = ch.at(-1);
  if (!latest) return null;
  const prev = ch.at(-2) ?? null;
  const period = rateCycles(ch, today).at(-1) ?? null;
  const months = prev ? monthsBetween(latest.decided_on, today) : null;
  const direction = period?.cycle ?? null;
  const cycle: RateCycle = !direction || (months != null && months >= regimeConfig(rules).rate_hold_months) ? 'on_hold' : direction;
  return {
    rate: latest.policy_rate, decided_on: latest.decided_on, cycle, direction,
    last_change_pct: prev ? r2(latest.policy_rate - prev.policy_rate) : null, last_change_on: prev ? latest.decided_on : null,
    months_since_change: months, period,
  };
}

/** The rate in force on a day (step function), for charts. */
export function rateOn(rates: PolicyRate[], day: string): number | null {
  let v: number | null = null;
  for (const r of rateChanges(rates)) { if (r.decided_on <= day) v = r.policy_rate; else break; }
  return v;
}

// ---------------------------------------------------------------------------
// Market trend
// ---------------------------------------------------------------------------
/** Index-wide figures from PSX's screener rows of the index's own stocks (weighted by market cap). */
export interface MarketBreadth { members: number; change_1y_pct: number | null; earnings_yield_pct: number | null; dividend_yield_pct: number | null }

export function marketBreadth(screen: ScreenRow[], rules: Rules = DEFAULT_RULES): MarketBreadth {
  const code = regimeConfig(rules).index_code;
  const peMin = rules.undervalued.pe_outlier_min, peMax = rules.undervalued.pe_outlier_max;
  const m = screen.filter((r) => r.listed_in?.includes(code) && r.market_cap != null && r.market_cap > 0);
  // 1-year change: today's total value over what the same stocks were worth a year ago.
  const y = m.filter((r) => r.change_1y_pct != null && r.change_1y_pct > -100);
  const now = y.reduce((s, r) => s + (r.market_cap as number), 0);
  const then = y.reduce((s, r) => s + (r.market_cap as number) / (1 + (r.change_1y_pct as number) / 100), 0);
  // Earnings yield: total profit over total value (stocks with a sensible positive P/E).
  const e = m.filter((r) => r.pe != null && r.pe >= peMin && r.pe <= peMax);
  const ev = e.reduce((s, r) => s + (r.market_cap as number), 0);
  const earn = e.reduce((s, r) => s + (r.market_cap as number) / (r.pe as number), 0);
  const d = m.filter((r) => r.dividend_yield_pct != null && r.dividend_yield_pct >= 0);
  const dv = d.reduce((s, r) => s + (r.market_cap as number), 0);
  const div = d.reduce((s, r) => s + (r.market_cap as number) * (r.dividend_yield_pct as number) / 100, 0);
  const enough = (n: number) => n >= Math.max(10, Math.floor(m.length / 2)); // half the index at least, else unknown
  return {
    members: m.length,
    change_1y_pct: enough(y.length) && then > 0 ? r1((now / then - 1) * 100) : null,
    earnings_yield_pct: enough(e.length) && ev > 0 ? r1((earn / ev) * 100) : null,
    dividend_yield_pct: enough(d.length) && dv > 0 ? r1((div / dv) * 100) : null,
  };
}

export interface TrendFacts { today: string; closes: IndexDay[]; close: number | null; change_1y_pct: number | null }
export interface TrendResult {
  on: boolean | null; flipped: boolean; reasons: string[];
  ma: number | null; ma_days: number; high: number | null; low: number | null; drawdown_pct: number | null; rise_pct: number | null;
}

export function evaluateTrend(f: TrendFacts, prevOn: boolean | null, rules: Rules = DEFAULT_RULES): TrendResult {
  const c = regimeConfig(rules);
  const since = addDays(f.today, -c.lookback_days);
  const closes = f.closes.filter((d) => d.day >= since && d.day <= f.today && d.close > 0).sort((a, b) => a.day.localeCompare(b.day));
  const close = f.close ?? closes.at(-1)?.close ?? null;
  const base: TrendResult = { on: prevOn, flipped: false, reasons: [], ma: null, ma_days: 0, high: null, low: null, drawdown_pct: null, rise_pct: null };
  if (close == null) return { ...base, reasons: ['No KSE-100 close yet'] };

  const lastN = closes.slice(-c.ma_days);
  const ma = closes.length >= c.min_days_for_ma ? lastN.reduce((s, d) => s + d.close, 0) / lastN.length : null;
  const vals = [...closes.map((d) => d.close), close];
  const high = Math.max(...vals), low = Math.min(...vals);
  const longEnough = closes.length >= c.min_days_for_ma; // a 12-month low from a few weeks of closes means nothing
  const drawdown = r1((close / high - 1) * 100);
  const rise = r1((close / low - 1) * 100);
  const y = f.change_1y_pct;
  const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

  const upYear = y != null && y >= c.on_1y_pct;
  const upFromLow = longEnough && rise >= c.on_rise_pct;
  const aboveMa = ma == null || close >= ma * (1 - c.band_pct / 100);
  const bigFall = longEnough && drawdown <= -c.off_drawdown_pct;
  const belowMa = ma != null && close < ma * (1 - c.band_pct / 100);
  const weakYear = y != null && y < c.off_1y_pct;

  const onSignal = (upYear || upFromLow) && aboveMa && !bigFall;
  const offSignal = bigFall || (belowMa && (y == null || weakYear)) || (ma == null && weakYear);
  const on = offSignal ? false : onSignal ? true : prevOn; // no signal and no earlier state: unknown, never a made-up OFF

  const reasons: string[] = [];
  if (y != null) reasons.push(`KSE-100 stocks ${fmt(y)} on a year (PSX, by market cap)`);
  if (ma != null) reasons.push(`${close >= ma ? 'Above' : 'Below'} its ${lastN.length}-day average (${Math.round(ma).toLocaleString('en-PK')})`);
  else reasons.push(`Average needs ${c.min_days_for_ma} days of closes (${closes.length} stored)`);
  if (longEnough) reasons.push(`${fmt(drawdown)} from the 12-month high, ${fmt(rise)} from the low`);
  if (!offSignal && !onSignal) reasons.push(`No clear signal: keeps its last state`);
  return { on, flipped: prevOn != null && on !== prevOn, reasons, ma: ma == null ? null : r2(ma), ma_days: ma == null ? 0 : lastN.length, high, low, drawdown_pct: longEnough ? drawdown : null, rise_pct: longEnough ? rise : null };
}

/** A stored daily reading (table market_regime). */
export interface RegimeDay {
  day: string; bull: boolean; close: number | null; ma: number | null; change_1y_pct: number | null; drawdown_pct: number | null;
  earnings_yield_pct: number | null; policy_rate: number | null; reasons: string[];
  // Market Compass (migration 0011); optional so older rows still load.
  trend?: 'up' | 'sideways' | 'down' | null; pe?: number | null; dividend_yield_pct?: number | null;
  value_state?: 'cheap' | 'fair' | 'expensive' | null; action?: string | null; compass?: unknown;
}
export interface RegimePeriod { bull: boolean; from: string; to: string | null; days: number }

/** ON and OFF stretches from the daily readings, with how long each lasted (the last one runs to today). */
export function regimePeriods(days: RegimeDay[], today: string): RegimePeriod[] {
  const out: RegimePeriod[] = [];
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    const cur = out.at(-1);
    if (cur && cur.bull === d.bull) continue;
    if (cur) { cur.to = d.day; cur.days = daysBetween(cur.from, d.day); }
    out.push({ bull: d.bull, from: d.day, to: null, days: 0 });
  }
  const last = out.at(-1);
  if (last) last.days = daysBetween(last.from, today);
  return out;
}
