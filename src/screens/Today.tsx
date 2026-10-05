import type { ScreenProps } from '../App.tsx';
import { buildPortfolio } from '../../shared/portfolio.ts';
import { todayBanner } from '../../shared/signals.ts';
import { isStale, pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES } from '../../shared/types.ts';
import { asOfLabel, num, pct, rs, signedRs } from '../../shared/format.ts';
import { titleCase } from '../../shared/allocate.ts';
import { AsOf, Card, Section, Sparkline, changeTone } from '../components/ui.tsx';
import { AiCard } from '../components/AiCard.tsx';

export function latestAsOf(data: ScreenProps['data']): string | null {
  const times = Object.values(data.prices).map((p) => p.as_of).filter(Boolean) as string[];
  return times.sort().at(-1) ?? data.index?.ts ?? null;
}

const BANNER_STYLE = {
  Buy: 'bg-emerald-600 text-white',
  Hold: 'bg-slate-700 text-white dark:bg-slate-800',
  Wait: 'bg-amber-500 text-slate-950',
};

export function Today({ data, go, source }: ScreenProps) {
  const now = new Date();
  const asOf = latestAsOf(data);
  const stale = isStale(asOf, now, DEFAULT_RULES.data.stale_minutes, DEFAULT_RULES.market_hours_pkt);
  const today = pktDate(now);
  const due = (data.latestPlan?.payload?.plan?.tranches ?? []).find((t: any) => t.date === today && t.items?.length);
  const banner = todayBanner(data.index, data.settings, { stale, trancheDue: due ? { index: due.index, date: due.date } : null });
  const view = buildPortfolio(data.holdings, data.prices, data.settings);
  const idx = data.index;
  const crashAway = idx ? ((idx.kse100 - data.settings.crash_trigger_kse) / idx.kse100) * 100 : null;

  const attention: { text: string; tone: string }[] = [];
  for (const r of view.rows) {
    const s = r.holding.symbol;
    if (r.flags.over_cap) attention.push({ text: `${s} is ${r.weight_pct!.toFixed(1)}% of your portfolio, over the ${data.settings.max_position_pct}% cap`, tone: 'amber' });
    if (r.flags.below_cost) attention.push({ text: `${s} is ${Math.abs(r.pnl_pct!).toFixed(1)}% below your average cost`, tone: 'rose' });
    if (r.flags.big_move) attention.push({ text: `${s} moved ${pct(r.price?.change_pct)} today`, tone: 'slate' });
  }
  for (const s of view.sectors_over_limit) attention.push({ text: `${titleCase(s)} is above the ${DEFAULT_RULES.holding.sector_limit_pct}% sector limit`, tone: 'amber' });
  const recent = data.alerts.filter((a) => a.channel !== 'none' && Date.now() - Date.parse(a.sent_at) < 48 * 3600000).slice(0, 5);

  return (
    <>
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Today</h1>
        <span className="text-xs text-slate-500 dark:text-slate-400">{new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', weekday: 'short', month: 'short', day: 'numeric' }).format(now)}</span>
      </header>

      <div className={`rounded-3xl p-5 shadow-sm ${BANNER_STYLE[banner.action]}`} role="status">
        <p className="text-5xl font-extrabold tracking-tight">{banner.action}</p>
        <p className="mt-2 text-base leading-snug">{banner.reason}</p>
        {due && <button onClick={() => go('plan')} className="mt-3 rounded-full bg-white/20 px-3 py-1 text-sm font-semibold">See tranche {due.index}</button>}
      </div>

      <AiCard insight={data.aiInsight} aiEnabled={!!data.settings.ai_enabled} demo={source.kind === 'demo'} />

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-slate-500 dark:text-slate-400">KSE-100</p>
            <p className="num text-3xl font-bold">{idx ? num(idx.kse100, 0) : 'no data'}</p>
            <p className={`num text-sm font-semibold ${changeTone(idx?.change_pct)}`}>
              {idx?.change != null ? `${idx.change > 0 ? '+' : ''}${num(idx.change, 0)} ` : ''}({pct(idx?.change_pct, 2)})
            </p>
          </div>
          <Sparkline values={data.indexHistory.map((i) => i.kse100)} />
        </div>
        <div className="mt-3 flex items-center justify-between">
          <AsOf label={asOfLabel(asOf)} stale={stale} />
          {crashAway != null && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Crash level {num(data.settings.crash_trigger_kse, 0)} ({crashAway > 0 ? `${crashAway.toFixed(1)}% away` : 'reached'})
            </p>
          )}
        </div>
      </Card>

      <button onClick={() => go('portfolio')} className="block w-full text-left">
        <Card>
          <div className="flex items-end justify-between">
            <div>
              <p className="text-sm text-slate-500 dark:text-slate-400">Your portfolio</p>
              <p className="num text-2xl font-bold">{data.holdings.length ? rs(view.total_value) : 'No holdings yet'}</p>
            </div>
            {data.holdings.length > 0 && (
              <div className="text-right">
                <p className={`num text-sm font-semibold ${changeTone(view.day_change)}`}>{view.day_change == null ? '' : `${signedRs(view.day_change)} today`}</p>
                <p className={`num text-sm ${changeTone(view.total_pnl)}`}>{signedRs(view.total_pnl)} ({pct(view.total_pnl_pct)}) total</p>
              </div>
            )}
          </div>
          {view.missing_prices.length > 0 && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">No price yet for {view.missing_prices.join(', ')}. It appears after the next data refresh.</p>
          )}
        </Card>
      </button>

      <Section title="Needs attention">
        {attention.length === 0 ? (
          <Card><p className="text-sm text-slate-500 dark:text-slate-400">Nothing needs attention right now.</p></Card>
        ) : (
          <Card className="space-y-2">
            {attention.map((a) => (
              <p key={a.text} className="flex gap-2 text-sm">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.tone === 'rose' ? 'bg-rose-500' : a.tone === 'amber' ? 'bg-amber-500' : 'bg-slate-400'}`} />
                {a.text}
              </p>
            ))}
          </Card>
        )}
      </Section>

      {recent.length > 0 && (
        <Section title="Recent alerts" right={<button className="text-xs font-semibold text-teal-700 dark:text-teal-400" onClick={() => go('news')}>All</button>}>
          <Card className="divide-y divide-slate-100 dark:divide-slate-800">
            {recent.map((a) => (
              <div key={a.dedupe_key} className="py-2 first:pt-0 last:pb-0">
                <p className="text-sm">{a.message}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{asOfLabel(a.sent_at)}</p>
              </div>
            ))}
          </Card>
        </Section>
      )}

      <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
        Data refresh: {data.lastRun ? `${asOfLabel(data.lastRun.started_at)}${data.lastRun.ok === false ? ' (PSX unavailable, showing last good data)' : ''}` : 'waiting for the first scheduled run'}.
        Crash fund {rs(data.settings.crash_fund_pkr)} is kept separate.
      </p>
    </>
  );
}
