/**
 * Update the portfolio from broker screenshots: pick → AI reads → review every change against what is
 * saved → apply. The pictures are shrunk in the phone, read once by the AI and never stored.
 * Each change has its own tick, so a misread row or a stock that was merely off-screen is never applied.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeChange, diffImport, type ImportChange, type ImportedRow } from '../../shared/changes.ts';
import type { Holding, PriceMap } from '../../shared/types.ts';
import type { SectorMap } from '../../shared/portfolio.ts';
import { day, dayTime, rs } from '../../shared/format.ts';
import { pktDate } from '../../shared/time.ts';
import { screenShariah } from '../../shared/portfolio.ts';
import type { ScreenRow } from '../../shared/discover.ts';
import type { DataSource } from '../lib/data.ts';
import type { AiStatus } from '../lib/importer.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Button, Chip, ErrorNote, Toggle, inputCls } from './ui.tsx';

// Only a stock missing from the pictures needs care (it may just be off-screen); the rest are neutral labels.
const KIND = { new: { label: 'New', chip: 'neutral' }, changed: { label: 'Changed', chip: 'neutral' }, missing: { label: 'Not in screenshots', chip: 'caution' }, same: { label: 'Same', chip: 'neutral' } } as const;
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
    const rest = cooling.length ? ` · ${cooling.map((p) => `${name(p.name)} back ${dayTime(p.until)}`).join(', ')}` : '';
    return { tone: 'ok', text: `AI ready: ${ready.join(', ')}${rest}` };
  }
  if (cooling.length) return { tone: 'warn', text: `All AI readers are over their free limit. Try again after ${dayTime(st.retry_at ?? cooling[0].until)}.` };
  // A key the provider rejects: say what is visibly wrong with the stored value, so re-entering it fixes it.
  const PREFIX: Record<string, string> = { openrouter: 'sk-or-', gemini: 'AIza', groq: 'gsk_' };
  const why = (n: string) => {
    const k = st.keys?.[n];
    if (!k) return 'rejected';
    if (!k.clean) return 'contains a space, line break, quote or "=" (paste only the key)';
    if (!k.expected_prefix) return `does not start with ${PREFIX[n]} (wrong key pasted?)`;
    return `${k.length} characters, rejected by ${name(n)} (revoked or mistyped?)`;
  };
  if (badKey.length) return { tone: 'warn', text: `AI key problem: ${badKey.map((p) => `${name(p.name)} key ${why(p.name)}`).join(' · ')}. Re-enter it with: npx wrangler secret put ${badKey.map((p) => `${p.name.toUpperCase()}_API_KEY`).join(' / ')}` };
  if (failed.length) return { tone: 'warn', text: `AI check failed: ${failed.map((p) => `${name(p.name)}: ${p.detail ?? 'unknown'}`).join(' · ')}` };
  return null;
}

export function ImportSheet({ open, onClose, source, holdings, prices, sectors = {}, screen = [], onApplied }: {
  open: boolean; onClose: () => void; source: DataSource; holdings: Holding[]; prices: PriceMap; sectors?: SectorMap; screen?: ScreenRow[]; onApplied: (summary: string) => void;
}) {
  const [step, setStep] = useState<'pick' | 'reading' | 'review' | 'saving'>('pick');
  const [rows, setRows] = useState<ImportedRow[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [recordTxns, setRecordTxns] = useState(holdings.length > 0); // first import = baseline, not new buys
  const [tradeDate, setTradeDate] = useState(() => pktDate(new Date())); // screenshots carry no dates: the day of the trades, if not today
  const shariah = useMemo(() => screenShariah(screen), [screen]);
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

  const changes = useMemo(() => diffImport(holdings, rows, tradeDate || pktDate(new Date()), prices, { removeMissing: true, recordTxns, sectors, shariah }), [holdings, rows, prices, recordTxns, sectors, shariah, tradeDate]);
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
      const first = diffImport(holdings, r.holdings, tradeDate, prices, { removeMissing: true, recordTxns, sectors, shariah });
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
            <p className="text-14 text-muted">
              Take screenshots of the <b>Portfolio</b> screen in JS InvestPro (scroll and take more if the list is long, up to 4).
              The AI reads symbol, quantity and average cost and compares them with what is saved here: more shares, fewer shares,
              new stocks and ones that are gone. You tick every change before anything is saved. Screenshots are not stored.
            </p>
            <input ref={input} type="file" accept="image/*" multiple className="sr-only" id="shots" onChange={(e) => read(e.target.files)} />
            <label htmlFor="shots" className="press flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-brand/60 bg-brand/5 text-brand active:scale-[0.99]">
              <Icon name="camera" className="h-7 w-7" />
              <span className="font-semibold">Choose screenshots</span>
            </label>
            {line && (
              <p role="status" className={`flex items-start gap-2 text-12 ${line.tone === 'ok' ? 'text-muted' : 'text-caution'}`}>
                <Icon name={line.tone === 'ok' ? 'sparkles' : 'alert'} className="mt-0.5 h-3.5 w-3.5 shrink-0" />{line.text}
              </p>
            )}
            <ErrorNote error={error} />
            {error && detail && <p className="break-words px-1 font-mono text-12 text-muted">{detail}</p>}
          </>
        )}
        {step === 'reading' && (
          <div className="flex flex-col items-center gap-3 py-10" role="status" aria-busy="true">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            <p className="text-14 text-ink">AI is reading your screenshots…</p>
            <p className="text-12 text-muted">Up to a minute if the first AI is busy and another steps in.</p>
          </div>
        )}
        {(step === 'review' || step === 'saving') && (
          <>
            <p className="text-14 text-muted">Compared with your saved portfolio. Tick what to apply.</p>
            <ul className="divide-y divide-line">
              {shown.map((c) => {
                const on = ticked.has(c.symbol);
                return (
                  <li key={c.symbol}>
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 py-2">
                      <input type="checkbox" checked={on} onChange={() => toggle(c.symbol)} disabled={step === 'saving'}
                        aria-label={c.kind === 'missing' ? `${c.symbol}: sold all` : `Apply ${c.symbol}`}
                        className="h-5 w-5 shrink-0 rounded accent-brand" />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 font-semibold">{c.symbol} <Chip kind={KIND[c.kind].chip}>{KIND[c.kind].label}</Chip></p>
                        <p className="num text-12 text-muted">{describeChange(c, on)}</p>
                      </div>
                      {on && c.txn && (
                        <span className="num shrink-0 text-12 font-semibold text-ink">
                          {c.txn.side === 'buy' ? 'Bought' : 'Sold'} {rs(c.txn.amount)}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
              {!shown.length && <li className="py-4 text-center text-14 text-muted">Everything matches. Nothing to change.</li>}
            </ul>
            <p className="text-12 text-muted">
              {[
                unchanged > 0 && `${unchanged} unchanged`,
                shown.some((c) => c.kind === 'missing') && 'Tick a stock that is not in the pictures only if you sold all of it; leave it if it was just off-screen.',
              ].filter(Boolean).join(' · ')}
            </p>
            {dropped.length > 0 && <p className="text-12 text-caution">Couldn’t read {dropped.length} row{dropped.length > 1 ? 's' : ''}; add {dropped.length > 1 ? 'them' : 'it'} by hand if needed.</p>}
            <div className="flex items-center justify-between gap-3">
              <span className="text-14">Count changes as buys/sells<span className="block text-12 text-muted">Turn off for a first import of what you already own.</span></span>
              <Toggle checked={recordTxns} onChange={setRecordTxns} label="Record transactions" />
            </div>
            {recordTxns && actionable.some((c) => c.txn) && (
              <label className="flex items-center justify-between gap-3 text-14">
                <span>Trade date<span className="block text-12 text-muted">
                  Screenshots carry no dates. These buys and sells are dated {tradeDate ? day(tradeDate) : 'today'}; set the day you traded for returns and tax, or fix it later under Buys and sells.
                </span></span>
                <input type="date" aria-label="Trade date" value={tradeDate} max={pktDate(new Date())} onChange={(e) => setTradeDate(e.target.value)} className={`${inputCls} w-40 shrink-0 px-2`} />
              </label>
            )}
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
