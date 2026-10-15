import { useCallback, useRef } from 'react';

const BIG_FIGURE_PX = 18;

/**
 * Gives big figures (elements with the `num` class, 18px and up) a short fade when their value
 * changes in place, e.g. after a refresh. Opacity only, 180ms, skipped under reduced motion and
 * while the user is typing (so live previews do not flicker). Returns a ref for the container.
 */
export function useNumberFade() {
  const observer = useRef<MutationObserver | null>(null);
  return useCallback((root: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!root || typeof MutationObserver === 'undefined' || typeof root.animate !== 'function') return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const o = new MutationObserver((mutations) => {
      if (reduce?.matches) return;
      const active = document.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
      const hits = new Set<HTMLElement>();
      for (const m of mutations) {
        const el = m.type === 'characterData' ? m.target.parentElement : (m.target as Element);
        const num = el?.closest?.('.num');
        if (num instanceof HTMLElement && root.contains(num)) hits.add(num);
      }
      hits.forEach((n) => {
        if (parseFloat(getComputedStyle(n).fontSize) < BIG_FIGURE_PX) return;
        n.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
      });
    });
    o.observe(root, { subtree: true, characterData: true, childList: true });
    observer.current = o;
  }, []);
}
