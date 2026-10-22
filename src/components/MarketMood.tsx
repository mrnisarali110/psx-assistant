/**
 * Market Compass in the app. `MarketCard` is the glance on Home (KSE-100, the action for extra money, three lights and
 * a rates strip); `MarketDetails` is the Market page: the compass, the P/E gauge, shares against safe yield, the trend
 * chart, rates and inflation, Pakistan at a glance, and where spare cash could go.
 * Each card shows its light, its number and one line; the method, reasons, sources and "to verify" notes sit behind a
 * "How this works" sheet per card (owner review 2026-10-23).
 * Display only: every figure comes from shared/compass.ts and shared/regime.ts, every threshold from rules.json
 * (`compass`, `regime`). Colour always backs up a word (Cheap, Sideways, Safe yield pays more), never replaces it, and a
 * figure we don't have shows as "n/a", never a guess.
 */
import { useMemo, type ReactNode } from 'react';
import type { AppData } from '../lib/data.ts';
import { compass, GAP_WORD, TREND_WORD, VALUE_WORD, type ActionKey, type Compass, type GapBasis, type GapState, type Latest, type Trend, type ValueState } from '../../shared/compass.ts';
import { marketBreadth, rateCycles, type PolicyRate, type RateCycle, type RatePeriod, type RegimeDay } from '../../shared/regime.ts';
import { daysBetween, pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES, type IndexDay } from '../../shared/types.ts';
import { day, dayTime, num, sessionLabel } from '../../shared/format.ts';
import { Icon } from './Icon.tsx';
import { Card, Change, Chip, HowItWorks } from './ui.tsx';

const RULES = DEFAULT_RULES.regime;
const K = DEFAULT_RULES.compass;
const SBP_URL = 'https://www.sbp.org.pk/our-operations/monetary-policy';
const RATE_CHART_FROM = '2015-01-01';
const SIP_LINE = 'Your monthly investment (SIP) always runs; only extra money changes.';
const linkCls = 'inline-flex min-h-11 items-center gap-1 font-medium text-brand underline underline-offset-2';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Sep 2026" for a monthly figure such as CPI (a day would name a date the figure doesn't belong to). */
const month = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const plural = (v: number, word: string) => `${v} ${word}${v === 1 ? '' : 's'}`;
/** 12 days, 3.4 months, 2.1 years. */
function duration(days: number): string {
  if (days < 60) return plural(Math.max(0, days), 'day');
  if (days < 730) return `${(days / 30.44).toFixed(1)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}
/** +1.2, −0.4 (a true minus sign, so it reads well and doesn't wrap). */
const signed = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
const pc = (v: number | null | undefined, digits = 1) => (v == null ? null : `${v.toFixed(digits)}%`);
const CYCLE_WORD: Record<RateCycle, string> = { easing: 'Easing', tightening: 'Tightening', on_hold: 'On hold' };
const BASIS_WORD: Record<GapBasis, string> = { money_market: 'vs money market', pib: 'vs 10-year bond' };

/**
 * A move that is not a price or return (the rupee, the policy rate): arrow and sign in the body colour, since green
 * for "rupee weaker" or "rate up" would say good or bad where we mean neither.
 */
function Moved({ value, unit = '%', digits = 1 }: { value: number; unit?: string; digits?: number }) {
  const flat = Number(Math.abs(value).toFixed(digits)) === 0;
  return (
    <span className="num whitespace-nowrap">
      <span aria-hidden="true" className="text-[0.8em]">{flat ? '–' : value > 0 ? '▲' : '▼'}</span> {signed(value, digits)}{unit}
    </span>
  );
}

/** A rules note: "VERIFY:" in front (or "VERIFY." at the end) becomes a "To verify" chip. */
function Note({ text }: { text: string }) {
  const unverified = /VERIFY/.test(text);
  const stripped = text.replace(/^VERIFY:\s*/, '').replace(/,\s*VERIFY\.?\s*$/, '.');
  const body = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return (
    <p className="text-14 text-muted">
      {unverified && <span className="mr-1.5 align-middle"><Chip kind="caution">To verify</Chip></span>}
      {body}
    </p>
  );
}

/** One titled block inside a "How this works" sheet. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-12 font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </div>
  );
}
const Bullets = ({ items }: { items: string[] }) => (
  <ul className="list-disc space-y-1 pl-5 text-14">{items.map((r) => <li key={r}>{r}</li>)}</ul>
);

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
 * A stored day's shares-vs-safe-yield reading. Readings are never recomputed: rows saved before the money-market basis
 * (2026-10-23) carry no `gap_basis` and were measured against the 10-year bond, so they say so.
 */
interface StoredGap { day: string; spread: number; basis: GapBasis }
function storedGap(d: RegimeDay): StoredGap | null {
  const k = d.compass as { spread_pct?: unknown; gap_basis?: unknown } | null | undefined;
  if (!k || typeof k !== 'object' || typeof k.spread_pct !== 'number') return null;
  return { day: d.day, spread: k.spread_pct, basis: k.gap_basis === 'money_market' ? 'money_market' : 'pib' };
}

/** The Trend light's word: "Sideways · provisional" while the 200-day average is not known yet. */
const trendWord = (t: Compass['trend']) => (t.state ? `${TREND_WORD[t.state]}${t.provisional ? ' · provisional' : ''}` : null);
/** "200-day average (needs 120 stored closes; 37 so far)" while provisional, from the same reasons the rule gives. */
const maReason = (t: Compass['trend']) => t.reasons.find((r) => /day average/.test(r)) ?? null;

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
    // No stored readings yet: the period list shows today's live reading only, and says the history is still to come.
    let unstored = false;
    let rows = data.regime.map((d) => ({ day: d.day, key: trendKey(d) }));
    if (!rows.length && c.trend.state) { rows = [{ day: indexDay, key: c.trend.state }]; unstored = true; }
    const periods = trendPeriods(rows, today);
    const pastGaps = data.regime.map(storedGap).filter((g): g is StoredGap => g != null);
    return { today, indexDay, c, breadth, periods, unstored, pastGaps };
  }, [data.regime, data.policyRates, data.screen, data.index, data.indexDaily, data.macro]);
}

// ---------------------------------------------------------------------------
// Light tones: colour backs the word, the word carries the meaning
// ---------------------------------------------------------------------------
type Mood = 'good' | 'neutral' | 'caution' | 'bad' | 'unknown';
const MOOD: Record<Mood, { pill: string; dot: string; panel: string; word: string }> = {
  good: { pill: 'bg-surface text-up ring-1 ring-up/40', dot: 'bg-up', panel: 'bg-up/10', word: 'text-up' },
  neutral: { pill: 'bg-surface text-info ring-1 ring-info/40', dot: 'bg-info', panel: 'bg-info/10', word: 'text-info' },
  caution: { pill: 'bg-surface text-caution ring-1 ring-caution/40', dot: 'bg-caution', panel: 'bg-caution/10', word: 'text-caution' },
  bad: { pill: 'bg-surface text-down ring-1 ring-down/40', dot: 'bg-down', panel: 'bg-down/10', word: 'text-down' },
  unknown: { pill: 'bg-surface text-muted ring-1 ring-line', dot: 'bg-muted', panel: 'bg-surface-2', word: 'text-muted' },
};
const VALUE_MOOD: Record<ValueState, Mood> = { cheap: 'good', fair: 'neutral', expensive: 'bad' };
const GAP_MOOD: Record<GapState, Mood> = { shares: 'good', even: 'neutral', safe: 'caution' };
const TREND_MOOD: Record<TrendKey, Mood> = { up: 'good', sideways: 'neutral', down: 'bad', not_up: 'unknown' };
const ACTION_MOOD: Record<ActionKey, Mood> = { add_extra: 'good', buy_in_steps: 'neutral', on_schedule: 'neutral', park_extra: 'caution' };

interface LightView { id: 'value' | 'gap' | 'trend'; label: string; word: string | null; figure: ReactNode; mood: Mood }

function lights(c: Compass): LightView[] {
  const t = c.trend;
  return [
    { id: 'value', label: 'Value', word: c.value.state ? VALUE_WORD[c.value.state] : null, figure: c.value.pe != null ? `P/E ${c.value.pe.toFixed(1)}x` : null, mood: c.value.state ? VALUE_MOOD[c.value.state] : 'unknown' },
    { id: 'gap', label: 'Shares vs safe yield', word: c.gap.state ? GAP_WORD[c.gap.state] : null, figure: c.gap.spread_pct != null ? `${signed(c.gap.spread_pct)} pts` : null, mood: c.gap.state ? GAP_MOOD[c.gap.state] : 'unknown' },
    { id: 'trend', label: 'Trend', word: trendWord(t), figure: t.one_year_pct != null ? <><Change value={t.one_year_pct} /> 1y</> : null, mood: t.state ? TREND_MOOD[t.state] : 'unknown' },
  ];
}

function LightPill({ word, mood, big = false }: { word: string | null; mood: Mood; big?: boolean }) {
  const m = MOOD[word ? mood : 'unknown'];
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 font-semibold ${big ? 'rounded-chip px-3 py-1 text-14' : 'rounded-control px-2 py-0.5 text-12'} ${m.pill}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${m.dot}`} aria-hidden="true" />
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
          <p className="text-12 text-muted">Market · KSE-100</p>
          <p className="num text-28 font-bold tracking-tight">{idx ? num(idx.kse100, 0) : 'no data'}</p>
          {idx && <p className="text-12 font-semibold"><Change value={idx.change_pct} digits={2} /> <span className="font-normal text-muted">{sessionLabel(idx.ts)}</span></p>}
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-12 font-semibold text-brand">
          <Icon name="compass" className="h-4 w-4" />Compass<Icon name="chevron" className="h-4 w-4" />
        </span>
      </div>

      <div className={`rounded-control px-3 py-2.5 ${MOOD[mood].panel}`}>
        {/* 16px is not large text, so the title stays ink (contrast); the tint and the dot carry the tone. */}
        <p className="flex items-center gap-2 text-16 font-semibold">
          <span className={`h-2 w-2 shrink-0 rounded-full ${MOOD[mood].dot}`} aria-hidden="true" />{c.action.title}
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-12 text-ink">
          <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-info" />Your monthly investment stays on
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-2">
        {lights(c).map((l) => (
          <div key={l.id} className="min-w-0 rounded-control bg-surface-2 px-2 py-2">
            <dt className="min-h-8 text-12 text-muted">{l.label}</dt>
            <dd className="mt-1"><LightPill word={l.word} mood={l.mood} /></dd>
            <dd className={`num mt-1 text-12 ${l.figure ? 'font-semibold' : 'text-muted'}`}>{l.figure ?? (l.word ? 'n/a' : 'no data yet')}</dd>
          </div>
        ))}
      </dl>

      <p className="num flex flex-wrap gap-x-2 gap-y-0.5 text-12 text-muted" aria-label="Rates">
        {rates.map((r, i) => (
          <span key={r.label} className="whitespace-nowrap">
            {r.label} <b className={r.value ? 'font-semibold text-ink' : 'font-normal'}>{r.value ?? 'n/a'}</b>{i < rates.length - 1 && <span className="ml-2" aria-hidden="true">·</span>}
          </span>
        ))}
      </p>

      {data.indexDaily.length >= 2
        ? <IndexChart closes={data.indexDaily} periods={periods} today={today} compact />
        : <MiniTrend values={data.indexHistory.map((i) => i.kse100)} />}
      {footnote && <p className="text-12 text-muted">{footnote}</p>}
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
      <polyline points={pts} fill="none" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className={up ? 'stroke-up' : 'stroke-down'} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The Market page
// ---------------------------------------------------------------------------
/** A Market card: title, then the light, the number and one line; `how` is the "How this works" sheet's content. */
function SectionCard({ id, title, icon, how, children, className = '' }: {
  id: string; title: string; icon?: Parameters<typeof Icon>[0]['name']; how?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section aria-labelledby={id} className={`min-w-0 rounded-card bg-surface p-4 ring-1 ring-line lg:p-5 ${className}`}>
      <h2 id={id} className="flex items-center gap-2 text-16 font-semibold">
        {icon && <Icon name={icon} className="h-4.5 w-4.5 text-muted" />}{title}
      </h2>
      {children}
      {how && <div className="mt-1 -mb-2"><HowItWorks title={title}>{how}</HowItWorks></div>}
    </section>
  );
}

const SERIES_SOURCE: Record<string, string> = {
  pib_10y: 'SBP PIB auction', tbill_3m: 'SBP 3-month T-bill auction', tbill_12m: 'SBP 12-month T-bill auction', cpi_yoy: 'PBS inflation release',
  fx_reserves_total: 'SBP reserves', pkr_usd: 'SBP exchange rate', kse100_1y_pct: 'PSX',
};

/** "SBP PIB auction, Oct 7" linking to the document it came from (when we have its address). */
function SourceLink({ series, l }: { series: string; l: Latest }) {
  const label = `${SERIES_SOURCE[series] ?? 'Source'}, ${series === 'cpi_yoy' ? month(l.as_of) : day(l.as_of)}`;
  return /^https?:\/\//.test(l.source)
    ? <a href={l.source} target="_blank" rel="noopener noreferrer" className={linkCls}>{label}<Icon name="external" className="h-3.5 w-3.5" /></a>
    : <span>{label}</span>;
}
function Sources({ items }: { items: [string, Latest | null][] }) {
  const known = items.filter((s): s is [string, Latest] => s[1] != null);
  if (!known.length) return <p className="text-14 text-muted">Not read yet.</p>;
  return (
    <ul className="text-14">
      {known.map(([s, l]) => <li key={s} className="flex flex-wrap items-center gap-x-1.5"><SourceLink series={s} l={l} /><OldTag l={l} /></li>)}
    </ul>
  );
}

const OldTag = ({ l }: { l: Latest | null }) => (l?.stale ? <Chip kind="caution">Old</Chip> : null);

/** The Market page body: a grid on wide screens, one column on a phone. */
export function MarketDetails({ data }: { data: AppData }) {
  const { c, periods, today, unstored, pastGaps } = useCompass(data);
  return (
    <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0">
      <CompassHero c={c} asOf={data.index?.ts ?? null} />
      <ValueCard c={c} />
      <GapCard c={c} past={pastGaps} />
      <TrendCard c={c} data={data} periods={periods} today={today} unstored={unstored} />
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
  const reasons: Record<LightView['id'], string[]> = { value: c.value.reasons, gap: c.gap.reasons, trend: c.trend.reasons };
  const how = <>
    <p>Three separate lights, never one score. Worked out from PSX, SBP and PBS figures{asOf ? `; KSE-100 as of ${dayTime(asOf)}` : ''}.</p>
    {lights(c).map((l) => <Part key={l.id} title={l.label}><Bullets items={reasons[l.id]} /></Part>)}
    <Part title="Keep in mind">
      <p className="text-14 text-muted">{VALUE_NOTE}</p>
      <p className="text-14 text-muted">{TREND_NOTE}</p>
      <p className="text-14 text-muted">A rule of thumb, not advice.</p>
    </Part>
  </>;
  return (
    <SectionCard id="mc-compass" title="Compass" icon="compass" className="lg:col-span-2" how={how}>
      <div className={`mt-2 rounded-control px-4 py-3 lg:px-5 lg:py-4 ${MOOD[mood].panel}`}>
        <p className={`text-20 font-bold tracking-tight lg:text-28 ${MOOD[mood].word}`}>{c.action.title}</p>
        <p className="mt-1 text-14">{c.action.detail}</p>
        <p className="mt-2 flex items-start gap-1.5 text-14 font-medium">
          <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-info" />{SIP_LINE}
        </p>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
        {lights(c).map((l) => (
          <li key={l.id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-control bg-surface-2 px-3 py-2.5 sm:block">
            <p className="text-12 font-semibold text-muted">{l.label}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:mt-1.5">
              <LightPill word={l.word} mood={l.mood} big />
              {(l.figure || l.word) && <span className={`num text-14 ${l.figure ? 'font-semibold' : 'text-muted'}`}>{l.figure ?? 'n/a'}</span>}
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function Figure({ label, value, sub, tag }: { label: string; value: ReactNode; sub?: ReactNode; tag?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-control bg-surface-2 px-3 py-2">
      <dt className="text-12 text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={`num text-20 font-bold ${value ? '' : 'font-normal text-muted'}`}>{value ?? 'n/a'}</span>{tag}
      </dd>
      {sub && <dd className="text-12 text-muted">{sub}</dd>}
    </div>
  );
}

/** Light, then the big number beside it, then one plain line. */
function Headline({ pill, figure, line }: { pill: ReactNode; figure?: ReactNode; line?: ReactNode }) {
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {pill}
        {figure && <span className="num text-20 font-bold">{figure}</span>}
      </div>
      {line && <p className="mt-1.5 text-14 text-muted">{line}</p>}
    </>
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
        <div className="absolute inset-x-0 top-6 flex h-4 overflow-hidden rounded-chip">
          <div className="h-full bg-up/25" style={{ width: `${cheapW}%` }} />
          <div className="h-full bg-info/20" style={{ width: `${fairW}%` }} />
          <div className="h-full flex-1 bg-down/20" />
        </div>
        <div className="absolute top-5 h-6 border-l-2 border-dashed border-muted" style={{ left: at(avg) }} aria-hidden="true" />
        <span className="num absolute top-11 -translate-x-1/2 text-12 whitespace-nowrap text-muted" style={{ left: at(avg) }} aria-hidden="true">avg {avg}x</span>
        {pe != null && <>
          <div className="absolute top-4.5 h-7 w-1.5 -translate-x-1/2 rounded-full bg-ink ring-2 ring-surface" style={{ left: at(pe) }} aria-hidden="true" />
          <span className="num absolute top-0 -translate-x-1/2 text-12 font-bold whitespace-nowrap" style={{ left: `clamp(1.5rem, ${at(pe)}, calc(100% - 1.5rem))` }} aria-hidden="true">{pe.toFixed(1)}x</span>
        </>}
      </div>
      <div className="num mt-0.5 flex text-12 font-medium" aria-hidden="true">
        <span className="text-up" style={{ width: `${cheapW}%` }}>Cheap &lt;{K.pe_cheap_below}x</span>
        <span className="text-center text-info" style={{ width: `${fairW}%` }}>Fair</span>
        <span className="flex-1 text-right text-down">&gt;{K.pe_expensive_above}x Expensive</span>
      </div>
    </div>
  );
}

function ValueCard({ c }: { c: Compass }) {
  const v = c.value;
  const how = <>
    <Part title="Why this light"><Bullets items={v.reasons} /></Part>
    <dl className="grid grid-cols-2 gap-2">
      <Figure label="Earnings yield" value={pc(v.earnings_yield_pct)} sub="profit / price" />
      <Figure label="Dividend yield" value={pc(v.dividend_yield_pct)} sub="index stocks" />
    </dl>
    <Part title="Keep in mind">
      <p className="text-14 text-muted">{VALUE_NOTE}</p>
      <Note text={K.pe_avg_note} />
      <Note text={K.pe_bands_note} />
    </Part>
  </>;
  return (
    <SectionCard id="mc-value" title="Value" icon="scale" how={how}>
      <Headline
        pill={<LightPill word={v.state ? VALUE_WORD[v.state] : null} mood={v.state ? VALUE_MOOD[v.state] : 'unknown'} big />}
        figure={v.pe != null ? `P/E ${v.pe.toFixed(1)}x` : null}
        line={`KSE-100 P/E against its long-run average of about ${v.pe_avg}x.`} />
      <PeGauge pe={v.pe} avg={v.pe_avg} />
    </SectionCard>
  );
}

function GapCard({ c, past }: { c: Compass; past: StoredGap[] }) {
  const g = c.gap;
  const mm = c.rates.money_market_pct;
  const ey = c.value.earnings_yield_pct;
  const vsMoney = g.basis === 'money_market';
  const bars: { label: string; v: number | null; note: string; shares?: boolean; basis?: boolean }[] = [
    { label: 'Shares: earnings yield', v: ey, note: 'KSE-100 stocks', shares: true },
    { label: 'Money-market fund', v: mm, note: 'estimate', basis: vsMoney },
    { label: '12-month T-bill', v: g.tbill_12m?.value ?? null, note: 'government' },
    { label: '10-year PIB', v: g.pib_10y?.value ?? null, note: vsMoney ? 'for information' : 'government bond', basis: !vsMoney },
    { label: 'Bank savings', v: c.rates.savings_pct, note: 'estimate' },
  ];
  const max = Math.max(15, ...bars.map((b) => b.v ?? 0)) * 1.05;
  const known = bars.filter((b) => b.v != null);
  const label = `Yields compared: ${bars.map((b) => `${b.label} ${b.v != null ? `${b.v.toFixed(1)}%` : 'not available'}`).join(', ')}.`;
  const line = g.spread_pct == null ? (vsMoney ? 'Needs the P/E and the 3-month T-bill from SBP.' : 'Needs the P/E and the 10-year PIB from SBP.')
    : vsMoney ? `Earnings yield ${ey}% against a money-market fund at about ${mm}% (estimate).`
      : `Earnings yield ${ey}% against the 10-year bond at ${g.pib_10y?.value.toFixed(2)}%.`;
  const recent = past.slice(-5).reverse();
  const how = <>
    <Part title="Why this light"><Bullets items={g.reasons} /></Part>
    <Part title="The rule">
      <p className="text-14">
        Earnings yield minus the {vsMoney ? 'money-market estimate' : '10-year bond'}. From {signed(K.spread_neutral_low)} to {signed(K.spread_neutral_high)} points
        nothing changes; below {signed(K.spread_neutral_low)} safe yield pays more and the advice is to park extra cash; at {signed(K.spread_shares_above)} or more, shares pay more.
      </p>
      {vsMoney && <Note text={`VERIFY: the ${signed(K.spread_shares_above)} point mark for "shares pay more" is a re-based guess. It was +3.5 against the 10-year bond, which pays about 1.5 to 2 points more than a money-market fund.`} />}
      <Note text={K.money_market_note} />
    </Part>
    {recent.length > 0 && (
      <Part title="Past readings">
        <ul className="divide-y divide-line text-14">
          {recent.map((r) => (
            <li key={r.day} className="flex items-baseline justify-between gap-3 py-1.5">
              <span>{day(r.day)}</span>
              <span className="num">{signed(r.spread)} points <span className="text-muted">{BASIS_WORD[r.basis]}</span></span>
            </li>
          ))}
        </ul>
      </Part>
    )}
    <Part title="Sources"><Sources items={[['tbill_3m', g.tbill_3m], ['tbill_12m', g.tbill_12m], ['pib_10y', g.pib_10y]]} /></Part>
  </>;
  return (
    <SectionCard id="mc-gap" title="Shares vs safe yield" icon="coins" how={how}>
      <Headline
        pill={<LightPill word={g.state ? GAP_WORD[g.state] : null} mood={g.state ? GAP_MOOD[g.state] : 'unknown'} big />}
        figure={g.spread_pct != null ? <>{signed(g.spread_pct)} points <span className="text-14 font-normal text-muted">{BASIS_WORD[g.basis]}</span></> : null}
        line={line} />
      <ul className="mt-3 space-y-2.5" role="img" aria-label={label}>
        {bars.map((b) => (
          <li key={b.label} aria-hidden="true">
            <div className="flex items-baseline justify-between gap-3 text-14">
              <span className="min-w-0"><span className={b.basis || b.shares ? 'font-semibold' : ''}>{b.label}</span> <span className="text-12 text-muted">· {b.note}{b.basis ? ', compared' : ''}</span></span>
              <span className={`num shrink-0 ${b.v == null ? 'text-muted' : 'font-semibold'}`}>{b.v != null ? `${b.v.toFixed(1)}%` : 'n/a'}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-chip bg-surface-2">
              {b.v != null && <div className={`h-full rounded-chip ${b.shares ? 'bg-info' : b.basis ? 'bg-ink/60' : 'bg-muted/40'}`} style={{ width: `${(b.v / max) * 100}%` }} />}
            </div>
          </li>
        ))}
      </ul>
      {known.length < bars.length && <p className="mt-2 text-12 text-muted">n/a: not read from SBP yet; the night check fills these in.</p>}
    </SectionCard>
  );
}

function TrendCard({ c, data, periods, today, unstored }: { c: Compass; data: AppData; periods: TrendPeriod[]; today: string; unstored: boolean }) {
  const t = c.trend;
  const rule = `Up when the KSE-100 is up ${RULES.on_1y_pct}% on a year or ${RULES.on_rise_pct}% above its 12-month low, and not below its ${RULES.ma_days}-day average. Down after a ${RULES.off_drawdown_pct}% fall from the 12-month high, or below the average with the year negative. Sideways in between.`;
  const line = t.provisional ? maReason(t) : t.one_year_pct != null ? `On a year (${t.one_year_source === 'psx' ? 'PSX figure' : 'index stocks'}).` : null;
  const how = <>
    <Part title="Why this light"><Bullets items={t.reasons} /></Part>
    {t.provisional && <p className="text-14">Provisional: the {RULES.ma_days}-day average needs {RULES.min_days_for_ma} stored closes. Until then the light leans on the yearly change and the 12-month high and low only.</p>}
    <Part title="The rule"><p className="text-14">{rule}</p></Part>
    <Part title="Keep in mind"><p className="text-14 text-muted">{TREND_NOTE}</p></Part>
  </>;
  return (
    <SectionCard id="mc-trend" title="Trend" icon="chart" how={how}>
      <Headline
        pill={<span className="inline-flex flex-wrap items-center gap-2">
          <LightPill word={trendWord(t)} mood={t.state ? TREND_MOOD[t.state] : 'unknown'} big />
          {t.provisional && t.state && <Chip kind="provisional" />}
        </span>}
        figure={t.one_year_pct != null ? <><Change value={t.one_year_pct} /> <span className="text-14 font-normal text-muted">1 year</span></> : null}
        line={line} />
      {data.indexDaily.length < 2
        ? <p className="mt-2 text-14 text-muted">{data.indexDaily.length ? `Builds from ${day(data.indexDaily[0].day)}: ` : 'History builds up daily: '}the night check stores the KSE-100 close each trading day.</p>
        : <IndexChart closes={data.indexDaily} periods={periods} today={today} />}
      <h3 className="mt-4 text-12 font-semibold tracking-wide text-muted uppercase">Trend periods</h3>
      {periods.length === 0 || unstored ? (
        <p className="mt-1 text-14 text-muted">Each stretch appears here once the night check stores readings.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {[...periods].reverse().map((p) => (
            <li key={p.from} className="flex items-center gap-3 py-2">
              <LightPill word={TREND_KEY_WORD[p.key]} mood={TREND_MOOD[p.key]} />
              <span className="num min-w-0 flex-1 text-14">{day(p.from)} – {p.to ? day(p.to) : 'now'}</span>
              <span className="num shrink-0 text-12 text-muted">{duration(p.days)}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function MixCard({ c }: { c: Compass }) {
  const mix = c.action.mix;
  const rows = [
    { key: 'stocks', label: 'Shares you pick', pct: mix.stocks, note: c.value.earnings_yield_pct != null ? `about ${c.value.earnings_yield_pct}% earnings yield` : 'earnings yield: no PSX figure yet', bar: 'bg-info' },
    { key: 'equity_funds', label: 'Equity funds', pct: mix.equity_funds, note: 'spread across many shares', bar: 'bg-info/50' },
    { key: 'money_market', label: 'Money market / T-bills', pct: mix.money_market, note: c.rates.money_market_pct != null ? `about ${c.rates.money_market_pct}% a year (estimate)` : 'yield: n/a', bar: 'bg-muted/50' },
  ];
  const how = <>
    <p className="text-14">The split follows the compass's action for extra money: {c.action.title.toLowerCase()}.</p>
    <Note text={K.mix_note} />
    <Note text={K.money_market_note} />
  </>;
  return (
    <SectionCard id="mc-mix" title="Where spare cash could go" icon="coins" how={how}>
      <p className="mt-1.5 text-14 text-muted">Only money beyond your monthly investment and crash fund.</p>
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-3 text-14">
              <span className="min-w-0">{r.label}</span>
              <span className="num shrink-0 font-semibold">{r.pct}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-chip bg-surface-2" role="img" aria-label={`${r.label}: ${r.pct}%`}>
              <div className={`h-full rounded-chip ${r.bar}`} style={{ width: `${r.pct}%` }} />
            </div>
            <p className="num mt-0.5 text-12 text-muted">{r.note}</p>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function GlanceCard({ c }: { c: Compass }) {
  const fx = c.macro.fx_reserves, pkr = c.macro.pkr_usd;
  const how = <>
    <Part title="Sources"><Sources items={[['fx_reserves_total', fx], ['pkr_usd', pkr]]} /></Part>
    <Part title="Not shown">
      <p className="text-14 text-muted">Fund returns (MUFAP) and foreign flows (NCCPL): their sites block automated reading, and we don't get around that.</p>
    </Part>
  </>;
  return (
    <SectionCard id="mc-glance" title="Pakistan at a glance" icon="flag" how={how}>
      <dl className="mt-2 grid grid-cols-2 gap-2">
        <Figure label="FX reserves" value={fx ? `US$ ${(fx.value / 1000).toFixed(1)} bn` : null} tag={<OldTag l={fx} />}
          sub={fx ? (fx.change_pct != null ? <><Change value={fx.change_pct} /> over 4 weeks</> : 'change: n/a') : 'SBP, weekly'} />
        <Figure label="Rs per US$" value={pkr ? pkr.value.toFixed(2) : null} tag={<OldTag l={pkr} />}
          sub={pkr ? (pkr.change_pct != null ? <><Moved value={pkr.change_pct} /> over 30 days{pkr.change_pct < 0 ? ' (rupee stronger)' : pkr.change_pct > 0 ? ' (rupee weaker)' : ''}</> : 'change: n/a') : 'SBP, daily'} />
      </dl>
    </SectionCard>
  );
}

function RatesCard({ c, rates, today }: { c: Compass; rates: PolicyRate[]; today: string }) {
  const rate = c.rates.policy;
  const cycles = useMemo(() => rateCycles(rates, today), [rates, today]);
  const cpi = c.rates.cpi;
  const asOf = (l: Latest | null) => (l ? day(l.as_of) : 'not read yet');
  const how = <>
    <Part title="How the cycle is read">
      <p className="text-14">Easing while the State Bank is cutting, tightening while it is raising. No change for {RULES.rate_hold_months} months or more counts as on hold.</p>
      <Note text={RULES.rates_note} />
    </Part>
    <Part title="Sources">
      <Sources items={[['cpi_yoy', cpi], ['tbill_3m', c.gap.tbill_3m], ['tbill_12m', c.gap.tbill_12m], ['pib_10y', c.gap.pib_10y]]} />
      <p className="text-14">
        Policy rate: State Bank of Pakistan,{' '}
        <a href={SBP_URL} target="_blank" rel="noopener noreferrer" className={linkCls}>monetary policy<Icon name="external" className="h-3.5 w-3.5" /></a>
      </p>
      <p className="text-14 text-muted">Savings and money-market figures are estimates worked out from the policy rate and T-bill yields.</p>
    </Part>
  </>;
  return (
    <SectionCard id="mc-rates" title="Rates & inflation" icon="growth" className="lg:col-span-2" how={how}>
      <div className="lg:grid lg:grid-cols-5 lg:gap-6">
        <div className="min-w-0 lg:col-span-3">
          {rate == null ? <p className="mt-1.5 text-14 text-muted">No policy-rate history loaded yet.</p> : <>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="num text-28 font-bold tracking-tight">{rate.rate}%</p>
              <Chip kind="neutral">{CYCLE_WORD[rate.cycle]}</Chip>
              <p className="text-14 text-muted">SBP policy rate</p>
            </div>
            <p className="num mt-1 text-14 text-muted">
              Decided {day(rate.decided_on)}
              {rate.last_change_pct != null && <> · last change <Moved value={rate.last_change_pct} unit=" points" digits={Number.isInteger(rate.last_change_pct * 10) ? 1 : 2} /></>}
              {rate.months_since_change != null ? ` · ${plural(rate.months_since_change, 'month')} ago` : ''}
            </p>
          </>}
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Figure label="CPI inflation" value={pc(cpi?.value)} tag={<OldTag l={cpi} />} sub={cpi ? `${month(cpi.as_of)}, year on year` : 'PBS, not read yet'} />
            <Figure label="Real rate" value={c.rates.real_rate_pct != null ? `${signed(c.rates.real_rate_pct)}%` : null} sub="policy rate minus CPI" />
            <Figure label="T-bill 3-month" value={pc(c.gap.tbill_3m?.value, 2)} tag={<OldTag l={c.gap.tbill_3m} />} sub={asOf(c.gap.tbill_3m)} />
            <Figure label="T-bill 12-month" value={pc(c.gap.tbill_12m?.value, 2)} tag={<OldTag l={c.gap.tbill_12m} />} sub={asOf(c.gap.tbill_12m)} />
            <Figure label="PIB 10-year" value={pc(c.gap.pib_10y?.value, 2)} tag={<OldTag l={c.gap.pib_10y} />} sub={asOf(c.gap.pib_10y)} />
            <Figure label="Savings" value={pc(c.rates.savings_pct)} sub="estimate, from the policy rate" />
          </dl>
          {rates.length > 0 && <RateChart rates={rates} cycles={cycles} today={today} />}
        </div>
        <div className="min-w-0 lg:col-span-2">
          <h3 className="mt-4 text-12 font-semibold tracking-wide text-muted uppercase lg:mt-1">Rate cycles</h3>
          {cycles.length === 0 ? <p className="mt-1 text-14 text-muted">None yet.</p> : (
            <ul className="mt-1 divide-y divide-line lg:max-h-[560px] lg:overflow-y-auto lg:pr-2">
              {[...cycles].reverse().map((cy) => (
                <li key={cy.from} className="py-2">
                  <div className="flex items-center gap-2">
                    <span className={`h-3 w-3 shrink-0 rounded-sm ${CYCLE_SWATCH[cy.cycle === 'easing' ? 'easing' : 'tightening']}`} aria-hidden="true" />
                    <span className="w-21 shrink-0 text-14 font-medium">{cy.cycle === 'easing' ? 'Easing' : 'Tightening'}</span>
                    <span className="num min-w-0 flex-1 text-14">{cy.start_rate}% → {cy.end_rate}%</span>
                    <span className="num shrink-0 text-12 text-muted">{duration(cy.days)}</span>
                  </div>
                  <p className="num mt-0.5 text-12 text-muted">{day(cy.from)} – {cy.to ? day(cy.to) : 'now'} · {plural(cy.changes, 'change')}</p>
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
const TREND_FILL: Record<TrendKey, string> = { up: 'fill-up/15', sideways: 'fill-info/10', down: 'fill-down/15', not_up: 'fill-muted/10' };
const TREND_SWATCH: Record<TrendKey, string> = { up: 'bg-up/25', sideways: 'bg-info/20', down: 'bg-down/25', not_up: 'bg-muted/20' };
/** Rate cycles are not good or bad for you, so neither green nor amber: blue for cuts, grey for hikes. */
const CYCLE_FILL = { easing: 'fill-info/15', tightening: 'fill-muted/20' };
const CYCLE_SWATCH = { easing: 'bg-info/30', tightening: 'bg-muted/35' };

/** KSE-100 closes on a time scale, each trend stretch shaded behind the line (Up green, Sideways blue, Down red). */
function IndexChart({ closes, periods, today, compact = false }: { closes: IndexDay[]; periods: TrendPeriod[]; today: string; compact?: boolean }) {
  const first = closes[0].day;
  const last = closes[closes.length - 1].day;
  const span = Math.max(1, daysBetween(first, last));
  const vals = closes.map((c) => c.close);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { lo -= 1; hi += 1; }
  const x = (d: string) => PAD + (Math.min(span, Math.max(0, daysBetween(first, d))) / span) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);
  const line = closes.map((c) => `${x(c.day).toFixed(1)},${y(c.close).toFixed(1)}`).join(' ');
  const bands = periods
    .map((p) => ({ ...p, a: p.from < first ? first : p.from, b: (p.to ?? today) > last ? last : (p.to ?? today) }))
    .filter((p) => p.a <= last && p.b >= first && p.a <= p.b);
  const present = (['up', 'sideways', 'down', 'not_up'] as TrendKey[]).filter((k) => bands.some((b) => b.key === k));
  const label = `KSE-100 from ${day(first)} (${num(closes[0].close, 0)}) to ${day(last)} (${num(closes[closes.length - 1].close, 0)})`
    + (bands.length ? `, shaded by trend: ${present.map((k) => `${plural(bands.filter((b) => b.key === k).length, `${TREND_KEY_WORD[k]} period`)}`).join(', ')}.` : '. No trend readings in this range yet.');
  return (
    <div className={compact ? '' : 'mt-3'}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`${compact ? 'h-14' : 'h-40 lg:h-52'} w-full`} role="img" aria-label={label}>
        {bands.map((b) => <rect key={b.from} x={x(b.a)} y={0} width={Math.max(1.5, x(b.b) - x(b.a))} height={H} className={TREND_FILL[b.key]} />)}
        <polyline points={line} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="stroke-ink" />
      </svg>
      {!compact && <><div className="num flex items-center justify-between text-12 text-muted">
        <span>{day(first)}</span>
        <span>{day(last)}</span>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-12 text-muted" aria-label="Legend">
        {present.map((k) => <li key={k} className="flex items-center gap-1.5"><span className={`h-3 w-4 rounded-sm ${TREND_SWATCH[k]}`} aria-hidden="true" />{TREND_KEY_WORD[k]}{k === 'not_up' ? ' (older rule)' : ''}</li>)}
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-ink" aria-hidden="true" />KSE-100 close</li>
      </ul></>}
    </div>
  );
}

/** The policy rate as a step line since 2015, easing and tightening cycles shaded, years along the bottom. */
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
  const x = (d: string) => L + (Math.min(span, Math.max(0, daysBetween(start, d))) / span) * (W - L - PAD);
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
  const label = `Policy rate from ${day(start)} to ${day(today)}: ${steps[0].v}% at the start, a high of ${Math.max(...vals)}%, a low of ${Math.min(...vals)}%, and ${now.v}% now. ${plural(bands.filter((b) => b.cycle === 'easing').length, 'easing cycle')} shaded blue, ${plural(bands.filter((b) => b.cycle === 'tightening').length, 'tightening cycle')} shaded grey.`;
  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full lg:h-56" role="img" aria-label={label}>
        {bands.map((b) => (
          <rect key={b.from} x={x(b.a)} y={PAD} width={Math.max(1.5, x(b.b) - x(b.a))} height={H - BOTTOM - PAD}
            className={b.cycle === 'easing' ? CYCLE_FILL.easing : CYCLE_FILL.tightening} />
        ))}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - PAD} y1={y(t)} y2={y(t)} strokeWidth="0.5" strokeDasharray="2 3" className="stroke-muted/40" />
            <text x={L - 3} y={y(t) + 3} textAnchor="end" fontSize="9" className="fill-muted">{t}%</text>
          </g>
        ))}
        <path d={d} fill="none" strokeWidth="2" strokeLinejoin="round" className="stroke-ink" />
        {years.map((yr) => <text key={yr} x={x(`${yr}-01-01`)} y={H - 4} textAnchor="middle" fontSize="9" className="fill-muted">{yr}</text>)}
      </svg>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-12 text-muted" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className={`h-3 w-4 rounded-sm ${CYCLE_SWATCH.easing}`} aria-hidden="true" />Easing (cuts)</li>
        <li className="flex items-center gap-1.5"><span className={`h-3 w-4 rounded-sm ${CYCLE_SWATCH.tightening}`} aria-hidden="true" />Tightening (hikes)</li>
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-ink" aria-hidden="true" />Policy rate</li>
      </ul>
    </div>
  );
}
