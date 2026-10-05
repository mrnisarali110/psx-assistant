import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { allocate, planToText } from '../../shared/allocate.ts';
import { pktDate } from '../../shared/time.ts';
import { asOfLabel, dateLabel, rs, rs2 } from '../../shared/format.ts';
import { AsOf, Button, Card, Disclaimer, ErrorNote, Section, Tag, inputCls } from '../components/ui.tsx';
import { latestAsOf } from './Today.tsx';

export function PlanScreen({ data, source, reload }: ScreenProps) {
  const [amountText, setAmountText] = useState(String(data.settings.monthly_budget_pkr));
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const amount = Math.max(0, Math.floor(Number(amountText.replace(/[^\d.]/g, '')) || 0));
  const today = pktDate(new Date());

  const plan = useMemo(() => allocate({
    amount, holdings: data.holdings, watchlist: data.watchlist, prices: data.prices, settings: data.settings, today,
  }), [amount, data, today]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(planToText(plan));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Long-press the plan to select it instead.');
    }
  }

  async function save() {
    try {
      await source.savePlan(plan.amount, { source: 'app', plan, text: planToText(plan) });
      setSaved('Saved as this month’s plan. Today shows a reminder when a tranche is due.');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <header><h1 className="text-xl font-bold">Plan</h1></header>

      <Card className="space-y-2">
        <label htmlFor="amt" className="text-sm font-medium">Cash to invest (Rs)</label>
        <input id="amt" className={`${inputCls} num text-2xl font-bold`} inputMode="numeric" value={amountText}
          onChange={(e) => { setAmountText(e.target.value); setSaved(null); }} />
        <div className="flex flex-wrap gap-2">
          {[30000, 40000, 50000].map((v) => (
            <button key={v} onClick={() => setAmountText(String(v))} className="rounded-full bg-slate-100 px-3 py-1 text-sm dark:bg-slate-800">{rs(v)}</button>
          ))}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Your crash fund ({rs(data.settings.crash_fund_pkr)}) is never part of this plan.</p>
      </Card>

      <div className="flex gap-2">
        <Button onClick={copy} className="flex-1">{copied ? 'Copied ✓' : 'Copy list'}</Button>
        <Button kind="secondary" onClick={save} className="flex-1">Save as this month’s plan</Button>
      </div>
      {saved && <p className="text-sm text-teal-800 dark:text-teal-300">{saved}</p>}
      <ErrorNote error={error} />

      {plan.warnings.map((w) => <p key={w} className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">{w}</p>)}

      {plan.tranches.map((t) => (
        <Section key={t.index} title={`Tranche ${t.index}${t.is_buffer ? ' · buffer' : ''}`}
          right={<span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.date === today ? 'Today' : dateLabel(t.date)} · {rs(t.available)}</span>}>
          <Card className="space-y-3">
            {t.is_buffer && <p className="text-xs text-slate-500 dark:text-slate-400">Last-week buffer, plus leftovers from earlier tranches. Best used on a dip.</p>}
            {t.index > 1 && <p className="text-xs text-slate-500 dark:text-slate-400">Uses today’s prices; recheck them on the day.</p>}
            {t.items.length === 0 && <p className="text-sm text-slate-500">Nothing to buy in this tranche.</p>}
            {t.items.map((i) => (
              <div key={i.symbol} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{i.symbol} <Tag tone={i.kind === 'average_down' ? 'teal' : 'slate'}>{i.kind === 'average_down' ? 'Average down' : 'Watchlist'}</Tag></p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{i.reason}</p>
                </div>
                <div className="num shrink-0 text-right">
                  <p className="text-lg font-bold">{i.shares} sh</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{rs(i.rupees)} @ {rs2(i.price)}</p>
                </div>
              </div>
            ))}
            {t.leftover >= 1 && (
              <p className="border-t border-slate-100 pt-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                Leftover {rs(t.leftover)} {t.index < plan.tranches.length ? 'moves to the buffer' : 'stays as cash'}
              </p>
            )}
          </Card>
        </Section>
      ))}

      {plan.skipped.length > 0 && (
        <Section title="Not buying">
          <Card className="space-y-1">
            {plan.skipped.map((s) => <p key={s.symbol} className="text-sm"><span className="font-semibold">{s.symbol}</span> <span className="text-slate-500 dark:text-slate-400">{s.reason}</span></p>)}
          </Card>
        </Section>
      )}

      <div className="space-y-1">
        <AsOf label={asOfLabel(latestAsOf(data))} />
        <Disclaimer />
      </div>
    </>
  );
}
