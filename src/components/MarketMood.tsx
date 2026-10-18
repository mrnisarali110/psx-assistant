/**
 * Market Compass in the app. `MarketCard` is the glance on Home (KSE-100, the action for extra money, three lights and
 * a rates strip); `MarketDetails` is the Market page: the compass with its reasons, the P/E gauge, shares against safe
 * yield, the trend chart, rates and inflation, Pakistan at a glance, and where spare cash could go.
 * Display only: every figure comes from shared/compass.ts and shared/regime.ts, every threshold from rules.json
 * (`compass`, `regime`). Colour always backs up a word (Cheap, Sideways, Bonds pay more), never replaces it, and a
 * figure we don't have shows as "n/a", never a guess.
 */
import { useMemo, type ReactNode } from 'react';
import type { AppData } from '../lib/data.ts';
import { compass, GAP_WORD, TREND_WORD, VALUE_WORD, type ActionKey, type Compass, type GapState, type Latest, type Trend, type ValueState } from '../../shared/compass.ts';
import { marketBreadth, rateCycles, type PolicyRate, type RateCycle, type RatePeriod, type RegimeDay } from '../../shared/regime.ts';
import { daysBetween, pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES, type IndexDay } from '../../shared/types.ts';
import { asOfLabel, num, pct } from '../../shared/format.ts';
import { Icon } from './Icon.tsx';
import { Card, Tag, changeTone } from './ui.tsx';

const RULES = DEFAULT_RULES.regime;
const K = DEFAULT_RULES.compass;
const muted = 'text-slate-500 dark:text-slate-400';
const SBP_URL = 'https://www.sbp.org.pk/our-operations/monetary-policy';
const RATE_CHART_FROM = '2015-01-01';
const SIP_LINE = 'Your monthly investment (SIP) always runs; only extra money changes.';
const linkCls = 'inline-flex min-h-11 items-center gap-1 font-medium text-teal-700 underline underline-offset-2 dark:text-teal-400';

/** "Oct 5, 2026": the sheet spans years, so dates carry the year. */
const fullDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z'));
/** "Sep 2026" for a monthly figure such as CPI. */
const monthLabel = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(iso + 'T00:00:00Z'));
const plural = (v: number, word: string) => `${v} ${word}${v === 1 ? '' : 's'}`;
/** 12 days, 3.4 months, 2.1 years. */
function duration(days: number): string {
  if (days < 60) return plural(Math.max(0, days), 'day');
  if (days < 730) return `${(days / 30.44).toFixed(1)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}
/** +1.2, −0.4 (a true minus sign, so it reads well and doesn't wrap). */
const signed = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
/** +1.0, -0.5, +0.25 percentage points. */
const points = (v: number) => `${v > 0 ? '+' : ''}${Number.isInteger(v * 10) ? v.toFixed(1) : v.toFixed(2)} points`;
const pc = (v: number | null | undefined, digits = 1) => (v == null ? null : `${v.toFixed(digits)}%`);
const CYCLE_WORD: Record<RateCycle, string> = { easing: 'Easing', tightening: 'Tightening', on_hold: 'On hold' };

/** A rules note: "VERIFY:" in front (or "VERIFY." at the end) becomes an amber "to verify" tag. */
function Note({ text, className = '' }: { text: string; className?: string }) {
  const unverified = /VERIFY/.test(text);
  const stripped = text.replace(/^VERIFY:\s*/, '').replace(/,\s*VERIFY\.?\s*$/, '.');
  const body = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return (
    <p className={`text-[11px] leading-relaxed ${muted} ${className}`}>
      {unverified && <span className="mr-1 align-middle"><Tag tone="amber">to verify</Tag></span>}
      {body}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The shared reading
// ---------------------------------------------------------------------------
/** Trend shading: the stored three-way trend, or "not up" for rows from before the compass (OFF on the old rule). */
type TrendKey = Trend | 'not_up';
interface TrendPeriod { key: TrendKey; from: string; to: string | null; days: number }
const TREND_KEY_WORD: Record<TrendKey, string> = { ...TREND_WORD, not_up: 'Not up' };

function trendKey(d: RegimeDay): TrendKey {
  return d.trend ?? (d.bull ? 'up' : 'not_up');
}
function trendPeriods(days: { day: string; key: TrendKey }[], today: string): TrendPeriod[] {
  const out: TrendPeriod[] = [];
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    const cur = out.at(-1);
    if (cur && cur.key === d.key) continue;
    if (cur) { cur.to = d.day; cur.days = daysBetween(cur.from, d.day); }
    out.push({ key: d.key, from: d.day, to: null, days: 0 });
  }
  const last = out.at(-1);
  if (last) last.days = daysBetween(last.from, today);
  return out;
}

/**
 * Everything the market views need, shared by Home and the Market page. The compass is worked out here from the same
 * data and rules the night check uses (stored readings only feed the trend history); unknown stays unknown.
 */
export function useCompass(data: AppData) {
  return useMemo(() => {
    const today = pktDate(new Date());
    const indexDay = data.index ? pktDate(new Date(data.index.ts)) : today;
    const breadth = marketBreadth(data.screen);
    const c = compass({
      today, closes: data.indexDaily.filter((d) => d.day < indexDay), close: data.index?.kse100 ?? null,
      breadth, macro: data.macro, rates: data.policyRates,
    });
    let provisional = false;
    let rows = data.regime.map((d) => ({ day: d.day, key: trendKey(d) }));
    if (!rows.length && c.trend.state) { rows = [{ day: indexDay, key: c.trend.state }]; provisional = true; }
    const periods = trendPeriods(rows, today);
    return { today, indexDay, c, breadth, periods, provisional };
  }, [data.regime, data.policyRates, data.screen, data.index, data.indexDaily, data.macro]);
}

// ---------------------------------------------------------------------------
// Light tones: colour backs the word, the word carries the meaning
// ---------------------------------------------------------------------------
type Mood = 'good' | 'neutral' | 'caution' | 'bad' | 'unknown';
const MOOD: Record<Mood, { pill: string; dot: string; panel: string; word: string }> = {
  good: { pill: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', dot: 'bg-emerald-500', panel: 'bg-emerald-50 dark:bg-emerald-950/60', word: 'text-emerald-800 dark:text-emerald-300' },
  neutral: { pill: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', dot: 'bg-sky-500', panel: 'bg-sky-50 dark:bg-sky-950/50', word: 'text-sky-800 dark:text-sky-300' },
  caution: { pill: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300', dot: 'bg-amber-500', panel: 'bg-amber-50 dark:bg-amber-950/50', word: 'text-amber-900 dark:text-amber-300' },
  bad: { pill: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300', dot: 'bg-rose-500', panel: 'bg-rose-50 dark:bg-rose-950/50', word: 'text-rose-800 dark:text-rose-300' },
  unknown: { pill: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400', dot: 'bg-slate-400', panel: 'bg-slate-50 dark:bg-slate-800/60', word: 'text-slate-500 dark:text-slate-400' },
};
const VALUE_MOOD: Record<ValueState, Mood> = { cheap: 'good', fair: 'neutral', expensive: 'bad' };
const GAP_MOOD: Record<GapState, Mood> = { shares: 'good', even: 'neutral', safe: 'caution' };
const TREND_MOOD: Record<TrendKey, Mood> = { up: 'good', sideways: 'neutral', down: 'bad', not_up: 'unknown' };
const ACTION_MOOD: Record<ActionKey, Mood> = { add_extra: 'good', buy_in_steps: 'neutral', on_schedule: 'neutral', park_extra: 'caution' };

interface LightView { id: string; label: string; word: string | null; figure: string | null; mood: Mood }

function lights(c: Compass): LightView[] {
  const t = c.trend;
  return [
    { id: 'value', label: 'Value', word: c.value.state ? VALUE_WORD[c.value.state] : null, figure: c.value.pe != null ? `P/E ${c.value.pe.toFixed(1)}x` : null, mood: c.value.state ? VALUE_MOOD[c.value.state] : 'unknown' },
    { id: 'gap', label: 'Shares vs bonds', word: c.gap.state ? GAP_WORD[c.gap.state] : null, figure: c.gap.spread_pct != null ? `${signed(c.gap.spread_pct)} pts` : null, mood: c.gap.state ? GAP_MOOD[c.gap.state] : 'unknown' },
    { id: 'trend', label: 'Trend', word: t.state ? TREND_WORD[t.state] : null, figure: t.one_year_pct != null ? `${signed(t.one_year_pct)}% 1y` : null, mood: t.state ? TREND_MOOD[t.state] : 'unknown' },
  ];
}

function LightPill({ word, mood, big = false }: { word: string | null; mood: Mood; big?: boolean }) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 font-semibold ${big ? 'rounded-full px-3 py-1 text-sm' : 'rounded-xl px-2 py-0.5 text-xs leading-snug'} ${MOOD[word ? mood : 'unknown'].pill}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${MOOD[word ? mood : 'unknown'].dot}`} aria-hidden="true" />
      <span className="min-w-0">{word ?? 'n/a'}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Home: the glance
// ---------------------------------------------------------------------------
/** Home: the market at a glance. The whole card opens the Market page. */
export function MarketCard({ data, onOpen, footnote }: { data: AppData; onOpen: () => void; footnote?: ReactNode }) {
  const { c, periods, today } = useCompass(data);
  const idx = data.index;
  const mood = ACTION_MOOD[c.action.key];
  const rates: { label: string; value: string | null }[] = [
    { label: 'Policy', value: pc(c.rates.policy?.rate) },
    { label: 'CPI', value: pc(c.rates.cpi?.value) },
    { label: 'Real', value: c.rates.real_rate_pct != null ? `${signed(c.rates.real_rate_pct)}%` : null },
    { label: 'T-bill 3M', value: pc(c.gap.tbill_3m?.value) },
  ];
  return (
    <Card onClick={onOpen} className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-xs ${muted}`}>Market · KSE-100</p>
          <p className="num text-2xl font-bold tracking-tight">{idx ? num(idx.kse100, 0) : 'no data'}</p>
          <p className={`num text-xs font-semibold ${changeTone(idx?.change_pct)}`}>{pct(idx?.change_pct, 2)} today</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-teal-700 dark:text-teal-400">
          <Icon name="compass" className="h-4 w-4" />Compass<Icon name="chevron" className="h-4 w-4" />
        </span>
      </div>

      <div className={`rounded-2xl px-3 py-2.5 ${MOOD[mood].panel}`}>
        <p className={`text-[15px] leading-snug font-semibold ${MOOD[mood].word}`}>{c.action.title}</p>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
          <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />Your monthly investment stays on
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-2">
        {lights(c).map((l) => (
          <div key={l.id} className="min-w-0 rounded-2xl bg-slate-50 px-2 py-2 dark:bg-slate-800/60">
            <dt className={`truncate text-[11px] ${muted}`}>{l.label}</dt>
            <dd className="mt-1"><LightPill word={l.word} mood={l.mood} /></dd>
            <dd className={`num mt-1 text-xs ${l.figure ? 'font-semibold' : muted}`}>{l.figure ?? (l.word ? 'n/a' : 'no data yet')}</dd>
          </div>
        ))}
      </dl>

      <p className="num flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-slate-600 dark:text-slate-300" aria-label="Rates">
        {rates.map((r, i) => (
          <span key={r.label} className="whitespace-nowrap">
            {r.label} <b className={r.value ? 'font-semibold' : `font-normal ${muted}`}>{r.value ?? 'n/a'}</b>{i < rates.length - 1 && <span className={`ml-2 ${muted}`} aria-hidden="true">·</span>}
          </span>
        ))}
      </p>

      {data.indexDaily.length >= 2
        ? <IndexChart closes={data.indexDaily} periods={periods} today={today} compact />
        : <MiniTrend values={data.indexHistory.map((i) => i.kse100)} />}
      {footnote && <p className={`text-[11px] ${muted}`}>{footnote}</p>}
    </Card>
  );
}

/** Intraday KSE-100 readings while fewer than two daily closes are stored; nothing at all with fewer than two. */
function MiniTrend({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values) === lo ? lo + 1 : Math.max(...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 300).toFixed(1)},${(56 - ((v - lo) / (hi - lo)) * 52).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg viewBox="0 0 300 60" preserveAspectRatio="none" className="h-14 w-full" role="img" aria-label={`KSE-100 recent readings, ${up ? 'up' : 'down'} from ${num(values[0], 0)} to ${num(values[values.length - 1], 0)}`}>
      <polyline points={pts} fill="none" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className={up ? 'stroke-emerald-500' : 'stroke-rose-500'} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The Market page
// ---------------------------------------------------------------------------
function SectionCard({ id, title, icon, children, className = '' }: { id: string; title: string; icon?: Parameters<typeof Icon>[0]['name']; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`min-w-0 rounded-3xl bg-white p-4 ring-1 ring-slate-200/80 lg:p-5 dark:bg-slate-900 dark:ring-slate-800 ${className}`}>
      <h2 id={id} className="flex items-center gap-2 font-semibold">
        {icon && <Icon name={icon} className="h-4.5 w-4.5 text-teal-600 dark:text-teal-400" />}{title}
      </h2>
      {children}
    </section>
  );
}

const SERIES_SOURCE: Record<string, string> = {
  pib_10y: 'SBP PIB auction', tbill_3m: 'SBP 3-month T-bill auction', tbill_12m: 'SBP 12-month T-bill auction', cpi_yoy: 'PBS inflation release',
  fx_reserves_total: 'SBP reserves', pkr_usd: 'SBP exchange rate', kse100_1y_pct: 'PSX',
};

/** "SBP PIB auction, Oct 7, 2026" linking to the document it came from (when we have its address). */
function SourceLink({ series, l }: { series: string; l: Latest }) {
  const label = `${SERIES_SOURCE[series] ?? 'Source'}, ${series === 'cpi_yoy' ? monthLabel(l.as_of) : fullDate(l.as_of)}`;
  return /^https?:\/\//.test(l.source)
    ? <a href={l.source} target="_blank" rel="noopener noreferrer" className={linkCls}>{label}<Icon name="external" className="h-3.5 w-3.5" /></a>
    : <span>{label}</span>;
}

const OldTag = ({ l }: { l: Latest | null }) => (l?.stale ? <Tag tone="amber">old</Tag> : null);

/** The Market page body: a grid on wide screens, one column on a phone. */
export function MarketDetails({ data }: { data: AppData }) {
  const { c, periods, today, provisional } = useCompass(data);
  return (
    <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0">
      <CompassHero c={c} asOf={data.index?.ts ?? null} />
      <ValueCard c={c} />
      <GapCard c={c} />
      <TrendCard c={c} data={data} periods={periods} today={today} provisional={provisional} />
      <div className="space-y-4 lg:space-y-5">
        <MixCard c={c} />
        <GlanceCard c={c} />
      </div>
      <RatesCard c={c} rates={data.policyRates} today={today} />
    </div>
  );
}

const VALUE_NOTE = 'Valuation speaks to long-run returns; it says little about the next 12 months.';
const TREND_NOTE = 'In past data a trend rule cut how deep crashes went; it did not raise returns. Untested on the KSE-100.';

function CompassHero({ c, asOf }: { c: Compass; asOf: string | null }) {
  const mood = ACTION_MOOD[c.action.key];
  const reasons: Record<string, string[]> = { value: c.value.reasons, gap: c.gap.reasons, trend: c.trend.reasons };
  const notes: Record<string, string | undefined> = { value: VALUE_NOTE, trend: TREND_NOTE };
  return (
    <SectionCard id="mc-compass" title="Compass" icon="compass" className="lg:col-span-2">
      <div className={`mt-2 rounded-2xl px-4 py-3 lg:px-5 lg:py-4 ${MOOD[mood].panel}`}>
        <p className={`text-xl leading-tight font-bold tracking-tight lg:text-2xl ${MOOD[mood].word}`}>{c.action.title}</p>
        <p className="mt-1 text-sm leading-snug">{c.action.detail}</p>
        <p className="mt-2 flex items-start gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
          <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />{SIP_LINE}
        </p>
      </div>
      <ul className="mt-3 grid gap-3 md:grid-cols-3">
        {lights(c).map((l) => (
          <li key={l.id} className="min-w-0 rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/60">
            <p className={`text-xs font-semibold ${muted}`}>{l.label}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <LightPill word={l.word} mood={l.mood} big />
              {(l.figure || l.word) && <span className={`num text-sm ${l.figure ? 'font-semibold' : muted}`}>{l.figure ?? 'n/a'}</span>}
            </div>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs leading-snug text-slate-700 dark:text-slate-300">
              {reasons[l.id].map((r) => <li key={r}>{r}</li>)}
            </ul>
            {notes[l.id] && <p className={`mt-2 text-[11px] leading-snug italic ${muted}`}>{notes[l.id]}</p>}
          </li>
        ))}
      </ul>
      <p className={`mt-3 text-[11px] ${muted}`}>
        Three separate lights, never one score. Worked out from PSX, SBP and PBS figures{asOf ? `; KSE-100 as of ${asOfLabel(asOf)}` : ''}. A rule of thumb, not advice.
      </p>
    </SectionCard>
  );
}

function Figure({ label, value, sub, tag }: { label: string; value: string | null; sub?: ReactNode; tag?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
      <dt className={`text-[11px] ${muted}`}>{label}</dt>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={`num text-lg leading-tight font-bold ${value ? '' : `font-normal ${muted}`}`}>{value ?? 'n/a'}</span>{tag}
      </dd>
      {sub && <dd className={`text-[11px] leading-snug ${muted}`}>{sub}</dd>}
    </div>
  );
}

/** A bullet gauge for the P/E: cheap / fair / expensive bands labelled in words, the long-run average as a tick. */
function PeGauge({ pe, avg }: { pe: number | null; avg: number }) {
  const lo = Math.min(4, Math.floor((pe ?? 4) - 1));
  const hi = Math.max(14, Math.ceil((pe ?? 14) + 1));
  const at = (v: number) => `${((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100}%`;
  const cheapW = ((K.pe_cheap_below - lo) / (hi - lo)) * 100;
  const fairW = ((K.pe_expensive_above - K.pe_cheap_below) / (hi - lo)) * 100;
  const label = `P/E gauge from ${lo}x to ${hi}x: cheap below ${K.pe_cheap_below}x, fair up to ${K.pe_expensive_above}x, expensive above. Long-run average ${avg}x. `
    + (pe != null ? `Now ${pe.toFixed(1)}x.` : 'No P/E yet.');
  return (
    <div className="mt-3" role="img" aria-label={label}>
      <div className="relative h-16">
        <div className="absolute inset-x-0 top-6 flex h-4 overflow-hidden rounded-full">
          <div className="h-full bg-emerald-200 dark:bg-emerald-900/70" style={{ width: `${cheapW}%` }} />
          <div className="h-full bg-sky-200 dark:bg-sky-900/70" style={{ width: `${fairW}%` }} />
          <div className="h-full flex-1 bg-rose-200 dark:bg-rose-900/70" />
        </div>
        <div className="absolute top-5 h-6 border-l-2 border-dashed border-slate-500 dark:border-slate-400" style={{ left: at(avg) }} aria-hidden="true" />
        <span className={`num absolute top-11 -translate-x-1/2 text-[10px] whitespace-nowrap ${muted}`} style={{ left: at(avg) }} aria-hidden="true">avg {avg}x</span>
        {pe != null && <>
          <div className="absolute top-4.5 h-7 w-1.5 -translate-x-1/2 rounded-full bg-slate-900 ring-2 ring-white dark:bg-white dark:ring-slate-900" style={{ left: at(pe) }} aria-hidden="true" />
          <span className="num absolute top-0 -translate-x-1/2 text-[11px] font-bold whitespace-nowrap" style={{ left: `clamp(1.5rem, ${at(pe)}, calc(100% - 1.5rem))` }} aria-hidden="true">{pe.toFixed(1)}x</span>
        </>}
      </div>
      <div className="num mt-0.5 flex text-[11px] font-medium" aria-hidden="true">
        <span className="text-emerald-800 dark:text-emerald-300" style={{ width: `${cheapW}%` }}>Cheap &lt;{K.pe_cheap_below}x</span>
        <span className="text-center text-sky-800 dark:text-sky-300" style={{ width: `${fairW}%` }}>Fair</span>
        <span className="flex-1 text-right text-rose-800 dark:text-rose-300">&gt;{K.pe_expensive_above}x Expensive</span>
      </div>
    </div>
  );
}

function ValueCard({ c }: { c: Compass }) {
  const v = c.value;
  return (
    <SectionCard id="mc-value" title="Value" icon="scale">
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <LightPill word={v.state ? VALUE_WORD[v.state] : null} mood={v.state ? VALUE_MOOD[v.state] : 'unknown'} big />
        <span className={`text-sm ${muted}`}>KSE-100 P/E against its long-run average</span>
      </div>
      <PeGauge pe={v.pe} avg={v.pe_avg} />
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Figure label="P/E now" value={v.pe != null ? `${v.pe.toFixed(1)}x` : null} sub="index stocks" />
        <Figure label="Long-run avg" value={`${v.pe_avg}x`} sub="forward P/E" />
        <Figure label="Earnings yield" value={pc(v.earnings_yield_pct)} sub="profit / price" />
        <Figure label="Dividend yield" value={pc(v.dividend_yield_pct)} sub="index stocks" />
      </dl>
      <p className={`mt-3 text-xs ${muted}`}>{VALUE_NOTE}</p>
      <Note text={K.pe_avg_note} className="mt-2" />
      <Note text={K.pe_bands_note} className="mt-1" />
    </SectionCard>
  );
}

function GapCard({ c }: { c: Compass }) {
  const g = c.gap;
  const bars: { label: string; v: number | null; note: string; shares?: boolean }[] = [
    { label: 'Shares: earnings yield', v: c.value.earnings_yield_pct, note: 'KSE-100 stocks', shares: true },
    { label: '10-year PIB', v: g.pib_10y?.value ?? null, note: 'government bond' },
    { label: '12-month T-bill', v: g.tbill_12m?.value ?? null, note: 'government' },
    { label: 'Money-market fund', v: c.rates.money_market_pct, note: 'estimate' },
    { label: 'Bank savings', v: c.rates.savings_pct, note: 'estimate' },
  ];
  const max = Math.max(15, ...bars.map((b) => b.v ?? 0)) * 1.05;
  const known = bars.filter((b) => b.v != null);
  const label = `Yields compared: ${bars.map((b) => `${b.label} ${b.v != null ? `${b.v.toFixed(1)}%` : 'not available'}`).join(', ')}.`;
  const sources = ([['pib_10y', g.pib_10y], ['tbill_12m', g.tbill_12m], ['tbill_3m', g.tbill_3m]] as const).filter((s): s is readonly [typeof s[0], Latest] => s[1] != null);
  return (
    <SectionCard id="mc-gap" title="Shares vs safe yield" icon="coins">
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <LightPill word={g.state ? GAP_WORD[g.state] : null} mood={g.state ? GAP_MOOD[g.state] : 'unknown'} big />
        {g.spread_pct != null && <span className="num text-lg font-bold">{signed(g.spread_pct)} points</span>}
        <span className={`text-xs ${muted}`}>earnings yield minus 10-year PIB</span>
      </div>
      <ul className="mt-3 space-y-2.5" role="img" aria-label={label}>
        {bars.map((b) => (
          <li key={b.label} aria-hidden="true">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0">{b.label} <span className={`text-[11px] ${muted}`}>· {b.note}</span></span>
              <span className={`num shrink-0 font-semibold ${b.v == null ? `font-normal ${muted}` : ''}`}>{b.v != null ? `${b.v.toFixed(1)}%` : 'n/a'}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              {b.v != null && <div className={`h-full rounded-full ${b.shares ? 'bg-teal-500' : 'bg-slate-400 dark:bg-slate-500'}`} style={{ width: `${(b.v / max) * 100}%` }} />}
            </div>
          </li>
        ))}
      </ul>
      {known.length < bars.length && <p className={`mt-2 text-xs ${muted}`}>n/a: not read from SBP yet. The night check fills these in from SBP's auction results.</p>}
      <Note text={K.spread_note} className="mt-3" />
      {sources.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 text-xs">
          {sources.map(([s, l]) => <li key={s} className="flex items-center gap-1.5"><SourceLink series={s} l={l} /><OldTag l={l} /></li>)}
        </ul>
      )}
    </SectionCard>
  );
}

function TrendCard({ c, data, periods, today, provisional }: { c: Compass; data: AppData; periods: TrendPeriod[]; today: string; provisional: boolean }) {
  const t = c.trend;
  const rule = `Trend: Up when the KSE-100 is up ${RULES.on_1y_pct}% on a year or ${RULES.on_rise_pct}% above its 12-month low, and not below its ${RULES.ma_days}-day average. Down after a ${RULES.off_drawdown_pct}% fall from the 12-month high, or below the average with the year negative. Sideways in between.`;
  return (
    <SectionCard id="mc-trend" title="Trend" icon="chart">
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <LightPill word={t.state ? TREND_WORD[t.state] : null} mood={t.state ? TREND_MOOD[t.state] : 'unknown'} big />
        {t.one_year_pct != null && <>
          <span className={`num text-lg font-bold ${changeTone(t.one_year_pct)}`}>{signed(t.one_year_pct)}%</span>
          <span className={`text-xs ${muted}`}>on a year ({t.one_year_source === 'psx' ? 'PSX' : 'index stocks'})</span>
        </>}
      </div>
      {data.indexDaily.length < 2
        ? <p className={`mt-2 text-sm ${muted}`}>History builds up daily: the night check stores the KSE-100 close each trading day.</p>
        : <IndexChart closes={data.indexDaily} periods={periods} today={today} />}
      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm">{t.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      <h3 className={`mt-4 text-[13px] font-semibold tracking-wide uppercase ${muted}`}>Trend periods</h3>
      {periods.length === 0 || provisional ? (
        <p className={`mt-1 text-sm ${muted}`}>Each stretch appears here once the night check stores readings.</p>
      ) : (
        <ul className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
          {[...periods].reverse().map((p) => (
            <li key={p.from} className="flex items-center gap-3 py-2">
              <LightPill word={TREND_KEY_WORD[p.key]} mood={TREND_MOOD[p.key]} />
              <span className="num min-w-0 flex-1 text-sm">{fullDate(p.from)} – {p.to ? fullDate(p.to) : 'now'}</span>
              <span className={`num shrink-0 text-xs ${muted}`}>{duration(p.days)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={`mt-3 text-xs leading-relaxed ${muted}`}>{rule}</p>
      <p className={`mt-1 text-[11px] italic ${muted}`}>{TREND_NOTE}</p>
    </SectionCard>
  );
}

function MixCard({ c }: { c: Compass }) {
  const mix = c.action.mix;
  const rows = [
    { key: 'stocks', label: 'Shares you pick', pct: mix.stocks, note: c.value.earnings_yield_pct != null ? `about ${c.value.earnings_yield_pct}% earnings yield` : 'earnings yield: no PSX figure yet', bar: 'bg-teal-500' },
    { key: 'equity_funds', label: 'Equity funds', pct: mix.equity_funds, note: 'spread across many shares', bar: 'bg-sky-500' },
    { key: 'money_market', label: 'Money market / T-bills', pct: mix.money_market, note: c.rates.money_market_pct != null ? `about ${c.rates.money_market_pct}% a year (estimate)` : 'yield: n/a', bar: 'bg-slate-400 dark:bg-slate-500' },
  ];
  return (
    <SectionCard id="mc-mix" title="Where spare cash could go" icon="coins">
      <p className={`text-xs ${muted}`}>Only money beyond your monthly investment and crash fund.</p>
      <p className="mt-2 text-sm font-semibold">{c.action.title}</p>
      <ul className="mt-2 space-y-3">
        {rows.map((r) => (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0">{r.label}</span>
              <span className="num shrink-0 font-semibold">{r.pct}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="img" aria-label={`${r.label}: ${r.pct}%`}>
              <div className={`h-full rounded-full ${r.bar}`} style={{ width: `${r.pct}%` }} />
            </div>
            <p className={`num mt-0.5 text-xs ${muted}`}>{r.note}</p>
          </li>
        ))}
      </ul>
      <Note text={K.mix_note} className="mt-3 text-xs" />
      <Note text={K.money_market_note} className="mt-1" />
    </SectionCard>
  );
}

function GlanceCard({ c }: { c: Compass }) {
  const fx = c.macro.fx_reserves, pkr = c.macro.pkr_usd;
  return (
    <SectionCard id="mc-glance" title="Pakistan at a glance" icon="flag">
      <dl className="mt-2 grid grid-cols-2 gap-2">
        <Figure label="FX reserves" value={fx ? `US$ ${(fx.value / 1000).toFixed(1)} bn` : null} tag={<OldTag l={fx} />}
          sub={fx ? (fx.change_pct != null ? `${signed(fx.change_pct)}% over 4 weeks` : 'change: n/a') : 'SBP, weekly'} />
        <Figure label="Rs per US$" value={pkr ? pkr.value.toFixed(2) : null} tag={<OldTag l={pkr} />}
          sub={pkr ? (pkr.change_pct != null ? `${signed(pkr.change_pct)}% over 30 days${pkr.change_pct < 0 ? ' (rupee stronger)' : pkr.change_pct > 0 ? ' (rupee weaker)' : ''}` : 'change: n/a') : 'SBP, daily'} />
      </dl>
      {(fx || pkr) && (
        <ul className="mt-1 flex flex-wrap gap-x-4 text-xs">
          {fx && <li><SourceLink series="fx_reserves_total" l={fx} /></li>}
          {pkr && <li><SourceLink series="pkr_usd" l={pkr} /></li>}
        </ul>
      )}
      <p className={`mt-2 text-[11px] leading-relaxed ${muted}`}>
        Not shown: fund returns (MUFAP) and foreign flows (NCCPL) — their sites block automated reading, and we don't get around that.
      </p>
    </SectionCard>
  );
}

function RatesCard({ c, rates, today }: { c: Compass; rates: PolicyRate[]; today: string }) {
  const rate = c.rates.policy;
  const cycles = useMemo(() => rateCycles(rates, today), [rates, today]);
  const cpi = c.rates.cpi;
  const asOf = (l: Latest | null, monthly = false) => (l ? (monthly ? monthLabel(l.as_of) : fullDate(l.as_of)) : 'not read yet');
  return (
    <SectionCard id="mc-rates" title="Rates & inflation" icon="growth" className="lg:col-span-2">
      <div className="lg:grid lg:grid-cols-5 lg:gap-6">
        <div className="min-w-0 lg:col-span-3">
          {rate == null ? <p className={`mt-1 text-sm ${muted}`}>No policy-rate history loaded yet.</p> : <>
            <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-1">
              <p className="num text-3xl font-bold tracking-tight">{rate.rate}%</p>
              <div className="pb-1"><Tag tone={rate.cycle === 'easing' ? 'green' : rate.cycle === 'tightening' ? 'amber' : 'slate'}>{CYCLE_WORD[rate.cycle]}</Tag></div>
              <p className={`pb-1 text-sm ${muted}`}>SBP policy rate</p>
            </div>
            <p className={`num text-sm ${muted}`}>
              Decided {fullDate(rate.decided_on)}
              {rate.last_change_pct != null ? ` · last change ${points(rate.last_change_pct)}` : ''}
              {rate.months_since_change != null ? ` · ${plural(rate.months_since_change, 'month')} ago` : ''}
            </p>
            {rate.cycle === 'on_hold' && rate.direction && (
              <p className={`text-xs ${muted}`}>No change for {RULES.rate_hold_months} months or more, so the last {rate.direction} cycle counts as on hold.</p>
            )}
          </>}
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Figure label="CPI inflation" value={pc(cpi?.value)} tag={<OldTag l={cpi} />} sub={cpi ? `${monthLabel(cpi.as_of)}, year on year` : 'PBS, not read yet'} />
            <Figure label="Real rate" value={c.rates.real_rate_pct != null ? `${signed(c.rates.real_rate_pct)}%` : null} sub="policy rate minus CPI" />
            <Figure label="T-bill 3-month" value={pc(c.gap.tbill_3m?.value, 2)} tag={<OldTag l={c.gap.tbill_3m} />} sub={asOf(c.gap.tbill_3m)} />
            <Figure label="T-bill 12-month" value={pc(c.gap.tbill_12m?.value, 2)} tag={<OldTag l={c.gap.tbill_12m} />} sub={asOf(c.gap.tbill_12m)} />
            <Figure label="PIB 10-year" value={pc(c.gap.pib_10y?.value, 2)} tag={<OldTag l={c.gap.pib_10y} />} sub={asOf(c.gap.pib_10y)} />
            <Figure label="Savings (estimate)" value={pc(c.rates.savings_pct)} sub="from the policy rate" />
          </dl>
          {cpi && <p className="mt-1 text-xs"><SourceLink series="cpi_yoy" l={cpi} /></p>}
          <Note text={RULES.rates_note} className="mt-2" />
          {rates.length > 0 && <RateChart rates={rates} cycles={cycles} today={today} />}
          <p className={`mt-2 text-xs ${muted}`}>
            Source: State Bank of Pakistan,{' '}
            <a href={SBP_URL} target="_blank" rel="noopener noreferrer" className={linkCls}>monetary policy<Icon name="external" className="h-3.5 w-3.5" /></a>
          </p>
        </div>
        <div className="min-w-0 lg:col-span-2">
          <h3 className={`mt-4 text-[13px] font-semibold tracking-wide uppercase lg:mt-1 ${muted}`}>Rate cycles</h3>
          {cycles.length === 0 ? <p className={`mt-1 text-sm ${muted}`}>None yet.</p> : (
            <ul className="mt-1 divide-y divide-slate-100 lg:max-h-[560px] lg:overflow-y-auto lg:pr-2 dark:divide-slate-800">
              {[...cycles].reverse().map((cy) => (
                <li key={cy.from} className="py-2">
                  <div className="flex items-center gap-2">
                    <Tag tone={cy.cycle === 'easing' ? 'green' : 'amber'}>{cy.cycle === 'easing' ? 'Easing' : 'Tightening'}</Tag>
                    <span className="num min-w-0 flex-1 text-sm font-medium">{cy.start_rate}% → {cy.end_rate}%</span>
                    <span className={`num shrink-0 text-xs ${muted}`}>{duration(cy.days)}</span>
                  </div>
                  <p className={`num mt-0.5 text-xs ${muted}`}>{fullDate(cy.from)} – {cy.to ? fullDate(cy.to) : 'now'} · {plural(cy.changes, 'change')}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------
const W = 300;
const H = 140;
const PAD = 6;
const BOTTOM = 20; // room for the x labels inside the rate chart
const TREND_FILL: Record<TrendKey, string> = {
  up: 'fill-emerald-500/15 dark:fill-emerald-400/15',
  sideways: 'fill-sky-500/10 dark:fill-sky-400/10',
  down: 'fill-rose-500/12 dark:fill-rose-400/15',
  not_up: 'fill-slate-500/10 dark:fill-slate-400/10',
};
const TREND_SWATCH: Record<TrendKey, string> = { up: 'bg-emerald-500/25', sideways: 'bg-sky-500/20', down: 'bg-rose-500/20', not_up: 'bg-slate-500/20' };

/** KSE-100 closes on a time scale, each trend stretch shaded behind the line (Up green, Sideways blue, Down rose). */
function IndexChart({ closes, periods, today, compact = false }: { closes: IndexDay[]; periods: TrendPeriod[]; today: string; compact?: boolean }) {
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
  const present = (['up', 'sideways', 'down', 'not_up'] as TrendKey[]).filter((k) => bands.some((b) => b.key === k));
  const label = `KSE-100 from ${fullDate(first)} (${num(closes[0].close, 0)}) to ${fullDate(last)} (${num(closes[closes.length - 1].close, 0)})`
    + (bands.length ? `, shaded by trend: ${present.map((k) => `${plural(bands.filter((b) => b.key === k).length, `${TREND_KEY_WORD[k]} period`)}`).join(', ')}.` : '. No trend readings in this range yet.');
  return (
    <div className={compact ? '' : 'mt-2'}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`${compact ? 'h-14' : 'h-40 lg:h-52'} w-full`} role="img" aria-label={label}>
        {bands.map((b) => <rect key={b.from} x={x(b.a)} y={0} width={Math.max(1.5, x(b.b) - x(b.a))} height={H} className={TREND_FILL[b.key]} />)}
        <polyline points={line} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="stroke-slate-800 dark:stroke-slate-100" />
      </svg>
      {!compact && <><div className={`num flex items-center justify-between text-[11px] ${muted}`}>
        <span>{fullDate(first)}</span>
        <span>{fullDate(last)}</span>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300" aria-label="Legend">
        {present.map((k) => <li key={k} className="flex items-center gap-1.5"><span className={`h-3 w-4 rounded-sm ${TREND_SWATCH[k]}`} aria-hidden="true" />{TREND_KEY_WORD[k]}{k === 'not_up' ? ' (older rule)' : ''}</li>)}
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-slate-800 dark:bg-slate-100" aria-hidden="true" />KSE-100 close</li>
      </ul></>}
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
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full lg:h-56" role="img" aria-label={label}>
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
