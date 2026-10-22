/** Building blocks shared by the Profile sections: a settings row, fields that save on leave, and the section frame. */
import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenProps } from '../../App.tsx';
import type { Settings } from '../../../shared/types.ts';
import { profileHref } from '../../lib/nav.ts';
import { haptic } from '../../lib/gestures.ts';
import { Icon, type IconName } from '../../components/Icon.tsx';
import { Card, inputCls } from '../../components/ui.tsx';

/** What every section page gets: the screen props plus `save`, which writes a settings patch and says "Saved". */
export type SectionProps = Pick<ScreenProps, 'data' | 'source' | 'reload'> & { save: (patch: Partial<Settings>) => Promise<void> };

/** A settings row: icon, label with its control on the right, and the hint underneath at full width (phones keep it readable). */
export function Row({ icon, label, hint, children }: { icon: IconName; label: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <RowIcon icon={icon} />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-11 items-center gap-3">
          <p className="min-w-0 flex-1 text-16 font-medium">{label}</p>
          {children}
        </div>
        {hint && <p className="mt-1 text-14 text-muted">{hint}</p>}
      </div>
    </div>
  );
}

export function RowIcon({ icon }: { icon: IconName }) {
  return <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted"><Icon name={icon} className="h-[18px] w-[18px]" /></span>;
}

/** A card of rows with hairlines between them. */
export function RowCard({ children }: { children: ReactNode }) {
  return <Card className="divide-y divide-line py-0">{children}</Card>;
}

/** A short note under a card. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="px-1 text-14 text-muted">{children}</p>;
}

/** Number that saves when you leave the field (or press Enter). */
export function NumberInput({ value, onSave, min, max, prefix, suffix, label, width = 'w-28', decimals }: {
  value: number; onSave: (v: number) => Promise<void>; min: number; max: number; prefix?: string; suffix?: string; label: string; width?: string; decimals?: number;
}) {
  const show = (v: number) => v.toLocaleString('en-PK', { maximumFractionDigits: decimals ?? 2 });
  const [text, setText] = useState(show(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = async () => {
    const v = Number(text.replace(/[,\s]/g, ''));
    if (!Number.isFinite(v) || v < min || v > max) { setBad(true); return; }
    setBad(false);
    if (v !== value) await onSave(v);
  };
  return (
    <span className={`relative shrink-0 ${width}`}>
      {prefix && <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-14 text-muted">{prefix}</span>}
      <input aria-label={label} aria-invalid={bad} title={bad ? `Between ${show(min)} and ${show(max)}` : undefined} inputMode="decimal" value={text}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className={`${inputCls} num text-right ${prefix ? 'pl-9' : ''} ${suffix ? 'pr-8' : ''} ${bad ? 'border-caution ring-2 ring-caution/30' : ''}`} />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-14 text-muted">{suffix}</span>}
    </span>
  );
}

/** Short text that saves when you leave the field. */
export function TextInput({ value, onSave, label, maxLength = 40, width = 'w-36' }: { value: string; onSave: (v: string) => Promise<void>; label: string; maxLength?: number; width?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = async () => { const v = text.trim(); if (v && v !== value) await onSave(v); else setText(value); };
  return (
    <span className={`block shrink-0 ${width}`}>
      <input aria-label={label} value={text} maxLength={maxLength} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className={`${inputCls} text-right`} />
    </span>
  );
}

/** A section page: "Profile" back link (phones; the list stays beside it on a wide screen), title, then the content. */
export function SectionPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <a href={profileHref()} onClick={() => haptic()}
        className="press -ml-2 inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-control px-2 text-16 font-semibold text-brand lg:hidden">
        <Icon name="chevron" className="h-5 w-5 rotate-180" />Profile
      </a>
      <h1 className="text-28 font-bold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
