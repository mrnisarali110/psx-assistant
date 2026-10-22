/**
 * Every buy and sell on record, in one sheet: the list by month, add / edit / delete one, import a CSV (with
 * duplicate and bad-row checks before anything is saved), the template to fill in and an export.
 * Holdings are never changed here; this is the history behind returns, "invested this month" and the tax ledger.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TXN_CSV_TEMPLATE, dedupeTxns, parseTxnCsv, txnsToCsv } from '../../shared/transactions-csv.ts';
import { day, rs, rs2, signedRs } from '../../shared/format.ts';
import { pktDate } from '../../shared/time.ts';
import type { Txn } from '../../shared/types.ts';
import type { AppData, DataSource } from '../lib/data.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { useToast } from './Toast.tsx';
import { Button, Chip, CompanyMark, Empty, ErrorNote, Field, Segmented, inputCls } from './ui.tsx';

type Mode =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; txn: Txn }
  | { kind: 'import'; at: number; file: string; fresh: Txn[]; duplicates: number; errors: string[] };
type ImportMode = Extract<Mode, { kind: 'import' }>;

const r2 = (v: number) => Math.round(v * 100) / 100;
const MAX_CSV_BYTES = 2_000_000; // a broker statement is a few KB; anything bigger is the wrong file
const MAX_CSV_ROWS = 5000;
// A screenshot carries no trade date: such a buy is dated the day you chose on import (today unless changed).
const SOURCE_LABEL: Record<Txn['source'], string | null> = { manual: null, import: 'from screenshots, check the date', csv: 'from CSV' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "October 2026" for a YYYY-MM month heading (a heading, not a date, so not day()). */
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(0, 4)}`;
/** Money out for a buy, money in for a sell. */
const signedAmount = (t: Txn) => signedRs(t.side === 'buy' ? -t.amount : t.amount);
const chargesLabel = (t: Txn) => (t.charges == null ? 'charges estimated' : `charges ${rs2(t.charges)}`);
// Buy and sell are not price moves: neutral chips, the word carries it.
const sideTag = (side: Txn['side']) => <Chip kind="neutral">{side === 'buy' ? 'Buy' : 'Sell'}</Chip>;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const linkCls = 'inline-flex min-h-11 cursor-pointer items-center text-14 font-semibold text-brand underline-offset-2 hover:underline';

/** A download URL for `text` while it is set; revoked when it changes or the sheet closes. */
function useCsvUrl(text: string | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (text == null) { setUrl(undefined); return; }
    const u = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [text]);
  return url;
}

export function TransactionsSheet({ open, onClose, data, source, reload }: {
  open: boolean; onClose: () => void; data: AppData; source: DataSource; reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const today = pktDate(new Date());

  useEffect(() => { if (!open) { setMode({ kind: 'list' }); setError(null); } }, [open]);

  const exportCsv = useMemo(() => (data.transactions.length ? txnsToCsv(data.transactions) : null), [data.transactions]);
  const templateUrl = useCsvUrl(open ? TXN_CSV_TEMPLATE : null);
  const exportUrl = useCsvUrl(open ? exportCsv : null);

  const toList = () => { setMode({ kind: 'list' }); setError(null); };
  const close = useCallback(() => { setMode({ kind: 'list' }); setError(null); onClose(); }, [onClose]);
  const done = async (summary: string) => { await reload(); toList(); toast(summary); };

  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (fileInput.current) fileInput.current.value = ''; // so the same file can be chosen again after a fix
    if (!file) return;
    setError(null);
    if (file.size > MAX_CSV_BYTES) { setError(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB; a transactions CSV should be under ${MAX_CSV_BYTES / 1e6} MB.`); return; }
    try {
      const text = await file.text();
      const lines = text.split('\n').length;
      if (lines > MAX_CSV_ROWS + 1) { setError(`${file.name} has about ${lines - 1} rows; import at most ${MAX_CSV_ROWS} at a time.`); return; }
      const parsed = parseTxnCsv(text, { today }); // the same "not after today" rule as the form
      const { fresh, duplicates } = dedupeTxns(parsed.rows, data.transactions);
      setMode({ kind: 'import', at: Date.now(), file: file.name, fresh, duplicates: duplicates.length, errors: parsed.errors });
    } catch (e) {
      setError(`Could not read ${file.name}: ${(e as Error).message}`);
    }
  }

  return (
    <Sheet open={open} onClose={close} title="Buys and sells">
      <div className="space-y-4 pb-2">
        {mode.kind === 'list' && (
          <>
            <p className="text-14 text-muted">
              Every buy and sell behind your returns, “invested this month” and the tax ledger. Holdings themselves are not changed here.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button kind="secondary" onClick={() => setMode({ kind: 'add' })}><Icon name="plus" />Add one</Button>
              <Button kind="secondary" onClick={() => fileInput.current?.click()}><Icon name="upload" />Import CSV</Button>
            </div>
            <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => pick(e.target.files)} />
            <div className="flex flex-wrap gap-x-5">
              <a href={templateUrl} download="psx-transactions-template.csv" onClick={() => haptic()} className={linkCls}>Download template</a>
              {exportUrl && <a href={exportUrl} download="psx-transactions.csv" onClick={() => haptic()} className={linkCls}>Export CSV</a>}
            </div>
            <ErrorNote error={error} />
            <TxnList txns={data.transactions} onPick={(t) => setMode({ kind: 'edit', txn: t })} />
          </>
        )}
        {(mode.kind === 'add' || mode.kind === 'edit') && (
          <TxnForm key={mode.kind === 'edit' ? mode.txn.id ?? 'edit' : 'add'} txn={mode.kind === 'edit' ? mode.txn : null}
            today={today} source={source} onBack={toList} onDone={done} />
        )}
        {mode.kind === 'import' && <ImportReview key={mode.at} review={mode} source={source} onBack={toList} onDone={done} />}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// The list, newest first, by month
// ---------------------------------------------------------------------------
function TxnList({ txns, onPick }: { txns: Txn[]; onPick: (t: Txn) => void }) {
  const months = useMemo(() => {
    // Input is oldest first (later entries of one day last): reverse, then a stable sort keeps newest first by day.
    const sorted = [...txns].reverse().sort((a, b) => b.executed_on.localeCompare(a.executed_on));
    const out: { key: string; rows: Txn[]; bought: number }[] = [];
    for (const t of sorted) {
      const key = t.executed_on.slice(0, 7);
      let m = out[out.length - 1];
      if (!m || m.key !== key) { m = { key, rows: [], bought: 0 }; out.push(m); }
      m.rows.push(t);
      if (t.side === 'buy') m.bought = r2(m.bought + t.amount);
    }
    return out;
  }, [txns]);

  if (!txns.length) return <Empty title="No transactions yet"><p>Record a buy from the Portfolio tab, or import a CSV.</p></Empty>;
  return (
    <div className="space-y-4">
      {months.map((m) => (
        <section key={m.key} className="space-y-1" aria-label={monthLabel(m.key)}>
          <div className="flex items-baseline justify-between gap-3 px-1">
            <h3 className="text-12 font-semibold uppercase tracking-wide text-muted">{monthLabel(m.key)}</h3>
            <span className="num text-12 text-muted">{m.bought > 0 ? `Bought ${rs(m.bought)}` : 'No buys'}</span>
          </div>
          <ul className="divide-y divide-line">
            {m.rows.map((t, i) => <TxnRow key={t.id ?? `${m.key}-${i}`} t={t} onPick={() => onPick(t)} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TxnRow({ t, onPick }: { t: Txn; onPick: () => void }) {
  const meta = [chargesLabel(t), SOURCE_LABEL[t.source]].filter((s): s is string => s != null).join(' · ');
  return (
    <li>
      <button type="button" onClick={() => { haptic(); onPick(); }} title="Tap to edit"
        className="press flex min-h-14 w-full cursor-pointer items-center gap-3 py-2 text-left active:opacity-60">
        <CompanyMark symbol={t.symbol} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2"><span className="font-semibold">{t.symbol}</span>{sideTag(t.side)}</span>
          <span className="num block text-14 text-muted">{t.shares} × {rs2(t.price)}</span>
          <span className="num block text-12 text-muted">{meta}</span>
        </span>
        <span className="num shrink-0 text-right">
          <span className="block font-semibold">{signedAmount(t)}</span>
          <span className="block text-12 text-muted">{day(t.executed_on)}</span>
        </span>
        <Icon name="chevron" className="h-4 w-4 shrink-0 text-muted" />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Add / edit one
// ---------------------------------------------------------------------------
function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <Button kind="ghost" label="Back to the list" onClick={onBack} className="-ml-3 px-3"><Icon name="chevron" className="h-5 w-5 rotate-180" /></Button>
      <h3 className="text-16 font-semibold">{title}</h3>
    </div>
  );
}

function TxnForm({ txn, today, source, onBack, onDone }: {
  txn: Txn | null; today: string; source: DataSource; onBack: () => void; onDone: (summary: string) => Promise<void>;
}) {
  const [symbol, setSymbol] = useState(txn?.symbol ?? '');
  const [side, setSide] = useState<Txn['side']>(txn?.side ?? 'buy');
  const [shares, setShares] = useState(txn ? String(txn.shares) : '');
  const [price, setPrice] = useState(txn ? String(txn.price) : '');
  const [date, setDate] = useState(txn?.executed_on ?? today);
  const [charges, setCharges] = useState(txn?.charges == null ? '' : String(txn.charges));
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);

  const sym = symbol.trim().toUpperCase();
  const qty = Number(shares.replace(/[,\s]/g, ''));
  const px = Number(price.replace(/[,\s]/g, ''));
  const chg = charges.trim() === '' ? null : Number(charges.replace(/[,\s]/g, ''));
  const valid = Number.isInteger(qty) && qty > 0 && px > 0;

  async function save() {
    if (!/^[A-Z0-9]{1,12}$/.test(sym)) return setError('Symbol should be letters/numbers like SYS or MEBL.');
    if (!Number.isInteger(qty) || qty <= 0) return setError('Shares must be a whole number above 0.');
    if (!(px > 0)) return setError('Price must be above 0.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Pick the trade date.');
    if (date > today) return setError('The date cannot be after today.');
    if (chg != null && !(chg >= 0)) return setError('Charges must be a number (leave blank to estimate).');
    setError(null);
    setBusy('save');
    try {
      const amount = r2(qty * px);
      if (txn) {
        if (!txn.id) throw new Error('This row has no id yet. Refresh and try again.');
        await source.updateTxn(txn.id, { side, shares: qty, price: px, amount, executed_on: date, charges: chg });
        await onDone(`${sym}: ${side} updated`);
      } else {
        await source.saveTxns([{ symbol: sym, side, shares: qty, price: px, amount, executed_on: date, source: 'manual', charges: chg }]);
        await onDone(`${sym}: ${side === 'buy' ? 'bought' : 'sold'} ${plural(qty, 'share')} recorded`);
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function del() {
    if (!txn?.id) return setError('This row has no id yet. Refresh and try again.');
    setBusy('delete');
    try {
      await source.deleteTxn(txn.id);
      await onDone(`${txn.symbol}: ${txn.side} of ${plural(txn.shares, 'share')} deleted`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <SubHeader title={txn ? `Edit ${txn.side} of ${txn.shares} ${txn.symbol}` : 'Add a buy or sell'} onBack={onBack} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Symbol" hint={txn ? 'Delete and add again to change it.' : undefined}>
          <input className={`${inputCls} uppercase disabled:opacity-60`} value={symbol} disabled={!!txn} autoCapitalize="characters" autoComplete="off" placeholder="e.g. MEBL" onChange={(e) => setSymbol(e.target.value)} />
        </Field>
        <Field label="Shares">
          <input className={`${inputCls} num`} inputMode="numeric" value={shares} onChange={(e) => setShares(e.target.value)} />
        </Field>
      </div>
      <div className="space-y-1">
        <span className="block text-14 font-medium">Side</span>
        <Segmented label="Side" value={side} onChange={setSide} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price per share (Rs)">
          <input className={`${inputCls} num`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Date">
          <input type="date" className={`${inputCls} px-2`} value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Charges (Rs)" hint="Optional. Blank = estimated from your broker settings in Profile.">
        <input className={`${inputCls} num`} inputMode="decimal" value={charges} placeholder="estimate" onChange={(e) => setCharges(e.target.value)} />
      </Field>
      {valid && (
        <p className="num rounded-control bg-surface-2 p-3 text-14 text-muted" role="status">
          {qty} × {rs2(px)} = {rs2(r2(qty * px))} before charges
        </p>
      )}
      <ErrorNote error={error} />
      <Button className="w-full" disabled={busy != null} onClick={save}>{busy === 'save' ? 'Saving…' : txn ? 'Save changes' : 'Save'}</Button>
      {txn && (confirm ? (
        <div role="alert" className="space-y-2 rounded-control bg-caution/10 p-3 text-14 text-ink">
          <p>Delete this {txn.side} of {txn.shares} {txn.symbol}? It leaves the history for good; your holdings are not changed.</p>
          <div className="flex gap-2">
            <Button kind="secondary" className="flex-1" disabled={busy != null} onClick={() => setConfirm(false)}>Keep it</Button>
            <Button kind="danger" className="flex-1" disabled={busy != null} onClick={del}>{busy === 'delete' ? 'Deleting…' : 'Yes, delete'}</Button>
          </div>
        </div>
      ) : (
        <Button kind="danger" className="w-full" disabled={busy != null} onClick={() => setConfirm(true)}><Icon name="trash" />Delete</Button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV import review
// ---------------------------------------------------------------------------
const MAX_ERRORS_SHOWN = 20;

function ImportReview({ review, source, onBack, onDone }: {
  review: ImportMode; source: DataSource; onBack: () => void; onDone: (summary: string) => Promise<void>;
}) {
  const { fresh, duplicates, errors, file } = review;
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(fresh.map((_, i) => i)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = fresh.filter((_, i) => ticked.has(i));
  const toggle = (i: number) => {
    haptic();
    setTicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  };

  async function importNow() {
    setBusy(true);
    try {
      await source.saveTxns(chosen);
      const parts = [`Imported ${plural(chosen.length, 'transaction')}`];
      if (duplicates > 0) parts.push(`${duplicates} already recorded, skipped`);
      if (errors.length) parts.push(`${plural(errors.length, 'row')} with problems left out`);
      await onDone(parts.join(' · '));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <SubHeader title="Import from CSV" onBack={onBack} />
      <p className="text-14 text-muted">
        <span className="font-medium text-ink">{file}</span>: {fresh.length ? `${plural(fresh.length, 'new row')} found. Untick any you do not want.`
          : duplicates > 0 || errors.length > 0 ? 'nothing new to import.' : 'no rows found in this file.'}
        {duplicates > 0 && ` ${duplicates} already recorded, skipped.`}
      </p>
      {fresh.length > 0 && (
        <ul className="divide-y divide-line">
          {fresh.map((t, i) => (
            <li key={i}>
              <label className="flex min-h-14 cursor-pointer items-center gap-3 py-2">
                <input type="checkbox" checked={ticked.has(i)} onChange={() => toggle(i)} disabled={busy}
                  aria-label={`Import ${t.side} of ${t.shares} ${t.symbol} on ${day(t.executed_on)}`}
                  className="h-5 w-5 shrink-0 rounded accent-brand" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><span className="font-semibold">{t.symbol}</span>{sideTag(t.side)}</span>
                  <span className="num block text-12 text-muted">{t.shares} × {rs2(t.price)} · {day(t.executed_on)} · {chargesLabel(t)}</span>
                </span>
                <span className="num shrink-0 font-semibold">{signedAmount(t)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <div role="status" className="space-y-1 rounded-control bg-caution/10 p-3 text-12 text-ink">
          <p className="font-semibold">{plural(errors.length, 'row')} skipped. Fix the file and import it again; nothing below is saved.</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {errors.slice(0, MAX_ERRORS_SHOWN).map((e, i) => <li key={i}>{e}</li>)}
            {errors.length > MAX_ERRORS_SHOWN && <li>and {errors.length - MAX_ERRORS_SHOWN} more</li>}
          </ul>
        </div>
      )}
      <ErrorNote error={error} />
      <div className="flex gap-2">
        <Button kind="secondary" className="flex-1" disabled={busy} onClick={onBack}>Back</Button>
        {fresh.length > 0 && (
          <Button className="flex-1" disabled={busy || !chosen.length} onClick={importNow}>{busy ? 'Saving…' : `Import ${chosen.length}`}</Button>
        )}
      </div>
    </div>
  );
}
