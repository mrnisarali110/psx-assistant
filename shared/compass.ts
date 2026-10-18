/**
 * Market Compass: three separate lights and one action, from real data only, every threshold in rules.json (`compass`,
 * and the trend thresholds in `regime`).
 *
 *   Value         KSE-100 P/E (the index stocks' total value over total profit, from PSX's screener) against its
 *                 long-run average: cheap / fair / expensive.
 *   Shares vs     what shares earn on their price (earnings yield) minus the 10-year government bond (PIB) yield from
 *   safe yield    SBP's auction: shares / even / safe.
 *   Trend         up / sideways / down: up 20% on a year (PSX's own figure) or from the 12-month low; down 20% from the
 *                 12-month high, or below the 200-day average with the year negative; sideways in between.
 *   Rates         SBP policy rate and its cycle, CPI inflation (PBS), the real rate, T-bill yields, FX reserves, PKR.
 *
 * The action changes only EXTRA money: the monthly investment (SIP) always runs. Research (Vanguard, Morningstar,
 * J.P. Morgan) is clear that pausing a plan costs more than any signal saves; valuation speaks to long-run returns,
 * not the next 12 months; and the lights are shown separately, never squeezed into one score.
 */
import { evaluateTrend, rateState, type MarketBreadth, type PolicyRate, type RateState } from './regime.ts';
import { addDays, daysBetween } from './time.ts';
import { DEFAULT_RULES, type IndexDay, type Rules } from './types.ts';

/** One dated figure from SBP, PBS or PSX (table macro_readings). */
export interface MacroReading { series: string; as_of: string; value: number; source: string }
export interface Latest { value: number; as_of: string; source: string; stale: boolean }

export type Trend = 'up' | 'sideways' | 'down';
export type ValueState = 'cheap' | 'fair' | 'expensive';
export type GapState = 'shares' | 'even' | 'safe';
export type ActionKey = 'add_extra' | 'buy_in_steps' | 'on_schedule' | 'park_extra';

export interface CompassFacts {
  today: string;
  closes: IndexDay[]; // stored KSE-100 closes before today, oldest first
  close: number | null; // latest KSE-100
  breadth: MarketBreadth; // index stocks from PSX's screener
  macro: MacroReading[];
  rates: PolicyRate[];
}

export interface Compass {
  trend: { state: Trend | null; one_year_pct: number | null; one_year_source: 'psx' | 'index stocks' | null; ma: number | null; drawdown_pct: number | null; rise_pct: number | null; reasons: string[] };
  value: { state: ValueState | null; pe: number | null; pe_avg: number; earnings_yield_pct: number | null; dividend_yield_pct: number | null; reasons: string[] };
  gap: { state: GapState | null; spread_pct: number | null; pib_10y: Latest | null; tbill_3m: Latest | null; tbill_12m: Latest | null; reasons: string[] };
  rates: { policy: RateState | null; cpi: Latest | null; real_rate_pct: number | null; money_market_pct: number | null; savings_pct: number | null };
  macro: { fx_reserves: (Latest & { change_pct: number | null }) | null; pkr_usd: (Latest & { change_pct: number | null }) | null };
  action: { key: ActionKey; title: string; detail: string; extra_multiplier: number; mix: { stocks: number; equity_funds: number; money_market: number } };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

/** The newest reading of a series on or before `today`, marked stale past the series' limit in rules. */
export function latest(macro: MacroReading[], series: string, today: string, rules: Rules = DEFAULT_RULES): Latest | null {
  const rows = macro.filter((m) => m.series === series && m.as_of <= today).sort((a, b) => a.as_of.localeCompare(b.as_of));
  const row = rows.at(-1);
  if (!row) return null;
  const limit = (rules.compass.stale_days as Record<string, number>)[series] ?? 45;
  return { value: row.value, as_of: row.as_of, source: row.source, stale: daysBetween(row.as_of, today) > limit };
}

/** Change in % from the reading closest to `days` before the latest one. */
function changeOver(macro: MacroReading[], series: string, l: Latest | null, days: number): number | null {
  if (!l) return null;
  const target = addDays(l.as_of, -days);
  const prior = macro.filter((m) => m.series === series && m.as_of <= target).sort((a, b) => a.as_of.localeCompare(b.as_of)).at(-1);
  return prior && prior.value ? r1((l.value / prior.value - 1) * 100) : null;
}

/** Three-way trend from the same thresholds as the bull/bear rule, with PSX's own 1-year figure when we have it. */
export function trendOf(f: CompassFacts, rules: Rules = DEFAULT_RULES): Compass['trend'] {
  const c = rules.regime;
  const psx = latest(f.macro, 'kse100_1y_pct', f.today, rules);
  const oneYear = psx && !psx.stale ? psx.value : f.breadth.change_1y_pct;
  const source = psx && !psx.stale ? 'psx' : f.breadth.change_1y_pct != null ? 'index stocks' : null;
  const t = evaluateTrend({ today: f.today, closes: f.closes, close: f.close, change_1y_pct: oneYear }, null, rules);
  const reasons: string[] = [];
  if (oneYear != null) reasons.push(`KSE-100 ${fmt(oneYear)}% on a year (${source === 'psx' ? 'PSX' : 'PSX screener, index stocks by market cap'})`);
  reasons.push(...t.reasons.filter((r) => !/on a year/.test(r) && !/No clear signal/.test(r)));
  if (f.close == null) return { state: null, one_year_pct: oneYear, one_year_source: source, ma: null, drawdown_pct: null, rise_pct: null, reasons: ['No KSE-100 close yet'] };
  const ma = t.ma;
  const below = ma != null && f.close < ma * (1 - c.band_pct / 100);
  const above = ma == null || f.close >= ma * (1 - c.band_pct / 100);
  const up = ((oneYear != null && oneYear >= c.on_1y_pct) || (t.rise_pct != null && t.rise_pct >= c.on_rise_pct)) && above;
  const down = (t.drawdown_pct != null && t.drawdown_pct <= -c.off_drawdown_pct) || (below && oneYear != null && oneYear < 0);
  const state: Trend | null = down ? 'down' : up ? 'up' : oneYear == null && ma == null ? null : 'sideways';
  return { state, one_year_pct: oneYear, one_year_source: source, ma, drawdown_pct: t.drawdown_pct, rise_pct: t.rise_pct, reasons };
}

export function compass(f: CompassFacts, rules: Rules = DEFAULT_RULES): Compass {
  const k = rules.compass;
  const L = (s: string) => latest(f.macro, s, f.today, rules);
  const trend = trendOf(f, rules);

  // ---- value: P/E against its long-run average ----
  const ey = f.breadth.earnings_yield_pct;
  const pe = ey != null && ey > 0 ? r1(100 / ey) : null;
  const vState: ValueState | null = pe == null ? null : pe < k.pe_cheap_below ? 'cheap' : pe > k.pe_expensive_above ? 'expensive' : 'fair';
  const vReasons = pe == null ? ['No P/E yet: needs PSX screener figures for the index stocks'] : [
    `P/E ${pe.toFixed(1)}x against a long-run average of about ${k.pe_long_run_avg}x (cheap under ${k.pe_cheap_below}x, expensive over ${k.pe_expensive_above}x)`,
    ...(f.breadth.dividend_yield_pct != null ? [`Dividend yield ${f.breadth.dividend_yield_pct}%`] : []),
  ];

  // ---- shares vs safe yield ----
  const pib = L('pib_10y'), t3 = L('tbill_3m'), t12 = L('tbill_12m');
  const spread = ey != null && pib ? r1(ey - pib.value) : null;
  const gState: GapState | null = spread == null ? null : spread >= k.spread_shares_above ? 'shares' : spread < k.spread_safe_below ? 'safe' : 'even';
  const gReasons = spread == null ? ['Needs the 10-year PIB yield from SBP and the P/E'] : [
    `Shares earn ${ey}% on their price; the 10-year government bond pays ${pib!.value.toFixed(2)}% (${fmt(spread)} points)`,
    ...(t12 ? [`12-month T-bill ${t12.value.toFixed(2)}%`] : []),
  ];

  // ---- rates and inflation ----
  const policy = rateState(f.rates, f.today, rules);
  const cpi = L('cpi_yoy');
  const real = policy && cpi ? r1(policy.rate - cpi.value) : null;
  const mm = t3 ? r1(t3.value - k.money_market_fee_pct) : policy ? r1(policy.rate - rules.regime.money_market_below_policy_pct) : null;
  const savings = policy ? r1(policy.rate - rules.regime.savings_below_policy_pct) : null;

  const fx = L('fx_reserves_total'), pkr = L('pkr_usd');

  // ---- the action for extra money ----
  let key: ActionKey;
  if (vState === 'cheap') key = trend.state === 'down' ? 'buy_in_steps' : 'add_extra';
  else if (vState === 'expensive' || gState === 'safe') key = 'park_extra';
  else key = 'on_schedule';
  const safeRate = mm ?? t12?.value ?? null;
  const ACTION: Record<ActionKey, { title: string; detail: string }> = {
    add_extra: { title: 'Shares are cheap: add extra', detail: `Keep your monthly investment, and put spare cash in too (about ${k.extra_multiplier.add_extra}x your usual extra).` },
    buy_in_steps: { title: 'Cheap but still falling: buy in steps', detail: `Keep your monthly investment; put spare cash in over ${k.steps_months} months rather than all at once.` },
    on_schedule: { title: vState === 'fair' ? 'Fair value: stick to the plan' : 'Not enough data: stick to the plan', detail: 'Keep your monthly investment; add spare cash on your usual schedule.' },
    park_extra: {
      title: vState === 'expensive' ? 'Shares are expensive: park extra cash' : 'Safe yield pays more: park extra cash',
      detail: `Keep your monthly investment; park spare cash in T-bills or a money-market fund${safeRate != null ? ` (about ${safeRate}% a year, estimate)` : ''} and move it in over ${k.release_months} months once shares are fair or cheap again.`,
    },
  };
  return {
    trend,
    value: { state: vState, pe, pe_avg: k.pe_long_run_avg, earnings_yield_pct: ey, dividend_yield_pct: f.breadth.dividend_yield_pct, reasons: vReasons },
    gap: { state: gState, spread_pct: spread, pib_10y: pib, tbill_3m: t3, tbill_12m: t12, reasons: gReasons },
    rates: { policy, cpi, real_rate_pct: real, money_market_pct: mm, savings_pct: savings },
    macro: {
      fx_reserves: fx ? { ...fx, change_pct: changeOver(f.macro, 'fx_reserves_total', fx, 28) } : null,
      pkr_usd: pkr ? { ...pkr, change_pct: changeOver(f.macro, 'pkr_usd', pkr, 30) } : null,
    },
    action: { key, ...ACTION[key], extra_multiplier: k.extra_multiplier[key], mix: k.mix[key] },
  };
}

export const TREND_WORD: Record<Trend, string> = { up: 'Up', sideways: 'Sideways', down: 'Down' };
export const VALUE_WORD: Record<ValueState, string> = { cheap: 'Cheap', fair: 'Fair', expensive: 'Expensive' };
export const GAP_WORD: Record<GapState, string> = { shares: 'Shares pay more', even: 'About even', safe: 'Bonds pay more' };
