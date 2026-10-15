import type { AiInsight, DividendEvent, Holding, HoldingCallKind, Price, PriceMap, Rules, Settings } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { sectorLabel, rs2 } from './format.ts';
import { dividendCut, missingNum, peOutlier } from './quality.ts';

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
  sector_pct: number | null; // the holding's whole sector as a share of the portfolio
  ref_price: number; // last buy price, or average cost when no buy is recorded
  vs_ref_pct: number | null; // price vs last buy, % (negative = cheaper than you last paid)
  flags: { over_cap: boolean; over_sector: boolean; big_move: boolean };
  call: HoldingCall; // rules call; mergeCall() can swap in the AI's
}

export interface RebalanceTip { kind: 'position' | 'sector'; name: string; pct: number; limit: number; text: string }

export interface PortfolioView {
  rows: HoldingView[];
  sector_limit_pct: number; // the user's "max per sector"
  total_value: number;
  total_cost: number; // cost of holdings that have a price (so P/L compares like with like)
  total_pnl: number;
  total_pnl_pct: number | null;
  day_change: number | null;
  sector_weights: { sector: string; pct: number; value: number; count: number }[];
  sectors_over_limit: string[];
  missing_prices: string[];
  rebalance: RebalanceTip[];
}

/** symbol → PSX sector, from the market screen: covers listed stocks the worker has not priced for you yet. */
export type SectorMap = Record<string, string | null | undefined>;
export function screenSectors(screen: { symbol: string; sector: string | null }[]): SectorMap {
  return Object.fromEntries(screen.filter((r) => r.sector).map((r) => [r.symbol, r.sector]));
}
/** symbol → Shariah compliant (KMI All Share member), from the market screen. */
export function screenShariah(screen: { symbol: string; is_shariah: boolean | null }[]): Record<string, boolean | null | undefined> {
  return Object.fromEntries(screen.filter((r) => r.is_shariah != null).map((r) => [r.symbol, r.is_shariah]));
}

/** Typical (median) P/E per PSX sector from the KSE-100 screen, leaving out untrustworthy P/Es; needs 3 peers. */
export function sectorPeMap(screen: { sector: string | null; pe: number | null }[], rules: Rules = DEFAULT_RULES): Record<string, number> {
  const by = new Map<string, number[]>();
  for (const r of screen) if (r.sector && !missingNum(r.pe) && !peOutlier(r.pe, rules).outlier) by.set(r.sector, [...(by.get(r.sector) ?? []), r.pe as number]);
  const out: Record<string, number> = {};
  for (const [sector, xs] of by) {
    if (xs.length < 3) continue;
    const s = [...xs].sort((a, b) => a - b);
    out[sector] = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }
  return out;
}

/** What the trim and review rules need besides prices: today's date, sector P/Es and the dividend filings. */
export interface RuleContext { today?: string; sectorPe?: Record<string, number>; dividends?: DividendEvent[] }

/** PSX's own sector name (one taxonomy for everything): from the price row, else the screen, else what is stored. */
export function sectorOf(symbol: string, prices: PriceMap, fallback?: string | null, extra: SectorMap = {}): string {
  return prices[symbol]?.sector ?? extra[symbol] ?? fallback ?? 'Unknown';
}

export const refPrice = (h: Holding) => (h.last_buy_price && h.last_buy_price > 0 ? h.last_buy_price : h.avg_cost);

/** Why new money must not go to this holding (the user's own rules), or null if it may. */
export function addBlockedReason(h: Pick<Holding, 'status' | 'is_shariah'> | undefined, weightPct: number | null,
  settings: Pick<Settings, 'max_position_pct' | 'shariah_only'> & Partial<Pick<Settings, 'max_sector_pct'>>, sectorPct: number | null = null): string | null {
  if (!h) return null;
  if (h.status === 'hold_no_add') return 'you set it to hold, no add';
  if (h.status === 'review') return 'it is under review';
  if (weightPct != null && weightPct >= settings.max_position_pct) return `it is at your ${settings.max_position_pct}% cap`;
  if (sectorPct != null && settings.max_sector_pct != null && sectorPct >= settings.max_sector_pct) return `its sector is at your ${settings.max_sector_pct}% cap`;
  if (settings.shariah_only && !h.is_shariah) return 'it is not Shariah compliant';
  return null;
}

/** Short forms of addBlockedReason() for one-line labels. */
const SHORT: Record<string, string> = { 'you set it to hold, no add': 'hold only', 'it is under review': 'under review', 'it is not Shariah compliant': 'not Shariah' };
const shortReason = (r: string) => SHORT[r] ?? (r.includes('sector') ? 'sector at cap' : r.includes('cap') ? 'at cap' : r);

/** Sell and trim triggers (FEATURE-05), each a setting: over the stock cap, target price reached, P/E far above the sector, a dividend cut. */
export function trimReason(h: Holding, p: Price | null, weight: number | null, sector: string, settings: Settings, ctx: RuleContext): string | null {
  if (weight != null && weight > settings.max_position_pct) return `${weight.toFixed(1)}% of your portfolio, over your ${settings.max_position_pct}% cap`;
  const px = p?.price ?? null;
  if (h.target_price && px != null && px >= h.target_price) return `Reached your target price of ${rs2(h.target_price)}`;
  const sectorPe = ctx.sectorPe?.[sector];
  if (p && !missingNum(p.pe) && !peOutlier(p.pe).outlier && sectorPe && settings.trim_pe_over_sector_pct > 0) {
    const over = ((p.pe as number) / sectorPe - 1) * 100;
    if (over >= settings.trim_pe_over_sector_pct) return `P/E ${(p.pe as number).toFixed(1)} is ${over.toFixed(0)}% above its sector's ${sectorPe.toFixed(1)}`;
  }
  if (settings.trim_on_dividend_cut && ctx.dividends?.length) {
    const cut = dividendCut(h.symbol, ctx.dividends);
    if (cut.cut) return `Dividend cut: Rs ${cut.latest} vs Rs ${cut.previous} before`;
  }
  return null;
}

/** Why the thesis needs a look (FEATURE-04): the review date arrived, or the status says so. */
export function reviewReason(h: Holding, ctx: RuleContext): string | null {
  if (h.status === 'review') return 'Under review: decide before adding more';
  if (h.review_on && ctx.today && h.review_on <= ctx.today) return `Review date reached: re-check why you own it${h.thesis ? ` (${h.thesis})` : ''}`;
  return null;
}

function ruleCall(h: Holding, p: Price | null, weight: number | null, sectorPct: number | null, sector: string, vsRef: number | null, settings: Settings, rules: Rules, ctx: RuleContext): HoldingCall {
  const below = vsRef != null && vsRef < 0 ? Math.abs(vsRef) : 0;
  const blocked = addBlockedReason(h, weight, settings, sectorPct);
  const trim = trimReason(h, p, weight, sector, settings, ctx);
  if (trim) return { call: 'trim', text: trim, source: 'rules' };
  const review = reviewReason(h, ctx);
  if (review) return { call: 'review', text: review, source: 'rules' };
  if (below >= settings.drop_alert_pct && !blocked) {
    return { call: 'opportunity', text: `${below.toFixed(1)}% below your last buy`, source: 'rules' };
  }
  if (below >= rules.holding.average_down_pct && !blocked) {
    return { call: 'average_down', text: `${below.toFixed(1)}% below your last buy`, source: 'rules' };
  }
  if (below > 0) return { call: 'hold', text: `${below.toFixed(1)}% below your last buy${blocked ? ` · ${shortReason(blocked)}` : ''}`, source: 'rules' };
  return { call: 'hold', text: vsRef == null ? 'No live price yet' : `${vsRef.toFixed(1)}% above your last buy`, source: 'rules' };
}

/** Use the AI's call for a holding when it exists and doesn't break the user's own rules. */
export function mergeCall(row: HoldingView, ai: Pick<AiInsight, 'holding_calls'> | null, settings: Settings): HoldingCall {
  const c = ai?.holding_calls?.find((x) => x.symbol === row.holding.symbol);
  if (!c) return row.call;
  const adding = c.call === 'average_down' || c.call === 'opportunity';
  if (adding && addBlockedReason(row.holding, row.weight_pct, settings, row.sector_pct)) return row.call;
  if (row.call.call === 'trim' || row.call.call === 'review') return row.call; // your own sell, trim and review rules come first
  return { call: c.call, text: c.text, source: 'ai' };
}

export function buildPortfolio(holdings: Holding[], prices: PriceMap, settings: Settings,
  rules: Rules = DEFAULT_RULES, sectors: SectorMap = {}, ctx: RuleContext = {}): PortfolioView {
  const priced = holdings.filter((h) => prices[h.symbol]?.price != null);
  const total = priced.reduce((s, h) => s + h.shares * (prices[h.symbol].price as number), 0);
  const sectorLimit = settings.max_sector_pct ?? rules.holding.sector_limit_pct;
  const bySector = new Map<string, { value: number; count: number }>();
  for (const h of holdings) {
    const sector = sectorOf(h.symbol, prices, h.sector, sectors);
    const px = prices[h.symbol]?.price ?? null;
    const agg = bySector.get(sector) ?? { value: 0, count: 0 };
    bySector.set(sector, { value: agg.value + (px == null ? 0 : h.shares * px), count: agg.count + 1 });
  }
  const sectorPctOf = (sector: string) => (total > 0 ? ((bySector.get(sector)?.value ?? 0) / total) * 100 : null);
  let dayChange: number | null = null;

  const rows: HoldingView[] = holdings.map((h) => {
    const p = prices[h.symbol] ?? null;
    const px = p?.price ?? null;
    const sector = sectorOf(h.symbol, prices, h.sector, sectors);
    const value = px == null ? null : h.shares * px;
    const cost = h.shares * h.avg_cost;
    if (p?.change != null) dayChange = (dayChange ?? 0) + h.shares * p.change;
    const weight = value != null && total > 0 ? (value / total) * 100 : null;
    const sectorPct = value == null ? null : sectorPctOf(sector);
    const ref = refPrice(h);
    const vsRef = px == null || ref <= 0 ? null : ((px - ref) / ref) * 100;
    return {
      holding: h, price: p, sector, value, cost,
      pnl: value == null ? null : value - cost,
      pnl_pct: value == null || cost === 0 ? null : ((value - cost) / cost) * 100,
      day_change: p?.change == null ? null : h.shares * p.change,
      weight_pct: weight,
      sector_pct: sectorPct,
      ref_price: ref,
      vs_ref_pct: vsRef,
      flags: {
        over_cap: weight != null && weight > settings.max_position_pct,
        over_sector: sectorPct != null && sectorPct > sectorLimit,
        big_move: p?.change_pct != null && Math.abs(p.change_pct) >= rules.holding.big_move_pct,
      },
      call: ruleCall(h, p, weight, sectorPct, sector, vsRef, settings, rules, ctx),
    };
  });

  const totalCost = priced.reduce((s, h) => s + h.shares * h.avg_cost, 0);
  const sectorWeights = [...bySector.entries()]
    .map(([sector, v]) => ({ sector, pct: total > 0 ? (v.value / total) * 100 : 0, value: v.value, count: v.count }))
    .sort((a, b) => b.pct - a.pct || a.sector.localeCompare(b.sector));
  const overLimit = sectorWeights.filter((s) => s.pct > sectorLimit);
  const rebalance: RebalanceTip[] = [
    ...rows.filter((r) => r.flags.over_cap).map((r) => ({
      kind: 'position' as const, name: r.holding.symbol, pct: r.weight_pct!, limit: settings.max_position_pct,
      text: `${r.holding.symbol} is ${r.weight_pct!.toFixed(0)}% of your money (cap ${settings.max_position_pct}%). Pause buying it; new money elsewhere brings it back down.`,
    })),
    ...overLimit.map((s) => ({
      kind: 'sector' as const, name: s.sector, pct: s.pct, limit: sectorLimit,
      text: `${sectorLabel(s.sector)} is ${s.pct.toFixed(0)}% of your money (your sector cap is ${sectorLimit}%). Put this month's cash into other sectors.`,
    })),
  ];

  return {
    rows: rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
    sector_limit_pct: sectorLimit,
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

export interface Slice { label: string; value: number; pct: number }

/** Sector slices for the Home donut: biggest first, at most `max`, the rest grouped as "Other". */
export function sectorSlices(view: PortfolioView, max = 6): Slice[] {
  const ws = view.sector_weights.filter((w) => w.value > 0);
  const top = ws.slice(0, ws.length > max ? max - 1 : max).map((w) => ({ label: sectorLabel(w.sector), value: w.value, pct: w.pct }));
  const rest = ws.slice(top.length);
  if (rest.length) {
    const value = rest.reduce((a, w) => a + w.value, 0);
    top.push({ label: `Other (${rest.length})`, value, pct: view.total_value > 0 ? (value / view.total_value) * 100 : 0 });
  }
  return top;
}

export interface SectorGroup {
  sector: string;
  label: string;
  value: number;
  pct: number; // of the whole portfolio
  count: number;
  rows: (HoldingView & { sector_pct: number | null })[]; // biggest first; sector_pct = share of this sector
}

/** Every sector with its stocks, biggest first, for the full breakdown view. */
export function sectorBreakdown(view: PortfolioView): SectorGroup[] {
  const groups = new Map<string, HoldingView[]>();
  for (const r of view.rows) groups.set(r.sector, [...(groups.get(r.sector) ?? []), r]);
  return [...groups.entries()].map(([sector, rows]) => {
    const value = rows.reduce((a, r) => a + (r.value ?? 0), 0);
    return {
      sector, label: sectorLabel(sector), value, count: rows.length,
      pct: view.total_value > 0 ? (value / view.total_value) * 100 : 0,
      rows: [...rows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
        .map((r) => ({ ...r, sector_pct: r.value != null && value > 0 ? (r.value / value) * 100 : null })),
    };
  }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** Per-stock slices (used by tests and the breakdown): biggest first, at most `max`, the rest grouped as "Other". */
export function allocationSlices(view: PortfolioView, max = 6): Slice[] {
  const priced = view.rows.filter((r) => r.value != null && r.value > 0);
  const top = priced.slice(0, priced.length > max ? max - 1 : max).map((r) => ({ label: r.holding.symbol, value: r.value!, pct: r.weight_pct! }));
  const rest = priced.slice(top.length);
  if (rest.length) {
    const value = rest.reduce((a, r) => a + r.value!, 0);
    top.push({ label: `Other (${rest.length})`, value, pct: view.total_value > 0 ? (value / view.total_value) * 100 : 0 });
  }
  return top;
}
