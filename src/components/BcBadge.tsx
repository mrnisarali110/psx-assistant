/**
 * The blue-chip pill and its checklist. The state comes only from the worker's checks (shared/bluechip.ts);
 * nothing here decides it. Tapping the pill (or the status chip) opens the five checks with their real numbers,
 * sources and the date of the last check.
 */
import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { BcState } from '../../shared/bluechip.ts';
import { day } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';

/**
 * Words spelled out (owner review B3). Only a real blue chip gets the info colour; at risk is a caution; "not a blue
 * chip" and "not enough data" are neutral grey, never red: they are facts, not alarms.
 */
const STATUS: Record<BcState['status'], { label: string; line: string; cls: string }> = {
  bc: { label: 'Blue chip', line: 'Blue chip: passes all five checks.', cls: 'bg-info/10 text-info ring-1 ring-info/25' },
  at_risk: { label: 'Blue chip at risk', line: 'Still a blue chip, but failed its last check. It loses the badge if the next check fails too.', cls: 'bg-caution/5 text-caution ring-1 ring-caution/30' },
  not_bc: { label: 'Not a blue chip', line: 'Not a blue chip: higher risk.', cls: 'bg-surface-2 text-muted' },
  not_enough_data: { label: 'Blue chip: not enough data', line: 'Not enough data yet to call it a blue chip. No badge until every check can be worked out.', cls: 'bg-surface-2 text-muted' },
};

/**
 * `mode`: "badge" shows only a real badge (Blue chip / at risk); "status" also shows "Not a blue chip" and "not enough
 * data" as a quiet chip (Discover, AI suggestions, the stock page), and "not checked yet" when there is no state at all.
 */
export function BcBadge({ state, symbol, mode = 'badge' }: { state: BcState | undefined; symbol: string; mode?: 'badge' | 'status' }) {
  const [open, setOpen] = useState(false);
  if (!state && mode === 'badge') return null;
  if (state && !state.badge && mode === 'badge') return null;
  const s = state ? STATUS[state.status] : null;
  const label = s?.label ?? 'Blue chip: not checked yet';
  const show = (e: MouseEvent | KeyboardEvent) => { e.stopPropagation(); e.preventDefault(); haptic(); if (state) setOpen(true); };
  return (
    <>
      {/* A span with button semantics: it often sits inside a row that is itself a button. The ::after widens the tap area. */}
      <span role="button" tabIndex={0} aria-label={`${symbol}: ${label}${state ? ', show the checklist' : ''}`}
        onClick={show} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && show(e)}
        className={`relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-chip px-2 py-0.5 text-12 font-semibold after:absolute after:-inset-2.5 after:content-[''] ${s?.cls ?? 'bg-surface-2 text-muted'}`}>
        {label}
      </span>
      {state && <BcSheet open={open} onClose={() => setOpen(false)} state={state} />}
    </>
  );
}

/** One check's mark: a tick for passed, a caution cross for failed, a question mark when it cannot be worked out. */
export function CheckMark({ ok }: { ok: boolean | null }) {
  return (
    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${ok === true ? 'bg-surface-2 text-ink' : ok === false ? 'bg-caution/10 text-caution' : 'bg-surface-2 text-muted'}`}
      role="img" aria-label={ok === true ? 'passed' : ok === false ? 'failed' : 'not enough data'}>
      {ok === true ? <Icon name="check" className="h-4 w-4" /> : ok === false ? <Icon name="x" className="h-4 w-4" /> : <span className="text-12 font-bold" aria-hidden="true">?</span>}
    </span>
  );
}

export function BcSheet({ open, onClose, state }: { open: boolean; onClose: () => void; state: BcState }) {
  return (
    <Sheet open={open} onClose={onClose} title={`${state.symbol} · blue-chip check`}>
      <div className="space-y-3 pb-2" onClick={(e) => e.stopPropagation()}>
        <p className="text-14">{STATUS[state.status].line}</p>
        {state.reason && state.status !== 'bc' && <p className={`rounded-control p-3 text-14 text-ink ${state.status === 'at_risk' ? 'bg-caution/10' : 'bg-surface-2'}`}>{state.reason}</p>}
        <ul className="divide-y divide-line">
          {state.checks.map((c) => (
            <li key={c.key} className="flex gap-3 py-2.5">
              <CheckMark ok={c.ok} />
              <span className="min-w-0 flex-1">
                <span className="block text-14 font-medium">{c.label}</span>
                <span className="num block text-14 text-muted">{c.detail}</span>
                {c.source && <span className="block text-12 text-muted">Source: {c.source}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-12 text-muted">
          Last checked: {day(state.checked_on)}. Rechecked weekly (size, trading), after each results or dividend filing, when PSX changes the
          index members, and once a year after annual results. A blue chip loses the badge only after failing two checks in a row.
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
