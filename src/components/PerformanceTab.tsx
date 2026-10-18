/**
 * Performance tab: how the account has really done. Total return with charges and dividends, the money-weighted
 * yearly rate (XIRR), what the same money would be worth in the KSE-100, a chart of your value against the index
 * and the money put in, where the return comes from, and the dividend side: expected yearly income, dividends
 * declared on shares you held at book closure, what was received, and a form to record one. Display only: every
 * figure comes from shared/performance.ts.
 */
import { useEffect, useMemo, useState, type PointerEvent as RPointerEvent } from 'react';
import type { AppData, DataSource } from '../lib/data.ts';
import type { DividendReceipt, Holding } from '../../shared/types.ts';
import { screenSectors, type PortfolioView } from '../../shared/portfolio.ts';
import {
  benchmark, benchmarkFromSnapshot, cashFlows, expectedDividends, headlineReturn, expectedYearlyIncome, logGaps, receiptFrom, totalReturn, valueSeries, whtPct, type ExpectedDividend,
} from '../../shared/performance.ts';
import { daysBetween, pktDate } from '../../shared/time.ts';
import { dateLabel, num, pct, rs, rs2, signedRs } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { useToast } from './Toast.tsx';
import { Button, Card, Empty, ErrorNote, Field, Section, Segmented, Tag, changeTone, inputCls } from './ui.tsx';

type SeriesPoint = ReturnType<typeof valueSeries>[number];
const r2 = (v: number) => Math.round(v * 100) / 100;
const muted = 'text-slate-500 dark:text-slate-400';
/**
 * Days of history before a yearly rate is shown. XIRR annualises whatever span it gets, so ten days at -8% reads
 * "-100% a year" and the KSE-100 gap "-95% behind": correct, and useless to a non-expert. Under this span the hero
 * says the yearly rate is on its way and the benchmark line uses the plain return so far, as the Home card does.
 */
const MIN_XIRR_DAYS = 90;
const r1 = (v: number) => Math.round(v * 10) / 10;

export function PerformanceTab({ data, view, source, reload, onTransactions }: {
  data: AppData; view: PortfolioView; source: DataSource; reload: () => Promise<void>; onTransactions: () => void;
}) {
  const today = pktDate(new Date());
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<false | { prefill: DividendReceipt | null }>(false);
  const [confirm, setConfirm] = useState<string | null>(null); // receipt id waiting for its second tap

  const screenMap = useMemo(() => screenSectors(data.screen), [data.screen]);
  /** PSX sector for a symbol: the price row, else the market screen, else what the holding stores. */
  const sectorFor = (symbol: string): string | null =>
    data.prices[symbol]?.sector ?? screenMap[symbol] ?? data.holdings.find((h) => h.symbol === symbol)?.sector ?? null;

  const m = useMemo(() => {
    const sectorsMap = Object.fromEntries(data.holdings.map((h) => [h.symbol, data.prices[h.symbol]?.sector ?? screenMap[h.symbol] ?? h.sector ?? null]));
    const tr = totalReturn(data.transactions, data.receipts, view.total_value, today, data.settings);
    const flows = cashFlows(data.transactions, data.receipts, view.total_value, today, data.settings);
    const bm = benchmark(flows, view.total_value, data.indexDaily, today);
    const series = valueSeries(flows, data.indexDaily, data.portfolioDaily, today);
    const expected = expectedDividends(data.transactions, data.dividends, data.receipts, sectorsMap, data.settings);
    const income = expectedYearlyIncome(data.holdings, data.prices);
    const received = [...data.receipts].sort((a, b) => b.paid_on.localeCompare(a.paid_on));
    const gaps = logGaps(data.transactions, data.holdings);
    const snap = benchmarkFromSnapshot(data.portfolioDaily, data.transactions, data.receipts, view.total_value, data.indexDaily, today, data.settings);
    return { tr, bm, series, expected, income, received, gaps, snap };
  }, [data, view.total_value, today, screenMap]);
  const { tr, bm, series, expected, income, received, gaps, snap } = m;
  // Older buys missing from the log would count as free shares: until the log explains every holding, show the
  // price-only figure from your average cost and leave total return, XIRR and the KSE-100 comparison out.
  const partial = gaps.length > 0;
  // Average-cost view: price profit/loss of what you hold plus every dividend received, net of tax.
  const hr = headlineReturn(view, data.receipts);
  const snapGap = snap && snap.bm.my_return_pct != null && snap.bm.index_return_pct != null ? r1(snap.bm.my_return_pct - snap.bm.index_return_pct) : null;

  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirm]);

  /** Save or delete, then reload; the toast on success, the ErrorNote on failure. True when it went through. */
  async function run(key: string, job: () => Promise<void>, done: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      await job();
      await reload();
      toast(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const noTxns = data.transactions.length === 0;
  const noPrices = data.holdings.length > 0 && view.total_value === 0;
  // A yearly rate only once there is enough history for one; the benchmark's XIRRs span the covered flows, so their
  // clock starts at the first index day that priced a flow, not at the first transaction.
  const historyDays = tr.first_date ? daysBetween(tr.first_date, today) : 0;
  const yearly = tr.xirr_pct != null && historyDays >= MIN_XIRR_DAYS;
  const bmDays = bm.coverage.from ? daysBetween(bm.coverage.from, today) : 0;
  const bmYearly = bm.my_xirr_pct != null && bm.index_xirr_pct != null && bmDays >= MIN_XIRR_DAYS;
  const gap = bmYearly ? bm.diff_pct
    : bm.my_return_pct != null && bm.index_return_pct != null ? r1(bm.my_return_pct - bm.index_return_pct) : null;
  const diffTone = gap == null || gap === 0 ? muted : gap > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  const diffLine = gap == null ? '' : gap === 0 ? `vs KSE-100: level with it${bmYearly ? '' : ' so far'}`
    : bmYearly ? `vs KSE-100: ${pct(gap)} a year ${gap > 0 ? 'better' : 'behind'}` : `vs KSE-100: ${pct(gap)} ${gap > 0 ? 'better' : 'behind'} so far`;

  // Wide screens: the headline and its breakdown side by side, the chart and dividends full width below.
  return (
    <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
      {/* 1. Hero */}
      <Card className="lg:order-1">
        {/* The same headline as Home and the Portfolio header: profit/loss on your average cost plus dividends received. */}
        <p className={`text-xs ${muted}`}>Total return, dividends included</p>
        <p className={`num text-3xl font-bold tracking-tight ${changeTone(hr.total)}`}>
          {signedRs(hr.total)} <span className="text-base font-semibold">({pct(hr.pct)})</span>
        </p>
        <p className={`num mt-1 text-sm ${muted}`}>Price only {signedRs(hr.price_only)} ({pct(hr.price_only_pct)}) · dividends {rs(hr.dividends)} net</p>
        {(noTxns || partial) && (
          <p className={`mt-1 text-sm ${muted}`}>
            {noTxns ? 'Record your buys and sells to see the yearly rate and charges paid.'
              : `Your buys list is missing older buys of ${gaps.map((g) => g.symbol).slice(0, 4).join(', ')}${gaps.length > 4 ? ` and ${gaps.length - 4} more` : ''}. Add them under Buys and sells for the yearly rate and the full KSE-100 comparison.`}
          </p>
        )}
        {!partial && <p className={`num mt-1 text-sm ${muted}`}>
          {tr.xirr_pct == null ? 'XIRR needs a sale, a dividend or more than one day of history'
            : yearly ? `${pct(tr.xirr_pct)} a year, money-weighted (XIRR)`
              : `A yearly rate (XIRR) comes after ${MIN_XIRR_DAYS} days of history; ${historyDays} day${historyDays === 1 ? '' : 's'} so far`}
        </p>}
        {noPrices && <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">No prices yet for your holdings, so the value side reads Rs 0 until the next market check.</p>}
        {(partial || gap == null) && (
          <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            {snap && snapGap != null ? (
              <>
                <p className={`num text-sm font-semibold ${snapGap === 0 ? muted : changeTone(snapGap)}`}>
                  vs KSE-100 since {dateLabel(snap.start.day)}: {snapGap === 0 ? 'level' : `${pct(snapGap)} ${snapGap > 0 ? 'better' : 'behind'}`}
                </p>
                <p className={`num text-xs ${muted}`}>Your holdings on {dateLabel(snap.start.day)} count as the starting point; the same money in the index would be worth {rs(snap.bm.index_value)}.</p>
              </>
            ) : (
              <p className={`text-sm ${muted}`}>KSE-100 comparison starts with tonight's check: your holdings then are the starting point.</p>
            )}
          </div>
        )}
        {!partial && gap != null && <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          {gap != null ? (
            <>
              <p className={`num text-sm font-semibold ${diffTone}`}>{diffLine}</p>
              <p className={`num text-xs ${muted}`}>the same money in the index would be worth {rs(bm.index_value)}</p>
            </>
          ) : (
            <p className={`text-sm ${muted}`}>KSE-100 comparison needs index history from your first buy</p>
          )}
          {bm.coverage.note && <p className={`mt-1 text-[11px] leading-snug ${muted}`}>{bm.coverage.note}</p>}
        </div>}
      </Card>

      {/* 2. Chart: only when the buys log explains every holding */}
      {!partial && (
      <Card className="lg:order-3 lg:col-span-2">
        <h3 className="font-semibold">Your money vs the KSE-100</h3>
        {series.length < 2 ? (
          <div className="mt-2">
            <Empty title="Not enough history yet">
              <p>The night check stores the KSE-100 close and your value every trading day; the chart draws itself once there are two days to join.</p>
            </Empty>
          </div>
        ) : (
          <ValueChart series={series} todayValue={view.total_value} />
        )}
      </Card>
      )}

      {/* 3. Breakdown */}
      <Card className="lg:order-2">
        <h3 className="font-semibold">Where the return comes from</h3>
        <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
          <Row label="Put in" value={noTxns ? 'n/a' : partial ? rs(view.total_cost) : rs(tr.invested)} note={partial ? 'at your average cost' : 'incl. charges'} />
          <Row label="Value now" value={rs(tr.current_value)} />
          <Row label="Sold" value={noTxns ? 'n/a' : rs(tr.proceeds)} note="net of charges" />
          {received.length > 0 ? (
            <>
              <Row label="Dividends gross" value={rs(tr.dividends_gross)} />
              <Row label="Withholding tax" value={signedRs(-tr.dividends_wht)} tone={changeTone(-tr.dividends_wht)} />
              <Row label="Dividends net" value={rs(tr.dividends_net)} />
            </>
          ) : (
            <Row label="Dividends" value="none recorded yet" />
          )}
          <Row label="Charges paid" value={noTxns ? 'n/a' : rs(tr.costs)} />
          <Row label="Since" value={tr.first_date ? dateLabel(tr.first_date) : 'no transactions yet'} />
        </div>
      </Card>

      {/* 4. Dividends */}
      <div className="lg:order-4 lg:col-span-2"><Section title="Dividends">
        <Card className="space-y-3">
          <p className={`num text-sm ${muted}`}>
            {income.with_data > 0
              ? `About ${rs(income.gross)} a year before tax at today's yields (an estimate)${income.without_data.length ? ` (${income.without_data.length} holding${income.without_data.length === 1 ? ' has' : 's have'} no yield figure)` : ''}`
              : data.holdings.length ? 'No yield figures yet for your holdings, so yearly income cannot be estimated.' : 'Add holdings to see an estimate of yearly dividend income.'}
          </p>

          {expected.length > 0 && (
            <div>
              <h3 className={`text-[13px] font-semibold uppercase tracking-wide ${muted}`}>Expected</h3>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {expected.map((e) => (
                  <ExpectedRow key={e.dividend_id} e={e} busy={busy === e.dividend_id}
                    onReceived={() => setAdding({ prefill: receiptFrom(e) })} />
                ))}
              </ul>
              <p className={`mt-1 text-xs ${muted}`}>A declared dividend for shares you held at book closure. Tap Received once it is credited.</p>
            </div>
          )}

          <div>
            <h3 className={`text-[13px] font-semibold uppercase tracking-wide ${muted}`}>Received</h3>
            {received.length === 0 ? (
              <p className={`py-2 text-sm ${muted}`}>No dividends recorded yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {received.map((r) => {
                  const id = r.id ?? `${r.symbol}-${r.paid_on}`;
                  const arming = confirm === id;
                  return (
                    <li key={id} className="flex items-center gap-2 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 font-medium"><span>{r.symbol}</span><span className={`text-xs font-normal ${muted}`}>{dateLabel(r.paid_on)}</span></span>
                        <span className={`num block text-xs ${muted}`}>{num(r.shares, 0)} × {rs2(r.dps)}</span>
                      </span>
                      <span className="num shrink-0 text-right">
                        <span className="block text-sm font-semibold">{rs(r.net)} net</span>
                        <span className={`block text-xs ${muted}`}>gross {rs(r.gross)} · tax {rs(r.gross - r.net)}</span>
                      </span>
                      <button type="button" disabled={!r.id || busy === id}
                        aria-label={arming ? `Tap again to delete the ${r.symbol} dividend of ${dateLabel(r.paid_on)}` : `Delete the ${r.symbol} dividend of ${dateLabel(r.paid_on)}`}
                        onClick={() => {
                          haptic();
                          if (!arming) return setConfirm(id);
                          setConfirm(null);
                          run(id, () => source.deleteReceipt(r.id!), 'Dividend deleted');
                        }}
                        className={`flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-2xl px-2 text-xs font-semibold transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${arming ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300' : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}>
                        {arming ? 'Tap again to delete' : <Icon name="trash" className="h-5 w-5" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {adding ? (
            <ReceiptForm key={adding.prefill?.dividend_id ?? 'new'} prefill={adding.prefill} holdings={data.holdings} today={today} filer={data.settings.tax_filer} sectorFor={sectorFor} busy={busy === 'add'}
              onCancel={() => setAdding(false)}
              onSave={(r) => run('add', () => source.saveReceipt(r), `${r.symbol} dividend saved`).then((ok) => { if (ok) setAdding(false); })} />
          ) : (
            <Button kind="ghost" className="w-full" onClick={() => setAdding({ prefill: null })}><Icon name="plus" className="h-4 w-4" />Add a dividend</Button>
          )}
          <ErrorNote error={error} />
        </Card>
      </Section></div>

      {/* 5. Footer */}
      <Button kind="ghost" className="w-full lg:order-5 lg:col-span-2 lg:w-auto lg:justify-self-start" onClick={onTransactions}><Icon name="list" className="h-4 w-4" />Buys and sells<Icon name="chevron" className="h-4 w-4" /></Button>
      <p className={`px-1 text-xs lg:order-6 lg:col-span-2 ${muted}`}>Returns use your recorded buys and sells. Buys imported from screenshots are dated the import day until you fix them.</p>
    </div>
  );
}

/** One expected dividend: the declared figures, the tax taken at source, and the button that turns it into a receipt. */
function ExpectedRow({ e, busy, onReceived }: { e: ExpectedDividend; busy: boolean; onReceived: () => void }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 font-medium">{e.symbol}{!e.verified && <Tag tone="amber">unverified</Tag>}</span>
        <span className="num block text-xs text-slate-600 dark:text-slate-300">{rs2(e.dps)}/share × {num(e.shares, 0)} = {rs(e.gross)}</span>
        <span className={`num block text-xs ${muted}`}>net {rs(e.net)} after {e.wht_pct}% tax · book closure {dateLabel(e.book_closure_from)}</span>
      </span>
      <Button kind="secondary" className="shrink-0" disabled={busy} onClick={onReceived}>Received</Button>
    </li>
  );
}

const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
const OTHER = '__other__';

/** Record a dividend by hand: symbol, date, shares, rupees per share and the withholding rate; gross and net update as you type. */
function ReceiptForm({ prefill, holdings, today, filer, sectorFor, busy, onSave, onCancel }: {
  prefill: DividendReceipt | null; holdings: Holding[]; today: string; filer: boolean; sectorFor: (symbol: string) => string | null; busy: boolean;
  onSave: (r: DividendReceipt) => void; onCancel: () => void;
}) {
  const sorted = useMemo(() => [...holdings].sort((a, b) => a.symbol.localeCompare(b.symbol)), [holdings]);
  const first = prefill ? sorted.find((h) => h.symbol === prefill.symbol) ?? null : sorted[0];
  const [pick, setPick] = useState(prefill && !first ? OTHER : first ? first.symbol : OTHER);
  const [other, setOther] = useState(prefill && !first ? prefill.symbol : '');
  // No default date: the credit date decides the tax year and the return, so it must be the real one.
  const [paidOn, setPaidOn] = useState('');
  const [shares, setShares] = useState(prefill ? String(prefill.shares) : first ? String(first.shares) : '');
  const [mode, setMode] = useState<'dps' | 'net'>('dps');
  const [dps, setDps] = useState(prefill ? String(prefill.dps) : '');
  const [amount, setAmount] = useState('');
  const [wht, setWht] = useState(String(prefill ? prefill.wht_pct : whtPct(first ? sectorFor(first.symbol) : null, filer)));
  const [err, setErr] = useState<string | null>(null);

  const symbol = (pick === OTHER ? other : pick).trim().toUpperCase();
  const sharesN = Number(shares);
  const whtN = Number(wht);
  // "Amount credited" is what the bank shows: net of tax for all shares, so work back to the gross rupees per share.
  const dpsN = mode === 'dps' ? Number(dps) : sharesN > 0 && whtN < 100 ? r2(Number(amount) / (sharesN * (1 - whtN / 100)) * 10000) / 10000 : NaN;
  const valid = sharesN > 0 && dpsN > 0 && Number.isFinite(whtN) && whtN >= 0 && whtN <= 100;
  const gross = valid ? r2(sharesN * dpsN) : null;
  const net = gross == null ? null : r2(gross * (1 - whtN / 100));

  function choose(v: string) {
    setPick(v);
    if (v === OTHER) return;
    const h = sorted.find((x) => x.symbol === v);
    if (h) setShares(String(h.shares));
    setWht(String(whtPct(sectorFor(v), filer)));
  }
  function typeOther(v: string) {
    setOther(v.toUpperCase());
    const s = v.trim().toUpperCase();
    if (SYMBOL_RE.test(s)) setWht(String(whtPct(sectorFor(s), filer)));
  }
  function save() {
    if (!SYMBOL_RE.test(symbol)) return setErr('Enter a PSX symbol like MARI.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return setErr('Enter the date it was credited (on the credit advice or bank statement).');
    if (!(sharesN > 0)) return setErr('Shares must be more than 0.');
    if (!(dpsN > 0)) return setErr('Rupees per share must be more than 0.');
    if (gross == null || net == null) return setErr('Withholding tax must be between 0 and 100%.');
    setErr(null);
    onSave({ symbol, paid_on: paidOn, shares: sharesN, dps: dpsN, gross, wht_pct: whtN, net, dividend_id: prefill?.dividend_id ?? null, note: null });
  }

  return (
    <form className="space-y-3 rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/60" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label="Add a dividend">
      <Field label="Symbol">
        <select className={inputCls} value={pick} onChange={(e) => choose(e.target.value)}>
          {sorted.map((h) => <option key={h.symbol} value={h.symbol}>{h.symbol}</option>)}
          <option value={OTHER}>Another symbol</option>
        </select>
      </Field>
      {pick === OTHER && (
        <Field label="Symbol (type it)">
          <input className={`${inputCls} uppercase`} value={other} autoCapitalize="characters" placeholder="e.g. MARI" onChange={(e) => typeOther(e.target.value)} />
        </Field>
      )}
      <Field label="Credited on" hint="The date on the credit advice or bank statement, not today.">
        <input type="date" className={inputCls} value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} />
      </Field>
      <Segmented label="What you know" value={mode} onChange={setMode}
        options={[{ value: 'dps', label: 'Rs per share' }, { value: 'net', label: 'Amount credited' }]} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Shares held">
          <input type="number" inputMode="numeric" min="1" step="1" className={`${inputCls} num`} value={shares} onChange={(e) => setShares(e.target.value)} />
        </Field>
        {mode === 'dps' ? (
          <Field label="Rs per share (gross)">
            <input type="number" inputMode="decimal" min="0" step="0.01" className={`${inputCls} num`} value={dps} placeholder="e.g. 2.50" onChange={(e) => setDps(e.target.value)} />
          </Field>
        ) : (
          <Field label="Credited, after tax (Rs)">
            <input type="number" inputMode="decimal" min="0" step="0.01" className={`${inputCls} num`} value={amount} placeholder="e.g. 138" onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Withholding tax %" hint={filer ? 'Your rate as a filer; check the credit advice.' : 'Your rate as a non-filer; check the credit advice.'}>
        <input type="number" inputMode="decimal" min="0" max="100" step="0.5" className={`${inputCls} num`} value={wht} onChange={(e) => setWht(e.target.value)} />
      </Field>
      <p className="num text-sm" aria-live="polite">
        {gross == null ? <span className={muted}>Gross and net appear once shares and rupees per share are in.</span>
          : <>{sharesN} × {rs2(dpsN)} = gross <span className="font-semibold">{rs2(gross)}</span> · net <span className="font-semibold">{rs2(net)}</span> after {whtN}% tax</>}
      </p>
      <ErrorNote error={err} />
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={busy}>Save</Button>
        <Button kind="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

/** One ledger line: label on the left, the figure (and an optional note under it) on the right. */
function Row({ label, value, tone = '', note }: { label: string; value: string; tone?: string; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
      <span className="min-w-0 text-right">
        <span className={`num block text-sm font-semibold ${tone}`}>{value}</span>
        {note && <span className={`block text-xs ${muted}`}>{note}</span>}
      </span>
    </div>
  );
}

const W = 300;
const H = 140;
const PAD = 6;
const TEAL = '#0d9488';

/**
 * Your value (solid teal), the same money in the KSE-100 (dashed slate) and the money put in (dotted), one point per
 * index day. Drag or hover to read a day; the line above the chart states it. No animation, so reduced motion is
 * respected by default. Pointer events stop here: the Portfolio screen swipes between tabs on a horizontal drag,
 * and a drag across the chart is a scrub, not a swipe.
 */
function ValueChart({ series, todayValue }: { series: SeriesPoint[]; todayValue: number }) {
  const [at, setAt] = useState<number | null>(null);
  const n = series.length;
  const firstDay = series[0].day;
  // A tap leaves `at` set (touch has no pointerleave), and the chart stays mounted while receipts or buys are deleted
  // or re-dated under it. When the series changes shape, start again at today; and because the effect runs after
  // that first render, the index is clamped as well so a stale one never reads past the end.
  useEffect(() => { setAt(null); }, [n, firstDay]);
  const idx = at == null ? n - 1 : Math.min(at, n - 1);
  const last = series[n - 1];
  const p = series[idx];
  const nonNull = (d: { i: number; v: number | null }): d is { i: number; v: number } => d.v != null;
  const indexPts = series.map((s, i) => ({ i, v: s.index_value })).filter(nonNull);
  const investedPts = series.map((s, i) => ({ i, v: s.invested }));
  const mine = series.map((s, i) => ({ i, v: s.my_value })).filter(nonNull);
  const values = [...indexPts, ...investedPts, ...mine].map((d) => d.v);
  if (!mine.length) values.push(todayValue);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo === 0) { lo -= 1; hi += 1; }
  const x = (i: number) => PAD + (i / (n - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);
  const path = (pts: { i: number; v: number }[]) => pts.map((d) => `${x(d.i).toFixed(1)},${y(d.v).toFixed(1)}`).join(' ');
  const lastMine = mine.length ? mine[mine.length - 1] : null;
  const orNa = (v: number | null) => (v == null ? 'n/a' : rs(v));
  const label = `Your money vs the KSE-100 from ${dateLabel(series[0].day)} to ${dateLabel(last.day)}: put in ${rs(last.invested)}, the same money in the index ${orNa(last.index_value)}, your value ${lastMine ? `${rs(lastMine.v)} on ${dateLabel(series[lastMine.i].day)}` : `${rs(todayValue)} today, before the first daily snapshot`}.`;

  const stop = (e: RPointerEvent<SVGSVGElement>) => e.stopPropagation();
  const pick = (e: RPointerEvent<SVGSVGElement>) => {
    stop(e);
    const box = e.currentTarget.getBoundingClientRect();
    const scale = Math.min(box.width / W, box.height / H) || 1;
    const left = box.left + (box.width - W * scale) / 2;
    const fx = (e.clientX - left) / scale;
    setAt(Math.max(0, Math.min(n - 1, Math.round(((fx - PAD) / (W - PAD * 2)) * (n - 1)))));
  };

  return (
    <div className="mt-2">
      <p className="num text-xs text-slate-600 dark:text-slate-300" aria-live="polite">
        <span className="font-semibold">{dateLabel(p.day)}</span> · you {orNa(p.my_value)} · index {orNa(p.index_value)} · put in {rs(p.invested)}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-36 w-full touch-pan-y" role="img" aria-label={label}
        onPointerDown={pick} onPointerMove={pick} onPointerUp={stop} onPointerCancel={stop}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setAt(null); }}>
        {indexPts.length > 1 && <polyline points={path(indexPts)} fill="none" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" className="stroke-slate-400 dark:stroke-slate-500" />}
        <polyline points={path(investedPts)} fill="none" strokeWidth="2.2" strokeDasharray="0.1 4.5" strokeLinecap="round" strokeLinejoin="round" className="stroke-slate-600 dark:stroke-slate-300" />
        {mine.length > 1 ? (
          <polyline points={path(mine)} fill="none" stroke={TEAL} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        ) : mine.length === 1 ? (
          <circle cx={x(mine[0].i)} cy={y(mine[0].v)} r="4" fill={TEAL} />
        ) : (
          <circle cx={x(n - 1)} cy={y(todayValue)} r="4.5" fill={TEAL} strokeWidth="2" className="stroke-white dark:stroke-slate-900" />
        )}
        {at != null && (
          <>
            <line x1={x(idx)} x2={x(idx)} y1={PAD} y2={H - PAD} strokeWidth="1" className="stroke-slate-400" />
            {p.index_value != null && <circle cx={x(idx)} cy={y(p.index_value)} r="3.5" className="fill-slate-400 dark:fill-slate-500" />}
            <circle cx={x(idx)} cy={y(p.invested)} r="3.5" className="fill-slate-600 dark:fill-slate-300" />
            {p.my_value != null && <circle cx={x(idx)} cy={y(p.my_value)} r="4" fill={TEAL} />}
          </>
        )}
      </svg>
      <div className={`flex items-center justify-between text-[11px] ${muted}`}>
        <span>{dateLabel(series[0].day)}</span>
        <span>{dateLabel(last.day)}</span>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-5 rounded bg-teal-600" aria-hidden="true" />You (solid)</li>
        <li className="flex items-center gap-1.5"><span className="w-5 border-t-2 border-dashed border-slate-400 dark:border-slate-500" aria-hidden="true" />KSE-100, same money (dashed)</li>
        <li className="flex items-center gap-1.5"><span className="w-5 border-t-2 border-dotted border-slate-600 dark:border-slate-300" aria-hidden="true" />Put in (dotted)</li>
      </ul>
      {!mine.length && <p className={`mt-1.5 text-xs ${muted}`}>Your daily values start with tonight's check; the teal dot is today's value.</p>}
    </div>
  );
}
