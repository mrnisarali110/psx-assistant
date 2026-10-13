/**
 * Portfolio split as a donut. The biggest slice is red (most concentrated), shading to calm colours,
 * starting at 12 o'clock. Every slice is also listed with its % so colour is never the only cue.
 */
import { useState } from 'react';
import { rs, rsShort } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';

const COLORS = ['#e11d48', '#f97316', '#f59e0b', '#14b8a6', '#0ea5e9', '#94a3b8'];

export function Donut({ slices, total, caption }: { slices: { label: string; value: number; pct: number }[]; total: number; caption: string }) {
  const [sel, setSel] = useState<number | null>(null);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const pick = (i: number) => { haptic(); setSel(sel === i ? null : i); };
  const shown = sel == null ? null : slices[sel];
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" role="img"
          aria-label={`Portfolio split: ${slices.map((s) => `${s.label} ${s.pct.toFixed(0)}%`).join(', ')}`}>
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="13" className="stroke-slate-100 dark:stroke-slate-800" />
          {slices.map((s, i) => {
            const len = (s.pct / 100) * c;
            const el = (
              <circle key={s.label} cx="50" cy="50" r={r} fill="none" stroke={COLORS[Math.min(i, COLORS.length - 1)]}
                strokeWidth={sel === i ? 17 : 13} strokeDasharray={`${Math.max(0, len - 1.2)} ${c}`} strokeDashoffset={-offset}
                className="cursor-pointer transition-[stroke-width] duration-200" onClick={() => pick(i)} />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="num text-sm leading-tight font-bold">{shown ? `${shown.pct.toFixed(0)}%` : rsShort(total)}</span>
          <span className="max-w-20 truncate text-[11px] text-slate-500 dark:text-slate-400">{shown ? shown.label : caption}</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-0.5">
        {slices.map((s, i) => (
          <li key={s.label}>
            <button type="button" onClick={() => pick(i)} aria-pressed={sel === i}
              className={`flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 text-[13px] transition ${sel === i ? 'bg-slate-100 dark:bg-slate-800' : ''}`}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLORS[Math.min(i, COLORS.length - 1)] }} aria-hidden="true" />
              <span className="font-medium whitespace-nowrap">{s.label}</span>
              <span className={`num ml-auto font-semibold ${i === 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}>{s.pct.toFixed(0)}%</span>
              <span className="num hidden w-14 text-right text-[11px] text-slate-500 min-[420px]:inline dark:text-slate-400">{rs(s.value).replace('Rs ', '')}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
