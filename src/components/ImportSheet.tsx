/**
 * Update the portfolio from broker screenshots: pick → AI reads → review what changes → apply.
 * The pictures are shrunk in the phone, read once by the AI and never stored.
 */
import { useMemo, useRef, useState } from 'react';
import { diffImport, type ImportChange, type ImportedRow } from '../../shared/changes.ts';
import type { Holding, PriceMap, Txn } from '../../shared/types.ts';
import { rs, rs2 } from '../../shared/format.ts';
import { pktDate } from '../../shared/time.ts';
import type { DataSource } from '../lib/data.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Button, ErrorNote, Tag, Toggle } from './ui.tsx';

const KIND = { new: { label: 'New', tone: 'green' }, changed: { label: 'Changed', tone: 'teal' }, missing: { label: 'Not in screenshots', tone: 'amber' }, same: { label: 'Same', tone: 'slate' } } as const;

export function ImportSheet({ open, onClose, source, holdings, prices, onApplied }: {
  open: boolean; onClose: () => void; source: DataSource; holdings: Holding[]; prices: PriceMap; onApplied: (summary: string) => void;
}) {
  const [step, setStep] = useState<'pick' | 'reading' | 'review' | 'saving'>('pick');
  const [rows, setRows] = useState<ImportedRow[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [recordTxns, setRecordTxns] = useState(holdings.length > 0); // first import = baseline, not new buys
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const changes = useMemo(() => diffImport(holdings, rows, pktDate(new Date()), prices, { removeMissing, recordTxns }), [holdings, rows, prices, removeMissing, recordTxns]);
  const actionable = changes.filter((c) => c.kind === 'new' || c.kind === 'changed' || (c.kind === 'missing' && removeMissing));

  const reset = () => { setStep('pick'); setRows([]); setDropped([]); setError(null); setRemoveMissing(false); setRecordTxns(holdings.length > 0); };
  const close = () => { reset(); onClose(); };

  async function read(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setStep('reading');
    try {
      const r = await source.readScreenshots([...files].slice(0, 4));
      setRows(r.holdings);
      setDropped(r.dropped);
      setStep('review');
    } catch (e) {
      setError((e as Error).message);
      setStep('pick');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  async function apply() {
    setStep('saving');
    try {
      for (const c of actionable) await source.saveHoldingChange(c.before, c.after, c.txn as Txn | null);
      const n = (k: ImportChange['kind']) => actionable.filter((c) => c.kind === k).length;
      onApplied(`Portfolio updated: ${n('new')} new, ${n('changed')} changed${removeMissing ? `, ${n('missing')} removed` : ''}.`);
      close();
    } catch (e) {
      setError((e as Error).message);
      setStep('review');
    }
  }

  return (
    <Sheet open={open} onClose={close} title="Update from screenshots">
      <div className="space-y-4 pb-2">
        {step === 'pick' && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Take screenshots of the <b>Portfolio</b> screen in JS InvestPro (scroll and take more if the list is long, up to 4).
              The AI reads symbol, quantity and average cost. You review every change before anything is saved. Screenshots are not stored.
            </p>
            <input ref={input} type="file" accept="image/*" multiple className="sr-only" id="shots" onChange={(e) => read(e.target.files)} />
            <label htmlFor="shots" className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-teal-500/60 bg-teal-50/50 text-teal-800 active:scale-[0.99] dark:bg-teal-950/30 dark:text-teal-300">
              <Icon name="camera" className="h-7 w-7" />
              <span className="font-semibold">Choose screenshots</span>
            </label>
            <ErrorNote error={error} />
          </>
        )}
        {step === 'reading' && (
          <div className="flex flex-col items-center gap-3 py-10" role="status">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
            <p className="text-sm text-slate-600 dark:text-slate-300">AI is reading your screenshots…</p>
          </div>
        )}
        {(step === 'review' || step === 'saving') && (
          <>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {changes.filter((c) => c.kind === 'new' || c.kind === 'changed' || (c.kind === 'missing' && removeMissing)).map((c) => (
                <li key={c.symbol} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-semibold">{c.symbol} <Tag tone={KIND[c.kind].tone}>{KIND[c.kind].label}</Tag></p>
                    <p className="num truncate text-xs text-slate-500 dark:text-slate-400">
                      {c.kind === 'new' && `${c.after!.shares} @ ${rs2(c.after!.avg_cost)}`}
                      {c.kind === 'changed' && `${c.before!.shares} → ${c.after!.shares} shares · avg ${rs2(c.before!.avg_cost)} → ${rs2(c.after!.avg_cost)}`}
                      {c.kind === 'missing' && (removeMissing ? 'Will be removed' : 'Kept as is')}
                    </p>
                  </div>
                  {c.txn && <span className={`num shrink-0 text-xs font-semibold ${c.txn.side === 'buy' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{c.txn.side === 'buy' ? 'Bought' : 'Sold'} {rs(c.txn.amount)}</span>}
                </li>
              ))}
              {!actionable.length && <li className="py-4 text-center text-sm text-slate-500">Nothing to change.</li>}
            </ul>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {[
                changes.some((c) => c.kind === 'same') && `${changes.filter((c) => c.kind === 'same').length} unchanged`,
                !removeMissing && changes.some((c) => c.kind === 'missing') && `${changes.filter((c) => c.kind === 'missing').length} not in the screenshots, kept (${changes.filter((c) => c.kind === 'missing').map((c) => c.symbol).join(', ')})`,
              ].filter(Boolean).join(' · ')}
            </p>
            {dropped.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">Couldn’t read {dropped.length} row{dropped.length > 1 ? 's' : ''}; add {dropped.length > 1 ? 'them' : 'it'} by hand if needed.</p>}
            {changes.some((c) => c.kind === 'missing') && (
              <div className="flex items-center justify-between gap-3"><span className="text-sm">Remove holdings not in the screenshots</span><Toggle checked={removeMissing} onChange={setRemoveMissing} label="Remove missing holdings" /></div>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">Count changes as buys/sells this month<span className="block text-xs text-slate-500 dark:text-slate-400">Turn off for a first import of what you already own.</span></span>
              <Toggle checked={recordTxns} onChange={setRecordTxns} label="Record transactions" />
            </div>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button kind="secondary" className="flex-1" onClick={reset}>Start over</Button>
              <Button className="flex-1" disabled={!actionable.length || step === 'saving'} onClick={apply}>{step === 'saving' ? 'Saving…' : `Apply ${actionable.length}`}</Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
