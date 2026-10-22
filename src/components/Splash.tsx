/**
 * Branded loading screen. Shown only while something is really loading (auth, first data load);
 * when `leaving` turns on it fades out in 200ms and then calls `onGone`. It never holds content back:
 * the screen underneath renders at the same moment the fade starts.
 */
import { useEffect } from 'react';

/**
 * The PSX Assist mark: a teal tile with a rising line. Same drawing as public/logo.svg, the favicon and the app icons
 * (scripts/make-icons.ts), inline so it is sharp at any size and needs no request.
 */
export function LogoMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#0f766e" />
      <polyline points="14.08,42.24 25.6,30.72 34.56,37.12 48.64,21.76" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="48.64" cy="21.76" r="4.6" fill="#fff" />
    </svg>
  );
}

export function Splash({ leaving = false, onGone }: { leaving?: boolean; onGone?: () => void }) {
  // Backstop in case animationend never arrives (e.g. the page was hidden mid-fade).
  useEffect(() => {
    if (!leaving || !onGone) return;
    const t = window.setTimeout(onGone, 400);
    return () => window.clearTimeout(t);
  }, [leaving, onGone]);
  return (
    <div role="status" aria-label="Loading" aria-busy={!leaving} className={`splash ${leaving ? 'splash-leave' : ''}`}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone?.(); }}>
      <LogoMark className="splash-mark" />
      <span className="splash-name">PSX Assist</span>
      <span className="splash-bar" aria-hidden="true" />
    </div>
  );
}
