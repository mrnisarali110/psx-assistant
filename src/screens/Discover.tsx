import { useEffect, useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import {
  DV_SORTS, UP_SORTS, UV_SORTS, dividendLeaders, effectiveFrequency, sortDividends, sortUndervalued, sortUpcoming, undervalued, upcomingDividends,
  type DividendLeader, type DvSort, type Undervalued, type UpSort, type UvSort,
} from '../../shared/discover.ts';
import { tradingCalendar } from '../../shared/calendar.ts';
import { aiTextMatches, qualityChips, type QualityChip } from '../../shared/quality.ts';
import { exLabel } from '../../shared/symbols.ts';
import type { BcState } from '../../shared/bluechip.ts';
import { BcBadge } from '../components/BcBadge.tsx';
import { pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES, type AiPicks, type DividendEvent } from '../../shared/types.ts';
import { ago, dateLabel, rs2, titleCase } from '../../shared/format.ts';
import { AiBadge } from '../components/AiCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Chips, Disclaimer, Empty, Segmented, SymbolAvatar, Tag } from '../components/ui.tsx';
import { haptic, useSwipeTabs } from '../lib/gestures.ts';

type Tab = 'undervalued' | 'dividends' | 'upcoming';
const TABS: { value: Tab; label: string }[] = [{ value: 'undervalued', label: 'Undervalued' }, { value: 'dividends', label: 'Dividends' }, { value: 'upcoming', label: 'Upcoming' }];

/** Attach the AI's pick (rank + reason) to the rules' rows; ordering is the user's choice. */
function withAi<T extends { symbol: string }>(rows: T[], picks: AiPicks | null) {
  const why = new Map((picks?.items ?? []).map((i, n) => [i.symbol, { ...i, n }]));
  return rows.map((r) => ({ ...r, ai: why.get(r.symbol) ?? null }));
}

type Sorts = { uv: UvSort; dv: DvSort; up: UpSort };
type Filters = { loss: boolean; special: boolean; shariah: boolean; bc: boolean };
const SORT_KEY = 'psx-discover-sort';
const FILTER_KEY = 'psx-discover-filters';
const DEFAULT_SORTS: Sorts = { uv: 'discount', dv: 'yield', up: 'soonest' };
const DEFAULT_FILTERS: Filters = { loss: false, special: false, shariah: false, bc: false };
function loadSorts(): Sorts {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) ?? '{}');
    return {
      uv: UV_SORTS.some((o) => o.value === s.uv) ? s.uv : DEFAULT_SORTS.uv,
      dv: DV_SORTS.some((o) => o.value === s.dv) ? s.dv : DEFAULT_SORTS.dv,
      up: UP_SORTS.some((o) => o.value === s.up) ? s.up : DEFAULT_SORTS.up,
    };
  } catch { return DEFAULT_SORTS; }
}
function loadFilters(): Filters {
  try { return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') }; } catch { return DEFAULT_FILTERS; }
}

/** The number a sort is about, shown big on the right of each undervalued card. */
function uvMetric(r: { discount_pct: number | null; pe: number | null; dividend_yield_pct: number | null }, by: UvSort): { value: string; label: string } {
  if (by === 'pe') return { value: r.pe == null ? 'n/a' : r.pe.toFixed(1), label: 'P/E' };
  if (by === 'yield') return { value: r.dividend_yield_pct == null ? 'n/a' : `${r.dividend_yield_pct.toFixed(1)}%`, label: 'yield' };
  return r.discount_pct != null && r.discount_pct > 0 ? { value: `${r.discount_pct.toFixed(0)}%`, label: 'cheaper than sector' } : { value: r.pe == null ? 'n/a' : r.pe.toFixed(1), label: 'P/E' };
}

const TONE = { green: 'green', red: 'red', amber: 'amber', slate: 'slate' } as const;
function QualityTags({ chips }: { chips: QualityChip[] }) {
  return <>{chips.map((c) => <Tag key={c.key} tone={TONE[c.tone]} wrap>{c.label}</Tag>)}</>;
}
const ExTag = ({ ex }: { ex?: string | null }) => (ex ? <Tag tone="violet">{exLabel(ex)}</Tag> : null);
/** A quality chip that means "do not trust the headline number" or "the dividend is not what it looks like". */
const isLossLike = (chips: QualityChip[]) => chips.some((c) => c.key === 'loss' || c.key === 'payout' || c.key === 'outlier');

/** A pill that toggles one filter. */
function FilterChip({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={() => { haptic(); onChange(!on); }}
      className={`inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full px-3 text-xs font-semibold whitespace-nowrap transition ${on ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>
      {on && <Icon name="check" className="h-3.5 w-3.5" />}{children}
    </button>
  );
}

export function Discover({ data, source, reload }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('undervalued');
  const [sorts, setSorts] = useState<Sorts>(loadSorts);
  const [filters, setFilters] = useState<Filters>(loadFilters);
  useEffect(() => { try { localStorage.setItem(SORT_KEY, JSON.stringify(sorts)); } catch { /* private mode */ } }, [sorts]);
  useEffect(() => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* private mode */ } }, [filters]);
  const toast = useToast();
  const today = pktDate(new Date());
  const shariahOnly = data.settings.shariah_only || filters.shariah;
  const mine = useMemo(() => new Set([...data.holdings.map((h) => h.symbol), ...data.watchlist.map((w) => w.symbol)]), [data]);
  const held = useMemo(() => new Set(data.holdings.map((h) => h.symbol)), [data]);
  const eventsOf = useMemo(() => {
    const m = new Map<string, DividendEvent[]>();
    for (const e of data.dividends) m.set(e.symbol, [...(m.get(e.symbol) ?? []), e]);
    return (symbol: string) => m.get(symbol) ?? [];
  }, [data.dividends]);
  const chipsFor = (r: { symbol: string; pe: number | null; price: number | null; dividend_yield_pct: number | null; change_1y_pct?: number | null }) =>
    qualityChips(r, eventsOf(r.symbol), today).filter((c) => c.key !== 'trend'); // the 1y chip is drawn separately
  const cal = useMemo(() => tradingCalendar(DEFAULT_RULES, data.indexDaily), [data.indexDaily]);

  const uv = useMemo(() => {
    const rows = sortUndervalued(withAi(undervalued(data.screen, { shariahOnly }), data.picks.undervalued), sorts.uv).map((r) => ({ r, chips: chipsFor(r) }));
    return rows.filter((x) => !(filters.loss && isLossLike(x.chips)) && (!filters.bc || !!data.bluechip[x.r.symbol]?.badge));
  }, [data, shariahOnly, sorts.uv, filters.loss]); // eslint-disable-line react-hooks/exhaustive-deps
  const dv = useMemo(() => {
    const rows = sortDividends(withAi(dividendLeaders(data.screen, data.dividends, today, { shariahOnly }), data.picks.dividend), sorts.dv)
      .map((d) => ({ d, chips: chipsFor({ symbol: d.symbol, pe: d.pe, price: d.price, dividend_yield_pct: d.psx_yield_pct }).filter((c) => c.key !== 'special') }));
    return rows.filter((x) => !(filters.loss && isLossLike(x.chips)) && !(filters.special && (x.d.special || x.d.high_yield_hint)) && (!filters.bc || !!data.bluechip[x.d.symbol]?.badge));
  }, [data, today, shariahOnly, sorts.dv, filters.loss, filters.special]); // eslint-disable-line react-hooks/exhaustive-deps
  const up = useMemo(() => sortUpcoming(upcomingDividends(data.dividends, today, DEFAULT_RULES, cal), sorts.up), [data.dividends, today, sorts.up, cal]);
  const swipe = useSwipeTabs(TABS.length, TABS.findIndex((t) => t.value === tab), (i) => setTab(TABS[i].value));

  const watch = async (symbol: string) => {
    try {
      await source.addWatch(symbol, 'From Discover');
      await reload();
      toast(`Watching ${symbol}`);
    } catch (e) { toast((e as Error).message.includes('duplicate') ? `Already watching ${symbol}` : (e as Error).message); }
  };
  const WatchBtn = ({ symbol }: { symbol: string }) => mine.has(symbol)
    ? <Tag tone={held.has(symbol) ? 'teal' : 'slate'}>{held.has(symbol) ? 'You own it' : 'Watching'}</Tag>
    : <Button kind="ghost" className="min-h-9 px-2" onClick={() => watch(symbol)}><Icon name="plus" className="h-4 w-4" />Watch</Button>;
  const picksTime = tab === 'undervalued' ? data.picks.undervalued?.created_at : tab === 'dividends' ? data.picks.dividend?.created_at : null;
  /** The AI's sentence, only while every number in it still matches what the card shows (ISSUE-05). */
  const AiWhy = ({ why, shown }: { why: string | undefined; shown: Record<string, number | null | undefined> }) =>
    why && aiTextMatches(why, shown) ? <p className="min-w-0 text-sm">{why}</p> : <span className="min-w-0" />;

  return (
    <>
      <header className="space-y-3">
        <h1 className="text-xl font-bold tracking-tight">Discover</h1>
        <Segmented label="Discover" value={tab} onChange={setTab} options={TABS} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          {tab === 'undervalued' && 'KSE-100 stocks trading below their sector’s usual P/E that still pay dividends. A P/E under 2 or over 100 is left out: it is a quirk of the figures, not a bargain.'}
          {tab === 'dividends' && 'Highest dividend yields in the KSE-100. A yield built on a one-off special payout is ranked on the regular payout instead.'}
          {tab === 'upcoming' && 'Dividends where you can still buy in time. “Buy by” = book closure minus 2 working days (T+1 settlement since Feb 2026; an estimate, confirm with your broker).'}
          {picksTime && <> AI reviewed {ago(picksTime)}.</>}{shariahOnly && ' Shariah only.'}
        </p>
        {tab !== 'upcoming' && (
          <div role="group" aria-label="Filters" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 py-0.5 scrollbar-none">
            <FilterChip on={filters.loss} onChange={(loss) => setFilters((f) => ({ ...f, loss }))}>Hide loss-making</FilterChip>
            {tab === 'dividends' && <FilterChip on={filters.special} onChange={(special) => setFilters((f) => ({ ...f, special }))}>Hide special dividends</FilterChip>}
            <FilterChip on={filters.bc} onChange={(bc) => setFilters((f) => ({ ...f, bc }))}>Blue chips only</FilterChip>
            {!data.settings.shariah_only && <FilterChip on={filters.shariah} onChange={(shariah) => setFilters((f) => ({ ...f, shariah }))}>Shariah only</FilterChip>}
          </div>
        )}
        {tab === 'undervalued' && <Chips label="Sort undervalued stocks by" options={UV_SORTS} value={sorts.uv} onChange={(uv) => setSorts((s) => ({ ...s, uv }))} />}
        {tab === 'dividends' && <Chips label="Sort dividend stocks by" options={DV_SORTS} value={sorts.dv} onChange={(dv) => setSorts((s) => ({ ...s, dv }))} />}
        {tab === 'upcoming' && <Chips label="Sort upcoming dividends by" options={UP_SORTS} value={sorts.up} onChange={(up) => setSorts((s) => ({ ...s, up }))} />}
      </header>

      <div {...swipe} className="touch-pan-y space-y-3">
        {tab === 'undervalued' && (uv.length ? uv.map(({ r, chips }, i) => <UndervaluedCard key={r.symbol} r={r} i={i} chips={chips} by={sorts.uv} bc={data.bluechip[r.symbol]} watch={<WatchBtn symbol={r.symbol} />}
          ai={<AiWhy why={r.ai?.why} shown={{ pe: r.pe, sector_pe: r.sector_pe, discount: r.discount_pct, yield: r.dividend_yield_pct, price: r.price, change_1y: r.change_1y_pct }} />} />)
          : <Empty title={filters.loss || filters.bc || shariahOnly ? 'Nothing passes these filters' : 'No screen data yet'}>{filters.loss || filters.bc || shariahOnly ? 'Turn a filter off to see more.' : 'It fills after the next market check.'}</Empty>)}

        {tab === 'dividends' && (dv.length ? dv.map(({ d, chips }, i) => <DividendCard key={d.symbol} d={d} i={i} chips={chips} bc={data.bluechip[d.symbol]} watch={<WatchBtn symbol={d.symbol} />}
          ai={<AiWhy why={d.ai?.why} shown={{ yield: d.dividend_yield_pct, psx_yield: d.psx_yield_pct, dps: d.annual_dps, last: d.last?.dps, price: d.price, pe: d.pe }} />} />)
          : <Empty title={filters.loss || filters.special || filters.bc || shariahOnly ? 'Nothing passes these filters' : 'No dividend data yet'}>{filters.loss || filters.special || filters.bc || shariahOnly ? 'Turn a filter off to see more.' : 'It fills after the next market check.'}</Empty>)}

        {tab === 'upcoming' && (up.length ? up.map((u) => (
          <Card key={u.id}>
            <div className="flex items-center gap-3">
              <div className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl ${u.days_left <= 2 ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'}`}>
                <span className="num text-lg leading-none font-bold">{u.days_left}</span>
                <span className="text-[10px] font-semibold uppercase">{u.days_left === 1 ? 'day' : 'days'}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 font-semibold">{u.symbol}{held.has(u.symbol) && <Tag tone="teal">Yours</Tag>}{!u.verified && <Tag tone="amber">check PDF</Tag>}</p>
                <p className="text-sm">{u.dps != null ? <b className="num">Rs {u.dps}/share</b> : 'Dividend'}{u.dividend_type ? ` ${u.dividend_type}` : ''}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">Buy by <b>{dateLabel(u.buy_by)}</b> · book closure {dateLabel(u.book_closure_from!)}</p>
              </div>
              {u.pdf_url
                ? <a href={u.pdf_url} target="_blank" rel="noopener noreferrer" aria-label={`${u.symbol} notice PDF`} className="flex h-11 w-11 items-center justify-center rounded-full text-teal-700 dark:text-teal-400"><Icon name="external" /></a>
                : <WatchBtn symbol={u.symbol} />}
            </div>
          </Card>
        )) : <Empty title="No upcoming dividends found yet">The night scan reads dividend notices from PSX and lists them here with the last day to buy.</Empty>)}
      </div>
      <Disclaimer />
    </>
  );
}

function UndervaluedCard({ r, i, chips, by, watch, ai, bc }: { r: Undervalued & { ai: { n: number; why: string } | null }; i: number; chips: QualityChip[]; by: UvSort; watch: React.ReactNode; ai: React.ReactNode; bc?: BcState }) {
  const m = uvMetric(r, by);
  return (
    <Card>
      <div className="flex items-center gap-3">
        <SymbolAvatar symbol={r.symbol} change={r.change_pct} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 font-semibold"><span className="num text-xs text-slate-400">{i + 1}</span>{r.symbol}<BcBadge state={bc} symbol={r.symbol} mode="status" />{r.ai && <AiBadge />}{r.is_shariah && <Tag tone="green">Shariah</Tag>}<ExTag ex={r.ex} /></p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{r.sector ? titleCase(r.sector) : ''} · {rs2(r.price)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="num text-lg font-bold text-emerald-600 dark:text-emerald-400">{m.value}</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{m.label}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Tag tone="teal">P/E {r.pe == null ? 'n/a' : r.pe.toFixed(1)}{r.sector_pe ? ` vs ${r.sector_pe}` : ''}</Tag>
        {r.discount_pct != null && r.discount_pct > 0 && <Tag tone="green">{r.discount_pct.toFixed(0)}% cheaper than sector</Tag>}
        <Tag>{r.dividend_yield_pct == null ? 'yield n/a' : `${r.dividend_yield_pct.toFixed(1)}% yield`}</Tag>
        {r.change_1y_pct != null && <Tag tone={r.change_1y_pct < 0 ? 'red' : 'green'}>1y {r.change_1y_pct > 0 ? '+' : ''}{r.change_1y_pct.toFixed(0)}%</Tag>}
        <QualityTags chips={chips} />
      </div>
      <NotBlueChip bc={bc} />
      <div className="mt-2 flex items-center justify-between gap-2">{ai}{watch}</div>
    </Card>
  );
}

function DividendCard({ d, i, chips, watch, ai, bc }: { d: DividendLeader & { ai: { n: number; why: string; frequency?: string | null } | null }; i: number; chips: QualityChip[]; watch: React.ReactNode; ai: React.ReactNode; bc?: BcState }) {
  const freq = effectiveFrequency(d);
  const freqNote = d.frequency ? 'from filings' : freq ? 'AI estimate' : d.frequency_enough ? 'how often' : 'not enough history';
  return (
    <Card>
      <div className="flex items-center gap-3">
        <SymbolAvatar symbol={d.symbol} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 font-semibold"><span className="num text-xs text-slate-400">{i + 1}</span>{d.symbol}<BcBadge state={bc} symbol={d.symbol} mode="status" />{d.ai && <AiBadge />}{d.is_shariah && <Tag tone="green">Shariah</Tag>}<ExTag ex={d.ex} /></p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{d.sector ? titleCase(d.sector) : ''} · {rs2(d.price)}</p>
        </div>
        <div className="text-right">
          <p className="num text-lg font-bold text-emerald-600 dark:text-emerald-400">{d.dividend_yield_pct.toFixed(1)}%</p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">{d.yield_from === 'filings' ? 'regular yield' : 'yield'}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-2xl bg-slate-50 p-2 dark:bg-slate-800/60"><p className="num text-sm font-semibold">Rs {d.annual_dps.toFixed(2)}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">per share / year</p></div>
        <div className="rounded-2xl bg-slate-50 p-2 dark:bg-slate-800/60"><p className="num text-sm font-semibold">{d.last?.dps != null ? `Rs ${d.last.dps}` : 'n/a'}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{d.last ? `last, ${dateLabel(d.last.announced_on).replace(/^\w+, /, '')}` : 'no filing read yet'}</p></div>
        <div className="rounded-2xl bg-slate-50 p-2 dark:bg-slate-800/60"><p className="text-sm font-semibold">{freq ?? 'n/a'}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{freqNote}</p></div>
      </div>
      {(d.special || d.high_yield_hint || d.suspect || chips.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {d.special && <Tag tone="amber" wrap>Special Rs {d.special.dps} on {dateLabel(d.special.announced_on).replace(/^\w+, /, '')} · PSX yield {d.psx_yield_pct.toFixed(1)}%</Tag>}
          {d.suspect && <Tag tone="amber" wrap>Ranked lower: pays out more than {DEFAULT_RULES.dividends.suspect_payout_pct}% of profit, one-off unclear</Tag>}
          {d.high_yield_hint && <Tag tone="amber" wrap>Above {DEFAULT_RULES.dividends.special_yield_hint_pct}%: may include a one-off</Tag>}
          <QualityTags chips={chips} />
        </div>
      )}
      <NotBlueChip bc={bc} />
      <div className="mt-2 flex items-center justify-between gap-2">{ai}{watch}</div>
    </Card>
  );
}

/** A Discover suggestion that is not a blue chip says so (the badge's own checks decide; the AI never does). */
function NotBlueChip({ bc }: { bc?: BcState }) {
  if (bc?.status !== 'not_bc') return null;
  return <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-rose-700 dark:text-rose-300"><Icon name="alert" className="mt-px h-3.5 w-3.5 shrink-0" />Not a blue chip — higher risk</p>;
}
