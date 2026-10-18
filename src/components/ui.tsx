import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { haptic } from '../lib/gestures.ts';

export function Card({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const base = `rounded-3xl bg-white p-4 ring-1 ring-slate-200/80 dark:bg-slate-900 dark:ring-slate-800 ${className}`;
  return onClick
    ? <button type="button" onClick={() => { haptic(); onClick(); }} className={`press block w-full cursor-pointer text-left ${base}`}>{children}</button>
    : <div className={base}>{children}</div>;
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export const TONES = {
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  red: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
};
export type Tone = keyof typeof TONES;

/** A small label. `wrap` lets a long one break over lines inside its card (phones), instead of running off the edge. */
export function Tag({ tone = 'slate', wrap = false, children }: { tone?: Tone; wrap?: boolean; children: ReactNode }) {
  const shape = wrap ? 'max-w-full whitespace-normal break-words rounded-2xl' : 'whitespace-nowrap rounded-full';
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium ${shape} ${TONES[tone]}`}>{children}</span>;
}

export const changeTone = (v: number | null | undefined) =>
  v == null || v === 0 ? 'text-slate-500 dark:text-slate-400' : v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';

export function Button({ children, onClick, kind = 'primary', disabled, type = 'button', className = '', label }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean; type?: 'button' | 'submit'; className?: string; label?: string;
}) {
  const styles = {
    primary: 'bg-teal-700 text-white hover:bg-teal-800 disabled:bg-slate-400 dark:disabled:bg-slate-700',
    secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    ghost: 'text-teal-700 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-slate-800',
  }[kind];
  return (
    <button type={type} disabled={disabled} aria-label={label} onClick={() => { haptic(); onClick?.(); }}
      className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold press disabled:cursor-not-allowed ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span role="alert" className="block text-xs text-rose-600 dark:text-rose-400">{error}</span>
        : hint && <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full min-h-11 rounded-2xl border border-slate-300 bg-white px-3 py-2 text-base outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20 dark:border-slate-700 dark:bg-slate-950';

/** iOS-style segmented control. */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  const index = options.findIndex((o) => o.value === value);
  const box = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  // Segments size to their labels, so measure the selected one. The pill is absolutely positioned:
  // moving or resizing it never shifts anything else.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const b = el.querySelectorAll<HTMLElement>('[role=tab]')[index];
      setPill(b ? { x: b.offsetLeft, w: b.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [index, options.length]);
  return (
    <div ref={box} role="tablist" aria-label={label} className="relative flex rounded-2xl bg-slate-200/70 p-1 dark:bg-slate-800">
      {pill && (
        <span aria-hidden="true" className="slide-indicator pointer-events-none absolute top-1 bottom-1 left-0 rounded-xl bg-white shadow-sm dark:bg-slate-950"
          style={{ width: pill.w, transform: `translateX(${pill.x}px)` }} />
      )}
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => { haptic(); onChange(o.value); }}
          className={`press relative min-h-10 flex-1 cursor-pointer rounded-xl px-2 text-sm font-semibold ${value === o.value ? 'text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A row of pills: scrolls sideways on a phone (edges fade so it is clear there is more), wraps on a wide screen.
 * Shared by sort chips, Discover's filters and News's filters so every chip row looks and behaves the same.
 */
export const chipRowCls =
  '-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5 scrollbar-none [mask-image:linear-gradient(to_right,transparent,#000_16px,#000_calc(100%-16px),transparent)] lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 lg:[mask-image:none]';
/** One pill in such a row: 44px tall, never wraps its own label. */
export const chipCls = (on: boolean, solid: 'teal' | 'ink' = 'teal') =>
  `press inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap transition-colors ${
    on ? (solid === 'teal' ? 'bg-teal-700 text-white' : 'bg-slate-900 text-white dark:bg-white dark:text-slate-900')
      : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`;

/** One-of-many pills in a scrolling row (sort orders, filters). */
export function Chips<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={chipRowCls}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => { haptic(); onChange(o.value); }}
          className={chipCls(value === o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => { haptic(); onChange(!checked); }}
      className={`relative h-8 w-13 shrink-0 cursor-pointer rounded-full transition-colors ${checked ? 'bg-teal-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
      <span className={`absolute top-1 left-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function Empty({ title, children, className = '' }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-3xl border border-dashed border-slate-300 p-6 text-center dark:border-slate-700 ${className}`}>
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{children}</div>}
    </div>
  );
}

export function Disclaimer() {
  return <p className="px-1 text-xs text-slate-500 dark:text-slate-400">Suggestions only, not licensed financial advice. Check live prices in your broker app.</p>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="rounded-2xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-300">{error}</p>;
}

/** The KSE-100 trend line. Needs at least two real points. */
export function Sparkline({ values, className = '' }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const w = 120, h = 36;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`h-9 w-28 ${up ? 'text-emerald-500' : 'text-rose-500'} ${className}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Round letter avatar for a symbol, ring coloured by today's move (Instagram-story style). */
export function SymbolAvatar({ symbol, change, size = 'h-11 w-11' }: { symbol: string; change?: number | null; size?: string }) {
  const ring = change == null || change === 0 ? 'ring-slate-300 dark:ring-slate-700' : change > 0 ? 'ring-emerald-500' : 'ring-rose-500';
  return (
    <span className={`${size} inline-flex shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold tracking-tight text-slate-700 ring-2 ring-offset-2 ring-offset-white dark:bg-slate-800 dark:text-slate-200 dark:ring-offset-slate-900 ${ring}`}>
      {symbol.slice(0, 4)}
    </span>
  );
}
