/**
 * One stock's price over 1M / 3M / 6M / 1Y / All, drawn as hand-rolled SVG from the stored daily closes (price_daily,
 * which builds from 2026-10-23). It never implies more history than is stored: only ranges the closes cover are
 * offered, a short history says "Since <date>", and with fewer than five closes it shows PSX's 52-week range bar and
 * "Price chart builds from <date>" instead of a line.
 */
import { useId, useRef, useState } from 'react';
import type { PriceDay } from '../../shared/types.ts';
import { day, rs2 } from '../../shared/format.ts';
import { addDays, pktDate } from '../../shared/time.ts';
import { haptic } from '../lib/gestures.ts';
import { Change } from './ui.tsx';

export type PriceRange = '1M' | '3M' | '6M' | '1Y' | 'All';
export const PRICE_RANGES: PriceRange[] = ['1M', '3M', '6M', '1Y', 'All'];
const RANGE_DAYS: Record<Exclude<PriceRange, 'All'>, number> = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365 };
const RANGE_WORDS: Record<PriceRange, string> = { '1M': 'Past month', '3M': 'Past 3 months', '6M': 'Past 6 months', '1Y': 'Past year', All: 'All stored' };
/** Fewer closes than this and the card shows the 52-week bar, not a line (a 3-point line says nothing). */
export const MIN_CLOSES = 5;

export interface PricePoint { day: string; close: number }

/**
 * The closes to draw for one symbol, oldest first: one per day, nothing after today (PKT), no zero or broken values.
 * `current` (the live price dated by its price day) replaces or extends the last stored close.
 */
export function priceSeries(days: PriceDay[], symbol: string, now: Date, current?: PricePoint | null): PricePoint[] {
  const today = pktDate(now);
  const by = new Map<string, number>();
  for (const d of days) {
    if (d.symbol !== symbol || !Number.isFinite(d.close) || d.close <= 0 || d.day > today) continue;
    by.set(d.day, d.close);
  }
  if (current && Number.isFinite(current.close) && current.close > 0 && current.day <= today) {
    const last = [...by.keys()].sort().at(-1);
    if (!last || current.day >= last) by.set(current.day, current.close);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, close]) => ({ day: d, close }));
}

/** The first day a range covers, counted back from the latest close (null = everything stored). */
export function priceCutoff(range: PriceRange, latest: string): string | null {
  return range === 'All' ? null : addDays(latest, -RANGE_DAYS[range]);
}

/** Ranges the stored closes can fill: a range is offered only when history starts before it does. All is always there. */
export function rangesFor(points: PricePoint[]): PriceRange[] {
  if (points.length < 2) return ['All'];
  const first = points[0].day, last = points[points.length - 1].day;
  return PRICE_RANGES.filter((r) => r === 'All' || first < (priceCutoff(r, last) as string));
}

export function cutRange(points: PricePoint[], range: PriceRange): PricePoint[] {
  if (!points.length) return points;
  const cutoff = priceCutoff(range, points[points.length - 1].day);
  return cutoff ? points.filter((p) => p.day >= cutoff) : points;
}

const STORE_KEY = 'psx-stock-range';
const savedRange = (): PriceRange => {
  try { const v = localStorage.getItem(STORE_KEY); return PRICE_RANGES.includes(v as PriceRange) ? (v as PriceRange) : '1Y'; } catch { return '1Y'; }
};

export function PriceChart({ symbol, days, current, low52, high52, now = new Date() }: {
  symbol: string; days: PriceDay[]; current?: PricePoint | null; low52: number | null; high52: number | null; now?: Date;
}) {
  const [want, setWant] = useState<PriceRange>(savedRange);
  const all = priceSeries(days, symbol, now, current);
  const offered = rangesFor(all);
  // A saved range the history cannot fill yet falls back to everything stored.
  const range = offered.includes(want) ? want : 'All';
  const pick = (r: PriceRange) => {
    haptic();
    setWant(r);
    try { localStorage.setItem(STORE_KEY, r); } catch { /* private mode */ }
  };

  if (all.length < MIN_CLOSES) {
    return (
      <div className="space-y-4">
        <RangeBar low={low52} high={high52} value={current?.close ?? all.at(-1)?.close ?? null} />
        <p className="rounded-control bg-surface-2 px-4 py-3 text-14 text-muted">
          {all.length
            ? `Price chart builds from ${day(all[0].day, now)}: one close each trading day (${all.length} of ${MIN_CLOSES} so far).`
            : 'Price chart builds from the next nightly close: one point each trading day.'}
        </p>
      </div>
    );
  }

  const points = cutRange(all, range);
  return (
    <div className="space-y-2">
      {offered.length > 1 && (
        <div role="radiogroup" aria-label="Chart range" className="flex gap-1">
          {offered.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={range === r} onClick={() => pick(r)}
              className={`press min-h-11 flex-1 cursor-pointer rounded-control text-14 font-semibold ${range === r ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}>
              {r}
            </button>
          ))}
        </div>
      )}
      <Line symbol={symbol} points={points} range={range} now={now} />
    </div>
  );
}

function Line({ symbol, points, range, now }: { symbol: string; points: PricePoint[]; range: PriceRange; now: Date }) {
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId();
  const box = useRef<HTMLDivElement>(null);
  const W = 300, H = 120, PAD = 6;
  const vals = points.map((p) => p.close);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || Math.max(0.01, max * 0.01);
  const x = (i: number) => (points.length > 1 ? (i / (points.length - 1)) * W : W / 2);
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);
  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.close).toFixed(2)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  const first = points[0], last = points[points.length - 1];
  const gain = last.close - first.close;
  const gainPct = (gain / first.close) * 100;
  const tone = Math.abs(gainPct) < 0.05 ? 'text-muted' : gain > 0 ? 'text-up' : 'text-down';
  // A range with less stored history than it names says where it starts.
  const cutoff = priceCutoff(range, last.day);
  const words = range === 'All' || (cutoff != null && first.day > addDays(cutoff, 3)) ? `Since ${day(first.day, now)}` : RANGE_WORDS[range];
  const active = hover != null ? points[hover] : null;

  const onMove = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const k = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setHover(Math.round(k * (points.length - 1)));
  };
  // Arrow keys walk the closes, so the values are reachable without a pointer.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = hover ?? points.length - 1;
    setHover(Math.min(points.length - 1, Math.max(0, i + (e.key === 'ArrowRight' ? 1 : -1))));
  };

  return (
    <div className="space-y-1">
      <div className="flex min-h-6 flex-wrap items-baseline gap-x-1.5 text-14" aria-live="polite">
        {active
          ? <span className="text-ink"><span className="text-muted">{day(active.day, now)}</span> · <b>{rs2(active.close)}</b></span>
          : (
            <>
              <Change kind="rs" digits={2} value={gain} className="font-semibold" label={words} />
              <Change value={gainPct} className="font-semibold" />
              <span className="text-muted">{words}</span>
            </>
          )}
      </div>
      <div ref={box} tabIndex={0} className={`relative h-44 rounded-control outline-none focus-visible:ring-2 focus-visible:ring-brand lg:h-56 ${tone}`} style={{ touchAction: 'pan-y' }}
        onPointerMove={(e) => onMove(e.clientX)} onPointerDown={(e) => onMove(e.clientX)} onPointerLeave={() => setHover(null)} onPointerCancel={() => setHover(null)}
        onKeyDown={onKey} onBlur={() => setHover(null)}
        role="img" aria-label={`${symbol} price, ${words.toLowerCase()}: from ${rs2(first.close)} on ${day(first.day, now)} to ${rs2(last.close)} on ${day(last.day, now)}. Arrow keys step through the closes.`}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" x2={W} y1={y(first.close)} y2={y(first.close)} stroke="var(--color-line)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <polygon points={area} fill={`url(#${gradId})`} />
          <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="var(--color-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        </svg>
        {/* The dot is HTML so the stretched SVG never turns it into an oval. */}
        {(() => {
          const i = hover ?? points.length - 1;
          return <span aria-hidden="true" className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-surface"
            style={{ left: `${(x(i) / W) * 100}%`, top: `${(y(points[i].close) / H) * 100}%` }} />;
        })()}
      </div>
      <div className="flex justify-between text-12 text-muted">
        <span>{day(first.day, now)}</span>
        <span className="num">Low {rs2(min)} · High {rs2(max)}</span>
        <span>{day(last.day, now)}</span>
      </div>
    </div>
  );
}

/** PSX's 52-week low and high with today's price on it. Neutral colours: the bar shows a position, not a direction. */
export function RangeBar({ low, high, value }: { low: number | null; high: number | null; value: number | null }) {
  if (low == null || high == null || value == null || !(high > low)) {
    return <p className="text-14 text-muted">No 52-week range from PSX yet.</p>;
  }
  const pos = Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100));
  return (
    <div role="img" aria-label={`52-week range ${rs2(low)} to ${rs2(high)}; now ${rs2(value)}, ${pos.toFixed(0)}% of the way up`}>
      <p className="mb-2 text-12 font-semibold text-muted">52-week range</p>
      <div className="relative h-2 rounded-chip bg-surface-2 ring-1 ring-line" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded-chip bg-info/30" style={{ width: `${pos}%` }} />
        <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-ink shadow-card" style={{ left: `${pos}%` }} />
      </div>
      <div className="num mt-1.5 flex justify-between text-12 text-muted" aria-hidden="true">
        <span>Low {rs2(low)}</span><span>High {rs2(high)}</span>
      </div>
    </div>
  );
}
