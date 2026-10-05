import { useState, type FormEvent } from 'react';
import type { ScreenProps } from '../App.tsx';
import { buildPortfolio, type HoldingView } from '../../shared/portfolio.ts';
import { titleCase } from '../../shared/allocate.ts';
import { isStale } from '../../shared/time.ts';
import { DEFAULT_RULES, type Holding, type HoldingStatus } from '../../shared/types.ts';
import { asOfLabel, pct, rs, rs2, signedRs } from '../../shared/format.ts';
import { AsOf, Button, Card, ErrorNote, Field, Section, Tag, changeTone, inputCls } from '../components/ui.tsx';
import { latestAsOf } from './Today.tsx';

const STATUS_LABEL: Record<HoldingStatus, string> = { core: 'Core', hold_no_add: 'Hold, no add', review: 'Review' };
const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;

export function Portfolio({ data, source, reload }: ScreenProps) {
  const view = buildPortfolio(data.holdings, data.prices, data.settings);
  const [editing, setEditing] = useState<Holding | 'new' | null>(null);
  const asOf = latestAsOf(data);
  const stale = isStale(asOf, new Date(), DEFAULT_RULES.data.stale_minutes, DEFAULT_RULES.market_hours_pkt);

  return (
    <>
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Portfolio</h1>
        <Button kind="ghost" onClick={() => setEditing('new')}>+ Add</Button>
      </header>

      <Card>
        <p className="text-sm text-slate-500 dark:text-slate-400">Total value</p>
        <p className="num text-3xl font-bold">{rs(view.total_value)}</p>
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm">
          <span className={`num font-semibold ${changeTone(view.total_pnl)}`}>{signedRs(view.total_pnl)} ({pct(view.total_pnl_pct)})</span>
          {view.day_change != null && <span className={`num ${changeTone(view.day_change)}`}>{signedRs(view.day_change)} today</span>}
          <span className="num text-slate-500 dark:text-slate-400">cost {rs(view.total_cost)}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {view.sector_weights.map((s) => (
            <Tag key={s.sector} tone={view.sectors_over_limit.includes(s.sector) ? 'amber' : 'slate'}>{titleCase(s.sector)} {s.pct.toFixed(0)}%</Tag>
          ))}
        </div>
        <div className="mt-2"><AsOf label={asOfLabel(asOf)} stale={stale} /></div>
      </Card>

      {editing && (
        <HoldingForm initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSave={async (h) => { await source.saveHolding(h); await reload(); setEditing(null); }}
          onDelete={editing !== 'new' && editing.id ? async () => { await source.deleteHolding(editing.id!); await reload(); setEditing(null); } : undefined} />
      )}

      <div className="space-y-3">
        {view.rows.map((r) => <HoldingCard key={r.holding.id ?? r.holding.symbol} r={r} cap={data.settings.max_position_pct} onEdit={() => setEditing(r.holding)} />)}
        {!view.rows.length && <Card><p className="text-sm text-slate-500">No holdings yet. Tap “+ Add” and enter shares and average cost from your broker app.</p></Card>}
      </div>

      <Watchlist {...{ data, source, reload }} />
    </>
  );
}

function HoldingCard({ r, cap, onEdit }: { r: HoldingView; cap: number; onEdit: () => void }) {
  const h = r.holding;
  return (
    <button onClick={onEdit} className="block w-full text-left">
      <Card>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-lg font-bold">{h.symbol}</span>
              <Tag tone={h.status === 'core' ? 'teal' : h.status === 'review' ? 'amber' : 'slate'}>{STATUS_LABEL[h.status]}</Tag>
              {h.is_shariah && <Tag tone="green">Shariah</Tag>}
            </div>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{r.price?.name ?? titleCase(r.sector)}</p>
          </div>
          <div className="text-right">
            <p className="num text-lg font-semibold">{rs2(r.price?.price)}</p>
            <p className={`num text-xs font-medium ${changeTone(r.price?.change_pct)}`}>{pct(r.price?.change_pct, 2)}</p>
          </div>
        </div>
        <div className="num mt-3 grid grid-cols-3 gap-2 text-sm">
          <div><p className="text-xs text-slate-500 dark:text-slate-400">Value</p><p className="font-semibold">{rs(r.value)}</p></div>
          <div><p className="text-xs text-slate-500 dark:text-slate-400">Profit / loss</p><p className={`font-semibold ${changeTone(r.pnl)}`}>{signedRs(r.pnl)}<span className="block text-xs">{pct(r.pnl_pct)}</span></p></div>
          <div><p className="text-xs text-slate-500 dark:text-slate-400">Weight</p><p className={`font-semibold ${r.flags.over_cap ? 'text-amber-600 dark:text-amber-400' : ''}`}>{r.weight_pct == null ? 'no data' : `${r.weight_pct.toFixed(1)}%`}</p></div>
        </div>
        <p className="num mt-2 text-xs text-slate-500 dark:text-slate-400">{h.shares} shares @ avg Rs {h.avg_cost.toFixed(2)}</p>
        {(r.flags.over_cap || r.flags.below_cost || r.flags.big_move) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {r.flags.over_cap && <Tag tone="amber">Over {cap}% cap: no new buys</Tag>}
            {r.flags.below_cost && <Tag tone="red">Below cost {pct(r.pnl_pct)}</Tag>}
            {r.flags.big_move && <Tag tone="slate">Big move today</Tag>}
          </div>
        )}
      </Card>
    </button>
  );
}

function HoldingForm({ initial, onSave, onDelete, onClose }: {
  initial: Holding | null; onSave: (h: Holding) => Promise<void>; onDelete?: () => Promise<void>; onClose: () => void;
}) {
  const [f, setF] = useState({
    symbol: initial?.symbol ?? '', shares: initial ? String(initial.shares) : '', avg_cost: initial ? String(initial.avg_cost) : '',
    status: initial?.status ?? 'core' as HoldingStatus, sector: initial?.sector ?? '', is_shariah: initial?.is_shariah ?? false, note: initial?.note ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const symbol = f.symbol.trim().toUpperCase();
    const shares = Number(f.shares);
    const avg = Number(f.avg_cost);
    if (!SYMBOL_RE.test(symbol)) return setError('Symbol should be letters/numbers like SYS or MEBL.');
    if (!Number.isInteger(shares) || shares <= 0) return setError('Shares must be a whole number above 0.');
    if (!(avg >= 0)) return setError('Average cost must be a number.');
    setBusy(true);
    try {
      await onSave({ ...(initial ?? {}), symbol, shares, avg_cost: avg, status: f.status, sector: f.sector.trim() || null, is_shariah: f.is_shariah, note: f.note.trim() || null } as Holding);
    } catch (err) {
      setError((err as Error).message.includes('duplicate') ? `${symbol} is already in your portfolio. Edit that card instead.` : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card className="ring-2 ring-teal-600">
      <form onSubmit={submit} className="space-y-3">
        <h2 className="font-semibold">{initial ? `Edit ${initial.symbol}` : 'Add a holding'}</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Symbol"><input className={`${inputCls} uppercase`} value={f.symbol} disabled={!!initial} autoCapitalize="characters" onChange={(e) => setF({ ...f, symbol: e.target.value })} /></Field>
          <Field label="Status">
            <select className={inputCls} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as HoldingStatus })}>
              <option value="core">Core</option><option value="hold_no_add">Hold, no add</option><option value="review">Review</option>
            </select>
          </Field>
          <Field label="Shares"><input className={inputCls} inputMode="numeric" value={f.shares} onChange={(e) => setF({ ...f, shares: e.target.value })} /></Field>
          <Field label="Average cost (Rs)"><input className={inputCls} inputMode="decimal" value={f.avg_cost} onChange={(e) => setF({ ...f, avg_cost: e.target.value })} /></Field>
        </div>
        <Field label="Sector" hint="Optional. PSX’s own sector is used when available.">
          <input className={inputCls} value={f.sector} onChange={(e) => setF({ ...f, sector: e.target.value })} />
        </Field>
        <Field label="Note"><input className={inputCls} value={f.note} maxLength={200} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-teal-700" checked={f.is_shariah} onChange={(e) => setF({ ...f, is_shariah: e.target.checked })} /> Shariah compliant
        </label>
        <ErrorNote error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>Save</Button>
          <Button kind="secondary" onClick={onClose}>Cancel</Button>
          {onDelete && <Button kind="danger" className="ml-auto" onClick={() => { if (confirm(`Remove ${initial?.symbol} from your portfolio?`)) onDelete(); }}>Delete</Button>}
        </div>
      </form>
    </Card>
  );
}

function Watchlist({ data, source, reload }: Pick<ScreenProps, 'data' | 'source' | 'reload'>) {
  const [symbol, setSymbol] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    const s = symbol.trim().toUpperCase();
    if (!SYMBOL_RE.test(s)) return setError('Enter a PSX symbol like MARI.');
    try {
      await source.addWatch(s);
      setSymbol('');
      setError(null);
      await reload();
    } catch (err) {
      setError((err as Error).message.includes('duplicate') ? `${s} is already on your watchlist.` : (err as Error).message);
    }
  }
  return (
    <Section title="Watchlist">
      <Card className="space-y-3">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.watchlist.map((w) => {
            const p = data.prices[w.symbol];
            return (
              <li key={w.id ?? w.symbol} className="flex items-center justify-between gap-2 py-2">
                <div>
                  <span className="font-semibold">{w.symbol}</span>
                  {p?.is_shariah && <span className="ml-2"><Tag tone="green">Shariah</Tag></span>}
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {p ? `Yield ${p.dividend_yield_pct == null ? 'n/a' : p.dividend_yield_pct.toFixed(1) + '%'} · 52w high ${rs2(p.high_52w)}` : 'Price after next refresh'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="num text-sm font-semibold">{rs2(p?.price)}</p>
                    <p className={`num text-xs ${changeTone(p?.change_pct)}`}>{pct(p?.change_pct, 2)}</p>
                  </div>
                  {w.id && <button aria-label={`Remove ${w.symbol}`} className="rounded-lg px-2 py-1 text-slate-400 hover:text-rose-600" onClick={async () => { await source.deleteWatch(w.id!); await reload(); }}>✕</button>}
                </div>
              </li>
            );
          })}
        </ul>
        <form onSubmit={add} className="flex gap-2">
          <input className={`${inputCls} uppercase`} placeholder="Add symbol" value={symbol} autoCapitalize="characters" onChange={(e) => setSymbol(e.target.value)} />
          <Button type="submit" kind="secondary">Add</Button>
        </form>
        <ErrorNote error={error} />
      </Card>
    </Section>
  );
}
