/**
 * Bottom sheet (drag the handle or the top area down to close, tap outside, or Escape) and an
 * iOS-style action sheet built on it. Opens where the thumb is, never at the top of the page.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { haptic } from '../lib/gestures.ts';
import { Icon, type IconName } from './Icon.tsx';

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-handle])')?.focus({ preventScroll: true });
    return () => { window.removeEventListener('keydown', key); document.body.style.overflow = prev; setDrag(0); };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40">
      <button type="button" aria-label="Close" className="absolute inset-0 h-full w-full animate-fade cursor-default bg-black/50" onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title}
        className="absolute inset-x-0 bottom-0 mx-auto max-h-[90dvh] max-w-md animate-sheet overflow-y-auto rounded-t-[28px] bg-white pb-[max(16px,env(safe-area-inset-bottom))] dark:bg-slate-900"
        style={{ transform: drag ? `translateY(${drag}px)` : undefined, transition: drag ? 'none' : undefined }}>
        <div className="sticky top-0 z-10 bg-white/95 px-5 pt-2 pb-2 backdrop-blur dark:bg-slate-900/95"
          onPointerDown={(e) => { start.current = e.clientY; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
          onPointerMove={(e) => { if (start.current != null) setDrag(Math.max(0, e.clientY - start.current)); }}
          onPointerUp={() => { if (drag > 110) { haptic(); onClose(); } start.current = null; setDrag(0); }}
          onPointerCancel={() => { start.current = null; setDrag(0); }}>
          <div data-handle className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-slate-300 dark:bg-slate-700" aria-hidden="true" />
          {title && <h2 className="text-center text-base font-semibold">{title}</h2>}
        </div>
        <div className="px-5 pt-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export interface SheetAction { label: string; icon: IconName; onSelect: () => void; destructive?: boolean }

export function ActionSheet({ open, onClose, title, actions }: { open: boolean; onClose: () => void; title?: string; actions: SheetAction[] }) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ul className="divide-y divide-slate-100 pb-2 dark:divide-slate-800">
        {actions.map((a) => (
          <li key={a.label}>
            <button type="button" onClick={() => { haptic(); onClose(); a.onSelect(); }}
              className={`flex min-h-13 w-full cursor-pointer items-center gap-3 py-3 text-left text-base font-medium active:opacity-60 ${a.destructive ? 'text-rose-600 dark:text-rose-400' : ''}`}>
              <Icon name={a.icon} />
              {a.label}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
