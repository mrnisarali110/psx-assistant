/**
 * Everything you can do to a stock, in one place, used by Home, Portfolio and the stock page: open the stock page,
 * long-press menu, edit / record-buy form, plan a sale, remove with Undo, watchlist actions.
 */
import { useMemo, useState } from 'react';
import { buildPortfolio, cleanInsight, mergeCall, screenSectors, screenShariah, sectorPeMap, type HoldingView, type RuleContext } from '../../shared/portfolio.ts';
import { peMap, sectorStats } from '../../shared/valuation.ts';
import { pktDate } from '../../shared/time.ts';
import { DEFAULT_RULES, type AiInsight, type Holding } from '../../shared/types.ts';
import type { ScreenProps } from '../App.tsx';
import { openStock } from '../lib/nav.ts';
import { useToast } from './Toast.tsx';
import { ActionSheet } from './Sheet.tsx';
import { HoldingForm, type FormMode } from './Holding.tsx';
import { SellPlanner } from './SellPlanner.tsx';

/** The latest AI insight if it is recent enough to trust for today. */
export function freshInsight(ai: AiInsight | null, now = new Date()): AiInsight | null {
  return ai && now.getTime() - Date.parse(ai.created_at) < DEFAULT_RULES.ai.fresh_hours * 3600_000 ? ai : null;
}

export function useHoldingActions({ data, source, reload }: Pick<ScreenProps, 'data' | 'source' | 'reload'>) {
  const toast = useToast();
  const [menu, setMenu] = useState<string | null>(null);
  const [form, setForm] = useState<FormMode | null>(null);
  const [plan, setPlan] = useState<{ open: boolean; symbol: string | null }>({ open: false, symbol: null });
  // PSX's sector for every listed symbol, so a holding is filed under its sector the moment it is added.
  const sectors = useMemo(() => screenSectors(data.screen), [data.screen]);
  const shariah = useMemo(() => screenShariah(data.screen), [data.screen]);
  const today = pktDate(new Date());
  // One P/E per stock (filings first, PSX's figure otherwise), the same one every screen shows and every rule uses.
  // Live prices win over the screen's for the stocks you hold or watch.
  const pe = useMemo(() => {
    const rows = new Map(data.screen.map((r) => [r.symbol, { symbol: r.symbol, price: r.price, pe: r.pe }]));
    for (const p of Object.values(data.prices)) rows.set(p.symbol, { symbol: p.symbol, price: p.price, pe: p.pe ?? rows.get(p.symbol)?.pe ?? null });
    return peMap([...rows.values()], data.earnings);
  }, [data.screen, data.prices, data.earnings]);
  const sectorPe = useMemo(() => sectorPeMap(data.screen, DEFAULT_RULES, pe), [data.screen, pe]);
  const sectorStat = useMemo(() => sectorStats(data.screen, DEFAULT_RULES, pe), [data.screen, pe]);
  const ctx: RuleContext = useMemo(() => ({ today, sectorPe, dividends: data.dividends, earnings: data.earnings, pe }), [today, sectorPe, data.dividends, data.earnings, pe]);
  const view = useMemo(() => buildPortfolio(data.holdings, data.prices, data.settings, DEFAULT_RULES, sectors, ctx), [data.holdings, data.prices, data.settings, sectors, ctx]);
  const ai = cleanInsight(freshInsight(data.aiInsight), view, data.settings);
  const callFor = (row: HoldingView) => mergeCall(row, ai, data.settings);
  const rowOf = (sym: string | null) => view.rows.find((r) => r.holding.symbol === sym);
  const watchOf = (sym: string | null) => data.watchlist.find((w) => w.symbol === sym);

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
  const watch = async (sym: string) => {
    try {
      await source.addWatch(sym);
      await reload();
      toast(`${sym} added to your watchlist`);
    } catch (e) { toast((e as Error).message); }
  };
  const buy = (sym: string) => setForm({ mode: 'buy', holding: rowOf(sym)?.holding, symbol: sym, price: data.prices[sym]?.price ?? data.screen.find((r) => r.symbol === sym)?.price });
  const edit = (h: Holding) => setForm({ mode: 'edit', holding: h });
  const planSale = (sym: string | null = null) => setPlan({ open: true, symbol: sym });

  const menuRow = rowOf(menu);
  const ui = (
    <>
      <ActionSheet open={!!menu} onClose={() => setMenu(null)} title={menu ?? ''} actions={menuRow ? [
        { label: 'Record a buy', icon: 'bag', onSelect: () => buy(menuRow.holding.symbol) },
        { label: 'Plan a sale', icon: 'tag', onSelect: () => planSale(menuRow.holding.symbol) },
        { label: 'Edit holding', icon: 'pencil', onSelect: () => edit(menuRow.holding) },
        { label: 'Open stock page', icon: 'eye', onSelect: () => openStock(menuRow.holding.symbol) },
        { label: 'Remove', icon: 'trash', destructive: true, onSelect: () => remove(menuRow.holding) },
      ] : menu ? [
        { label: 'Record a buy', icon: 'bag', onSelect: () => buy(menu) },
        { label: 'Open stock page', icon: 'eye', onSelect: () => openStock(menu) },
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
    view, sectors, callFor, ui, today, ai, pe, sectorStat, ctx,
    // One detail view: every tap on a ticker opens its stock page.
    open: openStock, menu: setMenu, edit, buy, remove, unwatch, watch, planSale,
    add: () => setForm({ mode: 'add' }),
  };
}
