/**
 * Holdings UI: call chip, swipeable row (left: edit/remove, right: record buy; long press: menu),
 * detail sheet, and the add / edit / record-buy form as a bottom sheet.
 */
import { useEffect, useState } from 'react';
import type { BcState } from '../../shared/bluechip.ts';
import { BcBadge } from './BcBadge.tsx';
import type { HoldingCall, HoldingView, SectorMap } from '../../shared/portfolio.ts';
import { applyBuy, txnFromChange, withLastBuy } from '../../shared/changes.ts';
import type { DividendEvent, Holding, HoldingCallKind, HoldingStatus, Price, Settings, Txn } from '../../shared/types.ts';
import { DEFAULT_SETTINGS } from '../../shared/types.ts';
import { buyCostBasis, cheapShareWarning, costRates, roundTripPct, type CostRates } from '../../shared/costs.ts';
import { pct, rs, rs2, signedRs, titleCase, dateLabel } from '../../shared/format.ts';
import { missingNum, peOutlier } from '../../shared/quality.ts';
import { exLabel } from '../../shared/symbols.ts';
import { pktDate } from '../../shared/time.ts';
import { compose, useLongPress, useSwipeRow } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Button, ErrorNote, Field, Segmented, SymbolAvatar, Tag, Toggle, changeTone, inputCls, type Tone } from './ui.tsx';

const CALL: Record<HoldingCallKind, { label: string; tone: Tone }> = {
  hold: { label: 'Hold', tone: 'slate' },
  average_down: { label: 'Buy more', tone: 'teal' },
  opportunity: { label: 'Opportunity', tone: 'green' },
  trim: { label: 'Trim', tone: 'amber' },
  review: { label: 'Review', tone: 'amber' },
  sell: { label: 'Sell', tone: 'red' },
};

export function CallChip({ call }: { call: HoldingCall }) {
  const c = CALL[call.call];
  return (
    <Tag tone={c.tone}>
      {call.source === 'ai' && <Icon name="sparkles" className="h-3 w-3" label="AI" />}
      {c.label}
    </Tag>
  );
}

export const STATUS_LABEL: Record<HoldingStatus, string> = { core: 'Core', hold_no_add: 'Hold, no add', review: 'Review' };

export interface RowActions { onOpen: () => void; onMenu: () => void; onEdit: () => void; onBuy: () => void; onRemove: () => void }

export function HoldingRow({ row, call, actions, bc }: { row: HoldingView; call: HoldingCall; actions: RowActions; bc?: BcState }) {
  const swipe = useSwipeRow({ maxLeft: 144, maxRight: 80 });
  const press = useLongPress(actions.onMenu);
  const h = row.holding;
  const act = (fn: () => void) => () => { swipe.close(); fn(); };
  return (
    <li className="relative overflow-hidden rounded-3xl bg-slate-100 dark:bg-slate-800">
      <div className="absolute inset-y-0 left-0 flex w-20 items-stretch" aria-hidden={swipe.dx <= 0} style={{ visibility: swipe.dx > 0 ? 'visible' : 'hidden' }}>
        <button type="button" tabIndex={swipe.dx > 0 ? 0 : -1} onClick={act(actions.onBuy)} className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 bg-teal-600 text-xs font-semibold text-white">
          <Icon name="bag" />Buy
        </button>
      </div>
      <div className="absolute inset-y-0 right-0 flex w-36 items-stretch" aria-hidden={swipe.dx >= 0} style={{ visibility: swipe.dx < 0 ? 'visible' : 'hidden' }}>
        <button type="button" tabIndex={swipe.dx < 0 ? 0 : -1} onClick={act(actions.onEdit)} className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 bg-slate-500 text-xs font-semibold text-white">
          <Icon name="pencil" />Edit
        </button>
        <button type="button" tabIndex={swipe.dx < 0 ? 0 : -1} onClick={act(actions.onRemove)} className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 bg-rose-600 text-xs font-semibold text-white">
          <Icon name="trash" />Remove
        </button>
      </div>
      <div {...compose(swipe.handlers, press.handlers)} style={{ transform: `translateX(${swipe.dx}px)`, transition: swipe.dragging ? 'none' : 'transform 260ms var(--ease-out-quint)' }}
        className="no-callout relative touch-pan-y bg-white dark:bg-slate-900">
        <button type="button" className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
          onClick={() => { if (swipe.consumeClick() || press.consumed()) return; if (swipe.open) swipe.close(); else actions.onOpen(); }}>
          <SymbolAvatar symbol={h.symbol} change={row.price?.change_pct} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="font-semibold">{h.symbol}</span>
              <BcBadge state={bc} symbol={h.symbol} />
              <CallChip call={call} />
            </span>
            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{call.text}</span>
          </span>
          <span className="num shrink-0 text-right">
            <span className="block font-semibold">{rs(row.value)}</span>
            <span className={`block text-xs font-medium ${changeTone(row.pnl_pct)}`}>{pct(row.pnl_pct)}</span>
          </span>
        </button>
        <button type="button" onClick={actions.onMenu} aria-label={`More actions for ${h.symbol}`}
          className="absolute top-1 right-1 hidden h-8 w-8 cursor-pointer items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 sm:flex dark:hover:bg-slate-800">
          <Icon name="more" />
        </button>
      </div>
    </li>
  );
}

function RangeBar({ low, high, value }: { low: number | null; high: number | null; value: number | null }) {
  if (low == null || high == null || value == null || high <= low) return <p className="text-sm">no data</p>;
  const pos = Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100));
  return (
    <div>
      <div className="relative h-2 rounded-full bg-gradient-to-r from-rose-400 via-amber-300 to-emerald-400">
        <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-slate-900 shadow dark:border-slate-900 dark:bg-white" style={{ left: `${pos}%` }} />
      </div>
      <div className="num mt-1 flex justify-between text-[11px] text-slate-500 dark:text-slate-400"><span>{rs2(low)}</span><span>52-week</span><span>{rs2(high)}</span></div>
    </div>
  );
}

const Stat = ({ label, value, tone = '' }: { label: string; value: string; tone?: string }) => (
  <div><p className="text-xs text-slate-500 dark:text-slate-400">{label}</p><p className={`num text-sm font-semibold ${tone}`}>{value}</p></div>
);

/** Detail for a holding (row) or a watchlist stock (price only). */
export function StockSheet({ open, onClose, symbol, price, row, call, dividend, news, children }: {
  open: boolean; onClose: () => void; symbol: string; price: Price | null; row?: HoldingView; call?: HoldingCall;
  dividend?: (DividendEvent & { buy_by: string }) | null; news?: { title: string; ai_summary?: string | null; published_at: string } | null; children?: React.ReactNode;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={symbol}>
      <div className="space-y-4 pb-2">
        <div className="flex items-center gap-3">
          <SymbolAvatar symbol={symbol} change={price?.change_pct} size="h-14 w-14" />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-sm text-slate-500 dark:text-slate-400">{price?.name ?? (price?.sector ? titleCase(price.sector) : 'PSX')}{price?.ex && <Tag tone="violet">{exLabel(price.ex)}</Tag>}</p>
            <p className="num text-2xl font-bold">{rs2(price?.price)}</p>
            <p className={`num text-sm font-medium ${changeTone(price?.change_pct)}`}>{pct(price?.change_pct, 2)} today</p>
          </div>
        </div>
        {call && (
          <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/60">
            <CallChip call={call} />
            <p className="mt-1 text-sm">{call.text}</p>
          </div>
        )}
        {row && (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Shares" value={String(row.holding.shares)} />
            <Stat label="Avg cost" value={rs2(row.holding.avg_cost)} />
            <Stat label="Last buy" value={row.holding.last_buy_price ? rs2(row.holding.last_buy_price) : '—'} />
            <Stat label="Value" value={rs(row.value)} />
            <Stat label="Profit / loss" value={signedRs(row.pnl)} tone={changeTone(row.pnl)} />
            <Stat label="Weight" value={row.weight_pct == null ? 'no data' : `${row.weight_pct.toFixed(1)}%`} />
          </div>
        )}
        <RangeBar low={price?.low_52w ?? null} high={price?.high_52w ?? null} value={price?.price ?? null} />
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Dividend yield" value={missingNum(price?.dividend_yield_pct) ? 'n/a' : `${price!.dividend_yield_pct!.toFixed(1)}%`} />
          <Stat label="P/E" value={missingNum(price?.pe) ? 'n/a' : price!.pe!.toFixed(1)} tone={peOutlier(price?.pe).outlier && !missingNum(price?.pe) ? 'text-amber-600 dark:text-amber-400' : ''} />
          <Stat label="Status" value={row ? STATUS_LABEL[row.holding.status] : 'Watching'} />
        </div>
        {!missingNum(price?.pe) && peOutlier(price?.pe).outlier && <p className="text-xs text-amber-700 dark:text-amber-400">{peOutlier(price?.pe).reason}</p>}
        {dividend && (
          <p className="flex items-start gap-2 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">
            <Icon name="coins" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{dividend.dps != null ? `Rs ${dividend.dps}/share dividend. ` : 'Dividend declared. '}Buy by <b>{dateLabel(dividend.buy_by)}</b> to get it (estimate; confirm with your broker).</span>
          </p>
        )}
        {news && (
          <p className="rounded-2xl bg-violet-50 p-3 text-sm dark:bg-violet-950/40">
            <span className="text-xs text-slate-500 dark:text-slate-400">{dateLabel(news.published_at)} · </span>{news.ai_summary ?? news.title}
          </p>
        )}
        {children}
      </div>
    </Sheet>
  );
}

export type FormMode = { mode: 'add' } | { mode: 'edit'; holding: Holding } | { mode: 'buy'; holding?: Holding; symbol: string; price?: number | null };

/** Add, edit or record a buy. Every save goes through one change → transaction path. */
export function HoldingForm({ open, onClose, form, prices, sectors = {}, shariah = {}, settings = DEFAULT_SETTINGS, onSave }: {
  open: boolean; onClose: () => void; form: FormMode | null; prices: Record<string, Price>; sectors?: SectorMap; shariah?: Record<string, boolean | null | undefined>; settings?: Settings;
  onSave: (before: Holding | undefined, after: Holding, txn: Txn | null) => Promise<void>;
}) {
  return (
    <Sheet open={open && !!form} onClose={onClose} title={!form ? '' : form.mode === 'add' ? 'Add a holding' : form.mode === 'edit' ? `Edit ${form.holding.symbol}` : `Record a buy`}>
      {form && <FormBody key={JSON.stringify(form)} form={form} prices={prices} sectors={sectors} shariah={shariah} settings={settings} onSave={onSave} onClose={onClose} />}
    </Sheet>
  );
}

/** What this order really costs: value, each charge, the total and the cost per share (FEATURE-08). */
export function OrderTicket({ shares, price, rates, charges }: { shares: number; price: number; rates: CostRates; charges?: number | null }) {
  const est = buyCostBasis(shares, price, rates);
  const c = est.costs;
  const total = charges != null ? Math.round((c.value + charges) * 100) / 100 : est.total;
  const warn = cheapShareWarning(price, rates);
  const trip = roundTripPct(price, rates);
  const Line = ({ k, v, strong = false }: { k: string; v: string; strong?: boolean }) => (
    <div className={`flex justify-between gap-3 ${strong ? 'font-semibold' : 'text-slate-600 dark:text-slate-300'}`}><span>{k}</span><span className="num">{v}</span></div>
  );
  return (
    <div className="space-y-1 rounded-2xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60" role="status">
      <Line k={`${shares} × ${rs2(price)}`} v={rs2(c.value)} />
      {charges == null ? (
        <>
          <Line k={`Commission (${rates.commission_pct}%, min ${rs2(rates.min_commission_per_share)}/share)`} v={rs2(c.commission)} />
          <Line k={`Sales tax ${rates.sales_tax_pct}%`} v={rs2(c.sales_tax)} />
          <Line k="PSX fee + SECP levy + CDC" v={rs2(c.psx_fee + c.secp_levy + c.cdc)} />
        </>
      ) : <Line k="Charges (from your contract note)" v={rs2(charges)} />}
      <Line k="Total cost" v={rs2(total)} strong />
      <Line k="Per share, all in" v={rs2(shares > 0 ? total / shares : 0)} />
      <p className={`pt-1 text-xs ${warn ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
        Round trip (buy and sell) about {trip == null ? 'n/a' : `${trip.toFixed(2)}%`} in charges.{warn ? ' The per-share minimum commission bites on cheap shares.' : ''}
      </p>
    </div>
  );
}

function FormBody({ form, prices, sectors, shariah: shariahMap, settings, onSave, onClose }: { form: FormMode; prices: Record<string, Price>; sectors: SectorMap; shariah: Record<string, boolean | null | undefined>; settings: Settings; onClose: () => void; onSave: (b: Holding | undefined, a: Holding, t: Txn | null) => Promise<void> }) {
  const before = form.mode === 'edit' ? form.holding : form.mode === 'buy' ? form.holding : undefined;
  const [symbol, setSymbol] = useState(form.mode === 'buy' ? form.symbol : before?.symbol ?? '');
  const [shares, setShares] = useState(form.mode === 'buy' ? '' : before ? String(before.shares) : '');
  const [price, setPrice] = useState(form.mode === 'buy' ? (form.price ? form.price.toFixed(2) : '') : before ? String(before.avg_cost) : '');
  const [status, setStatus] = useState<HoldingStatus>(before?.status ?? 'core');
  const [shariah, setShariah] = useState(before?.is_shariah ?? false);
  const [note, setNote] = useState(before?.note ?? '');
  const [thesis, setThesis] = useState(before?.thesis ?? '');
  const [reviewOn, setReviewOn] = useState(before?.review_on ?? '');
  const [target, setTarget] = useState(before?.target_price ? String(before.target_price) : '');
  const [charges, setCharges] = useState(''); // blank = estimate from the broker settings
  const [countIt, setCountIt] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = pktDate(new Date());
  const rates = costRates(settings);

  const sym = symbol.trim().toUpperCase();
  // Adding a stock: the Shariah toggle follows PSX (KMI All Share membership) for the symbol typed; it can still be changed.
  const psxShariah = form.mode === 'add' ? prices[sym]?.is_shariah ?? shariahMap[sym] ?? null : null;
  useEffect(() => { if (psxShariah != null) setShariah(psxShariah); }, [psxShariah]);
  const qty = Number(shares);
  const px = Number(price);
  const delta = before && form.mode === 'edit' && Number.isInteger(qty) ? qty - before.shares : 0;
  const chargesNum = charges.trim() === '' ? null : Number(charges.replace(/[,\s]/g, ''));
  const targetNum = target.trim() === '' ? null : Number(target.replace(/[,\s]/g, ''));

  async function save() {
    if (!/^[A-Z0-9]{1,12}$/.test(sym)) return setError('Symbol should be letters/numbers like SYS or MEBL.');
    if (!Number.isInteger(qty) || qty <= 0) return setError('Shares must be a whole number above 0.');
    if (!(px > 0)) return setError(form.mode === 'buy' ? 'Enter the price you paid.' : 'Average cost must be above 0.');
    if (chargesNum != null && !(chargesNum >= 0)) return setError('Charges must be a number (leave blank to estimate).');
    if (targetNum != null && !(targetNum > 0)) return setError('Target price must be above 0 (or leave it blank).');
    if (reviewOn && !/^\d{4}-\d{2}-\d{2}$/.test(reviewOn)) return setError('Pick a review date.');
    setBusy(true);
    try {
      let after: Holding;
      let txn: Txn | null;
      if (form.mode === 'buy') {
        after = applyBuy(before, sym, qty, px, prices[sym]);
        txn = { symbol: sym, side: 'buy', shares: qty, price: px, amount: Math.round(qty * px * 100) / 100, executed_on: today, source: 'manual', charges: chargesNum };
      } else {
        // The sector is PSX's, never asked: price row first, else the market screen.
        after = {
          ...(before ?? { sector: prices[sym]?.sector ?? sectors[sym] ?? null }), symbol: sym, shares: qty, avg_cost: px, status, is_shariah: shariah, note: note.trim() || null,
          thesis: thesis.trim() || null, review_on: reviewOn || null, target_price: targetNum,
        } as Holding;
        txn = countIt ? txnFromChange(before, after, today, prices[sym]?.price, 'manual') : null;
      }
      await onSave(before, withLastBuy(after, txn), txn);
      onClose();
    } catch (e) {
      setError((e as Error).message.includes('duplicate') ? `${sym} is already in your portfolio. Edit it instead.` : (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 pb-2">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Symbol">
          <input className={`${inputCls} uppercase`} value={symbol} disabled={form.mode !== 'add'} autoCapitalize="characters" autoComplete="off" onChange={(e) => setSymbol(e.target.value)} />
        </Field>
        <Field label={form.mode === 'buy' ? 'Shares bought' : 'Shares'}>
          <input className={`${inputCls} num`} inputMode="numeric" value={shares} onChange={(e) => setShares(e.target.value)} />
        </Field>
      </div>
      <Field label={form.mode === 'buy' ? 'Price paid per share (Rs)' : 'Average cost (Rs)'} hint={form.mode === 'buy' ? 'The traded price, before charges; the ticket below adds them.' : undefined}>
        <input className={`${inputCls} num`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      {form.mode === 'buy' && (
        <>
          <Field label="Charges on the contract note (Rs)" hint="Optional. Blank = estimated from your broker settings in Profile.">
            <input className={`${inputCls} num`} inputMode="decimal" value={charges} placeholder="estimate" onChange={(e) => setCharges(e.target.value)} />
          </Field>
          {Number.isInteger(qty) && qty > 0 && px > 0 && <OrderTicket shares={qty} price={px} rates={rates} charges={chargesNum != null && chargesNum >= 0 ? chargesNum : null} />}
        </>
      )}
      {form.mode !== 'buy' && (
        <>
          <Segmented label="Status" value={status} onChange={setStatus}
            options={[{ value: 'core', label: 'Core' }, { value: 'hold_no_add', label: 'Hold, no add' }, { value: 'review', label: 'Review' }]} />
          <Field label="Why I own it" hint="One line. “Review” shows up when the review date arrives or the thesis is challenged.">
            <input className={inputCls} value={thesis} maxLength={200} placeholder="e.g. Cheapest big bank, 7% yield, adding on dips" onChange={(e) => setThesis(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Review on">
              <input type="date" className={`${inputCls} px-2`} value={reviewOn} min={today} onChange={(e) => setReviewOn(e.target.value)} />
            </Field>
            <Field label="Target price (Rs)">
              <input className={`${inputCls} num`} inputMode="decimal" value={target} placeholder="none" onChange={(e) => setTarget(e.target.value)} />
            </Field>
          </div>
          <Field label="Note"><input className={inputCls} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Shariah compliant{psxShariah != null && <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">PSX lists {sym} as {psxShariah ? 'a KMI All Share member' : 'not in the KMI All Share'}</span>}</span>
            <Toggle checked={shariah} onChange={setShariah} label="Shariah compliant" />
          </div>
          {(form.mode === 'add' || delta !== 0) && (
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/60">
              <span className="text-sm">
                {form.mode === 'add' ? 'Count this as a new buy this month' : delta > 0 ? `Count the extra ${delta} shares as bought this month` : `Record ${-delta} shares as sold`}
              </span>
              <Toggle checked={countIt} onChange={setCountIt} label="Record as a transaction" />
            </div>
          )}
        </>
      )}
      <ErrorNote error={error} />
      <Button className="w-full" disabled={busy} onClick={save}>{busy ? 'Saving…' : form.mode === 'buy' ? 'Save buy' : 'Save'}</Button>
    </div>
  );
}
