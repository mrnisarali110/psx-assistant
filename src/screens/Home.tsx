import { useMemo } from 'react';
import type { ScreenProps } from '../App.tsx';
import { tradingCalendar, weekAhead } from '../../shared/calendar.ts';
import { investedThisMonth } from '../../shared/changes.ts';
import { todayState } from '../../shared/quality.ts';
import { headlineReturn } from '../../shared/performance.ts';
import { dayStance, todayBanner } from '../../shared/signals.ts';
import { addDays, isMarketOpen, isStale, minutesToClose, pktDate, pktParts } from '../../shared/time.ts';
import { DEFAULT_RULES } from '../../shared/types.ts';
import { asOfLabel, num, pct, rs, signedRs } from '../../shared/format.ts';
import { AiCard } from '../components/AiCard.tsx';
import { useHoldingActions } from '../components/HoldingActions.tsx';
import { Button, Card, Section, Sparkline, SymbolAvatar, changeTone } from '../components/ui.tsx';
import { useLongPress } from '../lib/gestures.ts';
import { WeekRow } from './News.tsx';

/** The three Home states (ISSUE-09): the colour backs up the word, never replaces it. */
const HERO = {
  add: { word: 'ADD', cls: 'from-emerald-500 to-teal-600 text-white' },
  hold: { word: 'HOLD', cls: 'from-slate-700 to-slate-900 text-white dark:from-slate-800 dark:to-slate-900' },
  review: { word: 'REVIEW', cls: 'from-amber-400 to-orange-500 text-slate-950' },
  trim: { word: 'TRIM', cls: 'from-amber-400 to-orange-500 text-slate-950' },
};

export function latestAsOf(data: ScreenProps['data']): string | null {
  const times = Object.values(data.prices).map((p) => p.as_of).filter(Boolean) as string[];
  return times.sort().at(-1) ?? data.index?.ts ?? null;
}

function greeting(now: Date) {
  const h = Math.floor(pktParts(now).minutes / 60);
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Home(props: ScreenProps) {
  const { data, go, source } = props;
  const now = new Date();
  const acts = useHoldingActions(props);
  const { view, today } = acts;
  const asOf = latestAsOf(data);
  const stale = isStale(asOf, now, DEFAULT_RULES.data.stale_minutes, DEFAULT_RULES.market_hours_pkt);
  const ai = acts.ai; // the AI insight after your rules: no trim without a rule, no add where new money is blocked
  const banner = todayBanner(data.index, data.settings, { stale });
  const stance = dayStance(banner, ai, now);
  const invested = investedThisMonth(data.transactions, pktDate(now));
  const budget = data.settings.monthly_budget_pkr;
  const open = isMarketOpen(now, DEFAULT_RULES.market_hours_pkt);
  const toClose = minutesToClose(now, DEFAULT_RULES.market_hours_pkt);
  const idx = data.index;

  // One story with the AI card below: what it suggests adding or trimming decides the Today card too (the worker's
  // guardrails already dropped any add that breaks your caps, Shariah or hold-no-add rules).
  const aiAdds = (ai?.suggestions ?? []).filter((x) => (x.action === 'add' || x.action === 'buy') && x.symbol).map((x) => x.symbol as string);
  const trimRows = view.rows.filter((r) => r.call.call === 'trim' || r.call.call === 'sell');
  const ruleTrims = trimRows.map((r) => r.holding.symbol);
  const addable = [...new Set([
    ...view.rows.filter((r) => { const c = acts.callFor(r).call; return c === 'average_down' || c === 'opportunity'; }).map((r) => r.holding.symbol),
    ...aiAdds,
  ])].filter((s) => !ruleTrims.includes(s));
  const trims = trimRows.map((r) => ({ symbol: r.holding.symbol, reason: r.call.text }));
  const state = todayState({
    stance: stance.action === 'Hold' && aiAdds.length ? 'Buy' : stance.action, cash_left: budget - invested, attention: 0, addable, trims,
  });
  const hero = HERO[state.state];

  const week = useMemo(() => weekAhead({
    today, days: 7, max: 4, held: data.holdings.map((h) => h.symbol), watched: data.watchlist.map((w) => w.symbol), dividends: data.dividends,
    announcements: data.announcements, holdings: data.holdings, cal: tradingCalendar(DEFAULT_RULES, data.indexDaily),
  }), [data, today]);

  // Only blue-chip warnings reach Home: a holding at risk, or one that lost the badge in the last 30 days.
  const bcAlerts = data.holdings.map((h) => data.bluechip[h.symbol]).filter((b): b is NonNullable<typeof b> =>
    !!b && (b.status === 'at_risk' || (b.status === 'not_bc' && !!b.lost_on && b.lost_on >= addDays(today, -30))));
  const unpriced = view.missing_prices.length;
  const nonePriced = data.holdings.length > 0 && unpriced === data.holdings.length;
  // Profit / loss on your average cost, as before: the full return with dividends and the KSE-100 comparison live on
  // Portfolio → Performance, where they only show once your buys list explains every holding.
  // Total return: price profit/loss on your average cost plus dividends received (net of tax), one line.
  const hr = headlineReturn(view, data.receipts);
  const { total, pct: totalPct, dividends: divNet } = hr;
  const retLine = !data.holdings.length || nonePriced ? null
    : `${signedRs(total)} (${pct(totalPct)}) total${divNet > 0 ? `, incl. ${rs(divNet)} dividends` : ''}${unpriced ? ` · ${unpriced} not priced yet` : ''}`;

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
          <p className="mt-0.5 text-xs leading-snug opacity-90">{banner.reason}</p>
        </div>
      </div>

      <Card onClick={() => go('portfolio')}>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-500 dark:text-slate-400">Your portfolio</p>
            <p className="num text-2xl font-bold tracking-tight">{!data.holdings.length ? 'Empty' : nonePriced ? 'No prices yet' : rs(view.total_value)}</p>
            {retLine && <p className={`num text-xs font-semibold ${changeTone(total)}`}>{retLine}</p>}
          </div>
          {view.day_change != null && (
            <span className={`num shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${view.day_change >= 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'}`}>
              {signedRs(view.day_change)} today
            </span>
          )}
        </div>
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

      {bcAlerts.length > 0 && (
        <Section title="Needs attention">
          <Card className="divide-y divide-slate-100 py-1 dark:divide-slate-800">
            {bcAlerts.slice(0, 3).map((b) => (
              <button key={b.symbol} type="button" onClick={() => acts.open(b.symbol)} className="flex min-h-12 w-full cursor-pointer items-center gap-3 py-2 text-left active:opacity-70">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-xs font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">BC</span>
                <span className="min-w-0 flex-1 text-sm leading-snug">
                  <b>{b.symbol}</b> {b.status === 'at_risk' ? 'is a blue chip at risk' : 'lost its blue-chip badge'}{b.reason ? `: ${b.reason}` : ''}
                </span>
              </button>
            ))}
          </Card>
        </Section>
      )}

      <Section title="This week" right={<Button kind="ghost" className="-my-2 px-2" onClick={() => { location.hash = '/news?week'; }}>See all</Button>}>
        <Card className={week.events.length ? 'divide-y divide-slate-100 py-1 dark:divide-slate-800' : ''}>
          {week.events.length
            ? week.events.map((e) => <WeekRow key={`${e.symbol}|${e.kind}|${e.date}`} e={e} onOpen={acts.open} bc={data.bluechip[e.symbol]} />)
            : <p className="text-sm text-slate-500 dark:text-slate-400">Nothing dated for your stocks in the next 7 days</p>}
        </Card>
      </Section>

      <AiCard insight={ai} aiEnabled={!!data.settings.ai_enabled} demo={source.kind === 'demo'} bc={data.bluechip} />

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
