import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800 ${className}`}>{children}</div>;
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

const TONES = {
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  red: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
};

export function Tag({ tone = 'slate', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export const changeTone = (v: number | null | undefined) =>
  v == null || v === 0 ? 'text-slate-500 dark:text-slate-400' : v > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';

export function AsOf({ label, stale }: { label: string; stale?: boolean }) {
  return (
    <p className={`text-xs ${stale ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
      {stale ? 'Stale: ' : ''}as of {label}
    </p>
  );
}

export function Disclaimer() {
  return (
    <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
      Not licensed financial advice. Check live prices in your broker app before you place an order.
    </p>
  );
}

export function Button({ children, onClick, kind = 'primary', disabled, type = 'button', className = '' }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean; type?: 'button' | 'submit'; className?: string;
}) {
  const styles = {
    primary: 'bg-teal-700 text-white hover:bg-teal-800 disabled:bg-slate-400',
    secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    ghost: 'text-teal-700 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-slate-800',
  }[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`min-h-11 rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-base outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20 dark:border-slate-700 dark:bg-slate-950';

/** The one allowed chart: a tiny trend line. Needs at least two real points. */
export function Sparkline({ values, className = '' }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const w = 120, h = 32;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`h-8 w-28 ${up ? 'text-emerald-500' : 'text-rose-500'} ${className}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-300">{error}</p>;
}
