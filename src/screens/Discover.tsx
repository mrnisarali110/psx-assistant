import { useEffect, useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import {
  DV_SORTS, UP_SORTS, UV_SORTS, dividendLeaders, effectiveFrequency, sortDividends, sortUndervalued, sortUpcoming, undervalued, upcomingDividends,
  type DividendLeader, type DvSort, type Undervalued, type UpSort, type UvSort,
} from '../../shared/discover.ts';
import { tradingCalendar } from '../../shared/calendar.ts';
import { aiTextMatches, oneOffYield, qualityChips, type QualityChip } from '../../shared/quality.ts';
import type { PeFigure } from '../../shared/valuation.ts';
import { useHoldingActions } from '../components/HoldingActions.tsx';
import { exLabel } from '../../shared/symbols.ts';
import type { BcState } from '../../shared/bluechip.ts';
import { BcSheet } from '../components/BcBadge.tsx';
import { pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES, type AiPicks, type DividendEvent } from '../../shared/types.ts';
import { day, dayTime, rs2, sectorLabel } from '../../shared/format.ts';
import { AiBadge } from '../components/AiCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Change, Chip, Chips, CompanyMark, Empty, HowItWorks, Segmented, chipCls, chipRowCls } from '../components/ui.tsx';
import { haptic, useSwipeTabs } from '../lib/gestures.ts';
import { stockHref } from '../lib/nav.ts';

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

/** The P/E as every screen shows it (valuation.peFor): a loss reads "n/a (loss)", never a negative P/E. */
const peText = (pe: number | null, fig?: PeFigure) => (pe != null ? pe.toFixed(1) : fig?.loss ? 'n/a (loss)' : 'n/a');

/** The number a sort is about, shown big on the right of each undervalued card. */
function uvMetric(r: { discount_pct: number | null; pe: number | null; dividend_yield_pct: number | null }, by: UvSort): { value: string; label: string } {
  if (by === 'pe') return { value: peText(r.pe), label: 'P/E' };
  if (by === 'yield') return { value: r.dividend_yield_pct == null ? 'n/a' : `${r.dividend_yield_pct.toFixed(1)}%`, label: 'yield' };
  return r.discount_pct != null && r.discount_pct > 0 ? { value: `${r.discount_pct.toFixed(0)}%`, label: 'cheaper than sector' } : { value: peText(r.pe), label: 'P/E' };
}

/** Quality chips: warnings in caution, missing figures in neutral grey (red / green mean price direction only). */
function QualityTags({ chips }: { chips: QualityChip[] }) {
  return <>{chips.map((c) => <Chip key={c.key} kind={c.tone === 'slate' ? 'neutral' : 'caution'}>{c.label}</Chip>)}</>;
}
const ExChip = ({ ex }: { ex?: string | null }) => { const l = exLabel(ex); return l ? <Chip kind="exdiv">{l}</Chip> : null; };
/** A neutral chip with a figure in it. */
const Fact = ({ children }: { children: React.ReactNode }) => (
  <span className="num inline-flex max-w-full items-baseline gap-1 whitespace-nowrap rounded-chip bg-surface-2 px-2 py-0.5 text-12 font-semibold text-ink">{children}</span>
);
/** A quality chip that means "do not trust the headline number" or "the dividend is not what it looks like". */
const isLossLike = (chips: QualityChip[]) => chips.some((c) => c.key === 'loss' || c.key === 'payout' || c.key === 'outlier');

/** A pill that toggles one filter. */
function FilterChip({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={() => { haptic(); onChange(!on); }}
      className={chipCls(on, 'ink')}>
      {on && <Icon name="check" className="h-3.5 w-3.5" />}{children}
    </button>
  );
}

const INTRO: Record<Tab, { title: string; text: string }> = {
  undervalued: {
    title: 'How the undervalued list works',
    text: 'KSE-100 stocks trading below their sector’s usual P/E that still pay dividends. The sector figure is the median of at least '
      + `${DEFAULT_RULES.undervalued.sector_min_peers} comparable companies; when they are too spread out the card says the sector is too mixed to compare. `
      + `A P/E under ${DEFAULT_RULES.undervalued.pe_outlier_min} or over ${DEFAULT_RULES.undervalued.pe_outlier_max} is left out: it is a quirk of the figures, not a bargain. `
      + 'The P/E comes from the company’s own filings where we have them (the card names the basis), else from PSX.',
  },
  dividends: {
    title: 'How the dividend list works',
    text: 'Highest dividend yields in the KSE-100. A yield built on a one-off (a special payout, or latest results with no dividend) is marked “One-off yield” '
      + `and ranked on the regular payout instead. A company paying out more than ${DEFAULT_RULES.holding.payout_warn_pct}% of its profit gets a “High payout” chip: that rate may not last.`,
  },
  upcoming: {
    title: 'How “buy by” works',
    text: `Dividends where you can still buy in time. “Buy by” is book closure minus ${DEFAULT_RULES.dividends.buy_by_working_days} working days `
      + '(T+1 settlement since Feb 2026). It is an estimate: confirm with your broker.',
  },
};

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
  // One P/E per stock, the very map the stock page and the rules use (live prices win for stocks you hold or watch),
  // so the sector medians built from it match too.
  const { pe } = useHoldingActions({ data, source, reload });
  // The screen rows with the same live price and yield, so each card's price agrees with the P/E worked out on it.
  const screen = useMemo(() => data.screen.map((r) => {
    const p = data.prices[r.symbol];
    return p ? { ...r, price: p.price, pe: p.pe ?? r.pe, dividend_yield_pct: p.dividend_yield_pct ?? r.dividend_yield_pct } : r;
  }), [data.screen, data.prices]);
  const eventsOf = useMemo(() => {
    const m = new Map<string, DividendEvent[]>();
    for (const e of data.dividends) m.set(e.symbol, [...(m.get(e.symbol) ?? []), e]);
    return (symbol: string) => m.get(symbol) ?? [];
  }, [data.dividends]);
  const chipsFor = (r: { symbol: string; pe: number | null; price: number | null; dividend_yield_pct: number | null; change_1y_pct?: number | null }) => {
    const fig = pe[r.symbol];
    return qualityChips(fig ? { ...r, eps: fig.eps, loss: fig.loss } : r, eventsOf(r.symbol), today).filter((c) => c.key !== 'trend'); // the 1y change is drawn with its arrow
  };
  const cal = useMemo(() => tradingCalendar(DEFAULT_RULES, data.indexDaily), [data.indexDaily]);

  const uv = useMemo(() => {
    const rows = sortUndervalued(withAi(undervalued(screen, { shariahOnly, pe }), data.picks.undervalued), sorts.uv).map((r) => {
      const oneOff = oneOffYield(r.symbol, eventsOf(r.symbol), today, data.earnings);
      // The one-off chip says what the special-dividend chip would, and why the yield will not repeat.
      return { r, oneOff, chips: chipsFor(r).filter((c) => !(oneOff && c.key === 'special')) };
    });
    return rows.filter((x) => !(filters.loss && isLossLike(x.chips)) && (!filters.bc || !!data.bluechip[x.r.symbol]?.badge));
  }, [data, screen, pe, shariahOnly, sorts.uv, filters.loss, filters.bc]); // eslint-disable-line react-hooks/exhaustive-deps
  const dv = useMemo(() => {
    const rows = sortDividends(withAi(dividendLeaders(screen, data.dividends, today, { shariahOnly, pe, earnings: data.earnings }), data.picks.dividend), sorts.dv)
      .map((d) => ({ d, chips: chipsFor({ symbol: d.symbol, pe: d.pe, price: d.price, dividend_yield_pct: d.psx_yield_pct }).filter((c) => c.key !== 'special') }));
    return rows.filter((x) => !(filters.loss && isLossLike(x.chips)) && !(filters.special && (x.d.special || x.d.one_off || x.d.high_yield_hint)) && (!filters.bc || !!data.bluechip[x.d.symbol]?.badge));
  }, [data, screen, pe, today, shariahOnly, sorts.dv, filters.loss, filters.special, filters.bc]); // eslint-disable-line react-hooks/exhaustive-deps
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
    ? <Chip kind="neutral">{held.has(symbol) ? 'You own it' : 'Watching'}</Chip>
    : <Button kind="ghost" className="-mr-2 shrink-0 px-3" onClick={() => watch(symbol)}><Icon name="plus" className="h-4 w-4" />Watch</Button>;
  const picksTime = tab === 'undervalued' ? data.picks.undervalued?.created_at : tab === 'dividends' ? data.picks.dividend?.created_at : null;
  /** The AI's sentence, only while every number in it still matches what the card shows (ISSUE-05). */
  const AiWhy = ({ why, shown }: { why: string | undefined; shown: Record<string, number | null | undefined> }) =>
    why && aiTextMatches(why, shown) ? <p className="min-w-0 text-14 leading-relaxed text-ink">{why}</p> : <span className="min-w-0" />;

  return (
    <>
      <header className="space-y-3">
        <h1 className="text-20 font-bold tracking-tight">Discover</h1>
        <div className="lg:max-w-xl"><Segmented label="Discover" value={tab} onChange={setTab} options={TABS} /></div>
        <div className="flex flex-wrap items-center gap-x-3 px-1 text-14 text-muted">
          <HowItWorks title={INTRO[tab].title}><p>{INTRO[tab].text}</p></HowItWorks>
          {picksTime && <span>AI reviewed {dayTime(picksTime)}</span>}
          {shariahOnly && <span>Shariah only</span>}
        </div>
        {/* Filters and sort: one row each on a phone (scrolls sideways), side by side on a wide screen. */}
        <div className="space-y-2 lg:flex lg:flex-wrap lg:items-start lg:gap-x-8 lg:gap-y-3 lg:space-y-0">
          {tab !== 'upcoming' && (
            <div role="group" aria-label="Filters" className={chipRowCls}>
              <FilterChip on={filters.loss} onChange={(loss) => setFilters((f) => ({ ...f, loss }))}>Hide loss-making</FilterChip>
              {tab === 'dividends' && <FilterChip on={filters.special} onChange={(special) => setFilters((f) => ({ ...f, special }))}>Hide one-off yields</FilterChip>}
              <FilterChip on={filters.bc} onChange={(bc) => setFilters((f) => ({ ...f, bc }))}>Blue chips only</FilterChip>
              {!data.settings.shariah_only && <FilterChip on={filters.shariah} onChange={(shariah) => setFilters((f) => ({ ...f, shariah }))}>Shariah only</FilterChip>}
            </div>
          )}
          {tab === 'undervalued' && <Chips label="Sort undervalued stocks by" options={UV_SORTS} value={sorts.uv} onChange={(uv) => setSorts((s) => ({ ...s, uv }))} />}
          {tab === 'dividends' && <Chips label="Sort dividend stocks by" options={DV_SORTS} value={sorts.dv} onChange={(dv) => setSorts((s) => ({ ...s, dv }))} />}
          {tab === 'upcoming' && <Chips label="Sort upcoming dividends by" options={UP_SORTS} value={sorts.up} onChange={(up) => setSorts((s) => ({ ...s, up }))} />}
        </div>
      </header>

      <div {...swipe} className="touch-pan-y space-y-3 lg:grid lg:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] lg:gap-4 lg:space-y-0">
        {tab === 'undervalued' && (uv.length ? uv.map(({ r, chips, oneOff }, i) => <UndervaluedCard key={r.symbol} r={r} i={i} chips={chips} oneOff={oneOff} fig={pe[r.symbol]} by={sorts.uv} bc={data.bluechip[r.symbol]} watch={<WatchBtn symbol={r.symbol} />}
          ai={<AiWhy why={r.ai?.why} shown={{ ...r.ai?.facts, pe: r.pe, sector_pe: r.sector_pe, discount: r.discount_pct, yield: r.dividend_yield_pct, price: r.price, change_1y: r.change_1y_pct }} />} />)
          : <Empty className="lg:col-span-full" title={filters.loss || filters.bc || shariahOnly ? 'Nothing passes these filters' : 'No screen data yet'}>{filters.loss || filters.bc || shariahOnly ? 'Turn a filter off to see more.' : 'It fills after the next market check.'}</Empty>)}

        {tab === 'dividends' && (dv.length ? dv.map(({ d, chips }, i) => <DividendCard key={d.symbol} d={d} i={i} chips={chips} fig={pe[d.symbol]} bc={data.bluechip[d.symbol]} watch={<WatchBtn symbol={d.symbol} />}
          ai={<AiWhy why={d.ai?.why} shown={{ ...d.ai?.facts, yield: d.dividend_yield_pct, psx_yield: d.psx_yield_pct, dps: d.annual_dps, last: d.last?.dps, price: d.price, pe: d.pe }} />} />)
          : <Empty className="lg:col-span-full" title={filters.loss || filters.special || filters.bc || shariahOnly ? 'Nothing passes these filters' : 'No dividend data yet'}>{filters.loss || filters.special || filters.bc || shariahOnly ? 'Turn a filter off to see more.' : 'It fills after the next market check.'}</Empty>)}

        {tab === 'upcoming' && (up.length ? up.map((u) => (
          <Card key={u.id} className="flex h-full items-center">
            <div className="flex w-full items-center gap-3">
              <a href={stockHref(u.symbol)} className="press -m-2 flex min-w-0 flex-1 items-center gap-3 rounded-control p-2 hover:bg-surface-2">
                {/* Days left is a warning only when it is nearly gone. */}
                <div className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-control ${u.days_left <= 2 ? 'bg-caution/10 text-caution' : 'bg-surface-2 text-ink'}`}>
                  <span className="num text-20 leading-none font-bold">{u.days_left}</span>
                  <span className="text-12 font-semibold">{u.days_left === 1 ? 'day' : 'days'}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink">{u.symbol}{held.has(u.symbol) && <Chip kind="neutral">Yours</Chip>}{!u.verified && <Chip kind="caution">Check PDF</Chip>}</p>
                  <p className="text-14 text-ink">{u.dps != null ? <b className="num">Rs {u.dps}/share</b> : 'Dividend'}{u.dividend_type ? ` ${u.dividend_type}` : ''}</p>
                  <p className="text-12 text-muted">Buy by <b className="text-ink">{day(u.buy_by)}</b> · book closure {day(u.book_closure_from)}</p>
                </div>
              </a>
              {u.pdf_url
                ? <a href={u.pdf_url} target="_blank" rel="noopener noreferrer" aria-label={`${u.symbol} notice PDF`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-brand hover:bg-surface-2"><Icon name="external" /></a>
                : <WatchBtn symbol={u.symbol} />}
            </div>
          </Card>
        )) : <Empty className="lg:col-span-full" title="No upcoming dividends found yet">The night scan reads dividend notices from PSX and lists them here with the last day to buy.</Empty>)}
      </div>
    </>
  );
}

/** The top of a card: company mark, name, price and the headline number. The whole block opens the stock page. */
function CardHead({ symbol, sector, price, i, ai, value, label }: { symbol: string; sector: string | null; price: number | null; i: number; ai: boolean; value: string; label: string }) {
  return (
    <a href={stockHref(symbol)} className="press -m-2 flex items-center gap-3 rounded-control p-2 hover:bg-surface-2">
      <CompanyMark symbol={symbol} sector={sector} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 font-semibold text-ink"><span className="num text-12 font-medium text-muted">{i + 1}</span>{symbol}{ai && <AiBadge />}</p>
        <p className="truncate text-12 text-muted">{sector ? sectorLabel(sector) : ''}{sector ? ' · ' : ''}{rs2(price)}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="num text-20 font-bold text-ink">{value}</p>
        <p className="text-12 text-muted">{label}</p>
      </div>
    </a>
  );
}

function UndervaluedCard({ r, i, chips, oneOff, fig, by, watch, ai, bc }: { r: Undervalued & { ai: { n: number; why: string; facts?: Record<string, number> } | null }; i: number; chips: QualityChip[]; oneOff: boolean; fig?: PeFigure; by: UvSort; watch: React.ReactNode; ai: React.ReactNode; bc?: BcState }) {
  const m = uvMetric(r, by);
  const basis = [r.pe_label ? `P/E: ${r.pe_label}` : null, r.sector_pe == null && r.sector_note ? r.sector_note.charAt(0).toUpperCase() + r.sector_note.slice(1) : null].filter(Boolean);
  return (
    <Card className="flex h-full flex-col">
      <CardHead symbol={r.symbol} sector={r.sector} price={r.price} i={i} ai={!!r.ai} value={m.value} label={m.label} />
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <BcChip bc={bc} />{r.is_shariah && <Chip kind="shariah" />}<ExChip ex={r.ex} />
        <Fact>P/E {peText(r.pe, fig)}{r.sector_pe ? <span className="font-medium text-muted">vs sector {r.sector_pe}</span> : null}</Fact>
        {r.discount_pct != null && r.discount_pct > 0 && m.label !== 'cheaper than sector' && <Fact>{r.discount_pct.toFixed(0)}% cheaper than sector</Fact>}
        <Fact>{r.dividend_yield_pct == null ? 'yield n/a' : `${r.dividend_yield_pct.toFixed(1)}% yield`}</Fact>
        {r.change_1y_pct != null && <Fact><span className="font-medium text-muted">1y</span><Change value={r.change_1y_pct} digits={0} label="1 year" /></Fact>}
        {oneOff && <Chip kind="caution">One-off yield</Chip>}
        <QualityTags chips={chips} />
      </div>
      {basis.length > 0 && <p className="mt-2 text-12 text-muted">{basis.join(' · ')}</p>}
      <CardFoot ai={ai} watch={watch} />
    </Card>
  );
}

function DividendCard({ d, i, chips, fig, watch, ai, bc }: { d: DividendLeader & { ai: { n: number; why: string; frequency?: string | null; facts?: Record<string, number> } | null }; i: number; chips: QualityChip[]; fig?: PeFigure; watch: React.ReactNode; ai: React.ReactNode; bc?: BcState }) {
  const freq = effectiveFrequency(d);
  const freqNote = d.frequency ? 'from filings' : freq ? 'AI estimate' : d.frequency_enough ? 'how often' : 'not enough history';
  const tile = 'rounded-control bg-surface-2 p-2';
  return (
    <Card className="flex h-full flex-col">
      <CardHead symbol={d.symbol} sector={d.sector} price={d.price} i={i} ai={!!d.ai} value={`${d.dividend_yield_pct.toFixed(1)}%`} label={d.yield_from === 'filings' ? 'regular yield' : 'yield'} />
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className={tile}><p className="num text-14 font-semibold text-ink">Rs {d.annual_dps.toFixed(2)}</p><p className="text-12 text-muted">per share / year</p></div>
        <div className={tile}><p className="num text-14 font-semibold text-ink">{d.last?.dps != null ? `Rs ${d.last.dps}` : 'n/a'}</p><p className="text-12 text-muted">{d.last ? `last, ${day(d.last.announced_on)}` : 'no filing read yet'}</p></div>
        <div className={tile}><p className="text-14 font-semibold text-ink">{freq ?? 'n/a'}</p><p className="text-12 text-muted">{freqNote}</p></div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <BcChip bc={bc} />{d.is_shariah && <Chip kind="shariah" />}<ExChip ex={d.ex} />
        {(d.pe != null || fig?.loss) && <Fact>P/E {peText(d.pe, fig)}</Fact>}
        {d.one_off && <Chip kind="caution">One-off yield</Chip>}
        {d.high_yield_hint && <Chip kind="caution">May include a one-off</Chip>}
        <QualityTags chips={chips} />
      </div>
      {((d.pe_label && d.pe != null) || d.special || d.suspect) && (
        <div className="mt-2 space-y-1 text-12">
          {d.special && <p className="text-muted">Includes a special Rs {d.special.dps} ({day(d.special.announced_on)}); ranked on the regular payout. PSX yield {d.psx_yield_pct.toFixed(1)}%.</p>}
          {d.suspect && <p className="text-caution">Ranked lower: pays out more than {DEFAULT_RULES.dividends.suspect_payout_pct}% of profit and no filing shows which part is a one-off.</p>}
          {d.pe_label && d.pe != null && <p className="text-muted">P/E: {d.pe_label}</p>}
        </div>
      )}
      <CardFoot ai={ai} watch={watch} />
    </Card>
  );
}

/** The AI's reason and the Watch action, pinned to the bottom of the card so every card in a row ends on the same line. */
function CardFoot({ ai, watch }: { ai: React.ReactNode; watch: React.ReactNode }) {
  return (
    <>
      <span aria-hidden="true" className="min-h-3 flex-1" />
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-line pt-2">{ai}{watch}</div>
    </>
  );
}

/**
 * "Blue chip" (or "Blue chip at risk") / "Not a blue chip" from the worker's checks; the AI never decides it. Neutral
 * grey for not, so it does not read as a price fall. Tapping opens the five checks.
 */
function BcChip({ bc }: { bc?: BcState }) {
  const [open, setOpen] = useState(false);
  if (!bc || (bc.status !== 'bc' && bc.status !== 'at_risk' && bc.status !== 'not_bc')) return null;
  const chip = bc.status === 'bc' ? <Chip kind="bluechip" /> : bc.status === 'at_risk' ? <Chip kind="caution">Blue chip at risk</Chip> : <Chip kind="not_bluechip" />;
  return (
    <>
      <button type="button" aria-label={`${bc.symbol}: ${bc.status === 'not_bc' ? 'not a blue chip' : bc.status === 'at_risk' ? 'blue chip at risk' : 'blue chip'}, show the checks`}
        onClick={() => { haptic(); setOpen(true); }}
        className="relative inline-flex cursor-pointer rounded-chip after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']">
        {chip}
      </button>
      <BcSheet open={open} onClose={() => setOpen(false)} state={bc} />
    </>
  );
}
