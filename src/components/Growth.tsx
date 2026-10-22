/**
 * Wealth growth: today's value + monthly SIP (rising by the yearly step-up from Profile), at a chosen yearly return.
 * Shows future rupees and the same amount in today's money (inflation from Profile). Tap the chart to read a year.
 */
import { useMemo, useState } from 'react';
import { GROWTH_SCENARIOS, projectWealth, realValue } from '../../shared/growth.ts';
import { rs, rsShort } from '../../shared/format.ts';
import { DEFAULT_SETTINGS } from '../../shared/types.ts';
import { haptic } from '../lib/gestures.ts';
import { Segmented } from './ui.tsx';

const YEARS = [5, 10, 15, 20] as const;

export function GrowthCard({ start, monthly, stepUpPct = 0, inflationPct = DEFAULT_SETTINGS.inflation_pct }: {
  start: number; monthly: number; stepUpPct?: number; inflationPct?: number;
}) {
  const [scenario, setScenario] = useState<(typeof GROWTH_SCENARIOS)[number]['id']>('steady');
  const [years, setYears] = useState<(typeof YEARS)[number]>(10);
  const [at, setAt] = useState<number | null>(null);
  const rate = GROWTH_SCENARIOS.find((s) => s.id === scenario)!.rate;
  const g = useMemo(() => projectWealth({ start, monthly, annualReturnPct: rate, years, stepUpPct }), [start, monthly, rate, years, stepUpPct]);
  const point = g.points[at ?? years];
  const todayMoney = realValue(point.value, inflationPct, point.year);

  const w = 300, h = 120, pad = 4;
  const max = g.points[g.points.length - 1].value || 1;
  const x = (i: number) => pad + (i / years) * (w - pad * 2);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  const line = (k: 'value' | 'invested') => g.points.map((p, i) => `${x(i)},${y(p[k])}`).join(' ');

  return (
    <div className="space-y-3">
      <Segmented label="Return assumption" value={scenario} onChange={setScenario}
        options={GROWTH_SCENARIOS.map((s) => ({ value: s.id, label: `${s.label} ${s.rate}%` }))} />
      <div className="flex gap-1.5" role="group" aria-label="Years">
        {YEARS.map((yv) => (
          <button key={yv} type="button" onClick={() => { haptic(); setYears(yv); setAt(null); }} aria-pressed={years === yv}
            className={`press min-h-11 flex-1 cursor-pointer rounded-control text-14 font-semibold ${years === yv ? 'bg-brand text-canvas' : 'bg-surface-2 text-ink'}`}>{yv} years</button>
        ))}
      </div>
      <div>
        <p className="text-14 text-muted">{point.year === 0 ? 'Today' : `In ${point.year} year${point.year > 1 ? 's' : ''}`}</p>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="num text-28 font-bold">{rs(point.value)}</p>
          {point.year > 0 && <p className="num text-16 text-ink">≈ {rs(todayMoney)} <span className="text-14 text-muted">in today's money</span></p>}
        </div>
        <p className="num text-14 text-muted">You put in {rs(point.invested)} · growth {rs(point.value - point.invested)}</p>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-32 w-full touch-pan-y text-info" role="img"
        aria-label={`Projected ${rs(g.final)} after ${years} years at ${rate}% a year, about ${rs(realValue(g.final, inflationPct, years))} in today's money; ${rs(g.invested)} invested`}
        onPointerMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setAt(Math.max(0, Math.min(years, Math.round(((e.clientX - box.left) / box.width) * years))));
        }}
        onPointerLeave={() => setAt(null)}>
        <defs>
          <linearGradient id="growthFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`${x(0)},${h - pad} ${line('value')} ${x(years)},${h - pad}`} fill="url(#growthFill)" />
        <polyline points={line('value')} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <polyline points={line('invested')} fill="none" strokeWidth="1.5" strokeDasharray="4 4" className="stroke-muted" />
        {at != null && <line x1={x(at)} x2={x(at)} y1={pad} y2={h - pad} strokeWidth="1" className="stroke-muted" />}
        {at != null && <circle cx={x(at)} cy={y(point.value)} r="4" fill="currentColor" />}
      </svg>
      <div className="flex items-center justify-between text-12 text-muted">
        <span>Now</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 rounded bg-info" />Value</span>
          <span className="flex items-center gap-1"><span className="w-4 border-t border-dashed border-muted" />You put in</span>
        </span>
        <span className="num">{years}y · {rsShort(g.final)}</span>
      </div>
      <p className="text-14 leading-snug text-muted">
        {rs(monthly)} a month{stepUpPct > 0 ? `, rising ${stepUpPct}% every year,` : ''} at {rate}% a year, compounded monthly. Today's money assumes
        inflation averages {inflationPct}% a year. An illustration, not a forecast: PSX returns swing a lot from year to year.
      </p>
    </div>
  );
}
