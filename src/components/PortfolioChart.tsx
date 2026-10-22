/**
 * Your portfolio's value over 1D / 1W / 1M / YTD / All, drawn as hand-rolled SVG. It never draws more history than is
 * stored: 1D runs from the previous close through the market-run ticks of the latest session to today's value, the
 * rest use the nightly portfolio_daily rows plus today's value; a range with too little data shows what exists and
 * says from when, and fewer than two points show "Builds from <date>" instead of a line. The gain over a range never
 * counts money you put in or took out (buys and sells from the transaction log).
 */
import { useId, useRef, useState } from 'react';
import type { PortfolioDay, PortfolioTick, Settings, Txn } from '../../shared/types.ts';
import { day, rs, sessionLabel, time } from '../../shared/format.ts';
import { CLOSE_LOOKBACK_DAYS, cashFlows } from '../../shared/performance.ts';
import { addDays, pktDate } from '../../shared/time.ts';
import { haptic } from '../lib/gestures.ts';
import { Change } from './ui.tsx';

export type ChartRange = '1D' | '1W' | '1M' | 'YTD' | 'All';
export const RANGES: ChartRange[] = ['1D', '1W', '1M', 'YTD', 'All'];
const RANGE_WORDS: Record<ChartRange, string> = { '1D': 'Today', '1W': 'Past week', '1M': 'Past month', YTD: 'This year', All: 'All time' };

/** One point of the line: a timestamp (1D) or a YYYY-MM-DD day, and the value. `close` marks 1D's previous-close start. */
export interface ChartPoint { t: string; v: number; close?: boolean }

/** Money you put in (+) or took out (−) on a PKT day. */
export interface MoneyMove { date: string; amount: number }

/**
 * Today's value from live prices: `day` dates it for the daily ranges; `ts` (the price time) places it on the 1D line;
 * `prev_close` is what today's holdings were worth at the previous close (value − the day change), 1D's start when
 * no stored close is near enough.
 */
export interface CurrentValue { day: string; value: number; ts?: string | null; prev_close?: number | null }

const isDay = (t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t);
const pktDayOf = (t: string) => (isDay(t) ? t : pktDate(new Date(t)));
const good = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The first day a daily range covers, counted back from the latest point (null = everything). */
export function rangeCutoff(range: ChartRange, anchor: string): string | null {
  if (range === '1W') return addDays(anchor, -7);
  if (range === '1M') return addDays(anchor, -30);
  if (range === 'YTD') return `${anchor.slice(0, 4)}-01-01`;
  return null;
}

/**
 * Money in and out from the transaction log, oldest first: a buy puts in its amount plus charges, a sale takes out
 * its proceeds net of charges (the same cash flows as the money-weighted return, performance.cashFlows()).
 */
export function moneyIn(txns: Txn[], settings: Settings): MoneyMove[] {
  return cashFlows(txns, [], Number.NaN, '', settings)
    .filter((f) => f.kind === 'buy' || f.kind === 'sell')
    .map((f) => ({ date: f.date, amount: Math.round(-f.amount * 100) / 100 }));
}

/**
 * The points to draw for a range, oldest first. 1D: the session is the latest PKT day with a tick or today's value;
 * its ticks, then today's value when it is newer, starting from the previous close: `current.prev_close` (today's
 * holdings at the previous close) dated on the session day itself, so rangeChange() does not take today's buys off a
 * start that already holds them; else the last stored close before the session (within CLOSE_LOOKBACK_DAYS). Others: the daily values, with `current` replacing
 * or extending the last one, cut to the range counted back from the latest point. Nothing dated after `now`, no zero
 * or broken values.
 */
export function seriesFor(range: ChartRange, ticks: PortfolioTick[], daily: PortfolioDay[], now: Date, current?: CurrentValue | null): ChartPoint[] {
  const nowMs = now.getTime();
  const today = pktDate(now);
  const days = daily.filter((d) => good(d.value) && d.day <= today).sort((a, b) => a.day.localeCompare(b.day));
  if (range === '1D') {
    const ok = ticks.filter((t) => good(t.value) && Number.isFinite(Date.parse(t.ts)) && Date.parse(t.ts) <= nowMs)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const curTs = current && good(current.value) && current.ts && Number.isFinite(Date.parse(current.ts)) && Date.parse(current.ts) <= nowMs ? current.ts : null;
    const curDay = curTs ? pktDayOf(curTs) : null;
    const session = [ok.length ? pktDayOf(ok[ok.length - 1].ts) : null, curDay].filter((d): d is string => !!d).sort().at(-1);
    if (!session) return [];
    const pts: ChartPoint[] = ok.filter((t) => pktDayOf(t.ts) === session).map((t) => ({ t: t.ts, v: t.value }));
    const lastTick = pts.at(-1);
    const curHere = curTs != null && curDay === session;
    if (curHere && (!lastTick || Date.parse(curTs) > Date.parse(lastTick.t))) pts.push({ t: curTs, v: current!.value });
    const before = days.filter((d) => d.day < session && d.day >= addDays(session, -CLOSE_LOOKBACK_DAYS)).at(-1);
    // Today's holdings at the previous close (value - the day change) first, so the 1D figure is the header's day
    // change; the stored close is the fallback when there is no live day change.
    const start: ChartPoint | null = curHere && good(current!.prev_close) ? { t: session, v: current!.prev_close, close: true }
      : before ? { t: before.day, v: before.value, close: true } : null;
    return start && pts.length ? [start, ...pts] : pts;
  }
  const pts: ChartPoint[] = days.map((d) => ({ t: d.day, v: d.value }));
  if (current && good(current.value) && current.day <= today) {
    const p = { t: current.day, v: current.value };
    const last = pts.at(-1);
    if (last && last.t === current.day) pts[pts.length - 1] = p;
    else if (!last || current.day > last.t) pts.push(p);
  }
  if (!pts.length) return [];
  const cutoff = rangeCutoff(range, pts[pts.length - 1].t);
  return cutoff ? pts.filter((d) => d.t >= cutoff) : pts;
}

/**
 * Gain over the points: the change in value minus the money put in (buys) and plus the money taken out (sales)
 * after the first point's day up to the last point's. Money moved on the first point's day is already in that close.
 * The percentage is only given when no money moved, so it is never a deposit dressed up as growth.
 */
export function rangeChange(points: ChartPoint[], moves: MoneyMove[] = []): { gain: number; pct: number | null; added: number } | null {
  if (points.length < 2) return null;
  const a = points[0], b = points[points.length - 1];
  const from = pktDayOf(a.t), to = pktDayOf(b.t);
  const added = moves.reduce((s, m) => (m.date > from && m.date <= to && Number.isFinite(m.amount) ? s + m.amount : s), 0);
  const moved = Math.abs(added) >= 1;
  const gain = b.v - a.v - added;
  return { gain, pct: !moved && a.v > 0 ? (gain / a.v) * 100 : null, added: moved ? added : 0 };
}

const pointLabel = (p: ChartPoint, now: Date) => (p.close ? 'Previous close' : isDay(p.t) ? day(p.t, now) : time(p.t));

const STORE_KEY = 'psx-home-range';
const savedRange = (): ChartRange => {
  try { const v = localStorage.getItem(STORE_KEY); return RANGES.includes(v as ChartRange) ? (v as ChartRange) : '1M'; } catch { return '1M'; }
};

export function PortfolioChart({ ticks, daily, current, moves = [], now = new Date() }: {
  ticks: PortfolioTick[]; daily: PortfolioDay[]; current?: CurrentValue | null; moves?: MoneyMove[]; now?: Date;
}) {
  const [range, setRange] = useState<ChartRange>(savedRange);
  const [hover, setHover] = useState<number | null>(null);
  const pick = (r: ChartRange) => {
    haptic();
    setRange(r);
    setHover(null);
    try { localStorage.setItem(STORE_KEY, r); } catch { /* private mode */ }
  };
  const points = seriesFor(range, ticks, daily, now, current);
  const change = rangeChange(points, moves);

  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Chart range" className="flex gap-1">
        {RANGES.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={range === r} onClick={() => pick(r)}
            className={`press min-h-11 flex-1 cursor-pointer rounded-control text-14 font-semibold ${range === r ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'}`}>
            {r}
          </button>
        ))}
      </div>
      {points.length < 2
        ? <BuildsFrom range={range} points={points} now={now} />
        : <Line points={points} hover={hover} setHover={setHover} change={change} range={range} now={now} />}
    </div>
  );
}

function BuildsFrom({ range, points, now }: { range: ChartRange; points: ChartPoint[]; now: Date }) {
  const from = points[0] ? pointLabel(points[0], now) : null;
  const text = range === '1D'
    ? from ? `Today's line builds from ${from}: a point at each market check.` : "Today's line builds from the next market check (every 30 minutes while the market is open)."
    : `Your value chart builds from ${from ?? day(pktDate(now), now)}: one point each trading day.`;
  return (
    <div className="flex h-40 items-center justify-center rounded-control bg-surface-2 px-6 text-center lg:h-48">
      <p className="text-14 text-muted">{text}</p>
    </div>
  );
}

function Line({ points, hover, setHover, change, range, now }: {
  points: ChartPoint[]; hover: number | null; setHover: (i: number | null) => void;
  change: ReturnType<typeof rangeChange>; range: ChartRange; now: Date;
}) {
  const gradId = useId();
  const box = useRef<HTMLDivElement>(null);
  const W = 300, H = 120, PAD = 6;
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || Math.max(1, max * 0.01);
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);
  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  const tone = change == null || Math.abs(change.gain) < 0.5 ? 'text-muted' : change.gain > 0 ? 'text-up' : 'text-down';
  const active = hover != null ? points[hover] : null;

  // A range with less stored history than it asks for says where it starts.
  const first = points[0], last = points[points.length - 1];
  const cutoff = isDay(last.t) ? rangeCutoff(range, last.t) : null;
  const short = range === 'All' || (cutoff != null && first.t > addDays(cutoff, 3));
  const words = range === '1D' ? sessionLabel(last.t, now) : short ? `Since ${day(first.t, now)}` : RANGE_WORDS[range];

  const onMove = (clientX: number) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setHover(Math.round(k * (points.length - 1)));
  };

  return (
    <div className="space-y-1">
      <div className="flex min-h-6 flex-wrap items-baseline justify-between gap-x-3 text-14">
        {active
          ? <span className="text-ink"><span className="text-muted">{pointLabel(active, now)}</span> · <b>{rs(active.v)}</b></span>
          : (
            <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
              {change && <Change kind="rs" value={change.gain} className="font-semibold" label={words} />}
              {change?.pct != null && <Change value={change.pct} className="font-semibold" />}
              <span className="text-muted">{words}</span>
            </span>
          )}
        {!active && change != null && change.added !== 0 && (
          <span className="text-12 text-muted">not counting {rs(Math.abs(change.added))} {change.added > 0 ? 'added' : 'taken out'}</span>
        )}
      </div>
      <div ref={box} className={`relative h-40 lg:h-48 ${tone}`} style={{ touchAction: 'pan-y' }}
        onPointerMove={(e) => onMove(e.clientX)} onPointerDown={(e) => onMove(e.clientX)} onPointerLeave={() => setHover(null)} onPointerCancel={() => setHover(null)}
        role="img" aria-label={`Portfolio value, ${words.toLowerCase()}: from ${rs(first.v)} to ${rs(last.v)}`}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.18" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" x2={W} y1={y(first.v)} y2={y(first.v)} stroke="var(--color-line)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <polygon points={area} fill={`url(#${gradId})`} />
          <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="var(--color-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        </svg>
        {/* The dot is HTML so the stretched SVG never turns it into an oval. */}
        {(() => {
          const i = hover ?? points.length - 1;
          return <span aria-hidden="true" className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-surface"
            style={{ left: `${(x(i) / W) * 100}%`, top: `${(y(points[i].v) / H) * 100}%` }} />;
        })()}
      </div>
      <div className="flex justify-between text-12 text-muted">
        <span>{pointLabel(first, now)}</span>
        <span>{pointLabel(last, now)}</span>
      </div>
    </div>
  );
}
