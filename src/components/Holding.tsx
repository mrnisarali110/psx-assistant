/**
 * Holdings UI: call chip, swipeable row (left: edit/remove, right: record buy; long press: menu; tap: stock page),
 * and the add / edit / record-buy form as a bottom sheet.
 */
import { useEffect, useState } from 'react';
import type { BcState } from '../../shared/bluechip.ts';
import { BcBadge } from './BcBadge.tsx';
import type { HoldingCall, HoldingView, SectorMap } from '../../shared/portfolio.ts';
import { applyBuy, txnFromChange, withLastBuy } from '../../shared/changes.ts';
import type { Holding, HoldingCallKind, HoldingStatus, Price, Settings, Txn } from '../../shared/types.ts';
import { DEFAULT_SETTINGS } from '../../shared/types.ts';
import { buyCostBasis, cheapShareWarning, costRates, roundTripPct, type CostRates } from '../../shared/costs.ts';
import { rs, rs2 } from '../../shared/format.ts';
import { pktDate } from '../../shared/time.ts';
import { compose, useLongPress, useSwipeRow } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Button, Change, CompanyMark, ErrorNote, Field, Segmented, Toggle, inputCls } from './ui.tsx';

/**
 * Calls in the app's colour language: brand for a suggested action (Buy more), caution for anything that asks you to
 * look (Trim, Review, Sell), neutral for Hold. Green and red stay for price direction only.
 */
const CALL: Record<HoldingCallKind, { label: string; cls: string }> = {
  hold: { label: 'Hold', cls: 'bg-surface-2 text-muted' },
  average_down: { label: 'Buy more', cls: 'bg-brand/10 text-brand' },
  opportunity: { label: 'Opportunity', cls: 'bg-brand/10 text-brand' },
  trim: { label: 'Trim', cls: 'bg-caution/5 text-caution ring-1 ring-caution/30' },
  review: { label: 'Review', cls: 'bg-caution/5 text-caution ring-1 ring-caution/30' },
  sell: { label: 'Sell', cls: 'bg-caution/5 text-caution ring-1 ring-caution/60' },
};

export function CallChip({ call }: { call: Pick<HoldingCall, 'call'> & Partial<Pick<HoldingCall, 'source'>> }) {
  const c = CALL[call.call];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-chip px-2 py-0.5 text-12 font-semibold ${c.cls}`}>
      {call.source === 'ai' && <Icon name="sparkles" className="h-3 w-3" label="AI" />}
      {c.label}
    </span>
  );
}

export const STATUS_LABEL: Record<HoldingStatus, string> = { core: 'Core', hold_no_add: 'Hold, no add', review: 'Review' };

export interface RowActions { onOpen: () => void; onMenu: () => void; onEdit: () => void; onBuy: () => void; onRemove: () => void }

export function HoldingRow({ row, call, actions, bc }: { row: HoldingView; call: HoldingCall; actions: RowActions; bc?: BcState }) {
  const swipe = useSwipeRow({ maxLeft: 144, maxRight: 80 });
  const press = useLongPress(actions.onMenu);
  const h = row.holding;
  const act = (fn: () => void) => () => { swipe.close(); fn(); };
  const back = 'flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-12 font-semibold text-canvas';
  return (
    <li className="relative overflow-hidden rounded-card bg-surface-2">
      <div className="absolute inset-y-0 left-0 flex w-20 items-stretch" aria-hidden={swipe.dx <= 0} style={{ visibility: swipe.dx > 0 ? 'visible' : 'hidden' }}>
        <button type="button" tabIndex={swipe.dx > 0 ? 0 : -1} onClick={act(actions.onBuy)} className={`${back} bg-brand`}>
          <Icon name="bag" />Buy
        </button>
      </div>
      <div className="absolute inset-y-0 right-0 flex w-36 items-stretch" aria-hidden={swipe.dx >= 0} style={{ visibility: swipe.dx < 0 ? 'visible' : 'hidden' }}>
        <button type="button" tabIndex={swipe.dx < 0 ? 0 : -1} onClick={act(actions.onEdit)} className={`${back} bg-muted`}>
          <Icon name="pencil" />Edit
        </button>
        <button type="button" tabIndex={swipe.dx < 0 ? 0 : -1} onClick={act(actions.onRemove)} className={`${back} bg-caution`}>
          <Icon name="trash" />Remove
        </button>
      </div>
      <div {...compose(swipe.handlers, press.handlers)} style={{ transform: `translateX(${swipe.dx}px)`, transition: swipe.dragging ? 'none' : 'transform 260ms var(--ease-out-quint)' }}
        className="no-callout relative touch-pan-y bg-surface ring-1 ring-line ring-inset">
        <button type="button" className="flex min-h-16 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
          onClick={() => { if (swipe.consumeClick() || press.consumed()) return; if (swipe.open) swipe.close(); else actions.onOpen(); }}>
          <CompanyMark symbol={h.symbol} sector={row.sector} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="text-16 font-semibold">{h.symbol}</span>
              <BcBadge state={bc} symbol={h.symbol} />
              <CallChip call={call} />
            </span>
            <span className="mt-0.5 line-clamp-2 block text-12 text-muted">{call.text}</span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-14 font-semibold">{rs(row.value)}</span>
            <span className="block text-12">
              <Change value={row.pnl_pct} className="font-semibold" label="profit or loss" /> <span className="text-muted">vs avg cost</span>
            </span>
          </span>
        </button>
        <button type="button" onClick={actions.onMenu} aria-label={`More actions for ${h.symbol}`}
          className="absolute top-1 right-1 hidden h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink sm:flex">
          <Icon name="more" />
        </button>
      </div>
    </li>
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
    <div className={`flex justify-between gap-3 ${strong ? 'font-semibold' : 'text-muted'}`}><span>{k}</span><span className="num">{v}</span></div>
  );
  return (
    <div className="space-y-1 rounded-control bg-surface-2 p-3 text-14" role="status">
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
      <p className={`pt-1 text-12 ${warn ? 'font-medium text-caution' : 'text-muted'}`}>
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
            <span className="text-14 font-medium">Shariah compliant{psxShariah != null && <span className="block text-12 font-normal text-muted">PSX lists {sym} as {psxShariah ? 'a KMI All Share member' : 'not in the KMI All Share'}</span>}</span>
            <Toggle checked={shariah} onChange={setShariah} label="Shariah compliant" />
          </div>
          {(form.mode === 'add' || delta !== 0) && (
            <div className="flex items-center justify-between gap-3 rounded-control bg-surface-2 p-3">
              <span className="text-14">
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
