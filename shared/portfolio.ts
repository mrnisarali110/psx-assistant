import type { Holding, Price, PriceMap, Rules, Settings } from './types.ts';
import { DEFAULT_RULES } from './types.ts';

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
  flags: { over_cap: boolean; below_cost: boolean; big_move: boolean };
}

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
}

/** PSX's own sector name when we have it (one taxonomy for everything), else what the user typed. */
export function sectorOf(symbol: string, prices: PriceMap, fallback?: string | null): string {
  return prices[symbol]?.sector ?? fallback ?? 'Unknown';
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
    return {
      holding: h,
      price: p,
      sector,
      value,
      cost,
      pnl: value == null ? null : value - cost,
      pnl_pct: value == null || cost === 0 ? null : ((value - cost) / cost) * 100,
      day_change: p?.change == null ? null : h.shares * p.change,
      weight_pct: weight,
      flags: {
        over_cap: weight != null && weight > settings.max_position_pct,
        below_cost: px != null && px <= h.avg_cost * (1 - settings.drop_alert_pct / 100),
        big_move: p?.change_pct != null && Math.abs(p.change_pct) >= rules.holding.big_move_pct,
      },
    };
  });

  const totalCost = priced.reduce((s, h) => s + h.shares * h.avg_cost, 0);
  const sectorWeights = [...bySector.entries()]
    .map(([sector, v]) => ({ sector, pct: total > 0 ? (v / total) * 100 : 0 }))
    .sort((a, b) => b.pct - a.pct);

  return {
    rows: rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
    total_value: total,
    total_cost: totalCost,
    total_pnl: total - totalCost,
    total_pnl_pct: totalCost > 0 ? ((total - totalCost) / totalCost) * 100 : null,
    day_change: dayChange,
    sector_weights: sectorWeights,
    sectors_over_limit: sectorWeights.filter((s) => s.pct > rules.holding.sector_limit_pct).map((s) => s.sector),
    missing_prices: holdings.filter((h) => prices[h.symbol]?.price == null).map((h) => h.symbol),
  };
}
