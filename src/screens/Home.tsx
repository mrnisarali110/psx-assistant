import { useMemo } from 'react';
import type { ScreenProps } from '../App.tsx';
import { tradingCalendar, weekAhead } from '../../shared/calendar.ts';
import { investedThisMonth } from '../../shared/changes.ts';
import { todayState } from '../../shared/quality.ts';
import { headlineReturn } from '../../shared/performance.ts';
import { dayStance, todayBanner } from '../../shared/signals.ts';
import { addDays, isStale, pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES } from '../../shared/types.ts';
import { greeting, num, pct, rs, sessionLabel } from '../../shared/format.ts';
import { AiCard } from '../components/AiCard.tsx';
import { MarketCard } from '../components/MarketMood.tsx';
import { useHoldingActions } from '../components/HoldingActions.tsx';
import { latestAsOf } from '../components/Freshness.tsx';
import { HoldingsList } from '../components/HoldingsList.tsx';
import { PortfolioChart, moneyIn } from '../components/PortfolioChart.tsx';
import { StatusLine } from '../components/StatusLine.tsx';
import { useCountUp } from '../components/motion.ts';
import { Icon } from '../components/Icon.tsx';
import { Button, Card, Change, CompanyMark, Section, changeTone } from '../components/ui.tsx';
import { openStock } from '../lib/nav.ts';
import { WeekRow } from './News.tsx';

export { latestAsOf };

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

  // One story with the AI card below: what it suggests adding or trimming decides the status line too (the worker's
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

  const week = useMemo(() => weekAhead({
    today, days: 7, max: 4, held: data.holdings.map((h) => h.symbol), watched: data.watchlist.map((w) => w.symbol), dividends: data.dividends,
    announcements: data.announcements, holdings: data.holdings, cal: tradingCalendar(DEFAULT_RULES, data.indexDaily),
  }), [data, today]);

  // Only blue-chip warnings reach Home: a holding at risk, or one that lost the badge in the last 30 days.
  const bcAlerts = data.holdings.map((h) => data.bluechip[h.symbol]).filter((b): b is NonNullable<typeof b> =>
    !!b && (b.status === 'at_risk' || (b.status === 'not_bc' && !!b.lost_on && b.lost_on >= addDays(today, -30))));
  const unpriced = view.missing_prices.length;
  const nonePriced = data.holdings.length > 0 && unpriced === data.holdings.length;
  // Total return: price profit/loss on your average cost plus dividends received (net of tax). The full return with
  // the KSE-100 comparison lives on Portfolio → Performance.
  const { total, pct: totalPct, dividends: divNet } = headlineReturn(view, data.receipts);
  const showValue = data.holdings.length > 0 && !nonePriced;
  const shown = useCountUp(showValue ? view.total_value : 0);
  const dayPct = view.day_change != null && view.total_value - view.day_change > 0 ? (view.day_change / (view.total_value - view.day_change)) * 100 : null;
  const session = sessionLabel(asOf, now);
  // The chart's 1D starts from the previous close and ends at this value, so its headline is the day change above
  // (on a day with buys or sales it also leaves out the money moved, and says so).
  const current = showValue && asOf ? {
    day: pktDate(new Date(asOf)), ts: asOf, value: view.total_value,
    prev_close: view.day_change != null ? view.total_value - view.day_change : null,
  } : null;
  const moves = useMemo(() => moneyIn(data.transactions, data.settings), [data.transactions, data.settings]);

  return (
    <>
      <h1 className="text-20 font-bold tracking-tight lg:text-28">{greeting(now)}</h1>

      <StatusLine state={state.state} headline={state.headline} reason={stance.reason} settings={data.settings} cashLeft={budget - invested}
        addable={addable} trims={ruleTrims} reviews={view.rows.filter((r) => r.call.call === 'review').map((r) => r.holding.symbol)} />

      {/* Desktop: your money on the left, the market and the AI on the right. Phone: one column in this order. */}
      <div className="space-y-4 lg:grid lg:grid-cols-12 lg:items-start lg:gap-5 lg:space-y-0">
      <div className="space-y-4 lg:col-span-7 lg:space-y-5">
      <Card className="space-y-4">
        <div>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-14 text-muted">Your portfolio</h2>
            <button type="button" onClick={() => go('portfolio')} className="press -my-2 -mr-2 inline-flex min-h-11 cursor-pointer items-center gap-0.5 px-2 text-14 font-semibold text-brand">
              Details<Icon name="chevron" className="h-4 w-4" />
            </button>
          </div>
          <p className="text-28 font-bold tracking-tight lg:text-40">
            {!data.holdings.length ? 'Empty' : nonePriced ? 'No prices yet' : rs(shown)}
          </p>
          {view.day_change != null && (
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-14">
              <Change kind="rs" value={view.day_change} className="font-semibold" label={session} />
              {dayPct != null && <Change value={dayPct} className="font-semibold" />}
              <span className="text-muted">{session}</span>
            </p>
          )}
          {showValue && (
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-14">
              <Change kind="rs" value={total} className="font-semibold" label="Total return" />
              {totalPct != null && <span className={`font-semibold ${changeTone(totalPct)}`}>({pct(totalPct).replace('-', '−')})</span>}
              <span className="text-muted">total{divNet > 0 ? `, incl. ${rs(divNet)} dividends` : ''}{unpriced ? ` · ${unpriced} not priced yet` : ''}</span>
            </p>
          )}
        </div>
        <PortfolioChart ticks={data.portfolioTicks} daily={data.portfolioDaily} current={current} moves={moves} now={now} />
        <div>
          <div className="flex justify-between text-12 text-muted"><span>Invested this month</span><span>{rs(invested)} of {rs(budget)}</span></div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Invested this month"
            aria-valuemin={0} aria-valuemax={budget} aria-valuenow={Math.min(invested, budget)}>
            <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${Math.min(100, budget > 0 ? (invested / budget) * 100 : 0)}%` }} />
          </div>
        </div>
      </Card>

      {view.rows.length > 0 && (
        <Section title="Your stocks" right={<span className="text-12 text-muted">Change: {session}</span>}>
          <Card className="py-1">
            <HoldingsList rows={view.rows} priceDaily={data.priceDaily} onMenu={acts.menu} />
          </Card>
        </Section>
      )}

      {bcAlerts.length > 0 && (
        <Section title="Needs attention">
          <Card className="divide-y divide-line py-1">
            {bcAlerts.slice(0, 3).map((b) => (
              <button key={b.symbol} type="button" onClick={() => openStock(b.symbol)} className="press flex min-h-14 w-full cursor-pointer items-center gap-3 py-2 text-left">
                <CompanyMark symbol={b.symbol} sector={view.rows.find((r) => r.holding.symbol === b.symbol)?.sector} />
                <span className="min-w-0 flex-1 text-14 leading-snug">
                  <b>{b.symbol}</b> {b.status === 'at_risk' ? 'is a blue chip at risk' : 'lost its blue-chip badge'}{b.reason ? `: ${b.reason}` : ''}
                </span>
                <Icon name="alert" className="h-5 w-5 shrink-0 text-caution" label="Caution" />
              </button>
            ))}
          </Card>
        </Section>
      )}

      <Section title="This week" right={<Button kind="ghost" className="-my-2 px-2" onClick={() => { location.hash = '/news?week'; }}>See all</Button>}>
        <Card className={week.events.length ? 'divide-y divide-line py-1' : ''}>
          {week.events.length
            ? week.events.map((e) => <WeekRow key={`${e.symbol}|${e.kind}|${e.date}`} e={e} onOpen={openStock} bc={data.bluechip[e.symbol]} />)
            : <p className="text-14 text-muted">Nothing dated for your stocks in the next 7 days</p>}
        </Card>
      </Section>

      </div>

      <div className="space-y-4 lg:col-span-5 lg:space-y-5">
        <MarketCard data={data} onOpen={() => go('market')} footnote={<span>Crash level {num(data.settings.crash_trigger_kse, 0)}</span>} />
        <AiCard insight={ai} aiEnabled={!!data.settings.ai_enabled} demo={source.kind === 'demo'} bc={data.bluechip} />
      </div>
      </div>

      {acts.ui}
    </>
  );
}
