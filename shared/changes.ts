/**
 * Holding changes → transactions. One code path for manual edits, "record buy" and screenshot import,
 * so "invested this month" and "x% below your last buy" stay consistent however the change came in.
 */
import type { Holding, Price, PriceMap, Txn } from './types.ts';
import { rs2 } from './format.ts';

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * What changed between two versions of a holding, as one transaction (or null for a correction that
 * only edits the average cost). For added shares the buy price is implied from the cost-basis change.
 */
export function txnFromChange(before: Holding | undefined, after: Holding | null, today: string,
  marketPrice: number | null | undefined, source: Txn['source']): Txn | null {
  const symbol = (after ?? before)?.symbol;
  if (!symbol) return null;
  const was = before?.shares ?? 0;
  const now = after?.shares ?? 0;
  if (now === was) return null;
  if (now > was) {
    const delta = now - was;
    const added = (after!.shares * after!.avg_cost) - (was * (before?.avg_cost ?? 0));
    const implied = added / delta;
    const price = r2(Number.isFinite(implied) && implied > 0 ? implied : after!.avg_cost);
    return { symbol, side: 'buy', shares: delta, price, amount: r2(delta * price), executed_on: today, source };
  }
  const delta = was - now;
  const price = r2(marketPrice ?? before!.avg_cost);
  return { symbol, side: 'sell', shares: delta, price, amount: r2(delta * price), executed_on: today, source };
}

/** Holding after a change, with the last-buy price kept current when shares were bought. */
export function withLastBuy(after: Holding, txn: Txn | null): Holding {
  return txn?.side === 'buy' ? { ...after, last_buy_price: txn.price, last_buy_on: txn.executed_on } : after;
}

/** Add a fill to a holding (weighted average cost), or start a new core holding. */
export function applyBuy(existing: Holding | undefined, symbol: string, shares: number, price: number, p?: Price | null): Holding {
  if (!Number.isInteger(shares) || shares <= 0) throw new Error('Shares must be a whole number above 0');
  if (!(price > 0)) throw new Error('Price must be above 0');
  if (existing) {
    const total = existing.shares + shares;
    return { ...existing, shares: total, avg_cost: r2((existing.shares * existing.avg_cost + shares * price) / total) };
  }
  return { symbol, shares, avg_cost: r2(price), status: 'core', sector: p?.sector ?? null, is_shariah: p?.is_shariah ?? false, note: null };
}

/** Rupees put into buys this calendar month (PKT). */
export function investedThisMonth(txns: Txn[], today: string): number {
  const month = today.slice(0, 7);
  return r2(txns.filter((t) => t.side === 'buy' && t.executed_on.slice(0, 7) === month).reduce((a, t) => a + t.amount, 0));
}

// ---------------------------------------------------------------------------
// Screenshot import
// ---------------------------------------------------------------------------
export interface ImportedRow { symbol: string; shares: number; avg_cost: number }

export interface ImportChange {
  symbol: string;
  kind: 'new' | 'changed' | 'same' | 'missing';
  before?: Holding;
  after: Holding | null; // null = remove
  txn: Txn | null;
}

/** Clean what the AI read: valid symbols, whole share counts, positive costs, one row per symbol. */
export function cleanImported(rows: unknown[]): { rows: ImportedRow[]; dropped: string[] } {
  const out = new Map<string, ImportedRow>();
  const dropped: string[] = [];
  for (const r of rows as any[]) {
    const symbol = String(r?.symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const shares = Number(String(r?.shares ?? r?.quantity ?? '').replace(/,/g, ''));
    const avg = Number(String(r?.avg_cost ?? '').replace(/[,Rs\s]/g, ''));
    if (!/^[A-Z0-9]{1,12}$/.test(symbol) || !Number.isInteger(shares) || shares <= 0 || !(avg > 0)) {
      dropped.push(symbol || '(unreadable row)');
      continue;
    }
    out.set(symbol, { symbol, shares, avg_cost: r2(avg) }); // a repeated row (overlapping screenshots) wins once
  }
  return { rows: [...out.values()], dropped };
}

/**
 * Compare a screenshot import with current holdings. With recordTxns off (e.g. the very first import of
 * an existing portfolio), nothing counts as bought or sold this month.
 */
export function diffImport(current: Holding[], imported: ImportedRow[], today: string, prices: PriceMap,
  opts: { removeMissing: boolean; recordTxns: boolean; sectors?: Record<string, string | null | undefined>; shariah?: Record<string, boolean | null | undefined> }): ImportChange[] {
  const { removeMissing, recordTxns } = opts;
  const track = (t: Txn | null) => (recordTxns ? t : null);
  const byS = new Map(current.map((h) => [h.symbol, h]));
  const changes: ImportChange[] = imported.map((row) => {
    const before = byS.get(row.symbol);
    if (!before) {
      const p = prices[row.symbol];
      // Filed under PSX's sector and Shariah status straight away (price row, else the market screen); never asked of the user.
      const after: Holding = { symbol: row.symbol, shares: row.shares, avg_cost: row.avg_cost, status: 'core', sector: p?.sector ?? opts.sectors?.[row.symbol] ?? null, is_shariah: p?.is_shariah ?? opts.shariah?.[row.symbol] ?? false, note: null };
      const txn = track(txnFromChange(undefined, after, today, p?.price, 'import'));
      return { symbol: row.symbol, kind: 'new', after: withLastBuy(after, txn), txn };
    }
    const same = before.shares === row.shares && Math.abs(before.avg_cost - row.avg_cost) < 0.01;
    const after = { ...before, shares: row.shares, avg_cost: row.avg_cost };
    const txn = same ? null : track(txnFromChange(before, after, today, prices[row.symbol]?.price, 'import'));
    return { symbol: row.symbol, kind: same ? 'same' : 'changed', before, after: withLastBuy(after, txn), txn };
  });
  const seen = new Set(imported.map((r) => r.symbol));
  for (const h of current) {
    if (seen.has(h.symbol)) continue;
    changes.push({
      symbol: h.symbol, kind: 'missing', before: h,
      after: removeMissing ? null : h,
      txn: removeMissing ? track(txnFromChange(h, null, today, prices[h.symbol]?.price, 'import')) : null,
    });
  }
  const order = { new: 0, changed: 1, missing: 2, same: 3 };
  return changes.sort((a, b) => order[a.kind] - order[b.kind] || a.symbol.localeCompare(b.symbol));
}

/** One line in plain words for a change in the review list. For a missing holding, apply = "sold all". */
export function describeChange(c: ImportChange, apply = true): string {
  if (c.kind === 'new') return `${c.after!.shares} shares at ${rs2(c.after!.avg_cost)} average`;
  if (c.kind === 'missing') {
    return apply ? `Sold all ${c.before!.shares} shares${c.txn ? ` at ${rs2(c.txn.price)}` : ''}` : `${c.before!.shares} shares kept; not in these screenshots`;
  }
  if (c.kind === 'same') return 'Unchanged';
  const b = c.before!, a = c.after!;
  if (a.shares > b.shares) return `${b.shares} → ${a.shares} shares · bought ${a.shares - b.shares} more${c.txn ? ` at about ${rs2(c.txn.price)}` : ''}`;
  if (a.shares < b.shares) return `${b.shares} → ${a.shares} shares · sold ${b.shares - a.shares}${c.txn ? ` at ${rs2(c.txn.price)}` : ''}`;
  return `Average cost ${rs2(b.avg_cost)} → ${rs2(a.avg_cost)}`;
}
