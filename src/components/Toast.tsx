/** Snackbar above the tab bar, with an optional Undo. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface ToastMsg { id: number; text: string; action?: { label: string; run: () => void } }
const Ctx = createContext<(text: string, action?: ToastMsg['action']) => void>(() => {});

export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | null>(null);
  const show = useCallback((text: string, action?: ToastMsg['action']) => {
    if (timer.current) window.clearTimeout(timer.current);
    setLeaving(false);
    setMsg({ id: Date.now(), text, action });
    timer.current = window.setTimeout(() => setLeaving(true), action ? 5000 : 2600);
  }, []);
  // Backstop: remove it even if animationend never fires (page hidden mid-animation).
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => { setMsg(null); setLeaving(false); }, 300);
    return () => window.clearTimeout(t);
  }, [leaving]);
  // Slides in (240ms), slides out (160ms) before it is removed.
  const dismiss = () => { if (timer.current) window.clearTimeout(timer.current); setLeaving(true); };
  return (
    <Ctx.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
        {msg && (
          <div key={msg.id} onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) { setMsg(null); setLeaving(false); } }}
            className={`flex max-w-md flex-1 ${leaving ? 'pointer-events-none animate-toast-out' : 'pointer-events-auto animate-toast-in'} items-center justify-between gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900`}>
            <span>{msg.text}</span>
            {msg.action && (
              <button type="button" className="min-h-9 cursor-pointer font-semibold text-teal-300 dark:text-teal-700"
                onClick={() => { msg.action!.run(); dismiss(); }}>{msg.action.label}</button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
