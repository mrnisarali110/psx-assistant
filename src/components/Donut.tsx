/**
 * Portfolio split as a donut, biggest slice first, starting at 12 o'clock. The slice colours are calm hues that
 * never mean up, down or caution (a big sector is not bad news); a sector over your limit says so in the list, in
 * the caution colour and in words. Every slice is also listed with its % so colour is never the only cue.
 */
import { useState } from 'react';
import { rs, rsShort } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';

/** Biggest slice first; the 6th is for "Other". No red, green or amber: those mean price direction and caution. */
export const SLICE_COLORS = ['#4f46e5', '#0284c7', '#7c3aed', '#0891b2', '#64748b', '#94a3b8'];
const COLORS = SLICE_COLORS;

export function Donut({ slices, total, caption, limit }: {
  slices: { label: string; value: number; pct: number }[]; total: number; caption: string; limit?: number;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const pick = (i: number) => { haptic(); setSel(sel === i ? null : i); };
  const shown = sel == null ? null : slices[sel];
  const over = (pct: number) => limit != null && pct > limit;
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-32 w-32 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" role="img"
          aria-label={`Portfolio split: ${slices.map((s) => `${s.label} ${s.pct.toFixed(0)}%`).join(', ')}`}>
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="13" className="stroke-surface-2" />
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
          <span className="num text-14 font-bold">{shown ? `${shown.pct.toFixed(0)}%` : rsShort(total)}</span>
          <span className="max-w-20 truncate text-12 text-muted">{shown ? shown.label : caption}</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1">
        {slices.map((s, i) => (
          <li key={s.label}>
            <button type="button" onClick={() => pick(i)} aria-pressed={sel === i}
              aria-label={`${s.label} ${s.pct.toFixed(0)}%${over(s.pct) ? `, over your ${limit}% limit` : ''}`}
              className={`press flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-control px-1.5 text-14 ${sel === i ? 'bg-surface-2' : ''}`}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLORS[Math.min(i, COLORS.length - 1)] }} aria-hidden="true" />
              <span className="min-w-0 truncate font-medium">{s.label}</span>
              <span className={`num ml-auto font-semibold ${over(s.pct) ? 'text-caution' : ''}`}>{s.pct.toFixed(0)}%</span>
              <span className="num hidden w-16 text-right text-12 text-muted min-[420px]:inline">{rs(s.value).replace('Rs ', '')}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
