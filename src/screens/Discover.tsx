import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { dividendLeaders, undervalued, upcomingDividends } from '../../shared/discover.ts';
import { pktDate } from '../../shared/time.ts';
import type { AiPicks } from '../../shared/types.ts';
import { ago, dateLabel, rs2, titleCase } from '../../shared/format.ts';
import { AiBadge } from '../components/AiCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Disclaimer, Empty, Segmented, SymbolAvatar, Tag } from '../components/ui.tsx';
import { useSwipeTabs } from '../lib/gestures.ts';

type Tab = 'undervalued' | 'dividends' | 'upcoming';
const TABS: { value: Tab; label: string }[] = [{ value: 'undervalued', label: 'Undervalued' }, { value: 'dividends', label: 'Dividends' }, { value: 'upcoming', label: 'Upcoming' }];

/** AI picks first (in the AI's order, with its reason), then the rest of the rules' list. */
function withAi<T extends { symbol: string }>(rows: T[], picks: AiPicks | null) {
  const why = new Map((picks?.items ?? []).map((i, n) => [i.symbol, { ...i, n }]));
  return rows.map((r) => ({ ...r, ai: why.get(r.symbol) ?? null }))
    .sort((a, b) => (a.ai ? a.ai.n : 99) - (b.ai ? b.ai.n : 99));
}

export function Discover({ data, source, reload }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('undervalued');
  const toast = useToast();
  const today = pktDate(new Date());
  const shariahOnly = data.settings.shariah_only;
  const mine = useMemo(() => new Set([...data.holdings.map((h) => h.symbol), ...data.watchlist.map((w) => w.symbol)]), [data]);
  const held = useMemo(() => new Set(data.holdings.map((h) => h.symbol)), [data]);
  const uv = useMemo(() => withAi(undervalued(data.screen, { shariahOnly }), data.picks.undervalued), [data, shariahOnly]);
  const dv = useMemo(() => withAi(dividendLeaders(data.screen, data.dividends, today, { shariahOnly }), data.picks.dividend), [data, today, shariahOnly]);
  const up = useMemo(() => upcomingDividends(data.dividends, today), [data.dividends, today]);
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
      </header>

      <div {...swipe} className="touch-pan-y space-y-3">
        {tab === 'undervalued' && (uv.length ? uv.map((r) => (
          <Card key={r.symbol}>
            <div className="flex items-center gap-3">
              <SymbolAvatar symbol={r.symbol} change={r.change_pct} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-semibold">{r.symbol}{r.ai && <AiBadge />}{r.is_shariah && <Tag tone="green">Shariah</Tag>}</p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">{r.sector ? titleCase(r.sector) : ''} · {rs2(r.price)}</p>
              </div>
              <WatchBtn symbol={r.symbol} />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Tag tone="teal">P/E {r.pe?.toFixed(1)}{r.sector_pe ? ` vs ${r.sector_pe}` : ''}</Tag>
              {r.discount_pct != null && r.discount_pct > 0 && <Tag tone="green">{r.discount_pct.toFixed(0)}% cheaper than sector</Tag>}
              <Tag>{(r.dividend_yield_pct ?? 0).toFixed(1)}% yield</Tag>
              {r.change_1y_pct != null && <Tag tone={r.change_1y_pct < 0 ? 'red' : 'green'}>1y {r.change_1y_pct > 0 ? '+' : ''}{r.change_1y_pct.toFixed(0)}%</Tag>}
            </div>
            {r.ai && <p className="mt-2 text-sm">{r.ai.why}</p>}
          </Card>
        )) : <Empty title="No screen data yet">It fills after the next market check.</Empty>)}

        {tab === 'dividends' && (dv.length ? dv.map((d) => {
          const freq = d.frequency ?? (d.ai?.frequency && d.ai.frequency !== 'Irregular' ? d.ai.frequency : null);
          return (
            <Card key={d.symbol}>
              <div className="flex items-center gap-3">
                <SymbolAvatar symbol={d.symbol} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 font-semibold">{d.symbol}{d.ai && <AiBadge />}{d.is_shariah && <Tag tone="green">Shariah</Tag>}</p>
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
