import type { AiInsight, Holding, HoldingCallKind, Price, PriceMap, Rules, Settings } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { titleCase } from './format.ts';

export interface HoldingCall {
  call: HoldingCallKind;
  text: string;
  source: 'ai' | 'rules';
}

export interface HoldingView {
  holding: Holding;
  price: Price | null;
  sector: string;
  value: number | null;
  cost: number;
  pnl: number | null;
  pnl_pct: number | null;
  day_change: number | null;
  weight_pct: number | null;
  ref_price: number; // last buy price, or average cost when no buy is recorded
  vs_ref_pct: number | null; // price vs last buy, % (negative = cheaper than you last paid)
  flags: { over_cap: boolean; big_move: boolean };
  call: HoldingCall; // rules call; mergeCall() can swap in the AI's
}

export interface RebalanceTip { kind: 'position' | 'sector'; name: string; pct: number; limit: number; text: string }

export interface PortfolioView {
  rows: HoldingView[];
  total_value: number;
  total_cost: number; // cost of holdings that have a price (so P/L compares like with like)
  total_pnl: number;
  total_pnl_pct: number | null;
  day_change: number | null;
  sector_weights: { sector: string; pct: number }[];
  sectors_over_limit: string[];
  missing_prices: string[];
  rebalance: RebalanceTip[];
}

/** PSX's own sector name when we have it (one taxonomy for everything), else what the user typed. */
export function sectorOf(symbol: string, prices: PriceMap, fallback?: string | null): string {
  return prices[symbol]?.sector ?? fallback ?? 'Unknown';
}

export const refPrice = (h: Holding) => (h.last_buy_price && h.last_buy_price > 0 ? h.last_buy_price : h.avg_cost);

/** Why new money must not go to this holding (the user's own rules), or null if it may. */
export function addBlockedReason(h: Pick<Holding, 'status' | 'is_shariah'> | undefined, weightPct: number | null,
  settings: Pick<Settings, 'max_position_pct' | 'shariah_only'>): string | null {
  if (!h) return null;
  if (h.status === 'hold_no_add') return 'you set it to hold, no add';
  if (h.status === 'review') return 'it is under review';
  if (weightPct != null && weightPct >= settings.max_position_pct) return `it is at your ${settings.max_position_pct}% cap`;
  if (settings.shariah_only && !h.is_shariah) return 'it is not Shariah compliant';
  return null;
}

function ruleCall(h: Holding, weight: number | null, vsRef: number | null, settings: Settings, rules: Rules): HoldingCall {
  const below = vsRef != null && vsRef < 0 ? Math.abs(vsRef) : 0;
  const blocked = addBlockedReason(h, weight, settings);
  if (weight != null && weight > settings.max_position_pct) {
    return { call: 'trim', text: `${weight.toFixed(1)}% of your portfolio, over your ${settings.max_position_pct}% cap`, source: 'rules' };
  }
  if (h.status === 'review') return { call: 'review', text: 'Under review: decide before adding more', source: 'rules' };
  if (below >= settings.drop_alert_pct && !blocked) {
    return { call: 'opportunity', text: `${below.toFixed(1)}% below your last buy`, source: 'rules' };
  }
  if (below >= rules.holding.average_down_pct && !blocked) {
    return { call: 'average_down', text: `${below.toFixed(1)}% below your last buy: average down`, source: 'rules' };
  }
  if (below > 0) return { call: 'hold', text: `${below.toFixed(1)}% below your last buy${blocked ? ` (${blocked})` : ''}`, source: 'rules' };
  return { call: 'hold', text: vsRef == null ? 'No live price yet' : `${vsRef.toFixed(1)}% above your last buy`, source: 'rules' };
}

/** Use the AI's call for a holding when it exists and doesn't break the user's own rules. */
export function mergeCall(row: HoldingView, ai: Pick<AiInsight, 'holding_calls'> | null, settings: Settings): HoldingCall {
  const c = ai?.holding_calls?.find((x) => x.symbol === row.holding.symbol);
  if (!c) return row.call;
  const adding = c.call === 'average_down' || c.call === 'opportunity';
  if (adding && addBlockedReason(row.holding, row.weight_pct, settings)) return row.call;
  return { call: c.call, text: c.text, source: 'ai' };
}

export function buildPortfolio(holdings: Holding[], prices: PriceMap, settings: Settings,
  rules: Rules = DEFAULT_RULES): PortfolioView {
  const priced = holdings.filter((h) => prices[h.symbol]?.price != null);
  const total = priced.reduce((s, h) => s + h.shares * (prices[h.symbol].price as number), 0);
  const bySector = new Map<string, number>();
  let dayChange: number | null = null;

  const rows: HoldingView[] = holdings.map((h) => {
    const p = prices[h.symbol] ?? null;
    const px = p?.price ?? null;
    const sector = sectorOf(h.symbol, prices, h.sector);
    const value = px == null ? null : h.shares * px;
    const cost = h.shares * h.avg_cost;
    if (value != null) bySector.set(sector, (bySector.get(sector) ?? 0) + value);
    if (p?.change != null) dayChange = (dayChange ?? 0) + h.shares * p.change;
    const weight = value != null && total > 0 ? (value / total) * 100 : null;
    const ref = refPrice(h);
    const vsRef = px == null || ref <= 0 ? null : ((px - ref) / ref) * 100;
    return {
      holding: h, price: p, sector, value, cost,
      pnl: value == null ? null : value - cost,
      pnl_pct: value == null || cost === 0 ? null : ((value - cost) / cost) * 100,
      day_change: p?.change == null ? null : h.shares * p.change,
      weight_pct: weight,
      ref_price: ref,
      vs_ref_pct: vsRef,
      flags: {
        over_cap: weight != null && weight > settings.max_position_pct,
        big_move: p?.change_pct != null && Math.abs(p.change_pct) >= rules.holding.big_move_pct,
      },
      call: ruleCall(h, weight, vsRef, settings, rules),
    };
  });

  const totalCost = priced.reduce((s, h) => s + h.shares * h.avg_cost, 0);
  const sectorWeights = [...bySector.entries()]
    .map(([sector, v]) => ({ sector, pct: total > 0 ? (v / total) * 100 : 0 }))
    .sort((a, b) => b.pct - a.pct);
  const overLimit = sectorWeights.filter((s) => s.pct > rules.holding.sector_limit_pct);
  const rebalance: RebalanceTip[] = [
    ...rows.filter((r) => r.flags.over_cap).map((r) => ({
      kind: 'position' as const, name: r.holding.symbol, pct: r.weight_pct!, limit: settings.max_position_pct,
      text: `${r.holding.symbol} is ${r.weight_pct!.toFixed(0)}% of your money (cap ${settings.max_position_pct}%). Pause buying it; new money elsewhere brings it back down.`,
    })),
    ...overLimit.map((s) => ({
      kind: 'sector' as const, name: s.sector, pct: s.pct, limit: rules.holding.sector_limit_pct,
      text: `${titleCase(s.sector)} is ${s.pct.toFixed(0)}% (limit ${rules.holding.sector_limit_pct}%). Put this month's cash into other sectors.`,
    })),
  ];

  return {
    rows: rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
    total_value: total,
    total_cost: totalCost,
    total_pnl: total - totalCost,
    total_pnl_pct: totalCost > 0 ? ((total - totalCost) / totalCost) * 100 : null,
    day_change: dayChange,
    sector_weights: sectorWeights,
    sectors_over_limit: overLimit.map((s) => s.sector),
    missing_prices: holdings.filter((h) => prices[h.symbol]?.price == null).map((h) => h.symbol),
    rebalance,
  };
}

/** Allocation slices for the donut: biggest first, at most `max` slices, the rest grouped as "Other". */
export function allocationSlices(view: PortfolioView, max = 6): { label: string; value: number; pct: number }[] {
  const priced = view.rows.filter((r) => r.value != null && r.value > 0);
  const top = priced.slice(0, priced.length > max ? max - 1 : max).map((r) => ({ label: r.holding.symbol, value: r.value!, pct: r.weight_pct! }));
  const rest = priced.slice(top.length);
  if (rest.length) {
    const value = rest.reduce((a, r) => a + r.value!, 0);
    top.push({ label: `Other (${rest.length})`, value, pct: view.total_value > 0 ? (value / view.total_value) * 100 : 0 });
  }
  return top;
}
