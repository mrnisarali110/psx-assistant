/**
 * Bull market ON/OFF and the State Bank policy rate. A one-line button on the Home KSE-100 card opens a sheet with the
 * status and its reasons, the KSE-100 with ON and OFF periods shaded, the rate history with its easing and tightening
 * cycles, and a rule-of-thumb split for spare cash. Display only: every figure comes from shared/regime.ts and every
 * threshold from rules.json (`regime`). Colour always backs up a word (ON, OFF, Easing, Tightening), never replaces it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppData } from '../lib/data.ts';
import {
  allocation, marketBreadth, rateCycles, rateState, regimePeriods, type PolicyRate, type RateCycle, type RatePeriod, type RegimePeriod,
} from '../../shared/regime.ts';
import { daysBetween, pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES, type IndexDay } from '../../shared/types.ts';
import { num } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Tag } from './ui.tsx';

const RULES = DEFAULT_RULES.regime;
const muted = 'text-slate-500 dark:text-slate-400';
const SBP_URL = 'https://www.sbp.org.pk/our-operations/monetary-policy';
const RATE_CHART_FROM = '2015-01-01';

/** "Oct 5, 2026": the sheet spans years, so dates carry the year. */
const fullDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z'));
const plural = (v: number, word: string) => `${v} ${word}${v === 1 ? '' : 's'}`;
/** 12 days, 3.4 months, 2.1 years. */
function duration(days: number): string {
  if (days < 60) return plural(Math.max(0, days), 'day');
  if (days < 730) return `${(days / 30.44).toFixed(1)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}
/** +1.0, -0.5, +0.25 percentage points. */
const points = (v: number) => `${v > 0 ? '+' : ''}${Number.isInteger(v * 10) ? v.toFixed(1) : v.toFixed(2)} points`;
const CYCLE_WORD: Record<RateCycle, string> = { easing: 'Easing', tightening: 'Tightening', on_hold: 'On hold' };

function useMood(data: AppData) {
  return useMemo(() => {
    const today = pktDate(new Date());
    const periods = regimePeriods(data.regime, today);
    const latest = data.regime.at(-1) ?? null;
    const current = periods.at(-1) ?? null;
    const rate = rateState(data.policyRates, today);
    const breadth = marketBreadth(data.screen);
    const mix = allocation({
      bull: latest ? latest.bull : null, rate,
      earnings_yield_pct: latest?.earnings_yield_pct ?? breadth.earnings_yield_pct, dividend_yield_pct: breadth.dividend_yield_pct,
    });
    return { today, periods, latest, current, rate, mix };
  }, [data.regime, data.policyRates, data.screen]);
}

/** `#/home?market` (the link in a bull/bear flip or rate-change notification) opens the sheet. */
const marketInHash = () => new URLSearchParams(location.hash.split('?')[1] ?? '').has('market');

/** The Home line: a pill with ON/OFF and how long, plus the policy rate. Opens the sheet. */
export function MarketMoodLine({ data }: { data: AppData }) {
  const [open, setOpen] = useState(marketInHash);
  useEffect(() => {
    const onHash = () => { if (marketInHash()) setOpen(true); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const close = useCallback(() => { setOpen(false); if (marketInHash()) location.hash = '/home'; }, []);
  const m = useMood(data);
  const on = m.current?.bull;
  const status = m.current ? `Bull market ${on ? 'ON' : 'OFF'} · ${plural(m.current.days, 'day')}` : 'Bull market: building data';
  const rateText = m.rate ? `Policy rate ${m.rate.rate}%` : null;
  const tone = m.current == null ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
    : on ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-300';
  const dot = m.current == null ? 'bg-slate-400' : on ? 'bg-emerald-500' : 'bg-rose-500';
  return (
    <>
      <button type="button" onClick={() => { haptic(); setOpen(true); }} aria-haspopup="dialog"
        aria-label={`${status}${rateText ? `, ${rateText}` : ''}. Open market mood and interest rate details`}
        className={`press mt-2 flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-2xl px-3 py-2 text-left text-xs transition active:scale-[0.99] ${tone}`}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 leading-snug">
          <span className="font-semibold">{status}</span>
          {rateText && <span className="opacity-80"> · {rateText}</span>}
        </span>
        <Icon name="chevron" className="h-4 w-4 shrink-0 opacity-70" />
      </button>
      <MarketSheet open={open} onClose={close} data={data} />
    </>
  );
}

/** The full picture: trend status, its history, the policy rate and its cycles, and where spare cash could go. */
export function MarketSheet({ open, onClose, data }: { open: boolean; onClose: () => void; data: AppData }) {
  const m = useMood(data);
  const { current, latest, rate, mix, periods, today } = m;
  const cycles = useMemo(() => rateCycles(data.policyRates, today), [data.policyRates, today]);
  const ratesNote = RULES.rates_note.replace(/^VERIFY:\s*/, '');
  const unverified = RULES.rates_note.startsWith('VERIFY');

  return (
    <Sheet open={open} onClose={onClose} title="Market mood and interest rate">
      <div className="space-y-6 pb-4">
        {/* 1. Status */}
        <section aria-labelledby="mm-status">
          <h3 id="mm-status" className="sr-only">Bull market status</h3>
          <div className={`flex items-center gap-3 rounded-3xl px-4 py-3 ${current == null ? 'bg-slate-100 dark:bg-slate-800' : current.bull ? 'bg-emerald-50 dark:bg-emerald-950' : 'bg-rose-50 dark:bg-rose-950'}`}>
            <div className="shrink-0">
              <p className={`text-[10px] font-semibold tracking-wide uppercase ${muted}`}>Bull market</p>
              <p className={`text-3xl leading-none font-extrabold tracking-tight ${current == null ? 'text-slate-700 dark:text-slate-200' : current.bull ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                {current == null ? '…' : current.bull ? 'ON' : 'OFF'}
              </p>
            </div>
            <p className="min-w-0 flex-1 text-sm leading-snug">
              {current == null ? 'Building data: the night check stores one reading per trading day, and the first one decides ON or OFF.'
                : <>Since <b>{fullDate(current.from)}</b> · {duration(current.days)}{periods.length === 1 ? <span className={muted}> (readings start that day)</span> : null}</>}
            </p>
          </div>
          {latest && latest.reasons.length > 0 && (
            <>
              <p className={`mt-3 text-xs font-semibold ${muted}`}>Why, as of {fullDate(latest.day)}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {latest.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </>
          )}
          <p className={`mt-3 text-xs leading-relaxed ${muted}`}><span className="font-semibold">The rule: </span>{RULES.rule_note}</p>
        </section>

        {/* 2. KSE-100 with ON/OFF shading */}
        <section aria-labelledby="mm-trend">
          <h3 id="mm-trend" className="font-semibold">KSE-100 with ON and OFF periods</h3>
          {data.indexDaily.length < 2 ? (
            <p className={`mt-1 text-sm ${muted}`}>History builds up daily: the night check stores the KSE-100 close each trading day, and the chart draws itself once there are two to join.</p>
          ) : (
            <IndexChart closes={data.indexDaily} periods={periods} today={today} />
          )}
        </section>

        {/* 3. Periods */}
        <section aria-labelledby="mm-periods">
          <h3 id="mm-periods" className="font-semibold">On and off periods</h3>
          {periods.length === 0 ? (
            <p className={`mt-1 text-sm ${muted}`}>None yet. Each stretch appears here once the night check starts storing readings.</p>
          ) : (
            <ul className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
              {[...periods].reverse().map((p) => (
                <li key={p.from} className="flex items-center gap-3 py-2">
                  <Tag tone={p.bull ? 'green' : 'red'}>{p.bull ? 'ON' : 'OFF'}</Tag>
                  <span className="num min-w-0 flex-1 text-sm">{fullDate(p.from)} – {p.to ? fullDate(p.to) : 'now'}</span>
                  <span className={`num shrink-0 text-xs ${muted}`}>{duration(p.days)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 4. Interest rate */}
        <section aria-labelledby="mm-rate">
          <h3 id="mm-rate" className="font-semibold">State Bank policy rate</h3>
          {rate == null ? (
            <p className={`mt-1 text-sm ${muted}`}>No policy-rate history loaded yet.</p>
          ) : (
            <>
              <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-1">
                <p className="num text-3xl font-bold tracking-tight">{rate.rate}%</p>
                <div className="pb-1">
                  <Tag tone={rate.cycle === 'easing' ? 'green' : rate.cycle === 'tightening' ? 'amber' : 'slate'}>{CYCLE_WORD[rate.cycle]}</Tag>
                </div>
              </div>
              <p className={`num text-sm ${muted}`}>
                Decided {fullDate(rate.decided_on)}
                {rate.last_change_pct != null ? ` · last change ${points(rate.last_change_pct)}` : ''}
                {rate.months_since_change != null ? ` · ${plural(rate.months_since_change, 'month')} ago` : ''}
              </p>
              {rate.cycle === 'on_hold' && rate.direction && (
                <p className={`text-xs ${muted}`}>No change for {RULES.rate_hold_months} months or more, so the last {rate.direction} cycle counts as on hold.</p>
              )}
              <RateChart rates={data.policyRates} cycles={cycles} today={today} />
              <h4 className={`mt-4 text-[13px] font-semibold tracking-wide uppercase ${muted}`}>Rate cycles</h4>
              <ul className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                {[...cycles].reverse().map((c) => (
                  <li key={c.from} className="py-2">
                    <div className="flex items-center gap-2">
                      <Tag tone={c.cycle === 'easing' ? 'green' : 'amber'}>{c.cycle === 'easing' ? 'Easing' : 'Tightening'}</Tag>
                      <span className="num min-w-0 flex-1 text-sm font-medium">{c.start_rate}% → {c.end_rate}%</span>
                      <span className={`num shrink-0 text-xs ${muted}`}>{duration(c.days)}</span>
                    </div>
                    <p className={`num mt-0.5 text-xs ${muted}`}>{fullDate(c.from)} – {c.to ? fullDate(c.to) : 'now'} · {plural(c.changes, 'change')}</p>
                  </li>
                ))}
              </ul>
              <p className={`mt-2 text-xs ${muted}`}>
                Source: State Bank of Pakistan,{' '}
                <a href={SBP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 font-medium text-teal-700 underline underline-offset-2 dark:text-teal-400">
                  monetary policy<Icon name="external" className="h-3.5 w-3.5" />
                </a>
              </p>
            </>
          )}
        </section>

        {/* 5. Where spare cash could go */}
        <section aria-labelledby="mm-mix">
          <h3 id="mm-mix" className="font-semibold">Where spare cash could go</h3>
          <p className={`text-xs ${muted}`}>A rule of thumb from the two signals above, not advice. Your monthly investment (SIP) and crash fund stay as they are.</p>
          <p className="mt-2 text-sm font-semibold">{mix.headline}</p>
          <ul className="mt-2 space-y-3">
            {mix.rows.map((r) => (
              <li key={r.key}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0">{r.label}</span>
                  <span className="num shrink-0 font-semibold">{r.pct}%</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="img" aria-label={`${r.label}: ${r.pct}%`}>
                  <div className={`h-full rounded-full ${r.key === 'stocks' ? 'bg-teal-500' : r.key === 'equity_funds' ? 'bg-sky-500' : 'bg-slate-400 dark:bg-slate-500'}`} style={{ width: `${r.pct}%` }} />
                </div>
                <p className={`num mt-0.5 text-xs ${muted}`}>
                  {r.yield_pct != null ? `about ${r.yield_pct}% a year${r.key === 'stocks' ? ' earnings yield' : ' (estimate)'} · ${r.note}`
                    : r.key === 'stocks' && r.note === 'earnings yield' ? 'earnings yield: no PSX figure yet' : r.note}
                </p>
              </li>
            ))}
          </ul>
          {mix.reasons.length > 0 && (
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm">
              {mix.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          <p className={`mt-3 text-xs leading-relaxed ${muted}`}>{RULES.mix_note}</p>
          <p className={`mt-1 text-[11px] leading-relaxed ${muted}`}>
            {unverified && <span className="mr-1 align-middle"><Tag tone="amber">to verify</Tag></span>}
            {ratesNote}
          </p>
        </section>
      </div>
    </Sheet>
  );
}

const W = 300;
const H = 140;
const PAD = 6;
const BOTTOM = 20; // room for the x labels inside the rate chart

/** KSE-100 closes on a time scale, with each ON stretch shaded green and each OFF stretch rose behind the line. */
function IndexChart({ closes, periods, today }: { closes: IndexDay[]; periods: RegimePeriod[]; today: string }) {
  const first = closes[0].day;
  const last = closes[closes.length - 1].day;
  const span = Math.max(1, daysBetween(first, last));
  const vals = closes.map((c) => c.close);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { lo -= 1; hi += 1; }
  const x = (day: string) => PAD + (Math.min(span, Math.max(0, daysBetween(first, day))) / span) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);
  const line = closes.map((c) => `${x(c.day).toFixed(1)},${y(c.close).toFixed(1)}`).join(' ');
  const bands = periods
    .map((p) => ({ ...p, a: p.from < first ? first : p.from, b: (p.to ?? today) > last ? last : (p.to ?? today) }))
    .filter((p) => p.a <= last && p.b >= first && p.a <= p.b);
  const onDays = bands.filter((b) => b.bull).length, offDays = bands.filter((b) => !b.bull).length;
  const label = `KSE-100 from ${fullDate(first)} (${num(closes[0].close, 0)}) to ${fullDate(last)} (${num(closes[closes.length - 1].close, 0)})`
    + (bands.length ? `, with ${plural(onDays, 'ON period')} and ${plural(offDays, 'OFF period')} shaded.` : '. No ON or OFF readings in this range yet.');
  return (
    <div className="mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label={label}>
        {bands.map((b) => (
          <rect key={b.from} x={x(b.a)} y={0} width={Math.max(1.5, x(b.b) - x(b.a))} height={H}
            className={b.bull ? 'fill-emerald-500/15 dark:fill-emerald-400/15' : 'fill-rose-500/12 dark:fill-rose-400/15'} />
        ))}
        <polyline points={line} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="stroke-slate-800 dark:stroke-slate-100" />
      </svg>
      <div className={`num flex items-center justify-between text-[11px] ${muted}`}>
        <span>{fullDate(first)}</span>
        <span>{fullDate(last)}</span>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-sm bg-emerald-500/25" aria-hidden="true" />ON (green)</li>
        <li className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-sm bg-rose-500/20" aria-hidden="true" />OFF (rose)</li>
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-slate-800 dark:bg-slate-100" aria-hidden="true" />KSE-100 close</li>
      </ul>
    </div>
  );
}

/** The policy rate as a step line since 2015, easing cycles shaded green and tightening amber, years along the bottom. */
function RateChart({ rates, cycles, today }: { rates: PolicyRate[]; cycles: RatePeriod[]; today: string }) {
  const sorted = useMemo(() => [...rates].sort((a, b) => a.decided_on.localeCompare(b.decided_on)), [rates]);
  const start = sorted.some((r) => r.decided_on <= RATE_CHART_FROM) ? RATE_CHART_FROM : sorted[0]?.decided_on;
  if (!start) return null;
  const before = sorted.filter((r) => r.decided_on <= start).at(-1);
  const steps: { day: string; v: number }[] = [];
  if (before) steps.push({ day: start, v: before.policy_rate });
  for (const r of sorted) if (r.decided_on > start && r.decided_on <= today && r.policy_rate !== steps.at(-1)?.v) steps.push({ day: r.decided_on, v: r.policy_rate });
  if (!steps.length) return null;
  const span = Math.max(1, daysBetween(start, today));
  const vals = steps.map((s) => s.v);
  let lo = Math.floor(Math.min(...vals)), hi = Math.ceil(Math.max(...vals));
  if (hi === lo) { lo -= 1; hi += 1; }
  const L = 22; // room for the % labels
  const x = (day: string) => L + (Math.min(span, Math.max(0, daysBetween(start, day))) / span) * (W - L - PAD);
  const y = (v: number) => H - BOTTOM - ((v - lo) / (hi - lo)) * (H - BOTTOM - PAD);
  let d = `M${x(steps[0].day).toFixed(1)},${y(steps[0].v).toFixed(1)}`;
  for (const s of steps.slice(1)) d += ` H${x(s.day).toFixed(1)} V${y(s.v).toFixed(1)}`;
  d += ` H${x(today).toFixed(1)}`;
  const bands = cycles.filter((c) => (c.to ?? today) >= start).map((c) => ({ ...c, a: c.from < start ? start : c.from, b: c.to ?? today }));
  const y0 = Number(start.slice(0, 4)) + (start.slice(5) === '01-01' ? 0 : 1);
  const years: number[] = [];
  const yEnd = Number(today.slice(0, 4));
  const every = yEnd - y0 > 7 ? 2 : 1;
  for (let yr = y0; yr <= yEnd; yr += every) years.push(yr);
  const mid = Math.round((lo + hi) / 2);
  const ticks = [...new Set([lo, mid, hi])];
  const now = steps.at(-1)!;
  const label = `Policy rate from ${fullDate(start)} to ${fullDate(today)}: ${steps[0].v}% at the start, a high of ${Math.max(...vals)}%, a low of ${Math.min(...vals)}%, and ${now.v}% now. ${plural(bands.filter((b) => b.cycle === 'easing').length, 'easing cycle')} shaded green, ${plural(bands.filter((b) => b.cycle === 'tightening').length, 'tightening cycle')} shaded amber.`;
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full" role="img" aria-label={label}>
        {bands.map((b) => (
          <rect key={b.from} x={x(b.a)} y={PAD} width={Math.max(1.5, x(b.b) - x(b.a))} height={H - BOTTOM - PAD}
            className={b.cycle === 'easing' ? 'fill-emerald-500/15 dark:fill-emerald-400/15' : 'fill-amber-500/20 dark:fill-amber-400/15'} />
        ))}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - PAD} y1={y(t)} y2={y(t)} strokeWidth="0.5" strokeDasharray="2 3" className="stroke-slate-300 dark:stroke-slate-700" />
            <text x={L - 3} y={y(t) + 3} textAnchor="end" fontSize="9" className="fill-slate-500 dark:fill-slate-400">{t}%</text>
          </g>
        ))}
        <path d={d} fill="none" strokeWidth="2" strokeLinejoin="round" className="stroke-slate-800 dark:stroke-slate-100" />
        {years.map((yr) => {
          const day = `${yr}-01-01`;
          return <text key={yr} x={x(day)} y={H - 4} textAnchor="middle" fontSize="9" className="fill-slate-500 dark:fill-slate-400">{yr}</text>;
        })}
      </svg>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-sm bg-emerald-500/25" aria-hidden="true" />Easing (cuts)</li>
        <li className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-sm bg-amber-500/30" aria-hidden="true" />Tightening (hikes)</li>
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-slate-800 dark:bg-slate-100" aria-hidden="true" />Policy rate</li>
      </ul>
    </div>
  );
}
