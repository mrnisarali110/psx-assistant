import { useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { investedThisMonth } from '../../shared/changes.ts';
import { pktDate } from '../../shared/time.ts';
import { pct, rs, rs2, signedRs } from '../../shared/format.ts';
import { useHoldingActions } from '../components/HoldingActions.tsx';
import { HoldingRow } from '../components/Holding.tsx';
import { ImportSheet } from '../components/ImportSheet.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Empty, ErrorNote, Section, SymbolAvatar, changeTone, inputCls } from '../components/ui.tsx';
import { useLongPress } from '../lib/gestures.ts';

const HINT_KEY = 'psx-swipe-hint';

export function Portfolio(props: ScreenProps) {
  const { data, source, reload } = props;
  const acts = useHoldingActions(props);
  const toast = useToast();
  const { view } = acts;
  const [importing, setImporting] = useState(false);
  const [hint, setHint] = useState(() => { try { return !localStorage.getItem(HINT_KEY); } catch { return false; } });
  const invested = investedThisMonth(data.transactions, pktDate(new Date()));
  const budget = data.settings.monthly_budget_pkr;

  return (
    <>
      <header className="flex items-center justify-between pt-1">
        <h1 className="text-2xl font-bold tracking-tight">Portfolio</h1>
        <div className="flex gap-1">
          <Button kind="ghost" label="Update from screenshots" onClick={() => setImporting(true)}><Icon name="camera" /></Button>
          <Button kind="ghost" label="Add a holding" onClick={acts.add}><Icon name="plus" /></Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <p className="text-xs text-slate-500 dark:text-slate-400">Value</p>
          <p className="num text-xl font-bold">{rs(view.total_value)}</p>
          <p className={`num text-xs font-semibold ${changeTone(view.total_pnl)}`}>{signedRs(view.total_pnl)} ({pct(view.total_pnl_pct)})</p>
        </Card>
        <Card>
          <p className="text-xs text-slate-500 dark:text-slate-400">Invested this month</p>
          <p className="num text-xl font-bold">{rs(invested)}</p>
          <p className="num text-xs text-slate-500 dark:text-slate-400">of {rs(budget)} · {rs(Math.max(0, budget - invested))} left</p>
        </Card>
      </div>

      {hint && view.rows.length > 0 && (
        <p className="flex items-center gap-2 rounded-2xl bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          <Icon name="info" className="h-4 w-4 shrink-0" />
          Swipe a stock left to edit or remove, right to record a buy. Long-press for more.
          <button type="button" className="-my-2 ml-auto min-h-11 min-w-11 cursor-pointer font-semibold" onClick={() => { setHint(false); try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ } }}>OK</button>
        </p>
      )}

      {view.rows.length === 0 ? (
        <Empty title="No holdings yet">
          <p>Update from a JS InvestPro screenshot, or add them one by one.</p>
          <div className="mt-3 flex justify-center gap-2">
            <Button onClick={() => setImporting(true)}><Icon name="camera" />From screenshots</Button>
            <Button kind="secondary" onClick={acts.add}><Icon name="plus" />Add</Button>
          </div>
        </Empty>
      ) : (
        <ul className="space-y-2">
          {view.rows.map((r) => (
            <HoldingRow key={r.holding.id ?? r.holding.symbol} row={r} call={acts.callFor(r)} actions={{
              onOpen: () => acts.open(r.holding.symbol), onMenu: () => acts.menu(r.holding.symbol),
              onEdit: () => acts.edit(r.holding), onBuy: () => acts.buy(r.holding.symbol), onRemove: () => acts.remove(r.holding),
            }} />
          ))}
        </ul>
      )}
      {view.missing_prices.length > 0 && <p className="px-1 text-xs text-amber-700 dark:text-amber-400">No price yet for {view.missing_prices.join(', ')}. It appears after the next market check.</p>}

      <Watchlist {...props} onOpen={acts.open} onMenu={acts.menu} />

      {acts.ui}
      <ImportSheet open={importing} onClose={() => setImporting(false)} source={source} holdings={data.holdings} prices={data.prices}
        onApplied={async (summary) => { await reload(); toast(summary); }} />
    </>
  );
}

function Watchlist({ data, source, reload, onOpen, onMenu }: ScreenProps & { onOpen: (s: string) => void; onMenu: (s: string) => void }) {
  const [symbol, setSymbol] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function add() {
    const s = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(s)) return setError('Enter a PSX symbol like MARI.');
    try {
      await source.addWatch(s);
      setSymbol('');
      setError(null);
      await reload();
    } catch (e) {
      setError((e as Error).message.includes('duplicate') ? `${s} is already on your watchlist.` : (e as Error).message);
    }
  }
  return (
    <Section title="Watchlist">
      <ul className="space-y-2">
        {data.watchlist.map((w) => <WatchRow key={w.id ?? w.symbol} symbol={w.symbol} p={data.prices[w.symbol]} onOpen={() => onOpen(w.symbol)} onMenu={() => onMenu(w.symbol)} />)}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className={`${inputCls} uppercase`} placeholder="Add symbol, e.g. MARI" value={symbol} autoCapitalize="characters" onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol to watch" />
        <Button type="submit" kind="secondary">Watch</Button>
      </form>
      <ErrorNote error={error} />
    </Section>
  );
}

function WatchRow({ symbol, p, onOpen, onMenu }: { symbol: string; p: ScreenProps['data']['prices'][string] | undefined; onOpen: () => void; onMenu: () => void }) {
  const press = useLongPress(onMenu);
  return (
    <li>
      <button type="button" {...press.handlers} onClick={() => { if (!press.consumed()) onOpen(); }}
        className="no-callout flex w-full cursor-pointer items-center gap-3 rounded-3xl bg-white px-4 py-3 text-left ring-1 ring-slate-200/80 active:scale-[0.99] dark:bg-slate-900 dark:ring-slate-800">
        <SymbolAvatar symbol={symbol} change={p?.change_pct} size="h-10 w-10" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{symbol}</span>
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
            {p ? `Yield ${p.dividend_yield_pct == null ? 'n/a' : `${p.dividend_yield_pct.toFixed(1)}%`} · P/E ${p.pe == null ? 'n/a' : p.pe.toFixed(1)}` : 'Price after the next market check'}
          </span>
        </span>
        <span className="num text-right">
          <span className="block text-sm font-semibold">{rs2(p?.price)}</span>
          <span className={`block text-xs ${changeTone(p?.change_pct)}`}>{pct(p?.change_pct, 2)}</span>
        </span>
      </button>
    </li>
  );
}
