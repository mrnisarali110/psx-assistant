import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { allocate, planToText, titleCase, type PlanItem } from '../../shared/allocate.ts';
import { findOpportunities } from '../../shared/opportunities.ts';
import { applyBuy } from '../../shared/portfolio.ts';
import { pktDate } from '../../shared/time.ts';
import { asOfLabel, dateLabel, rs, rs2 } from '../../shared/format.ts';
import { AsOf, Button, Card, Disclaimer, ErrorNote, Section, Tag, inputCls } from '../components/ui.tsx';
import { AiCard } from '../components/AiCard.tsx';
import { latestAsOf } from './Today.tsx';

export function PlanScreen({ data, source, reload }: ScreenProps) {
  const [amountText, setAmountText] = useState(String(data.settings.monthly_budget_pkr));
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState<PlanItem | null>(null);
  const amount = Math.max(0, Math.floor(Number(amountText.replace(/[^\d.]/g, '')) || 0));
  const today = pktDate(new Date());

  const plan = useMemo(() => allocate({
    amount, holdings: data.holdings, watchlist: data.watchlist, prices: data.prices, settings: data.settings, today,
  }), [amount, data, today]);

  const mine = new Set([...data.holdings.map((h) => h.symbol), ...data.watchlist.map((w) => w.symbol)]);
  const opportunities = findOpportunities(data.screen, mine, data.settings.shariah_only);

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

      {data.aiInsight?.plan_note && (
        <div className="space-y-1">
          <AiCard insight={data.aiInsight} aiEnabled={!!data.settings.ai_enabled} demo={source.kind === 'demo'} mode="plan" />
          {amount !== data.settings.monthly_budget_pkr && <p className="px-1 text-xs text-slate-500">The AI note is about your {rs(data.settings.monthly_budget_pkr)} monthly plan.</p>}
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={copy} className="flex-1">{copied ? 'Copied ✓' : 'Copy list'}</Button>
        <Button kind="secondary" onClick={save} className="flex-1">Save as this month’s plan</Button>
      </div>
      {saved && <p className="text-sm text-teal-800 dark:text-teal-300">{saved}</p>}
      <ErrorNote error={error} />

      {plan.warnings.map((w) => <p key={w} className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">{w}</p>)}

      {buying && (
        <BuyForm item={buying} onClose={() => setBuying(null)} onSave={async (shares, price) => {
          const existing = data.holdings.find((h) => h.symbol === buying.symbol);
          await source.saveHolding(applyBuy(existing, buying.symbol, shares, price, data.prices[buying.symbol]));
          if (!existing) {
            const w = data.watchlist.find((x) => x.symbol === buying.symbol);
            if (w?.id) await source.deleteWatch(w.id).catch(() => {});
          }
          setBuying(null);
          setSaved(`${buying.symbol} updated in your portfolio. The plan below now reflects it.`);
          await reload();
        }} />
      )}

      {plan.tranches.map((t) => (
        <Section key={t.index} title={`Tranche ${t.index}${t.is_buffer ? ' · buffer' : ''}`}
          right={<span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.date === today ? 'Today' : dateLabel(t.date)} · {rs(t.available)}</span>}>
          <Card className="space-y-3">
            {t.is_buffer && <p className="text-xs text-slate-500 dark:text-slate-400">Last-week buffer, plus leftovers from earlier tranches. Best used on a dip.</p>}
            {t.index > 1 && <p className="text-xs text-slate-500 dark:text-slate-400">Uses today’s prices; recheck them on the day.</p>}
            {t.items.length === 0 && <p className="text-sm text-slate-500">Nothing to buy in this tranche.</p>}
            {t.items.map((i) => (
              <div key={i.symbol} className="space-y-1.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{i.symbol} <Tag tone={i.kind === 'average_down' ? 'teal' : 'slate'}>{i.kind === 'average_down' ? 'Average down' : 'Watchlist'}</Tag></p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{i.reason}</p>
                  </div>
                  <div className="num shrink-0 text-right">
                    <p className="text-lg font-bold">{i.shares} sh</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{rs(i.rupees)} @ {rs2(i.price)}</p>
                  </div>
                </div>
                {t.index === 1 && (
                  <button onClick={() => setBuying(i)} className="text-xs font-semibold text-teal-700 dark:text-teal-400">✓ Mark as bought</button>
                )}
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

      {opportunities.length > 0 && (
        <Section title="Opportunities (KSE-100 screen)">
          <Card className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">High dividend yield and low P/E stocks you don’t own or watch yet{data.settings.shariah_only ? ', Shariah only' : ''}. Add one to your watchlist and the plan will consider it.</p>
            {opportunities.map((o) => (
              <div key={o.symbol} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{o.symbol} {o.is_shariah && <Tag tone="green">Shariah</Tag>}</p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">{o.reason}{o.sector ? ` · ${titleCase(o.sector)}` : ''}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="num text-sm font-semibold">{rs2(o.price)}</span>
                  <Button kind="ghost" onClick={async () => { await source.addWatch(o.symbol, 'From opportunity screen'); await reload(); }}>+ Watch</Button>
                </div>
              </div>
            ))}
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

function BuyForm({ item, onSave, onClose }: { item: PlanItem; onSave: (shares: number, price: number) => Promise<void>; onClose: () => void }) {
  const [shares, setShares] = useState(String(item.shares));
  const [price, setPrice] = useState(item.price.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="space-y-3 ring-2 ring-teal-600">
      <p className="font-semibold">Mark {item.symbol} as bought</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">Enter what you actually got in your broker app. Average cost updates automatically.</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-sm">Shares<input className={`${inputCls} num`} inputMode="numeric" value={shares} onChange={(e) => setShares(e.target.value)} /></label>
        <label className="space-y-1 text-sm">Price paid (Rs)<input className={`${inputCls} num`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      </div>
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={async () => {
          setBusy(true);
          try { await onSave(Number(shares), Number(price)); } catch (e) { setError((e as Error).message); setBusy(false); }
        }}>Save to portfolio</Button>
        <Button kind="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}
