import { useEffect, useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import {
  DV_SORTS, UP_SORTS, UV_SORTS, dividendLeaders, effectiveFrequency, sortDividends, sortUndervalued, sortUpcoming, undervalued, upcomingDividends,
  type DvSort, type UpSort, type UvSort,
} from '../../shared/discover.ts';
import { pktDate } from '../../shared/time.ts';
import type { AiPicks } from '../../shared/types.ts';
import { ago, dateLabel, rs2, titleCase } from '../../shared/format.ts';
import { AiBadge } from '../components/AiCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Chips, Disclaimer, Empty, Segmented, SymbolAvatar, Tag } from '../components/ui.tsx';
import { useSwipeTabs } from '../lib/gestures.ts';

type Tab = 'undervalued' | 'dividends' | 'upcoming';
const TABS: { value: Tab; label: string }[] = [{ value: 'undervalued', label: 'Undervalued' }, { value: 'dividends', label: 'Dividends' }, { value: 'upcoming', label: 'Upcoming' }];

/** Attach the AI's pick (rank + reason) to the rules' rows; ordering is the user's choice. */
function withAi<T extends { symbol: string }>(rows: T[], picks: AiPicks | null) {
  const why = new Map((picks?.items ?? []).map((i, n) => [i.symbol, { ...i, n }]));
  return rows.map((r) => ({ ...r, ai: why.get(r.symbol) ?? null }));
}

type Sorts = { uv: UvSort; dv: DvSort; up: UpSort };
const SORT_KEY = 'psx-discover-sort';
const DEFAULT_SORTS: Sorts = { uv: 'score', dv: 'yield', up: 'soonest' };
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

/** The number a sort is about, shown big on the right of each undervalued card. */
function uvMetric(r: { discount_pct: number | null; pe: number | null; dividend_yield_pct: number | null }, by: UvSort): { value: string; label: string } {
  if (by === 'pe') return { value: r.pe == null ? '—' : r.pe.toFixed(1), label: 'P/E' };
  if (by === 'yield') return { value: `${(r.dividend_yield_pct ?? 0).toFixed(1)}%`, label: 'yield' };
  return r.discount_pct != null && r.discount_pct > 0 ? { value: `${r.discount_pct.toFixed(0)}%`, label: 'cheaper than sector' } : { value: r.pe == null ? '—' : r.pe.toFixed(1), label: 'P/E' };
}

export function Discover({ data, source, reload }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('undervalued');
  const [sorts, setSorts] = useState<Sorts>(loadSorts);
  useEffect(() => { try { localStorage.setItem(SORT_KEY, JSON.stringify(sorts)); } catch { /* private mode */ } }, [sorts]);
  const toast = useToast();
  const today = pktDate(new Date());
  const shariahOnly = data.settings.shariah_only;
  const mine = useMemo(() => new Set([...data.holdings.map((h) => h.symbol), ...data.watchlist.map((w) => w.symbol)]), [data]);
  const held = useMemo(() => new Set(data.holdings.map((h) => h.symbol)), [data]);
  const uv = useMemo(() => sortUndervalued(withAi(undervalued(data.screen, { shariahOnly }), data.picks.undervalued), sorts.uv), [data, shariahOnly, sorts.uv]);
  const dv = useMemo(() => sortDividends(withAi(dividendLeaders(data.screen, data.dividends, today, { shariahOnly }), data.picks.dividend), sorts.dv), [data, today, shariahOnly, sorts.dv]);
  const up = useMemo(() => sortUpcoming(upcomingDividends(data.dividends, today), sorts.up), [data.dividends, today, sorts.up]);
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

  return (
    <>
      <header className="space-y-3">
        <h1 className="text-xl font-bold tracking-tight">Discover</h1>
        <Segmented label="Discover" value={tab} onChange={setTab} options={TABS} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          {tab === 'undervalued' && 'KSE-100 stocks trading below their sector’s usual P/E that still pay dividends.'}
          {tab === 'dividends' && 'Highest dividend yields in the KSE-100. Yearly dividend per share = yield × price. Yields above ~12% are often a one-off special dividend.'}
          {tab === 'upcoming' && 'Dividends where you can still buy in time. “Buy by” = book closure minus 3 working days (estimate).'}
          {picksTime && <> AI reviewed {ago(picksTime)}.</>}{shariahOnly && ' Shariah only.'}
        </p>
        {tab === 'undervalued' && <Chips label="Sort undervalued stocks by" options={UV_SORTS} value={sorts.uv} onChange={(uv) => setSorts((s) => ({ ...s, uv }))} />}
        {tab === 'dividends' && <Chips label="Sort dividend stocks by" options={DV_SORTS} value={sorts.dv} onChange={(dv) => setSorts((s) => ({ ...s, dv }))} />}
        {tab === 'upcoming' && <Chips label="Sort upcoming dividends by" options={UP_SORTS} value={sorts.up} onChange={(up) => setSorts((s) => ({ ...s, up }))} />}
      </header>

      <div {...swipe} className="touch-pan-y space-y-3">
        {tab === 'undervalued' && (uv.length ? uv.map((r, i) => {
          const m = uvMetric(r, sorts.uv);
          return (
            <Card key={r.symbol}>
              <div className="flex items-center gap-3">
                <SymbolAvatar symbol={r.symbol} change={r.change_pct} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 font-semibold"><span className="num text-xs text-slate-400">{i + 1}</span>{r.symbol}{r.ai && <AiBadge />}{r.is_shariah && <Tag tone="green">Shariah</Tag>}</p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">{r.sector ? titleCase(r.sector) : ''} · {rs2(r.price)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-lg font-bold text-emerald-600 dark:text-emerald-400">{m.value}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{m.label}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Tag tone="teal">P/E {r.pe?.toFixed(1)}{r.sector_pe ? ` vs ${r.sector_pe}` : ''}</Tag>
                {r.discount_pct != null && r.discount_pct > 0 && <Tag tone="green">{r.discount_pct.toFixed(0)}% cheaper than sector</Tag>}
                <Tag>{(r.dividend_yield_pct ?? 0).toFixed(1)}% yield</Tag>
                {r.change_1y_pct != null && <Tag tone={r.change_1y_pct < 0 ? 'red' : 'green'}>1y {r.change_1y_pct > 0 ? '+' : ''}{r.change_1y_pct.toFixed(0)}%</Tag>}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="min-w-0 text-sm">{r.ai?.why ?? ''}</p>
                <WatchBtn symbol={r.symbol} />
              </div>
            </Card>
          );
        }) : <Empty title="No screen data yet">It fills after the next market check.</Empty>)}

        {tab === 'dividends' && (dv.length ? dv.map((d, i) => {
          const freq = effectiveFrequency(d);
          return (
            <Card key={d.symbol}>
              <div className="flex items-center gap-3">
                <SymbolAvatar symbol={d.symbol} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 font-semibold"><span className="num text-xs text-slate-400">{i + 1}</span>{d.symbol}{d.ai && <AiBadge />}{d.is_shariah && <Tag tone="green">Shariah</Tag>}</p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">{d.sector ? titleCase(d.sector) : ''} · {rs2(d.price)}</p>
                </div>
                <div className="text-right">
                  <p className="num text-lg font-bold text-emerald-600 dark:text-emerald-400">{d.dividend_yield_pct.toFixed(1)}%</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">yield</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-2xl bg-slate-50 p-2 dark:bg-slate-800/60"><p className="num text-sm font-semibold">Rs {d.annual_dps.toFixed(2)}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">per share / year</p></div>
                <div className="rounded-2xl bg-slate-50 p-2 dark:bg-slate-800/60"><p className="num text-sm font-semibold">{d.last?.dps != null ? `Rs ${d.last.dps}` : '—'}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{d.last ? `last, ${dateLabel(d.last.announced_on).replace(/^\w+, /, '')}` : 'last declared'}</p></div>
                <div className="rounded-2xl bg-slate-50 p-2 dark:bg-slate-800/60"><p className="text-sm font-semibold">{freq ?? '—'}</p><p className="text-[11px] text-slate-500 dark:text-slate-400">{d.frequency ? 'from filings' : freq ? 'AI estimate' : 'how often'}</p></div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="min-w-0 text-sm">{d.ai?.why ?? ''}</p>
                <WatchBtn symbol={d.symbol} />
              </div>
            </Card>
          );
        }) : <Empty title="No dividend data yet">It fills after the next market check.</Empty>)}

        {tab === 'upcoming' && (up.length ? up.map((u) => (
          <Card key={u.id}>
            <div className="flex items-center gap-3">
              <div className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl ${u.days_left <= 2 ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'}`}>
                <span className="num text-lg leading-none font-bold">{u.days_left}</span>
                <span className="text-[10px] font-semibold uppercase">{u.days_left === 1 ? 'day' : 'days'}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-semibold">{u.symbol}{held.has(u.symbol) && <Tag tone="teal">Yours</Tag>}{!u.verified && <Tag tone="amber">check PDF</Tag>}</p>
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
