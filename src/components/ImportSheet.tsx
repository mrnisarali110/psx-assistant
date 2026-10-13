/**
 * Update the portfolio from broker screenshots: pick → AI reads → review every change against what is
 * saved → apply. The pictures are shrunk in the phone, read once by the AI and never stored.
 * Each change has its own tick, so a misread row or a stock that was merely off-screen is never applied.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeChange, diffImport, type ImportChange, type ImportedRow } from '../../shared/changes.ts';
import type { Holding, PriceMap } from '../../shared/types.ts';
import { asOfLabel, rs } from '../../shared/format.ts';
import { pktDate } from '../../shared/time.ts';
import type { DataSource } from '../lib/data.ts';
import type { AiStatus } from '../lib/importer.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Button, ErrorNote, Tag, Toggle } from './ui.tsx';

const KIND = { new: { label: 'New', tone: 'green' }, changed: { label: 'Changed', tone: 'teal' }, missing: { label: 'Not in screenshots', tone: 'amber' }, same: { label: 'Same', tone: 'slate' } } as const;
const PROVIDER: Record<string, string> = { openrouter: 'OpenRouter', gemini: 'Gemini', groq: 'Groq' };

/** A one-line verdict on who can read screenshots right now. */
export function aiStatusLine(st: AiStatus): { tone: 'ok' | 'warn'; text: string } | null {
  const vision = st.providers.filter((p) => st.vision.includes(p.name));
  if (!vision.length) return null;
  const name = (n: string) => PROVIDER[n] ?? n;
  const ready = vision.filter((p) => p.state === 'ready').map((p) => name(p.name));
  const cooling = vision.filter((p) => p.state === 'cooling');
  const badKey = vision.filter((p) => p.state === 'bad_key');
  const failed = vision.filter((p) => p.state === 'error');
  if (ready.length) {
    const rest = cooling.length ? ` · ${cooling.map((p) => `${name(p.name)} back ${asOfLabel(p.until)}`).join(', ')}` : '';
    return { tone: 'ok', text: `AI ready: ${ready.join(', ')}${rest}` };
  }
  if (cooling.length) return { tone: 'warn', text: `All AI readers are over their free limit. Try again after ${asOfLabel(st.retry_at ?? cooling[0].until)}.` };
  if (badKey.length) return { tone: 'warn', text: `AI key problem (${badKey.map((p) => name(p.name)).join(', ')}). Reading may fail.` };
  if (failed.length) return { tone: 'warn', text: `AI check failed: ${failed.map((p) => `${name(p.name)}: ${p.detail ?? 'unknown'}`).join(' · ')}` };
  return null;
}

export function ImportSheet({ open, onClose, source, holdings, prices, onApplied }: {
  open: boolean; onClose: () => void; source: DataSource; holdings: Holding[]; prices: PriceMap; onApplied: (summary: string) => void;
}) {
  const [step, setStep] = useState<'pick' | 'reading' | 'review' | 'saving'>('pick');
  const [rows, setRows] = useState<ImportedRow[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [recordTxns, setRecordTxns] = useState(holdings.length > 0); // first import = baseline, not new buys
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null); // which provider failed how, from the server
  const [status, setStatus] = useState<AiStatus | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // A free check (no AI tokens) each time the sheet opens: shows who will read the pictures, or when to come back.
  useEffect(() => {
    if (!open || source.kind !== 'live') return;
    let on = true;
    source.aiStatus().then((s) => on && setStatus(s)).catch(() => on && setStatus(null));
    return () => { on = false; };
  }, [open, source]);

  const changes = useMemo(() => diffImport(holdings, rows, pktDate(new Date()), prices, { removeMissing: true, recordTxns }), [holdings, rows, prices, recordTxns]);
  const shown = changes.filter((c) => c.kind !== 'same');
  const actionable = shown.filter((c) => ticked.has(c.symbol));
  const unchanged = changes.length - shown.length;

  const reset = () => { setStep('pick'); setRows([]); setDropped([]); setError(null); setDetail(null); setTicked(new Set()); setRecordTxns(holdings.length > 0); };
  const close = () => { reset(); onClose(); };
  const toggle = (symbol: string) => setTicked((t) => { const n = new Set(t); if (n.has(symbol)) n.delete(symbol); else n.add(symbol); return n; });

  async function read(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setDetail(null);
    setStep('reading');
    try {
      const r = await source.readScreenshots([...files].slice(0, 4), holdings.map((h) => h.symbol));
      setRows(r.holdings);
      setDropped(r.dropped);
      // New and changed rows start ticked; a holding missing from the pictures is kept unless you say it was sold.
      const first = diffImport(holdings, r.holdings, pktDate(new Date()), prices, { removeMissing: true, recordTxns });
      setTicked(new Set(first.filter((c) => c.kind === 'new' || c.kind === 'changed').map((c) => c.symbol)));
      setStep('review');
    } catch (e) {
      setError((e as Error).message);
      setDetail((e as { detail?: string | null }).detail ?? null);
      setStep('pick');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  async function apply() {
    setStep('saving');
    try {
      for (const c of actionable) await source.saveHoldingChange(c.before, c.after, c.txn);
      const n = (k: ImportChange['kind']) => actionable.filter((c) => c.kind === k).length;
      onApplied(`Portfolio updated: ${n('new')} new, ${n('changed')} changed, ${n('missing')} sold.`);
      close();
    } catch (e) {
      setError((e as Error).message);
      setStep('review');
    }
  }

  const line = status ? aiStatusLine(status) : null;

  return (
    <Sheet open={open} onClose={close} title="Update from screenshots">
      <div className="space-y-4 pb-2">
        {step === 'pick' && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Take screenshots of the <b>Portfolio</b> screen in JS InvestPro (scroll and take more if the list is long, up to 4).
              The AI reads symbol, quantity and average cost and compares them with what is saved here: more shares, fewer shares,
              new stocks and ones that are gone. You tick every change before anything is saved. Screenshots are not stored.
            </p>
            <input ref={input} type="file" accept="image/*" multiple className="sr-only" id="shots" onChange={(e) => read(e.target.files)} />
            <label htmlFor="shots" className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-teal-500/60 bg-teal-50/50 text-teal-800 active:scale-[0.99] dark:bg-teal-950/30 dark:text-teal-300">
              <Icon name="camera" className="h-7 w-7" />
              <span className="font-semibold">Choose screenshots</span>
            </label>
            {line && (
              <p role="status" className={`flex items-start gap-2 text-xs ${line.tone === 'ok' ? 'text-slate-500 dark:text-slate-400' : 'text-amber-700 dark:text-amber-400'}`}>
                <Icon name={line.tone === 'ok' ? 'sparkles' : 'alert'} className="mt-0.5 h-3.5 w-3.5 shrink-0" />{line.text}
              </p>
            )}
            <ErrorNote error={error} />
            {error && detail && <p className="break-words px-1 font-mono text-[11px] leading-snug text-slate-500 dark:text-slate-400">{detail}</p>}
          </>
        )}
        {step === 'reading' && (
          <div className="flex flex-col items-center gap-3 py-10" role="status" aria-busy="true">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
            <p className="text-sm text-slate-600 dark:text-slate-300">AI is reading your screenshots…</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">Up to a minute if the first AI is busy and another steps in.</p>
          </div>
        )}
        {(step === 'review' || step === 'saving') && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">Compared with your saved portfolio. Tick what to apply.</p>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {shown.map((c) => {
                const on = ticked.has(c.symbol);
                return (
                  <li key={c.symbol}>
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 py-2">
                      <input type="checkbox" checked={on} onChange={() => toggle(c.symbol)} disabled={step === 'saving'}
                        aria-label={c.kind === 'missing' ? `${c.symbol}: sold all` : `Apply ${c.symbol}`}
                        className="h-5 w-5 shrink-0 rounded accent-teal-600" />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 font-semibold">{c.symbol} <Tag tone={KIND[c.kind].tone}>{KIND[c.kind].label}</Tag></p>
                        <p className="num text-xs text-slate-500 dark:text-slate-400">{describeChange(c, on)}</p>
                      </div>
                      {on && c.txn && (
                        <span className={`num shrink-0 text-xs font-semibold ${c.txn.side === 'buy' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          {c.txn.side === 'buy' ? 'Bought' : 'Sold'} {rs(c.txn.amount)}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
              {!shown.length && <li className="py-4 text-center text-sm text-slate-500">Everything matches. Nothing to change.</li>}
            </ul>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {[
                unchanged > 0 && `${unchanged} unchanged`,
                shown.some((c) => c.kind === 'missing') && 'Tick a stock that is not in the pictures only if you sold all of it; leave it if it was just off-screen.',
              ].filter(Boolean).join(' · ')}
            </p>
            {dropped.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">Couldn’t read {dropped.length} row{dropped.length > 1 ? 's' : ''}; add {dropped.length > 1 ? 'them' : 'it'} by hand if needed.</p>}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">Count changes as buys/sells this month<span className="block text-xs text-slate-500 dark:text-slate-400">Turn off for a first import of what you already own.</span></span>
              <Toggle checked={recordTxns} onChange={setRecordTxns} label="Record transactions" />
            </div>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button kind="secondary" className="flex-1" onClick={reset}>Start over</Button>
              <Button className="flex-1" disabled={!actionable.length || step === 'saving'} onClick={apply}>
                {step === 'saving' ? 'Saving…' : `Apply ${actionable.length} change${actionable.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
