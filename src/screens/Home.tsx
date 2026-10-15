import { useMemo } from 'react';
import type { ScreenProps } from '../App.tsx';
import { tradingCalendar, weekAhead } from '../../shared/calendar.ts';
import { investedThisMonth } from '../../shared/changes.ts';
import { benchmark, cashFlows, totalReturn } from '../../shared/performance.ts';
import type { PortfolioView } from '../../shared/portfolio.ts';
import { todayState } from '../../shared/quality.ts';
import { dayStance, todayBanner } from '../../shared/signals.ts';
import { isMarketOpen, isStale, minutesToClose, pktDate, pktParts } from '../../shared/time.ts';
import { DEFAULT_RULES, type Settings } from '../../shared/types.ts';
import { asOfLabel, num, pct, rs, signedRs } from '../../shared/format.ts';
import { AiBadge, AiCard } from '../components/AiCard.tsx';
import { freshInsight, useHoldingActions } from '../components/HoldingActions.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Button, Card, Section, Sparkline, SymbolAvatar, changeTone } from '../components/ui.tsx';
import { haptic, useLongPress } from '../lib/gestures.ts';
import { WeekRow } from './News.tsx';

/** The three Home states (ISSUE-09): the colour backs up the word, never replaces it. */
const HERO = {
  add: { word: 'ADD', cls: 'from-emerald-500 to-teal-600 text-white' },
  hold: { word: 'HOLD', cls: 'from-slate-700 to-slate-900 text-white dark:from-slate-800 dark:to-slate-900' },
  review: { word: 'REVIEW', cls: 'from-amber-400 to-orange-500 text-slate-950' },
};

export function latestAsOf(data: ScreenProps['data']): string | null {
  const times = Object.values(data.prices).map((p) => p.as_of).filter(Boolean) as string[];
  return times.sort().at(-1) ?? data.index?.ts ?? null;
}

function greeting(now: Date) {
  const h = Math.floor(pktParts(now).minutes / 60);
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

interface Attention { icon: IconName; text: string; symbol: string | null }

/** Broken rules, most pressing first: stock caps, sector caps, trim triggers, reviews due. */
function attentionRows(view: PortfolioView, settings: Settings): Attention[] {
  const out: Attention[] = [];
  for (const r of view.rows) {
    if (r.flags.over_cap) out.push({ icon: 'scale', symbol: r.holding.symbol, text: `${r.holding.symbol} is ${num(r.weight_pct, 0)}% of your money, over your ${settings.max_position_pct}% cap` });
  }
  for (const t of view.rebalance) if (t.kind === 'sector') out.push({ icon: 'scale', symbol: null, text: t.text });
  for (const r of view.rows) {
    if (r.call.call === 'trim' && !r.flags.over_cap) out.push({ icon: 'tag', symbol: r.holding.symbol, text: `${r.holding.symbol}: ${r.call.text}` });
  }
  for (const r of view.rows) {
    if (r.call.call === 'review') out.push({ icon: 'flag', symbol: r.holding.symbol, text: `${r.holding.symbol}: ${r.call.text}` });
  }
  return out;
}

export function Home(props: ScreenProps) {
  const { data, go, source } = props;
  const now = new Date();
  const acts = useHoldingActions(props);
  const { view, today } = acts;
  const asOf = latestAsOf(data);
  const stale = isStale(asOf, now, DEFAULT_RULES.data.stale_minutes, DEFAULT_RULES.market_hours_pkt);
  const ai = freshInsight(data.aiInsight, now);
  const stance = dayStance(todayBanner(data.index, data.settings, { stale }), ai, now);
  const invested = investedThisMonth(data.transactions, pktDate(now));
  const budget = data.settings.monthly_budget_pkr;
  const open = isMarketOpen(now, DEFAULT_RULES.market_hours_pkt);
  const toClose = minutesToClose(now, DEFAULT_RULES.market_hours_pkt);
  const idx = data.index;

  const attention = attentionRows(view, data.settings);
  const addable = view.rows.filter((r) => { const c = acts.callFor(r).call; return c === 'average_down' || c === 'opportunity'; }).map((r) => r.holding.symbol);
  const state = todayState({ stance: stance.action, cash_left: budget - invested, attention: attention.length, addable });
  const hero = HERO[state.state];

  const tr = useMemo(() => totalReturn(data.transactions, data.receipts, view.total_value, today, data.settings), [data.transactions, data.receipts, view.total_value, today, data.settings]);
  const bm = useMemo(() => benchmark(cashFlows(data.transactions, data.receipts, view.total_value, today, data.settings), view.total_value, data.indexDaily, today),
    [data.transactions, data.receipts, view.total_value, today, data.settings, data.indexDaily]);
  const week = useMemo(() => weekAhead({
    today, days: 7, max: 4, held: data.holdings.map((h) => h.symbol), watched: data.watchlist.map((w) => w.symbol), dividends: data.dividends,
    announcements: data.announcements, holdings: data.holdings, cal: tradingCalendar(DEFAULT_RULES, data.indexDaily),
  }), [data, today]);

  const hasTxns = data.transactions.length > 0;
  const hasMoney = hasTxns || data.holdings.length > 0;
  const unpriced = view.missing_prices.length;
  const nonePriced = data.holdings.length > 0 && unpriced === data.holdings.length;
  // totalReturn() counts an unpriced holding as worth Rs 0 while view.total_value leaves it out: until every holding
  // has a price the card shows the price-only line, which compares like with like.
  const useTotal = hasTxns && unpriced === 0;
  const retLine = !hasMoney || nonePriced ? null
    : useTotal ? { v: tr.total_return, text: `${signedRs(tr.total_return)} (${pct(tr.total_return_pct)}) total, dividends included` }
      : { v: view.total_pnl, text: `${signedRs(view.total_pnl)} (${pct(view.total_pnl_pct)}) price only${unpriced ? ` · ${unpriced} not priced yet` : ''}` };
  // The one-line comparison is the plain return gap over the compared flows. bm.diff_pct is the yearly XIRR gap, which
  // over a few days of history annualises to a figure like -95% that reads broken here; it belongs on the Performance tab.
  const gap = bm.my_return_pct != null && bm.index_return_pct != null ? Math.round((bm.my_return_pct - bm.index_return_pct) * 10) / 10 : null;
  const muted = 'text-slate-500 dark:text-slate-400';
  const bmLine = !hasTxns ? { text: 'vs KSE-100: needs your buys recorded', cls: muted }
    : unpriced > 0 ? { text: 'vs KSE-100: n/a until every holding has a price', cls: muted }
      : gap == null ? { text: bm.index_latest ? 'vs KSE-100: needs index history from your first buy' : 'vs KSE-100: needs index history', cls: muted }
        : {
          text: `vs KSE-100: ${gap === 0 ? 'level' : `${pct(gap)} ${gap > 0 ? 'better' : 'behind'}`}${bm.coverage.uncovered_flows > 0 ? ' · partly compared' : ''}`,
          cls: changeTone(gap),
        };

  return (
    <>
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', weekday: 'long', month: 'short', day: 'numeric' }).format(now)}</p>
          <h1 className="text-xl font-bold tracking-tight">{greeting(now)}</h1>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${open ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400'}`}>
          <span className={`h-2 w-2 rounded-full ${open ? 'animate-pulse bg-emerald-500' : 'bg-slate-400'}`} />
          {open ? (toClose != null && toClose <= 60 ? `Closes in ${toClose}m` : 'Market open') : 'Market closed'}
        </span>
      </header>

      <div className={`flex items-center gap-4 rounded-3xl bg-gradient-to-br px-4 py-3.5 ${hero.cls}`} role="status">
        <div className="shrink-0">
          <p className="text-[10px] font-semibold tracking-wide uppercase opacity-80">Today</p>
          <p className="text-3xl leading-none font-extrabold tracking-tight">{hero.word}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-snug font-semibold">{state.headline}</p>
          <p className="mt-0.5 text-xs leading-snug opacity-90">{stance.reason}</p>
        </div>
        {stance.source === 'ai' && <span className="shrink-0 self-start"><AiBadge /></span>}
      </div>

      <Card onClick={() => { location.hash = '/portfolio?tab=performance'; }}>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-500 dark:text-slate-400">Your portfolio</p>
            <p className="num text-2xl font-bold tracking-tight">{!data.holdings.length ? 'Empty' : nonePriced ? 'No prices yet' : rs(view.total_value)}</p>
            {retLine && <p className={`num text-xs font-semibold ${changeTone(retLine.v)}`}>{retLine.text}</p>}
          </div>
          {view.day_change != null && (
            <span className={`num shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${view.day_change >= 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'}`}>
              {signedRs(view.day_change)} today
            </span>
          )}
        </div>
        <p className={`num mt-1.5 flex items-center gap-1 text-xs font-medium ${bmLine.cls}`}>{bmLine.text}<Icon name="chevron" className="h-3.5 w-3.5" /></p>
        <div className="mt-3">
          <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400"><span>Invested this month</span><span className="num">{rs(invested)} of {rs(budget)}</span></div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div className="h-full rounded-full bg-teal-500 transition-[width] duration-700" style={{ width: `${Math.min(100, budget > 0 ? (invested / budget) * 100 : 0)}%` }} />
          </div>
        </div>
      </Card>

      {view.rows.length > 0 && (
        <div className="-mx-4 overflow-x-auto px-4 scrollbar-none">
          <ul className="flex gap-3 pb-1">
            {view.rows.map((r) => <Story key={r.holding.symbol} symbol={r.holding.symbol} change={r.price?.change_pct ?? null} onOpen={() => acts.open(r.holding.symbol)} onMenu={() => acts.menu(r.holding.symbol)} />)}
          </ul>
        </div>
      )}

      {attention.length > 0 && (
        <Section title="Needs attention">
          <Card className="divide-y divide-slate-100 py-1 dark:divide-slate-800">
            {attention.slice(0, 3).map((a, i) => <AttentionRow key={i} a={a} onOpen={acts.open} />)}
            {attention.length > 3 && <Button kind="ghost" className="w-full" onClick={() => go('portfolio')}>+{attention.length - 3} more in Portfolio<Icon name="chevron" className="h-4 w-4" /></Button>}
          </Card>
        </Section>
      )}

      <Section title="This week" right={<Button kind="ghost" className="-my-2 px-2" onClick={() => { location.hash = '/news?week'; }}>See all</Button>}>
        <Card className={week.events.length ? 'divide-y divide-slate-100 py-1 dark:divide-slate-800' : ''}>
          {week.events.length
            ? week.events.map((e) => <WeekRow key={`${e.symbol}|${e.kind}|${e.date}`} e={e} onOpen={acts.open} />)
            : <p className="text-sm text-slate-500 dark:text-slate-400">Nothing dated for your stocks in the next 7 days</p>}
        </Card>
      </Section>

      <AiCard insight={ai} aiEnabled={!!data.settings.ai_enabled} demo={source.kind === 'demo'} />

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-slate-500 dark:text-slate-400">KSE-100</p>
            <p className="num text-xl font-bold">{idx ? num(idx.kse100, 0) : 'no data'}</p>
            <p className={`num text-sm font-semibold ${changeTone(idx?.change_pct)}`}>{pct(idx?.change_pct, 2)}</p>
          </div>
          <Sparkline values={data.indexHistory.map((i) => i.kse100)} />
        </div>
        <p className={`mt-2 text-xs ${stale ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
          {stale ? 'Prices may be out of date · ' : ''}as of {asOfLabel(asOf)} · crash level {num(data.settings.crash_trigger_kse, 0)}
        </p>
      </Card>

      {acts.ui}
    </>
  );
}

/** One broken rule; a stock row opens the stock, a sector row is read-only. */
function AttentionRow({ a, onOpen }: { a: Attention; onOpen: (symbol: string) => void }) {
  const symbol = a.symbol;
  const body = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
        <Icon name={a.icon} className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1 text-sm leading-snug">{a.text}</span>
      {symbol && <Icon name="chevron" className="h-4 w-4 shrink-0 text-slate-400" />}
    </>
  );
  return symbol
    ? <button type="button" onClick={() => { haptic(); onOpen(symbol); }} className="flex min-h-12 w-full cursor-pointer items-center gap-3 py-2 text-left active:opacity-70">{body}</button>
    : <div className="flex min-h-12 items-center gap-3 py-2">{body}</div>;
}

function Story({ symbol, change, onOpen, onMenu }: { symbol: string; change: number | null; onOpen: () => void; onMenu: () => void }) {
  const press = useLongPress(onMenu);
  return (
    <li>
      <button type="button" {...press.handlers} onClick={() => { if (!press.consumed()) onOpen(); }}
        className="no-callout flex w-13 cursor-pointer flex-col items-center gap-1 transition active:scale-95" aria-label={`${symbol}, ${pct(change)} today`}>
        <SymbolAvatar symbol={symbol} change={change} size="h-12 w-12" />
        <span className={`num text-[10px] font-semibold ${changeTone(change)}`}>{pct(change)}</span>
      </button>
    </li>
  );
}
