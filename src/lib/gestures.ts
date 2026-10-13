/**
 * Touch gestures shared by every screen: long press, swipe-to-reveal rows, swipe between tabs and
 * pull to refresh. Each has a visible button alternative elsewhere in the UI.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';

/** Tiny vibration on Android (iOS web has no haptics API). */
export const haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

/** Long press (450 ms without moving). Returns pointer handlers; a long press suppresses the click. */
export function useLongPress(onLong: () => void, ms = 450) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; };
  const handlers = {
    onPointerDown: (e: RPointerEvent) => {
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => { fired.current = true; haptic(12); onLong(); }, ms);
    },
    onPointerMove: (e: RPointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); if (!fired.current) { fired.current = true; onLong(); } },
  };
  return {
    handlers,
    /** Call at the top of onClick: true if this click ended a long press and must be ignored. */
    consumed: () => { const f = fired.current; fired.current = false; return f; },
  };
}

/** Horizontal swipe on a row: drag reveals actions (left: up to -maxLeft, right: up to maxRight). */
export function useSwipeRow(opts: { maxLeft: number; maxRight: number }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const s = useRef<{ x: number; y: number; base: number; axis: 'x' | 'y' | null } | null>(null);
  const moved = useRef(false);
  const close = useCallback(() => setDx(0), []);
  const handlers = {
    onPointerDown: (e: RPointerEvent) => { moved.current = false; s.current = { x: e.clientX, y: e.clientY, base: dx, axis: null }; },
    onPointerMove: (e: RPointerEvent) => {
      const st = s.current;
      if (!st) return;
      const mx = e.clientX - st.x;
      const my = e.clientY - st.y;
      if (!st.axis && Math.hypot(mx, my) > 8) st.axis = Math.abs(mx) > Math.abs(my) * 1.4 ? 'x' : 'y';
      if (st.axis !== 'x') return;
      moved.current = true;
      setDragging(true);
      const next = Math.max(-opts.maxLeft - 24, Math.min(opts.maxRight + 24, st.base + mx));
      setDx(next);
    },
    onPointerUp: () => {
      const st = s.current;
      s.current = null;
      if (!st || st.axis !== 'x') return;
      setDragging(false);
      setDx((v) => {
        const snapped = v < -opts.maxLeft / 2 ? -opts.maxLeft : v > opts.maxRight / 2 ? opts.maxRight : 0;
        if (snapped !== 0) haptic();
        return snapped;
      });
    },
    onPointerCancel: () => { s.current = null; setDragging(false); setDx(0); },
  };
  /** Call at the top of onClick: true if the pointer was swiping, so the click must be ignored. */
  const consumeClick = () => { const m = moved.current; moved.current = false; return m; };
  return { dx, dragging, close, handlers, open: dx !== 0, consumeClick };
}

/** Swipe left/right on a region to move between tabs. */
export function useSwipeTabs(count: number, index: number, onChange: (i: number) => void) {
  const s = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: RPointerEvent) => { if (e.pointerType !== 'mouse') s.current = { x: e.clientX, y: e.clientY }; },
    onPointerUp: (e: RPointerEvent) => {
      const st = s.current;
      s.current = null;
      if (!st) return;
      const mx = e.clientX - st.x;
      const my = e.clientY - st.y;
      if (Math.abs(mx) < 60 || Math.abs(mx) < Math.abs(my) * 1.6) return;
      const next = mx < 0 ? Math.min(count - 1, index + 1) : Math.max(0, index - 1);
      if (next !== index) { haptic(); onChange(next); }
    },
    onPointerCancel: () => { s.current = null; },
  };
}

/** Pull down at the top of the page to refresh. Returns the pull distance (0..max) and state. */
export function usePullToRefresh(onRefresh: () => Promise<void>, max = 80) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  useEffect(() => {
    const down = (e: TouchEvent) => { start.current = window.scrollY <= 0 && !busy ? e.touches[0].clientY : null; };
    const move = (e: TouchEvent) => {
      if (start.current == null) return;
      const d = e.touches[0].clientY - start.current;
      setPull(d > 0 ? Math.min(max, d * 0.5) : 0);
    };
    const up = async () => {
      if (start.current == null) return;
      start.current = null;
      setPull((p) => {
        if (p >= max * 0.85) {
          haptic(10);
          setBusy(true);
          onRefresh().finally(() => { setBusy(false); setPull(0); });
          return max * 0.6;
        }
        return 0;
      });
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up);
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
    };
  }, [onRefresh, busy, max]);
  return { pull, busy };
}

/** Merge gesture handler objects so each one still receives every event. */
export function compose<T extends Record<string, ((e: any) => void) | undefined>>(...sets: T[]): T {
  const out: Record<string, (e: any) => void> = {};
  for (const key of new Set(sets.flatMap((s) => Object.keys(s)))) {
    const fns = sets.map((s) => s[key]).filter(Boolean) as ((e: any) => void)[];
    out[key] = (e) => fns.forEach((f) => f(e));
  }
  return out as T;
}
