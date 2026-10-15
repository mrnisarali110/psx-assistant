/**
 * Allocation tab: where the money is. By sector (the donut, with any sector over your limit called out) and
 * per stock (one bar per holding against your position cap, biggest first). Tap a stock for its details;
 * "Show more" opens the full sector breakdown. Colour is never the only cue: every bar has its number and
 * anything over a limit carries a label.
 */
import { useMemo, useState } from 'react';
import { sectorSlices, type PortfolioView } from '../../shared/portfolio.ts';
import { rs, sectorLabel } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import type { BcState } from '../../shared/bluechip.ts';
import { blueChipShare } from './BcBadge.tsx';
import { BreakdownSheet } from './Breakdown.tsx';
import { Donut } from './Donut.tsx';
import { Icon } from './Icon.tsx';
import { Button, Card, Empty, Section, SymbolAvatar, Tag } from './ui.tsx';

export function AllocationTab({ view, maxPositionPct, onOpenStock, bc = {} }: { view: PortfolioView; maxPositionPct: number; onOpenStock: (symbol: string) => void; bc?: Record<string, BcState> }) {
  const blue = blueChipShare(view.rows, bc, view.total_value);
  const [more, setMore] = useState(false);
  const slices = useMemo(() => sectorSlices(view), [view]);
  const limit = view.sector_limit_pct;
  const overSectors = view.sector_weights.filter((w) => w.pct > limit);
  const sectorCount = view.sector_weights.filter((w) => w.value > 0).length;

  // Plain percentage scale: the track is the whole portfolio (100%), each fill is the stock's weight and the
  // marker sits at the cap, so a bar that reaches the marker is exactly at the cap. The number beside each
  // bar is the same figure.
  const capPos = Math.min(100, Math.max(0, maxPositionPct));
  const capShift = capPos > 80 ? 'translateX(-100%)' : capPos < 20 ? 'translateX(0)' : 'translateX(-50%)';

  if (view.rows.length === 0) {
    return (
      <Empty title="No holdings yet">
        <p>Add your holdings on the Portfolio tab and the split by sector and by stock appears here.</p>
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        {slices.length > 0 ? (
          <Donut slices={slices} total={view.total_value} caption={`${sectorCount} sector${sectorCount === 1 ? '' : 's'}`} />
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">No prices yet. The split by sector appears after the next market check.</p>
        )}
        {overSectors.length > 0 && (
          <ul className="mt-3 space-y-1.5" aria-label={`Sectors over your ${limit}% limit`}>
            {overSectors.map((w) => (
              <li key={w.sector} className="flex items-center gap-2 text-sm">
                <Tag tone="amber">over {limit}%</Tag>
                <span className="min-w-0 flex-1 truncate font-medium">{sectorLabel(w.sector)}</span>
                <span className="num shrink-0 text-slate-500 dark:text-slate-400">{w.pct.toFixed(0)}% · {rs(w.value)}</span>
              </li>
            ))}
          </ul>
        )}
        <Button kind="ghost" className="mt-2 w-full" onClick={() => setMore(true)}>Show more<Icon name="chevron" className="h-4 w-4" /></Button>
      </Card>

      <Section title="Per stock">
        <div className="space-y-1">
          {/* The cap label sits once above the list, aligned with the marker in every bar below it. */}
          <div className="flex items-end gap-3 px-1">
            <span className="w-10 shrink-0" aria-hidden="true" />
            <div className="relative h-6 flex-1">
              <span className="absolute bottom-0 flex flex-col items-center text-[11px] font-medium whitespace-nowrap text-slate-500 dark:text-slate-400"
                style={{ left: `${capPos}%`, transform: capShift }}>
                cap {maxPositionPct}%
                <span className="mt-0.5 h-1.5 w-0.5 rounded-full bg-slate-400 dark:bg-slate-500" aria-hidden="true" />
              </span>
            </div>
          </div>
          <ul className="space-y-1">
            {view.rows.map((r) => {
              const symbol = r.holding.symbol;
              const w = r.weight_pct;
              const over = r.flags.over_cap;
              return (
                <li key={r.holding.id ?? symbol}>
                  <button type="button" onClick={() => { haptic(); onOpenStock(symbol); }}
                    className="flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-2xl px-1 py-1.5 text-left transition active:bg-slate-100 dark:active:bg-slate-800">
                    <SymbolAvatar symbol={symbol} change={r.price?.change_pct} size="h-10 w-10" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-semibold">{symbol}</span>
                        {over && <Tag tone="amber">over cap</Tag>}
                        {w != null && <span className="num ml-auto shrink-0 text-xs text-slate-500 dark:text-slate-400">{rs(r.value)}</span>}
                        <span className={`num shrink-0 text-base font-bold ${w == null ? 'ml-auto text-slate-500 dark:text-slate-400' : over ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                          {w == null ? 'n/a' : `${w.toFixed(1)}%`}
                        </span>
                      </span>
                      {w == null ? (
                        <span className="block text-xs text-slate-500 dark:text-slate-400">no price yet</span>
                      ) : (
                        <span className="relative mt-2 block h-2 rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden="true">
                          <span className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${over ? 'bg-amber-500' : 'bg-teal-600 dark:bg-teal-500'}`}
                            style={{ width: `${Math.min(100, Math.max(0, w))}%` }} />
                          <span className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-slate-400 dark:bg-slate-500" style={{ left: `${capPos}%`, transform: 'translateX(-50%)' }} />
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </Section>

      <p className="num px-1 text-sm font-medium">
        Blue chips: {blue.pct == null ? 'n/a' : `${blue.pct.toFixed(0)}% of my portfolio`}
        {blue.unchecked > 0 && <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">{blue.unchecked} holding{blue.unchecked === 1 ? '' : 's'} not checked yet or without enough data</span>}
      </p>
      <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
        New money goes where it keeps every stock under {maxPositionPct}% and every sector under {limit}%.
      </p>

      <BreakdownSheet open={more} onClose={() => setMore(false)} view={view} onOpenStock={(s) => { setMore(false); onOpenStock(s); }} />
    </div>
  );
}
