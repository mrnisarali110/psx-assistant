/** Rules-based opportunity screen over KSE-100 stocks (dividend yield + valuation). Used by app and worker. */
import type { Rules } from './types.ts';
import { DEFAULT_RULES } from './types.ts';

export interface ScreenRow {
  symbol: string;
  sector: string | null;
  price: number | null;
  change_pct: number | null;
  pe: number | null;
  dividend_yield_pct: number | null;
  market_cap: number | null;
  is_shariah: boolean | null;
}

export interface Opportunity extends ScreenRow { score: number; reason: string }

export function findOpportunities(screen: ScreenRow[], exclude: Set<string>, shariahOnly: boolean,
  rules: Rules = DEFAULT_RULES): Opportunity[] {
  const o = rules.opportunities;
  return screen
    .filter((r) => !exclude.has(r.symbol) && r.price != null && r.dividend_yield_pct != null && r.pe != null
      && r.dividend_yield_pct >= o.min_dividend_yield_pct && r.pe > 0 && r.pe <= o.max_pe
      && (!shariahOnly || r.is_shariah === true))
    .map((r) => ({
      ...r,
      score: (r.dividend_yield_pct as number) + (o.max_pe - (r.pe as number)) * 0.3,
      reason: `${(r.dividend_yield_pct as number).toFixed(1)}% dividend yield, P/E ${(r.pe as number).toFixed(1)}`,
    }))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, o.picks);
}
