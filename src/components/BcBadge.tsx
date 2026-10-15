/**
 * The blue-chip (BC) pill and its checklist. The state comes only from the worker's checks (shared/bluechip.ts);
 * nothing here decides it. Tapping the pill (or the status chip) opens the five checks with their real numbers,
 * sources and the date of the last check.
 */
import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { BcState } from '../../shared/bluechip.ts';
import { dateLabel } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';

const STATUS: Record<BcState['status'], { label: string; line: string }> = {
  bc: { label: 'BC', line: 'Blue chip: passes all five checks.' },
  at_risk: { label: 'BC at risk', line: 'Still a blue chip, but failed its last check. It loses the badge if the next check fails too.' },
  not_bc: { label: 'Not BC', line: 'Not a blue chip: higher risk.' },
  not_enough_data: { label: 'BC: not enough data', line: 'Not enough data yet to call it a blue chip. No badge until every check can be worked out.' },
};

/**
 * `mode`: "badge" shows only a real badge (BC / BC at risk); "status" also shows "Not BC" and "not enough data" as a
 * quiet chip (Discover, AI suggestions), and "not checked yet" when there is no state at all.
 */
export function BcBadge({ state, symbol, mode = 'badge' }: { state: BcState | undefined; symbol: string; mode?: 'badge' | 'status' }) {
  const [open, setOpen] = useState(false);
  if (!state && mode === 'badge') return null;
  if (state && !state.badge && mode === 'badge') return null;
  const s = state?.status;
  const cls = s === 'bc' ? 'bg-teal-700 text-white dark:bg-teal-500 dark:text-slate-950'
    : s === 'at_risk' ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-400 dark:bg-amber-950 dark:text-amber-200'
      : s === 'not_bc' ? 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
  const label = state ? STATUS[state.status].label : 'BC: not checked yet';
  const show = (e: MouseEvent | KeyboardEvent) => { e.stopPropagation(); e.preventDefault(); haptic(); if (state) setOpen(true); };
  return (
    <>
      {/* A span with button semantics: it often sits inside a row that is itself a button. */}
      <span role="button" tabIndex={0} aria-label={`${symbol}: ${label}${state ? ', show the checklist' : ''}`}
        onClick={show} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && show(e)}
        className={`relative inline-flex shrink-0 cursor-pointer items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-wide whitespace-nowrap after:absolute after:-inset-2.5 after:content-[''] ${cls}`}>
        {label}
      </span>
      {state && <BcSheet open={open} onClose={() => setOpen(false)} state={state} />}
    </>
  );
}

export function BcSheet({ open, onClose, state }: { open: boolean; onClose: () => void; state: BcState }) {
  return (
    <Sheet open={open} onClose={onClose} title={`${state.symbol} · blue-chip check`}>
      <div className="space-y-3 pb-2" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm">{STATUS[state.status].line}</p>
        {state.reason && state.status !== 'bc' && <p className="rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{state.reason}</p>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {state.checks.map((c) => (
            <li key={c.key} className="flex gap-3 py-2.5">
              <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${c.ok === true ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : c.ok === false ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}
                aria-label={c.ok === true ? 'passed' : c.ok === false ? 'failed' : 'not enough data'}>
                {c.ok === true ? <Icon name="check" className="h-4 w-4" /> : c.ok === false ? <Icon name="x" className="h-4 w-4" /> : <span className="text-xs font-bold">?</span>}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{c.label}</span>
                <span className="num block text-sm text-slate-600 dark:text-slate-300">{c.detail}</span>
                {c.source && <span className="block text-[11px] text-slate-500 dark:text-slate-400">Source: {c.source}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Last checked: {dateLabel(state.checked_on)}. Rechecked weekly (size, trading), after each results or dividend filing, when PSX changes the
          index members, and once a year after annual results. A BC stock loses the badge only after failing two checks in a row.
          Calculated from PSX data and filings only; the AI cannot set it.
        </p>
      </div>
    </Sheet>
  );
}

/** Share of the portfolio's value in holdings that carry the BC badge, and how many holdings have no state yet. */
export function blueChipShare(rows: { holding: { symbol: string }; value: number | null }[], bc: Record<string, BcState>, total: number): { pct: number | null; unchecked: number } {
  if (!(total > 0)) return { pct: null, unchecked: rows.length };
  const value = rows.reduce((a, r) => a + (bc[r.holding.symbol]?.badge && r.value ? r.value : 0), 0);
  return { pct: (value / total) * 100, unchecked: rows.filter((r) => !bc[r.holding.symbol] || bc[r.holding.symbol].status === 'not_enough_data').length };
}
