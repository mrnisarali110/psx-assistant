/** Wealth growth: today's value + monthly SIP (rising by the yearly step-up from Profile), at a chosen yearly return. Tap the chart to read a year. */
import { useMemo, useState } from 'react';
import { GROWTH_SCENARIOS, projectWealth, realValue } from '../../shared/growth.ts';
import { rs, rsShort } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { Segmented } from './ui.tsx';

const YEARS = [5, 10, 15, 20] as const;
const INFLATION = 8; // assumption for the "today's rupees" line

export function GrowthCard({ start, monthly, stepUpPct = 0 }: { start: number; monthly: number; stepUpPct?: number }) {
  const [scenario, setScenario] = useState<(typeof GROWTH_SCENARIOS)[number]['id']>('steady');
  const [years, setYears] = useState<(typeof YEARS)[number]>(10);
  const [at, setAt] = useState<number | null>(null);
  const rate = GROWTH_SCENARIOS.find((s) => s.id === scenario)!.rate;
  const g = useMemo(() => projectWealth({ start, monthly, annualReturnPct: rate, years, stepUpPct }), [start, monthly, rate, years, stepUpPct]);
  const point = g.points[at ?? years];

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
            className={`min-h-9 flex-1 cursor-pointer rounded-xl text-xs font-semibold ${years === yv ? 'bg-teal-700 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}>{yv} years</button>
        ))}
      </div>
      <div>
        <p className="text-xs text-slate-500 dark:text-slate-400">{point.year === 0 ? 'Today' : `In ${point.year} year${point.year > 1 ? 's' : ''}`}</p>
        <p className="num text-2xl font-bold">{rs(point.value)}</p>
        <p className="num text-xs text-slate-500 dark:text-slate-400">You put in {rs(point.invested)} · growth {rs(point.value - point.invested)}</p>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-32 w-full touch-pan-y" role="img"
        aria-label={`Projected ${rs(g.final)} after ${years} years at ${rate}% a year, of which ${rs(g.invested)} invested`}
        onPointerMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setAt(Math.max(0, Math.min(years, Math.round(((e.clientX - box.left) / box.width) * years))));
        }}
        onPointerLeave={() => setAt(null)}>
        <defs>
          <linearGradient id="growthFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#14b8a6" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#14b8a6" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`${x(0)},${h - pad} ${line('value')} ${x(years)},${h - pad}`} fill="url(#growthFill)" />
        <polyline points={line('value')} fill="none" stroke="#0d9488" strokeWidth="2.5" strokeLinejoin="round" />
        <polyline points={line('invested')} fill="none" strokeWidth="1.5" strokeDasharray="4 4" className="stroke-slate-400" />
        {at != null && <line x1={x(at)} x2={x(at)} y1={pad} y2={h - pad} strokeWidth="1" className="stroke-slate-400" />}
        {at != null && <circle cx={x(at)} cy={y(point.value)} r="4" fill="#0d9488" />}
      </svg>
      <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
        <span>Now</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 rounded bg-teal-600" />Value</span>
          <span className="flex items-center gap-1"><span className="w-4 border-t border-dashed border-slate-400" />You put in</span>
        </span>
        <span>{years}y · {rsShort(g.final)}</span>
      </div>
      <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
        {rs(monthly)} a month{stepUpPct > 0 ? `, rising ${stepUpPct}% every year,` : ''} at {rate}% a year, compounded monthly. About {rs(realValue(g.final, INFLATION, years))} in today’s money if inflation averages {INFLATION}%.
        An illustration, not a forecast: PSX returns swing a lot from year to year.
      </p>
    </div>
  );
}
