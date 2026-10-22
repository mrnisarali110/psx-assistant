/**
 * Full breakdown of where the money is: every sector (bar + share of the portfolio, flagged when over the
 * sector limit) and, inside each, its stocks with value, share of the sector and profit/loss against your average
 * cost. Sectors come from PSX's own classification, so nothing here is typed by hand. Tap a stock for its page.
 */
import { useMemo, useState } from 'react';
import { sectorBreakdown, type PortfolioView } from '../../shared/portfolio.ts';
import { rs } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { SLICE_COLORS } from './Donut.tsx';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Change, Chip, CompanyMark } from './ui.tsx';

export function BreakdownSheet({ open, onClose, view, onOpenStock }: {
  open: boolean; onClose: () => void; view: PortfolioView; onOpenStock: (symbol: string) => void;
}) {
  const groups = useMemo(() => sectorBreakdown(view), [view]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const limit = view.sector_limit_pct;
  const toggle = (sector: string) => {
    haptic();
    setCollapsed((c) => { const n = new Set(c); if (n.has(sector)) n.delete(sector); else n.add(sector); return n; });
  };

  return (
    <Sheet open={open} onClose={onClose} title="Where your money is">
      <div className="space-y-3 pb-2">
        <p className="text-14 text-muted">
          {rs(view.total_value)} in {groups.length} sector{groups.length === 1 ? '' : 's'} and {view.rows.length} stock{view.rows.length === 1 ? '' : 's'}.
          Sectors follow PSX's own classification. Your limit per sector is {limit}%.
        </p>
        <ul className="space-y-2.5">
          {groups.map((g, i) => {
            const isOpen = !collapsed.has(g.sector);
            const color = SLICE_COLORS[Math.min(i, SLICE_COLORS.length - 1)];
            const over = g.pct > limit;
            return (
              <li key={g.sector} className="rounded-control bg-surface-2 p-3">
                <button type="button" aria-expanded={isOpen} onClick={() => toggle(g.sector)} className="flex min-h-11 w-full cursor-pointer items-center gap-3 text-left">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2"><span className="truncate font-semibold">{g.label}</span>{over && <Chip kind="caution">Over {limit}%</Chip>}</span>
                    <span className="num block text-12 text-muted">{g.count} stock{g.count === 1 ? '' : 's'} · {rs(g.value)}</span>
                  </span>
                  <span className={`num text-20 font-bold ${over ? 'text-caution' : ''}`}>{g.pct.toFixed(0)}%</span>
                  <Icon name="chevron" className={`h-4 w-4 shrink-0 text-muted transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} />
                </button>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, g.pct)}%`, background: color }} />
                </div>
                {isOpen && (
                  <ul className="mt-1 divide-y divide-line">
                    {g.rows.map((r) => (
                      <li key={r.holding.symbol}>
                        <button type="button" onClick={() => { haptic(); onOpenStock(r.holding.symbol); }} className="press flex min-h-12 w-full cursor-pointer items-center gap-3 py-1.5 text-left">
                          <CompanyMark symbol={r.holding.symbol} sector={r.sector} size="h-9 w-9" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-1.5"><span className="font-medium">{r.holding.symbol}</span><span className="num text-12 text-muted">{r.holding.shares} shares</span></span>
                            <span className="num block truncate text-12 text-muted">
                              {r.sector_pct == null ? 'no price yet' : `${r.sector_pct.toFixed(0)}% of this sector · ${r.weight_pct!.toFixed(1)}% of all`}
                            </span>
                          </span>
                          <span className="num shrink-0 text-right">
                            <span className="block font-semibold">{rs(r.value)}</span>
                            <span className="block text-12"><Change value={r.pnl_pct} label="profit or loss vs average cost" className="font-medium" /> <span className="text-muted">vs avg cost</span></span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {!groups.length && <li className="py-4 text-center text-14 text-muted">No holdings yet.</li>}
        </ul>
      </div>
    </Sheet>
  );
}
