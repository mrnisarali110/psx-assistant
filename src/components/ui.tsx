import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { haptic } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';

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

/** Text colour for a change: up / down tokens, muted when flat or unknown. Pair it with an arrow (see Change). */
export const changeTone = (v: number | null | undefined) =>
  v == null || v === 0 ? 'text-muted' : v > 0 ? 'text-up' : 'text-down';

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

/** @deprecated Use CompanyMark. Kept so older screens compile; no longer colours a ring by the day's move. */
export function SymbolAvatar({ symbol, size = 'h-11 w-11' }: { symbol: string; change?: number | null; size?: string }) {
  return <CompanyMark symbol={symbol} size={size} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Design-system primitives (owner review 2026-10-23). Screens use these instead of hand-rolled variants.
// ---------------------------------------------------------------------------------------------------------------

const nf = (digits: number) => new Intl.NumberFormat('en-PK', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * A change with an arrow, so colour is never the only signal: "▲ +2.3%", "▼ −Rs 593", "– 0.0%".
 * `kind` 'pct' (default) adds %, 'rs' formats rupees, 'num' a plain number (index points).
 */
export function Change({ value, kind = 'pct', digits, className = '', label }: {
  value: number | null | undefined; kind?: 'pct' | 'rs' | 'num'; digits?: number; className?: string; label?: string;
}) {
  if (value == null || !Number.isFinite(value)) return <span className={`text-muted ${className}`}>–</span>;
  const d = digits ?? (kind === 'pct' ? 1 : 0);
  const abs = Math.abs(value);
  const flat = Number(abs.toFixed(d)) === 0;
  const sign = flat ? '' : value > 0 ? '+' : '−';
  const body = kind === 'rs' ? `${sign}Rs ${nf(d).format(abs)}` : kind === 'num' ? `${sign}${nf(d).format(abs)}` : `${sign}${abs.toFixed(d)}%`;
  const arrow = flat ? '–' : value > 0 ? '▲' : '▼';
  const words = flat ? 'unchanged' : value > 0 ? 'up' : 'down';
  return (
    <span className={`num inline-flex items-baseline gap-0.5 whitespace-nowrap ${changeTone(flat ? 0 : value)} ${className}`}
      aria-label={`${label ? label + ' ' : ''}${words} ${body.replace(/^[+−]/, '')}`}>
      <span aria-hidden="true" className="text-[0.8em]">{arrow}</span>
      <span aria-hidden="true">{body}</span>
    </span>
  );
}

export type ChipKind = 'bluechip' | 'not_bluechip' | 'shariah' | 'exdiv' | 'ai' | 'caution' | 'estimate' | 'provisional' | 'neutral';
const CHIP: Record<ChipKind, { label: string; cls: string }> = {
  bluechip: { label: 'Blue chip', cls: 'bg-info/10 text-info ring-1 ring-info/25' },
  not_bluechip: { label: 'Not a blue chip', cls: 'bg-surface-2 text-muted' },
  shariah: { label: 'Shariah', cls: 'bg-surface-2 text-ink' },
  exdiv: { label: 'Ex-dividend', cls: 'bg-surface-2 text-ink' },
  ai: { label: 'AI', cls: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  caution: { label: 'Check', cls: 'bg-caution/10 text-caution' },
  estimate: { label: 'Estimate', cls: 'bg-surface-2 text-muted' },
  provisional: { label: 'Provisional', cls: 'bg-caution/10 text-caution' },
  neutral: { label: '', cls: 'bg-surface-2 text-muted' },
};
/** The fixed set of chips. Children override the label (e.g. a caution chip "High payout, may not last"). */
export function Chip({ kind, children, title }: { kind: ChipKind; children?: ReactNode; title?: string }) {
  const c = CHIP[kind];
  return (
    <span title={title} className={`inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-chip px-2 py-0.5 text-12 font-semibold ${c.cls}`}>
      {kind === 'caution' && <Icon name="alert" className="h-3 w-3" />}
      {kind === 'ai' && <Icon name="sparkles" className="h-3 w-3" />}
      {children ?? c.label}
    </span>
  );
}

/** Sector colours for company marks: calm hues that never mean up / down / caution. */
const SECTOR_HUES = ['#4f46e5', '#0284c7', '#7c3aed', '#0891b2', '#475569', '#9333ea', '#2563eb', '#0e7490', '#6d28d9', '#334155'];
export function sectorColor(sector: string | null | undefined): string {
  if (!sector) return '#64748b';
  let h = 0;
  for (const ch of sector.toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SECTOR_HUES[h % SECTOR_HUES.length];
}
/** Company mark: up to 3 initials of the symbol in a circle coloured by sector. The full symbol is its label. */
export function CompanyMark({ symbol, sector, size = 'h-10 w-10' }: { symbol: string; sector?: string | null; size?: string }) {
  const letters = symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase();
  return (
    <span role="img" aria-label={symbol} style={{ backgroundColor: sectorColor(sector) }}
      className={`${size} inline-flex shrink-0 items-center justify-center rounded-full text-[11px] font-bold tracking-tight text-white`}>
      <span aria-hidden="true">{letters}</span>
    </span>
  );
}

/** A small (i) that explains on tap (phones) or hover/focus (desktop). */
export function InfoTip({ text, label = 'More information' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open]);
  return (
    <span ref={box} className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open}
        onClick={() => setOpen((v) => !v)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full text-muted hover:text-ink">
        <Icon name="info" className="h-4 w-4" />
      </button>
      {open && (
        <span id={id} role="tooltip" className="absolute bottom-full left-1/2 z-30 mb-1 w-56 -translate-x-1/2 rounded-control bg-ink px-3 py-2 text-12 font-normal text-canvas shadow-float">
          {text}
        </span>
      )}
    </span>
  );
}

/** "How this works" link that opens a sheet with the method, sources and to-verify notes, keeping cards short. */
export function HowItWorks({ title, children, linkLabel = 'How this works' }: { title: string; children: ReactNode; linkLabel?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => { haptic(); setOpen(true); }}
        className="press inline-flex min-h-11 cursor-pointer items-center gap-1 text-14 font-semibold text-brand">
        <Icon name="info" className="h-4 w-4" />{linkLabel}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        <div className="space-y-3 text-14 text-ink">{children}</div>
      </Sheet>
    </>
  );
}
