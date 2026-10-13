import type { ScreenProps } from '../App.tsx';
import { allocationSlices } from '../../shared/portfolio.ts';
import { dayStance, todayBanner } from '../../shared/signals.ts';
import { investedThisMonth } from '../../shared/changes.ts';
import { isMarketOpen, isStale, minutesToClose, pktDate, pktParts } from '../../shared/time.ts';
import { DEFAULT_RULES } from '../../shared/types.ts';
import { asOfLabel, num, pct, rs, signedRs, titleCase } from '../../shared/format.ts';
import { AiBadge, AiCard } from '../components/AiCard.tsx';
import { Donut } from '../components/Donut.tsx';
import { GrowthCard } from '../components/Growth.tsx';
import { freshInsight, useHoldingActions } from '../components/HoldingActions.tsx';
import { Icon } from '../components/Icon.tsx';
import { Card, Section, Sparkline, SymbolAvatar, changeTone } from '../components/ui.tsx';
import { useLongPress } from '../lib/gestures.ts';

const HERO = {
  Buy: 'from-emerald-500 to-teal-600 text-white',
  Hold: 'from-slate-700 to-slate-900 text-white dark:from-slate-800 dark:to-slate-900',
  Wait: 'from-amber-400 to-orange-500 text-slate-950',
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
  const { view } = acts;
  const asOf = latestAsOf(data);
  const stale = isStale(asOf, now, DEFAULT_RULES.data.stale_minutes, DEFAULT_RULES.market_hours_pkt);
  const ai = freshInsight(data.aiInsight, now);
  const stance = dayStance(todayBanner(data.index, data.settings, { stale }), ai, now);
  const invested = investedThisMonth(data.transactions, pktDate(now));
  const budget = data.settings.monthly_budget_pkr;
  const open = isMarketOpen(now, DEFAULT_RULES.market_hours_pkt);
  const toClose = minutesToClose(now, DEFAULT_RULES.market_hours_pkt);
  const idx = data.index;
  const slices = allocationSlices(view);
  const tips = [...view.rebalance.map((t) => t.text), ...(ai?.rebalance ? [ai.rebalance] : [])];

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

      <div className={`flex items-center gap-4 rounded-3xl bg-gradient-to-br px-4 py-3.5 ${HERO[stance.action]}`} role="status">
        <div className="shrink-0">
          <p className="text-[10px] font-semibold tracking-wide uppercase opacity-80">Today</p>
          <p className="text-3xl leading-none font-extrabold tracking-tight">{stance.action}</p>
        </div>
        <p className="min-w-0 flex-1 text-[13px] leading-snug opacity-95">{stance.reason}</p>
        {stance.source === 'ai' && <span className="shrink-0 self-start"><AiBadge /></span>}
      </div>

      <Card onClick={() => go('portfolio')}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Your portfolio</p>
            <p className="num text-2xl font-bold tracking-tight">{data.holdings.length ? rs(view.total_value) : 'Empty'}</p>
            <p className={`num text-xs font-semibold ${changeTone(view.total_pnl)}`}>{signedRs(view.total_pnl)} ({pct(view.total_pnl_pct)}) total</p>
          </div>
          {view.day_change != null && (
            <span className={`num rounded-full px-2 py-0.5 text-xs font-semibold ${view.day_change >= 0 ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'}`}>
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

      {slices.length > 0 && (
        <Section title="Where your money is">
          <Card><Donut slices={slices} total={view.total_value} caption={`${view.rows.length} stocks`} /></Card>
        </Section>
      )}

      {tips.length > 0 && (
        <Section title="Rebalance">
          <Card className="space-y-2.5">
            {tips.map((t, i) => (
              <p key={i} className="flex gap-2.5 text-sm"><Icon name="scale" className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />{t}</p>
            ))}
            {view.sector_weights.length > 0 && <p className="text-xs text-slate-500 dark:text-slate-400">Sectors: {view.sector_weights.slice(0, 4).map((s) => `${titleCase(s.sector)} ${s.pct.toFixed(0)}%`).join(' · ')}</p>}
          </Card>
        </Section>
      )}

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

      <Section title="Wealth growth">
        <Card><GrowthCard start={view.total_value} monthly={budget} /></Card>
      </Section>

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
