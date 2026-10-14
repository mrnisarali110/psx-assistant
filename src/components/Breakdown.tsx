/**
 * Full breakdown of where the money is: every sector (bar + share of the portfolio, flagged when over the
 * sector limit) and, inside each, its stocks with value, share of the sector and profit/loss. Sectors come
 * from PSX's own classification, so nothing here is typed by hand. Tap a stock for its details.
 */
import { useMemo, useState } from 'react';
import { sectorBreakdown, type PortfolioView } from '../../shared/portfolio.ts';
import { pct, rs } from '../../shared/format.ts';
import { DEFAULT_RULES } from '../../shared/types.ts';
import { haptic } from '../lib/gestures.ts';
import { SLICE_COLORS } from './Donut.tsx';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { SymbolAvatar, Tag, changeTone } from './ui.tsx';

export function BreakdownSheet({ open, onClose, view, onOpenStock }: {
  open: boolean; onClose: () => void; view: PortfolioView; onOpenStock: (symbol: string) => void;
}) {
  const groups = useMemo(() => sectorBreakdown(view), [view]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const limit = DEFAULT_RULES.holding.sector_limit_pct;
  const toggle = (sector: string) => {
    haptic();
    setCollapsed((c) => { const n = new Set(c); if (n.has(sector)) n.delete(sector); else n.add(sector); return n; });
  };

  return (
    <Sheet open={open} onClose={onClose} title="Where your money is">
      <div className="space-y-3 pb-2">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {rs(view.total_value)} in {groups.length} sector{groups.length === 1 ? '' : 's'} and {view.rows.length} stock{view.rows.length === 1 ? '' : 's'}.
          Sectors follow PSX's own classification. Your limit per sector is {limit}%.
        </p>
        <ul className="space-y-2.5">
          {groups.map((g, i) => {
            const isOpen = !collapsed.has(g.sector);
            const color = SLICE_COLORS[Math.min(i, SLICE_COLORS.length - 1)];
            const over = g.pct > limit;
            return (
              <li key={g.sector} className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/60">
                <button type="button" aria-expanded={isOpen} onClick={() => toggle(g.sector)} className="flex min-h-11 w-full cursor-pointer items-center gap-3 text-left">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2"><span className="truncate font-semibold">{g.label}</span>{over && <Tag tone="amber">over {limit}%</Tag>}</span>
                    <span className="num block text-xs text-slate-500 dark:text-slate-400">{g.count} stock{g.count === 1 ? '' : 's'} · {rs(g.value)}</span>
                  </span>
                  <span className={`num text-lg font-bold ${over ? 'text-amber-600 dark:text-amber-400' : ''}`}>{g.pct.toFixed(0)}%</span>
                  <Icon name="chevron" className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} />
                </button>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden="true">
                  <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, g.pct)}%`, background: color }} />
                </div>
                {isOpen && (
                  <ul className="mt-1 divide-y divide-slate-200/70 dark:divide-slate-700/70">
                    {g.rows.map((r) => (
                      <li key={r.holding.symbol}>
                        <button type="button" onClick={() => { haptic(); onOpenStock(r.holding.symbol); }} className="flex min-h-12 w-full cursor-pointer items-center gap-3 py-1.5 text-left">
                          <SymbolAvatar symbol={r.holding.symbol} change={r.price?.change_pct} size="h-9 w-9" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-1.5"><span className="font-medium">{r.holding.symbol}</span><span className="num text-xs text-slate-500 dark:text-slate-400">{r.holding.shares} shares</span></span>
                            <span className="num block truncate text-xs text-slate-500 dark:text-slate-400">
                              {r.sector_pct == null ? 'no price yet' : `${r.sector_pct.toFixed(0)}% of this sector · ${r.weight_pct!.toFixed(1)}% of all`}
                            </span>
                          </span>
                          <span className="num shrink-0 text-right">
                            <span className="block font-semibold">{rs(r.value)}</span>
                            <span className={`block text-xs font-medium ${changeTone(r.pnl_pct)}`}>{pct(r.pnl_pct)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {!groups.length && <li className="py-4 text-center text-sm text-slate-500">No holdings yet.</li>}
        </ul>
      </div>
    </Sheet>
  );
}
