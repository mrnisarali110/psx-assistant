/**
 * Everything you can do to a stock, in one place, used by Home and Portfolio: detail sheet,
 * long-press menu, edit / record-buy form, remove with Undo, watchlist actions.
 */
import { useMemo, useState } from 'react';
import { buildPortfolio, mergeCall, screenSectors, screenShariah, sectorPeMap, type HoldingView } from '../../shared/portfolio.ts';
import { upcomingDividends } from '../../shared/discover.ts';
import { tradingCalendar } from '../../shared/calendar.ts';
import { pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES, type AiInsight, type Holding } from '../../shared/types.ts';
import type { ScreenProps } from '../App.tsx';
import { useToast } from './Toast.tsx';
import { ActionSheet } from './Sheet.tsx';
import { HoldingForm, StockSheet, type FormMode } from './Holding.tsx';
import { SellPlanner } from './SellPlanner.tsx';
import { Button } from './ui.tsx';
import { Icon } from './Icon.tsx';

/** The latest AI insight if it is recent enough to trust for today. */
export function freshInsight(ai: AiInsight | null, now = new Date()): AiInsight | null {
  return ai && now.getTime() - Date.parse(ai.created_at) < DEFAULT_RULES.ai.fresh_hours * 3600_000 ? ai : null;
}

export function useHoldingActions({ data, source, reload }: Pick<ScreenProps, 'data' | 'source' | 'reload'>) {
  const toast = useToast();
  const [detail, setDetail] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [form, setForm] = useState<FormMode | null>(null);
  const [plan, setPlan] = useState<{ open: boolean; symbol: string | null }>({ open: false, symbol: null });
  // PSX's sector for every listed symbol, so a holding is filed under its sector the moment it is added.
  const sectors = useMemo(() => screenSectors(data.screen), [data.screen]);
  const shariah = useMemo(() => screenShariah(data.screen), [data.screen]);
  const today = pktDate(new Date());
  const sectorPe = useMemo(() => sectorPeMap(data.screen), [data.screen]);
  const view = useMemo(() => buildPortfolio(data.holdings, data.prices, data.settings, DEFAULT_RULES, sectors, { today, sectorPe, dividends: data.dividends }), [data, sectors, today, sectorPe]);
  const ai = freshInsight(data.aiInsight);
  const callFor = (row: HoldingView) => mergeCall(row, ai, data.settings);
  const rowOf = (sym: string | null) => view.rows.find((r) => r.holding.symbol === sym);
  const watchOf = (sym: string | null) => data.watchlist.find((w) => w.symbol === sym);
  const cal = useMemo(() => tradingCalendar(DEFAULT_RULES, data.indexDaily), [data.indexDaily]);
  const upcoming = useMemo(() => upcomingDividends(data.dividends, today, DEFAULT_RULES, cal), [data.dividends, today, cal]);

  const remove = async (h: Holding) => {
    try {
      await source.saveHoldingChange(h, null, null);
      await reload();
      toast(`${h.symbol} removed`, { label: 'Undo', run: async () => { await source.saveHoldingChange(undefined, { ...h, id: undefined }, null); await reload(); } });
    } catch (e) { toast((e as Error).message); }
  };
  const unwatch = async (sym: string) => {
    const w = watchOf(sym);
    if (!w?.id) return;
    await source.deleteWatch(w.id);
    await reload();
    toast(`${sym} removed from watchlist`, { label: 'Undo', run: async () => { await source.addWatch(sym, w.note ?? undefined); await reload(); } });
  };
  const buy = (sym: string) => setForm({ mode: 'buy', holding: rowOf(sym)?.holding, symbol: sym, price: data.prices[sym]?.price });
  const edit = (h: Holding) => setForm({ mode: 'edit', holding: h });
  const planSale = (sym: string | null = null) => setPlan({ open: true, symbol: sym });

  const d = rowOf(detail);
  const menuRow = rowOf(menu);
  const ui = (
    <>
      <StockSheet open={!!detail} onClose={() => setDetail(null)} symbol={detail ?? ''} price={detail ? data.prices[detail] ?? null : null}
        row={d} call={d ? callFor(d) : undefined}
        dividend={upcoming.find((u) => u.symbol === detail) ?? null}
        news={data.announcements.find((a) => a.symbol === detail && a.kind !== 'other') ?? null}>
        {d && (d.holding.thesis || d.holding.review_on || d.holding.target_price) && (
          <div className="rounded-2xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
            <p className="text-xs text-slate-500 dark:text-slate-400">Why I own it</p>
            <p>{d.holding.thesis ?? <span className="text-slate-500 dark:text-slate-400">Not written yet (Edit to add it)</span>}</p>
            <p className="num mt-1 text-xs text-slate-500 dark:text-slate-400">
              {[d.holding.review_on && `Review ${d.holding.review_on <= today ? 'due' : 'on'} ${d.holding.review_on}`, d.holding.target_price && `Target Rs ${d.holding.target_price}`].filter(Boolean).join(' · ')}
            </p>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Button onClick={() => { const s = detail!; setDetail(null); buy(s); }}><Icon name="bag" />Buy</Button>
          {d ? (
            <>
              <Button kind="secondary" onClick={() => { setDetail(null); edit(d.holding); }}><Icon name="pencil" />Edit</Button>
              <Button kind="secondary" onClick={() => { const s = detail!; setDetail(null); planSale(s); }}><Icon name="tag" />Plan sale</Button>
              <Button kind="secondary" className="col-span-3 text-rose-600 dark:text-rose-400" onClick={() => { setDetail(null); remove(d.holding); }}><Icon name="trash" />Remove</Button>
            </>
          ) : watchOf(detail) ? (
            <Button kind="secondary" className="col-span-2" onClick={() => { const s = detail!; setDetail(null); unwatch(s); }}><Icon name="x" />Stop watching</Button>
          ) : null}
        </div>
      </StockSheet>
      <ActionSheet open={!!menu} onClose={() => setMenu(null)} title={menu ?? ''} actions={menuRow ? [
        { label: 'Record a buy', icon: 'bag', onSelect: () => buy(menuRow.holding.symbol) },
        { label: 'Plan a sale', icon: 'tag', onSelect: () => planSale(menuRow.holding.symbol) },
        { label: 'Edit holding', icon: 'pencil', onSelect: () => edit(menuRow.holding) },
        { label: 'Details', icon: 'eye', onSelect: () => setDetail(menuRow.holding.symbol) },
        { label: 'Remove', icon: 'trash', destructive: true, onSelect: () => remove(menuRow.holding) },
      ] : menu ? [
        { label: 'Record a buy', icon: 'bag', onSelect: () => buy(menu) },
        { label: 'Details', icon: 'eye', onSelect: () => setDetail(menu) },
        { label: 'Stop watching', icon: 'x', destructive: true, onSelect: () => unwatch(menu) },
      ] : []} />
      <SellPlanner open={plan.open} onClose={() => setPlan({ open: false, symbol: null })} view={view} txns={data.transactions} settings={data.settings} preselect={plan.symbol} />
      <HoldingForm open={!!form} onClose={() => setForm(null)} form={form} prices={data.prices} sectors={sectors} shariah={shariah} settings={data.settings}
        onSave={async (before, after, txn) => {
          await source.saveHoldingChange(before, after, txn);
          await reload();
          toast(txn?.side === 'buy' ? `${after.symbol}: bought ${txn.shares} shares` : `${after.symbol} saved`);
        }} />
    </>
  );

  return {
    view, sectors, callFor, ui, today,
    open: setDetail, menu: setMenu, edit, buy, remove, unwatch, planSale,
    add: () => setForm({ mode: 'add' }),
  };
}
