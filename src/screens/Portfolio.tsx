import { useEffect, useMemo, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { investedThisMonth } from '../../shared/changes.ts';
import { headlineReturn } from '../../shared/performance.ts';
import type { BcState } from '../../shared/bluechip.ts';
import { BcBadge } from '../components/BcBadge.tsx';
import { pktDate } from '../../shared/time.ts';
import { rs, rs2 } from '../../shared/format.ts';
import { missingNum } from '../../shared/quality.ts';
import type { PeFigure } from '../../shared/valuation.ts';
import { screenSectors } from '../../shared/portfolio.ts';
import { exLabel, normaliseWatchSymbol } from '../../shared/symbols.ts';
import { openStock } from '../lib/nav.ts';
import { useHoldingActions } from '../components/HoldingActions.tsx';
import { HoldingRow } from '../components/Holding.tsx';
import { ImportSheet } from '../components/ImportSheet.tsx';
import { AllocationTab } from '../components/Allocation.tsx';
import { PerformanceTab } from '../components/PerformanceTab.tsx';
import { TaxTab } from '../components/TaxTab.tsx';
import { TransactionsSheet } from '../components/Transactions.tsx';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { Button, Card, Change, Chip, CompanyMark, Empty, ErrorNote, Section, Segmented, inputCls } from '../components/ui.tsx';
import { haptic, useLongPress, useSwipeTabs } from '../lib/gestures.ts';

const HINT_KEY = 'psx-swipe-hint';
type Tab = 'holdings' | 'allocation' | 'performance' | 'tax';
const TABS: { value: Tab; label: string }[] = [
  { value: 'holdings', label: 'Holdings' }, { value: 'allocation', label: 'Allocation' }, { value: 'performance', label: 'Performance' }, { value: 'tax', label: 'Tax' },
];
/** `#/portfolio?tab=performance` opens straight on a tab (Home's portfolio card and the Tax tab use it). */
const tabFromHash = (): Tab => {
  const t = new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab');
  return TABS.some((x) => x.value === t) ? (t as Tab) : 'holdings';
};

export function Portfolio(props: ScreenProps) {
  const { data, source, reload } = props;
  const acts = useHoldingActions(props);
  const toast = useToast();
  const { view } = acts;
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [importing, setImporting] = useState(false);
  const [txns, setTxns] = useState(false);
  const [hint, setHint] = useState(() => { try { return !localStorage.getItem(HINT_KEY); } catch { return false; } });
  const invested = investedThisMonth(data.transactions, pktDate(new Date()));
  const budget = data.settings.monthly_budget_pkr;
  const hr = headlineReturn(view, data.receipts); // the same figure as Home
  const swipe = useSwipeTabs(TABS.length, TABS.findIndex((t) => t.value === tab), (i) => setTab(TABS[i].value));
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      <header className="flex items-center justify-between">
        <h1 className="text-20 font-bold tracking-tight">Portfolio</h1>
        <div className="flex gap-1">
          <Button kind="ghost" label="Plan a sale" onClick={() => acts.planSale()}><Icon name="tag" /></Button>
          <Button kind="ghost" label="Update from screenshots" onClick={() => setImporting(true)}><Icon name="camera" /></Button>
          <Button kind="ghost" label="Add a holding" onClick={acts.add}><Icon name="plus" /></Button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:gap-4">
        <Card className="lg:p-5">
          <p className="text-12 text-muted">Value</p>
          <p className="num text-20 font-bold lg:text-28">{rs(view.total_value)}</p>
          <p className="text-12 font-semibold">
            <Change value={hr.total} kind="rs" label="total return" /> <Change value={hr.pct} label="total return" /> <span className="font-normal text-muted">total</span>
          </p>
          {hr.dividends > 0 && <p className="num text-12 text-muted">incl. {rs(hr.dividends)} dividends</p>}
        </Card>
        <Card className="lg:p-5">
          <p className="text-12 text-muted">Invested this month</p>
          <p className="num text-20 font-bold lg:text-28">{rs(invested)}</p>
          <p className="num text-12 text-muted">of {rs(budget)} · {rs(Math.max(0, budget - invested))} left</p>
        </Card>
      </div>

      <div className="lg:max-w-2xl"><Segmented label="Portfolio view" value={tab} onChange={setTab} options={TABS} /></div>

      <div {...swipe} className="touch-pan-y space-y-4">
        {tab === 'holdings' && (
          <>
            {hint && view.rows.length > 0 && (
              <p className="flex items-center gap-2 rounded-control bg-surface-2 px-3 py-2 text-12 text-muted">
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
              <ul className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0 lg:[&>li>div]:h-full lg:[&>li>div>button]:h-full">
                {view.rows.map((r) => (
                  <HoldingRow key={r.holding.id ?? r.holding.symbol} row={r} call={acts.callFor(r)} bc={data.bluechip[r.holding.symbol]} actions={{
                    onOpen: () => openStock(r.holding.symbol), onMenu: () => acts.menu(r.holding.symbol),
                    onEdit: () => acts.edit(r.holding), onBuy: () => acts.buy(r.holding.symbol), onRemove: () => acts.remove(r.holding),
                  }} />
                ))}
              </ul>
            )}
            {view.missing_prices.length > 0 && <p className="px-1 text-12 text-caution">No price yet for {view.missing_prices.join(', ')}. It appears after the next market check.</p>}
            <button type="button" onClick={() => { haptic(); setTxns(true); }}
              className="press flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-card bg-surface px-4 py-2 text-left text-14 ring-1 ring-line active:scale-[0.99] lg:max-w-[calc(50%-0.375rem)]">
              <span className="flex h-9 w-9 items-center justify-center rounded-control bg-surface-2 text-muted"><Icon name="list" className="h-[18px] w-[18px]" /></span>
              <span className="flex-1"><span className="block font-medium">Buys and sells</span><span className="block text-12 text-muted">{data.transactions.length} recorded · edit, add or import a CSV</span></span>
              <Icon name="chevron" className="h-4 w-4 text-muted" />
            </button>
            <Watchlist {...props} pe={acts.pe} onMenu={acts.menu} />
          </>
        )}
        {tab === 'allocation' && <AllocationTab view={view} maxPositionPct={data.settings.max_position_pct} onOpenStock={openStock} bc={data.bluechip} />}
        {tab === 'performance' && <PerformanceTab data={data} view={view} source={source} reload={reload} onTransactions={() => setTxns(true)} />}
        {tab === 'tax' && <TaxTab data={data} onPlanSale={() => acts.planSale()} onTransactions={() => setTxns(true)} />}
      </div>

      {acts.ui}
      <ImportSheet open={importing} onClose={() => setImporting(false)} source={source} holdings={data.holdings} prices={data.prices} sectors={acts.sectors} screen={data.screen}
        onApplied={async (summary) => { await reload(); toast(summary); }} />
      <TransactionsSheet open={txns} onClose={() => setTxns(false)} data={data} source={source} reload={reload} />
    </>
  );
}

/**
 * Typing distance between two short symbols: letters added, dropped or changed, and two neighbours swapped count one
 * each, so "MARII", "OGD" and "LUKC" are all one away from MARI, OGDC and LUCK.
 */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * The known PSX symbol closest to what was typed (a prefix either way, else at most 2 typing slips away), or null.
 * Ties go to a symbol with the same first letter (people rarely mistype the first one), then alphabetical.
 */
function closestSymbol(typed: string, known: Iterable<string>): string | null {
  let best: { s: string; d: number } | null = null;
  for (const s of known) {
    const d = (s.startsWith(typed) || typed.startsWith(s) ? Math.abs(s.length - typed.length) * 0.5 : editDistance(typed, s)) + (s[0] === typed[0] ? 0 : 0.25);
    if (d <= 2.25 && (!best || d < best.d || (d === best.d && s < best.s))) best = { s, d };
  }
  return best?.s ?? null;
}

function Watchlist({ data, source, reload, pe, onMenu }: ScreenProps & { pe: Record<string, PeFigure>; onMenu: (s: string) => void }) {
  const [symbol, setSymbol] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A symbol PSX's list does not have: what was typed and the nearest one it does have.
  const [unknown, setUnknown] = useState<{ typed: string; suggest: string | null } | null>(null);
  const known = useMemo(() => new Set([...data.screen.map((r) => r.symbol), ...Object.keys(data.prices)]), [data.screen, data.prices]);
  const sectors = useMemo(() => screenSectors(data.screen), [data.screen]);

  async function save(s: string) {
    if (data.watchlist.some((w) => normaliseWatchSymbol(w.symbol, known) === s)) return setError(`${s} is already on your watchlist.`);
    try {
      await source.addWatch(s);
      setSymbol('');
      setError(null);
      setUnknown(null);
      await reload();
    } catch (e) {
      setError((e as Error).message.includes('duplicate') ? `${s} is already on your watchlist.` : (e as Error).message);
    }
  }
  function add() {
    // "ogdcl xd" is stored as OGDC: upper case, ex markers off, long forms through the alias list.
    const s = normaliseWatchSymbol(symbol, known);
    setUnknown(null);
    if (!/^[A-Z0-9]{1,12}$/.test(s)) return setError('Enter a PSX symbol like MARI.');
    // With no market list loaded yet (first run, demo) there is nothing to check against: take it as typed.
    if (known.size && !known.has(s)) {
      setError(null);
      return setUnknown({ typed: s, suggest: closestSymbol(s, known) });
    }
    return save(s);
  }
  return (
    <Section title="Watchlist">
      <ul className="space-y-2 lg:grid lg:grid-cols-2 lg:gap-3 lg:space-y-0">
        {data.watchlist.map((w) => (
          <WatchRow key={w.id ?? w.symbol} symbol={w.symbol} sector={data.prices[w.symbol]?.sector ?? sectors[w.symbol]} p={data.prices[w.symbol]} fig={pe[w.symbol]}
            bc={data.bluechip[w.symbol]} onMenu={() => onMenu(w.symbol)} />
        ))}
      </ul>
      <form className="flex gap-2 lg:max-w-[calc(50%-0.375rem)]" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className={`${inputCls} uppercase`} placeholder="Add symbol, e.g. MARI" value={symbol} autoCapitalize="characters" autoComplete="off"
          onChange={(e) => { setSymbol(e.target.value); setUnknown(null); }} aria-label="Symbol to watch" />
        <Button type="submit" kind="secondary">Watch</Button>
      </form>
      {unknown && (
        <div role="status" className="space-y-2 rounded-control bg-surface-2 p-3 text-14 lg:max-w-[calc(50%-0.375rem)]">
          <p>
            <span className="font-semibold">{unknown.typed}</span> is not in PSX's list.
            {unknown.suggest ? <> Did you mean <span className="font-semibold">{unknown.suggest}</span>?</> : ' Check the symbol on the PSX website.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {unknown.suggest && <Button onClick={() => save(unknown.suggest!)}>Watch {unknown.suggest}</Button>}
            <Button kind="ghost" onClick={() => save(unknown.typed)}>Add {unknown.typed} anyway</Button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
    </Section>
  );
}

type Price = ScreenProps['data']['prices'][string];

/**
 * The line under a watched stock: yield and the one P/E every screen shows (valuation.peFor via useHoldingActions),
 * so a loss reads "n/a (loss)" and an unusual figure carries the same marker as on the stock page.
 */
export function watchFacts(p: Price | undefined, fig: PeFigure | undefined): string {
  if (!p) return 'Price after the next market check';
  const pe = fig?.pe != null ? `${fig.pe.toFixed(1)}${fig.outlier ? ' (unusual, check)' : ''}` : fig?.loss ? 'n/a (loss)' : 'n/a';
  return `Yield ${missingNum(p.dividend_yield_pct) ? 'n/a' : `${p.dividend_yield_pct!.toFixed(1)}%`} · P/E ${pe}`;
}

function WatchRow({ symbol, sector, p, fig, bc, onMenu }: {
  symbol: string; sector?: string | null; p: Price | undefined; fig?: PeFigure; bc?: BcState; onMenu: () => void;
}) {
  const press = useLongPress(onMenu);
  const ex = exLabel(p?.ex);
  return (
    <li>
      <button type="button" {...press.handlers} onClick={() => { if (!press.consumed()) openStock(symbol); }}
        className="no-callout press flex h-full min-h-14 w-full cursor-pointer items-center gap-3 rounded-card bg-surface px-4 py-3 text-left ring-1 ring-line active:scale-[0.99]">
        <CompanyMark symbol={symbol} sector={sector} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 font-semibold">{symbol}<BcBadge state={bc} symbol={symbol} />{ex && <Chip kind="exdiv">{ex}</Chip>}</span>
          <span className="block truncate text-12 text-muted">
            {watchFacts(p, fig)}
          </span>
        </span>
        <span className="num shrink-0 text-right">
          <span className="block text-14 font-semibold">{rs2(p?.price)}</span>
          <Change value={p?.change_pct} digits={2} className="text-12 font-semibold" label="day change" />
        </span>
      </button>
    </li>
  );
}
