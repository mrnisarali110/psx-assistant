/**
 * Monthly allocation (spec section 7): turn a cash amount into dated tranches of
 * symbol / rupees / whole shares / reason. Pure function; the AI never decides numbers.
 */
import type { Holding, PriceMap, Rules, Settings, WatchItem } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { sectorOf } from './portfolio.ts';
import { addDays } from './time.ts';

export interface PlanItem {
  symbol: string;
  kind: 'average_down' | 'watchlist';
  price: number;
  shares: number;
  rupees: number;
  reason: string;
}

export interface PlanTranche {
  index: number; // 1-based
  date: string; // YYYY-MM-DD, moved off weekends
  pct: number;
  budget: number; // this tranche's share of the amount
  available: number; // budget plus leftovers carried in (buffer tranche only)
  items: PlanItem[];
  spent: number;
  leftover: number;
  is_buffer: boolean;
}

export interface Plan {
  amount: number;
  date: string;
  cap_pct: number;
  tranches: PlanTranche[];
  unallocated: number;
  weights_after: Record<string, number>; // percent, after every tranche is bought
  skipped: { symbol: string; reason: string }[];
  warnings: string[];
}

export interface AllocateInput {
  amount: number;
  holdings: Holding[];
  watchlist: WatchItem[];
  prices: PriceMap;
  settings: Settings;
  today: string; // YYYY-MM-DD (PKT)
  rules?: Rules;
}

const EPS = 1e-9;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** PSX trades Monday to Friday: push Saturday/Sunday dates to Monday. */
export function nextTradingDay(iso: string): string {
  const wd = new Date(iso + 'T00:00:00Z').getUTCDay();
  return wd === 6 ? addDays(iso, 2) : wd === 0 ? addDays(iso, 1) : iso;
}

export function allocate(input: AllocateInput): Plan {
  const rules = input.rules ?? DEFAULT_RULES;
  const { holdings, watchlist, prices, settings } = input;
  const cap = settings.max_position_pct / 100;
  const amount = Math.max(0, Math.floor(input.amount));
  const minOrder = rules.allocation.min_order_pkr;
  const warnings: string[] = [];
  const skipped: Plan['skipped'] = [];

  const held = new Map(holdings.map((h) => [h.symbol, h]));
  const px = (s: string) => prices[s]?.price ?? null;
  const value: Record<string, number> = {};
  for (const h of holdings) {
    const p = px(h.symbol);
    if (p == null) warnings.push(`${h.symbol}: no live price, left out of weights. Check it in your broker app.`);
    else value[h.symbol] = h.shares * p;
  }
  let total = Object.values(value).reduce((a, b) => a + b, 0);

  const weight = (s: string) => (total > 0 ? (value[s] ?? 0) / total : 0);
  const sectorKey = (s: string) => sectorOf(s, prices, held.get(s)?.sector);
  const sectorWeight = (sector: string) =>
    total > 0 ? Object.entries(value).filter(([s]) => sectorKey(s) === sector).reduce((a, [, v]) => a + v, 0) / total : 0;
  /** Most rupees we can add to `s` so that (v + x) / (total + x) <= cap. */
  const headroom = (s: string) => (cap >= 1 ? Infinity : Math.max(0, (cap * total - (value[s] ?? 0)) / (1 - cap)));
  const shariahOk = (s: string) => !settings.shariah_only || (held.get(s)?.is_shariah ?? prices[s]?.is_shariah) === true;

  // ---- who is eligible at all (explained to the user) ------------------
  for (const h of holdings) {
    if (h.status === 'hold_no_add') skipped.push({ symbol: h.symbol, reason: 'Hold, no new money' });
    else if (h.status === 'review') skipped.push({ symbol: h.symbol, reason: 'Under review, no new money' });
    else if (!shariahOk(h.symbol)) skipped.push({ symbol: h.symbol, reason: 'Not Shariah compliant (Shariah only is on)' });
    else if (px(h.symbol) != null && (px(h.symbol) as number) >= h.avg_cost)
      skipped.push({ symbol: h.symbol, reason: 'Above your average cost, nothing to average down' });
  }
  for (const w of watchlist) {
    const h = held.get(w.symbol);
    if (h && h.status !== 'core') continue; // already explained above
    if (px(w.symbol) == null) skipped.push({ symbol: w.symbol, reason: 'No live price' });
    else if (!shariahOk(w.symbol)) skipped.push({ symbol: w.symbol, reason: 'Not confirmed Shariah compliant (Shariah only is on)' });
  }

  const avgDownCandidates = () =>
    holdings.filter((h) => {
      const p = px(h.symbol);
      return h.status === 'core' && p != null && p < h.avg_cost && shariahOk(h.symbol) && weight(h.symbol) < cap - EPS;
    });

  const watchCandidates = () => {
    const scored = watchlist
      .filter((w) => {
        const h = held.get(w.symbol);
        return px(w.symbol) != null && (!h || h.status === 'core') && shariahOk(w.symbol) && weight(w.symbol) < cap - EPS;
      })
      .map((w) => {
        const p = prices[w.symbol];
        const dy = p.dividend_yield_pct ?? 0;
        const below = p.high_52w && p.price ? Math.max(0, ((p.high_52w - p.price) / p.high_52w) * 100) : 0;
        const sector = sectorKey(w.symbol);
        const underweight = sectorWeight(sector) * 100 < rules.allocation.underweight_sector_pct;
        const sc = rules.allocation.score;
        const score = dy * sc.dividend_yield + below * sc.below_52w_high + (underweight ? sc.underweight_sector_bonus : 0);
        const reasonParts = [
          p.dividend_yield_pct != null ? `${dy.toFixed(1)}% dividend yield` : 'dividend yield unknown',
          `${below.toFixed(0)}% below its 52-week high`,
        ];
        if (underweight) reasonParts.push(`adds to an underweight sector (${titleCase(sector)})`);
        return { symbol: w.symbol, score, reason: `Watchlist pick: ${reasonParts.join(', ')}` };
      })
      .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    return scored.slice(0, rules.allocation.watchlist_picks);
  };

  /** Buy whole shares of `symbol` worth up to `target`, within the cap. Returns rupees spent. */
  const buy = (items: PlanItem[], symbol: string, target: number, kind: PlanItem['kind'], reason: string): number => {
    const p = px(symbol);
    if (p == null || target < minOrder) return 0;
    const room = headroom(symbol);
    const shares = Math.floor(Math.min(target, room) / p + EPS);
    if (shares <= 0) return 0;
    const cost = r2(shares * p);
    if (cost < minOrder) return 0;
    value[symbol] = (value[symbol] ?? 0) + cost;
    total += cost;
    const capped = room < target;
    const existing = items.find((i) => i.symbol === symbol);
    if (existing) {
      existing.shares += shares;
      existing.rupees = r2(existing.rupees + cost);
    } else {
      items.push({
        symbol, kind, price: p, shares, rupees: cost,
        reason: capped ? `${reason}; capped to keep it at or below ${settings.max_position_pct}% of the portfolio` : reason,
      });
    }
    return cost;
  };

  /** Spread `pool` over candidates by weight; re-spread what capped names could not take. */
  const spread = (items: PlanItem[], pool: number, cands: { symbol: string; w: number; reason: string; kind: PlanItem['kind'] }[]) => {
    let spent = 0;
    let active = cands.filter((c) => c.w > 0);
    for (let round = 0; round < 4 && active.length; round++) {
      const remaining = pool - spent;
      if (remaining < minOrder) break;
      const sumW = active.reduce((a, c) => a + c.w, 0);
      const next: typeof active = [];
      let progressed = false;
      for (const c of active) {
        const target = (remaining * c.w) / sumW;
        const before = headroom(c.symbol);
        const got = buy(items, c.symbol, target, c.kind, c.reason);
        spent += got;
        if (got > 0) progressed = true;
        if (before > target && got > 0) next.push(c); // still has room for more
      }
      if (!progressed) break;
      active = next;
    }
    return spent;
  };

  // ---- tranches ---------------------------------------------------------
  const split = settings.tranche_split.length ? settings.tranche_split : [{ pct: 100, after_days: 0 }];
  const pctSum = split.reduce((a, t) => a + t.pct, 0) || 100;
  let assigned = 0;
  let carry = 0;
  const tranches: PlanTranche[] = split.map((t, i) => {
    const isLast = i === split.length - 1;
    const budget = isLast ? amount - assigned : Math.floor((amount * t.pct) / pctSum);
    assigned += budget;
    return {
      index: i + 1, date: nextTradingDay(addDays(input.today, t.after_days)), pct: t.pct, budget,
      available: budget, items: [], spent: 0, leftover: 0, is_buffer: isLast && split.length > 1,
    };
  });

  for (const tr of tranches) {
    if (tr.is_buffer || tr.index === tranches.length) {
      tr.available = tr.budget + carry;
      carry = 0;
    }
    const avgCands = avgDownCandidates().map((h) => {
      const p = px(h.symbol) as number;
      const d = (h.avg_cost - p) / h.avg_cost;
      return {
        symbol: h.symbol, w: d, kind: 'average_down' as const,
        reason: `Core holding ${(d * 100).toFixed(1)}% below your average cost of Rs ${h.avg_cost.toFixed(2)}`,
      };
    });
    const watch = watchCandidates().map((c) => ({ symbol: c.symbol, w: 1, kind: 'watchlist' as const, reason: c.reason }));

    const avgPool = watch.length ? tr.available * rules.allocation.avg_down_share : tr.available;
    let spent = avgCands.length ? spread(tr.items, avgPool, avgCands) : 0;
    // Whatever averaging-down could not use goes to the watchlist half, and the reverse.
    spent += spread(tr.items, tr.available - spent, watch);
    if (tr.available - spent >= minOrder) spent += spread(tr.items, tr.available - spent, avgDownCandidates().length ? avgCands : []);

    tr.spent = r2(spent);
    tr.leftover = r2(tr.available - spent);
    if (tr.index < tranches.length) carry += tr.leftover; // leftover rupees move to the buffer
  }

  const unallocated = tranches.length ? tranches[tranches.length - 1].leftover : amount;
  const weightsAfter = Object.fromEntries(Object.keys(value).map((s) => [s, total > 0 ? (value[s] / total) * 100 : 0]));
  if (!avgDownCandidates().length && !watchCandidates().length && amount > 0)
    warnings.push('Nothing eligible to buy: add watchlist names or core holdings below cost.');
  const sectorsAfter = new Set(Object.keys(value).map(sectorKey));
  for (const sector of sectorsAfter) {
    const w = sectorWeight(sector) * 100;
    if (w > rules.holding.sector_limit_pct)
      warnings.push(`${titleCase(sector)} would be ${w.toFixed(0)}% of the portfolio, above the ${rules.holding.sector_limit_pct}% sector limit. Consider trimming that line.`);
  }

  return {
    amount, date: input.today, cap_pct: settings.max_position_pct, tranches, unallocated,
    weights_after: weightsAfter, skipped, warnings,
  };
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Plain-text plan for the clipboard and for notifications. */
export function planToText(plan: Plan): string {
  const lines = [`Plan for Rs ${plan.amount.toLocaleString('en-PK')} (cap ${plan.cap_pct}% per stock)`];
  for (const t of plan.tranches) {
    lines.push('', `Tranche ${t.index}${t.is_buffer ? ' (buffer)' : ''} on ${t.date}: Rs ${Math.round(t.available).toLocaleString('en-PK')}`);
    if (!t.items.length) lines.push('  nothing to buy');
    for (const i of t.items) lines.push(`  ${i.symbol}: ${i.shares} shares @ ~Rs ${i.price.toFixed(2)} = Rs ${Math.round(i.rupees).toLocaleString('en-PK')}  (${i.reason})`);
    if (t.leftover >= 1) lines.push(`  leftover Rs ${Math.round(t.leftover).toLocaleString('en-PK')}${t.index < plan.tranches.length ? ' moves to the buffer' : ' stays as cash'}`);
  }
  lines.push('', 'Not licensed financial advice. Check live prices in your broker app before ordering.');
  return lines.join('\n');
}
