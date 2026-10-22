/**
 * Performance tab: how the account has really done. Total return with charges and dividends, the money-weighted
 * yearly rate (XIRR), what the same money would be worth in the KSE-100 (once there is enough history for the
 * comparison to mean something), a chart of your value against the index and the money put in, where the return
 * comes from (charges counted only on logged trades, plus an estimate for everything held), and the dividend side:
 * expected yearly income, dividends declared on shares you held at book closure, what was received (editable,
 * checked against what you held), and a form to record one. Display only: every figure comes from
 * shared/performance.ts.
 */
import { useEffect, useMemo, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import type { AppData, DataSource } from '../lib/data.ts';
import { DEFAULT_RULES, type DividendReceipt, type Holding } from '../../shared/types.ts';
import { screenSectors, type PortfolioView } from '../../shared/portfolio.ts';
import {
  RECEIPT_MATCH_DAYS, benchmark, benchmarkFromSnapshot, benchmarkReady, cashFlows, chargesSummary, expectedDividends, expectedYearlyIncome,
  headlineReturn, heldAtBookClosure, logGaps, receiptFrom, totalReturn, valueSeries, whtPct, type ExpectedDividend,
} from '../../shared/performance.ts';
import { bookClosureDate } from '../../shared/calendar.ts';
import { daysBetween, pktDate } from '../../shared/time.ts';
import { day, num, rs, rs2, signedRs } from '../../shared/format.ts';
import { haptic } from '../lib/gestures.ts';
import { Icon } from './Icon.tsx';
import { useToast } from './Toast.tsx';
import { Button, Card, Change, Chip, Empty, ErrorNote, Field, InfoTip, Section, Segmented, inputCls } from './ui.tsx';

type SeriesPoint = ReturnType<typeof valueSeries>[number];
const r2 = (v: number) => Math.round(v * 100) / 100;
const muted = 'text-muted';
/**
 * Days of history before a yearly rate is shown. XIRR annualises whatever span it gets, so ten days at -8% reads
 * "-100% a year" and the KSE-100 gap "-95% behind": correct, and useless to a non-expert. Under this span the hero
 * says the yearly rate is on its way and the benchmark line uses the plain return so far, as the Home card does.
 */
const MIN_XIRR_DAYS = 90;
const r1 = (v: number) => Math.round(v * 10) / 10;
/** How many holdings the missing-buys prompt names before "and N more". */
const GAPS_SHOWN = 6;
/** "starts tomorrow", "starts on Thu", "starts on Nov 22": day() words read naturally after "starts". */
const startsWhen = (iso: string) => {
  const w = day(iso);
  return w === 'Today' || w === 'Tomorrow' ? w.toLowerCase() : `on ${w}`;
};

/** The receipt form's job: a new one (maybe from an expected dividend) or an existing one being corrected. */
type FormState = { prefill: DividendReceipt | null; editing: DividendReceipt | null; bookClosure: string | null };

export function PerformanceTab({ data, view, source, reload, onTransactions }: {
  data: AppData; view: PortfolioView; source: DataSource; reload: () => Promise<void>; onTransactions: () => void;
}) {
  const today = pktDate(new Date());
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
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
    // Shares at book closure come from the log when it explains the holding, else from today's holding (an imported
    // baseline), and a dividend row without a book-closure date takes it from its notice, as Home's "This week" does.
    const expected = expectedDividends(data.transactions, data.dividends, data.receipts, sectorsMap, data.settings, DEFAULT_RULES,
      { holdings: data.holdings, announcements: data.announcements });
    const income = expectedYearlyIncome(data.holdings, data.prices);
    const received = [...data.receipts].sort((a, b) => b.paid_on.localeCompare(a.paid_on));
    const gaps = logGaps(data.transactions, data.holdings);
    const snap = benchmarkFromSnapshot(data.portfolioDaily, data.transactions, data.receipts, view.total_value, data.indexDaily, today, data.settings);
    const charges = chargesSummary(data.transactions, data.holdings, data.prices, data.settings);
    const ready = benchmarkReady(data.portfolioDaily, today);
    return { tr, bm, series, expected, income, received, gaps, snap, charges, ready };
  }, [data, view.total_value, today, screenMap]);
  const { tr, bm, series, expected, income, received, gaps, snap, charges, ready } = m;

  /**
   * Shares held at the book closure behind a receipt: its own dividend (dividend_id), else the latest declared
   * dividend of that stock whose book closure started up to RECEIPT_MATCH_DAYS before the credit. Null when no
   * declared dividend matches, so nothing is checked.
   */
  const heldFor = useMemo(() => {
    const notices = new Map(data.announcements.map((a) => [a.id, a]));
    const cutoffOf = (id: string, from: string | null) => from || bookClosureDate(notices.get(id));
    return (r: DividendReceipt): number | null => {
      let cutoff: string | null = null;
      if (r.dividend_id) {
        const e = data.dividends.find((d) => d.id === r.dividend_id);
        cutoff = e ? cutoffOf(e.id, e.book_closure_from) : null;
      } else {
        for (const e of data.dividends) {
          if (e.symbol !== r.symbol) continue;
          const c = cutoffOf(e.id, e.book_closure_from);
          if (!c || c > r.paid_on || daysBetween(c, r.paid_on) > RECEIPT_MATCH_DAYS) continue;
          if (!cutoff || c > cutoff) cutoff = c;
        }
      }
      return cutoff ? heldAtBookClosure(r.symbol, cutoff, data.transactions, data.holdings).shares : null;
    };
  }, [data.announcements, data.dividends, data.transactions, data.holdings]);

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

  /**
   * A corrected receipt is updated in place.
   */
  function saveReceipt(r: DividendReceipt) {
    const old = form?.editing;
    const job = () => (old?.id ? source.updateReceipt(old.id, r) : source.saveReceipt(r));
    run('add', job, `${r.symbol} dividend ${old ? 'updated' : 'saved'}`).then((ok) => { if (ok) setForm(null); });
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
  // The KSE-100 comparison waits for benchmark_min_days of history (a few days say nothing): of stored portfolio
  // values (benchmarkReady), or, with a complete log, of index days covering your own buys.
  const minDays = DEFAULT_RULES.performance.benchmark_min_days;
  const compare = ready.ready || (!partial && bmDays >= minDays);
  const hasSells = data.transactions.some((t) => t.side === 'sell');

  // Wide screens: the headline and its breakdown side by side, the chart and dividends full width below.
  return (
    <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
      {/* 1. Hero */}
      <Card className="lg:order-1">
        {/* The same headline as Home and the Portfolio header: profit/loss on your average cost plus dividends received. */}
        <p className={`text-12 ${muted}`}>Total return, dividends included</p>
        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-bold tracking-tight">
          <Change value={hr.total} kind="rs" label="total return" className="text-28" />
          <Change value={hr.pct} label="total return" className="text-16 font-semibold" />
        </p>
        <p className={`num mt-1 text-14 ${muted}`}>
          Price only <Change value={hr.price_only} kind="rs" label="price only" /> (<Change value={hr.price_only_pct} label="price only" />) · dividends {rs(hr.dividends)} net
        </p>
        {noTxns && <p className={`mt-1 text-14 ${muted}`}>Record your buys and sells to see the yearly rate and charges paid.</p>}
        {!partial && !noTxns && <p className={`num mt-1 text-14 ${muted}`}>
          {tr.xirr_pct == null ? 'XIRR needs a sale, a dividend or more than one day of history'
            : yearly ? <><Change value={tr.xirr_pct} label="yearly rate" /> a year, money-weighted (XIRR)</>
              : `A yearly rate (XIRR) comes after ${MIN_XIRR_DAYS} days of history; ${historyDays} day${historyDays === 1 ? '' : 's'} so far`}
        </p>}
        {noPrices && <p className="mt-1 text-12 font-medium text-caution">No prices yet for your holdings, so the value side reads Rs 0 until the next market check.</p>}

        {partial && !noTxns && <MissingBuys gaps={gaps} onTransactions={onTransactions} />}

        <div className="mt-3 border-t border-line pt-3">
          {!compare ? (
            <>
              <p className="text-14 font-semibold">
                {ready.ready_on ? `Comparison with the KSE-100 starts ${startsWhen(ready.ready_on)}` : 'Comparison with the KSE-100 starts once your daily values are stored'}
              </p>
              <p className={`text-12 ${muted}`}>
                {ready.starts_on ? `It needs ${minDays} days of your portfolio's history, stored from ${day(ready.starts_on)}.`
                  : `The night check stores your value every trading day; the comparison needs ${minDays} days of it.`}
              </p>
            </>
          ) : partial || gap == null ? (
            snap && snapGap != null ? (
              <>
                <p className="num text-14 font-semibold">
                  vs KSE-100 since {day(snap.start.day)}: {snapGap === 0 ? <span className={muted}>level</span> : <><Change value={snapGap} label="versus the KSE-100" /> {snapGap > 0 ? 'better' : 'behind'}</>}
                </p>
                <p className={`num text-12 ${muted}`}>Your holdings on {day(snap.start.day)} count as the starting point; the same money in the index would be worth {rs(snap.bm.index_value)}.</p>
              </>
            ) : (
              <p className={`text-14 ${muted}`}>KSE-100 comparison needs index history from your {partial ? 'first stored day' : 'first buy'}.</p>
            )
          ) : (
            <>
              <p className="num text-14 font-semibold">
                {gap === 0 ? <span className={muted}>vs KSE-100: level with it{bmYearly ? '' : ' so far'}</span>
                  : <>vs KSE-100: <Change value={gap} label="versus the KSE-100" /> {bmYearly ? 'a year ' : ''}{gap > 0 ? 'better' : 'behind'}{bmYearly ? '' : ' so far'}</>}
              </p>
              <p className={`num text-12 ${muted}`}>the same money in the index would be worth {rs(bm.index_value)}</p>
              {bm.coverage.note && <p className={`mt-1 text-12 ${muted}`}>{bm.coverage.note}</p>}
            </>
          )}
        </div>
      </Card>

      {/* 2. Chart: only when the buys log explains every holding and there is enough history to compare */}
      {!partial && (
      <Card className="lg:order-3 lg:col-span-2">
        <h3 className="text-16 font-semibold">Your money vs the KSE-100</h3>
        {!compare || series.length < 2 ? (
          <div className="mt-2">
            <Empty title={!compare && ready.starts_on ? `Builds from ${day(ready.starts_on)}` : series.length ? `Builds from ${day(series[0].day)}` : "Builds from tonight's check"}>
              <p>
                {ready.ready_on && !compare ? `The night check stores the KSE-100 close and your value every trading day; the chart appears ${startsWhen(ready.ready_on)}.`
                  : 'The night check stores the KSE-100 close and your value every trading day; the chart draws itself once there is enough to compare.'}
              </p>
            </Empty>
          </div>
        ) : (
          <ValueChart series={series} todayValue={view.total_value} />
        )}
      </Card>
      )}

      {/* 3. Breakdown */}
      <Card className="lg:order-2">
        <h3 className="text-16 font-semibold">Where the return comes from</h3>
        <div className="mt-1 divide-y divide-line">
          <Row label="Put in" value={noTxns ? 'n/a' : partial ? rs(view.total_cost) : rs(tr.invested)} note={partial ? 'at your average cost' : 'incl. charges'} />
          <Row label="Value now" value={rs(tr.current_value)} />
          <Row label="Sold" value={noTxns ? 'n/a' : rs(tr.proceeds)} note="net of charges" />
          {received.length > 0 ? (
            <>
              <Row label="Dividends gross" value={rs(tr.dividends_gross)} />
              <Row label="Withholding tax" value={signedRs(-tr.dividends_wht)} />
              <Row label="Dividends net" value={rs(tr.dividends_net)} />
            </>
          ) : (
            <Row label="Dividends" value="none recorded yet" />
          )}
          <Row
            label={<span className="inline-flex items-center gap-1">Charges paid<InfoTip label="About charges paid"
              text="Counts only the trades in your Buys and sells log. A buy price read from a screenshot is your broker's average cost, which already includes the charges, so nothing is added on top of it." /></span>}
            value={noTxns ? 'n/a' : rs(charges.logged)}
            note={noTxns ? 'no trades logged yet' : `on ${rs(charges.logged_on)} of logged ${hasSells ? 'buys and sells' : 'buys'}`} />
          {charges.cost_basis > 0 && (
            <Row label={<span className="inline-flex flex-wrap items-center gap-1.5">Charges in your cost<Chip kind="estimate" /></span>}
              value={`≈ ${rs(charges.estimate_all)}`} note={`on ${rs(charges.cost_basis)} cost of all holdings, at your rates`} />
          )}
          <Row label="Since" value={tr.first_date ? day(tr.first_date) : 'no transactions yet'} />
        </div>
      </Card>

      {/* 4. Dividends */}
      <div className="lg:order-4 lg:col-span-2"><Section title="Dividends">
        <Card className="space-y-3">
          <p className={`num text-14 ${muted}`}>
            {income.with_data > 0
              ? `About ${rs(income.gross)} a year before tax at today's yields (an estimate)${income.without_data.length ? ` (${income.without_data.length} holding${income.without_data.length === 1 ? ' has' : 's have'} no yield figure)` : ''}`
              : data.holdings.length ? 'No yield figures yet for your holdings, so yearly income cannot be estimated.' : 'Add holdings to see an estimate of yearly dividend income.'}
          </p>

          {expected.length > 0 && (
            <div>
              <h3 className={`text-12 font-semibold uppercase tracking-wide ${muted}`}>Expected</h3>
              <ul className="divide-y divide-line">
                {expected.map((e) => (
                  <ExpectedRow key={e.dividend_id} e={e} busy={busy === e.dividend_id}
                    onReceived={() => setForm({ prefill: receiptFrom(e), editing: null, bookClosure: e.book_closure_from })} />
                ))}
              </ul>
              <p className={`mt-1 text-12 ${muted}`}>A declared dividend for shares you held at book closure. Tap Received once it is credited.</p>
            </div>
          )}

          <div>
            <h3 className={`text-12 font-semibold uppercase tracking-wide ${muted}`}>Received</h3>
            {received.length === 0 ? (
              <p className={`py-2 text-14 ${muted}`}>No dividends recorded yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {received.map((r) => {
                  const id = r.id ?? `${r.symbol}-${r.paid_on}`;
                  const arming = confirm === id;
                  const held = heldFor(r);
                  const check = held != null && held > 0 && held !== r.shares;
                  return (
                    <li key={id} className="flex items-center gap-2 py-2">
                      <button type="button" disabled={!r.id} onClick={() => { haptic(); setForm({ prefill: r, editing: r, bookClosure: null }); }}
                        aria-label={`Edit the ${r.symbol} dividend of ${day(r.paid_on)}`}
                        className="press flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control text-left disabled:cursor-default">
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 font-medium"><span>{r.symbol}</span><span className={`text-12 font-normal ${muted}`}>{day(r.paid_on)}</span></span>
                          <span className={`num block text-12 ${muted}`}>{num(r.shares, 0)} × {rs2(r.dps)}</span>
                          {check && <span className="num block text-12 font-medium text-caution">Check: you held {num(held, 0)} at book closure</span>}
                        </span>
                        <span className="num shrink-0 text-right">
                          <span className="block text-14 font-semibold">{rs(r.net)} net</span>
                          <span className={`block text-12 ${muted}`}>gross {rs(r.gross)} · tax {rs(r.gross - r.net)}</span>
                        </span>
                      </button>
                      <button type="button" disabled={!r.id || busy === id}
                        aria-label={arming ? `Tap again to delete the ${r.symbol} dividend of ${day(r.paid_on)}` : `Delete the ${r.symbol} dividend of ${day(r.paid_on)}`}
                        onClick={() => {
                          haptic();
                          if (!arming) return setConfirm(id);
                          setConfirm(null);
                          run(id, () => source.deleteReceipt(r.id!), 'Dividend deleted');
                        }}
                        className={`press flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-control px-2 text-12 font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${arming ? 'bg-caution/10 text-caution' : `${muted} hover:bg-surface-2`}`}>
                        {arming ? 'Tap again to delete' : <Icon name="trash" className="h-5 w-5" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {form ? (
            <ReceiptForm key={form.editing?.id ?? form.prefill?.dividend_id ?? 'new'} form={form} holdings={data.holdings} today={today}
              filer={data.settings.tax_filer} sectorFor={sectorFor} busy={busy === 'add'} onCancel={() => setForm(null)} onSave={saveReceipt} />
          ) : (
            <Button kind="ghost" className="w-full" onClick={() => setForm({ prefill: null, editing: null, bookClosure: null })}><Icon name="plus" className="h-4 w-4" />Add a dividend</Button>
          )}
          <ErrorNote error={error} />
        </Card>
      </Section></div>

      {/* 5. Footer */}
      <Button kind="ghost" className="w-full lg:order-5 lg:col-span-2 lg:w-auto lg:justify-self-start" onClick={onTransactions}><Icon name="list" className="h-4 w-4" />Buys and sells<Icon name="chevron" className="h-4 w-4" /></Button>
      <p className={`px-1 text-12 lg:order-6 lg:col-span-2 ${muted}`}>Returns use your recorded buys and sells. Buys imported from screenshots carry the trade date chosen on import (today unless changed); fix it under Buys and sells.</p>
    </div>
  );
}

/** Which holdings the buys log does not explain yet, and the way to fix it. */
function MissingBuys({ gaps, onTransactions }: { gaps: { symbol: string; held: number; logged: number }[]; onTransactions: () => void }) {
  return (
    <div className="mt-3 rounded-control bg-surface-2 p-3">
      <p className="text-14 font-semibold">Older buys are missing from your log</p>
      <p className={`text-12 ${muted}`}>Until they are in, figures use your average cost; the yearly rate and the full KSE-100 comparison need them.</p>
      <ul className="mt-2 space-y-0.5 text-12" aria-label="Holdings with buys missing">
        {gaps.slice(0, GAPS_SHOWN).map((g) => (
          <li key={g.symbol} className="num flex justify-between gap-3">
            <span className="font-semibold">{g.symbol}</span>
            <span className={muted}>{num(g.held, 0)} held · {num(g.logged, 0)} in the log</span>
          </li>
        ))}
        {gaps.length > GAPS_SHOWN && <li className={muted}>and {gaps.length - GAPS_SHOWN} more</li>}
      </ul>
      <Button kind="ghost" className="-ml-2 mt-1" onClick={onTransactions}>Add them in Buys and sells<Icon name="chevron" className="h-4 w-4" /></Button>
    </div>
  );
}

/** One expected dividend: the declared figures, the tax taken at source, and the button that turns it into a receipt. */
function ExpectedRow({ e, busy, onReceived }: { e: ExpectedDividend; busy: boolean; onReceived: () => void }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 font-medium">{e.symbol}{!e.verified && <Chip kind="caution">Unverified</Chip>}</span>
        <span className="num block text-12 text-ink">{rs2(e.dps)}/share × {num(e.shares, 0)} = {rs(e.gross)}</span>
        <span className={`num block text-12 ${muted}`}>
          net {rs(e.net)} after {e.wht_pct}% tax · book closure {day(e.book_closure_from)}{e.basis === 'holdings' ? ' · shares from your holdings' : ''}
        </span>
      </span>
      <Button kind="secondary" className="shrink-0" disabled={busy} onClick={onReceived}>Received</Button>
    </li>
  );
}

const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;
const OTHER = '__other__';

/**
 * Record a dividend by hand, or correct one: symbol, date, shares, rupees per share and the withholding rate; gross
 * and net update as you type. From an expected dividend the shares are those held at book closure. The credit date
 * is never filled in for you: it decides the tax year and the return, so it must be the real one.
 */
function ReceiptForm({ form, holdings, today, filer, sectorFor, busy, onSave, onCancel }: {
  form: FormState; holdings: Holding[]; today: string; filer: boolean; sectorFor: (symbol: string) => string | null; busy: boolean;
  onSave: (r: DividendReceipt) => void; onCancel: () => void;
}) {
  const { prefill, editing, bookClosure } = form;
  const sorted = useMemo(() => [...holdings].sort((a, b) => a.symbol.localeCompare(b.symbol)), [holdings]);
  const first = prefill ? sorted.find((h) => h.symbol === prefill.symbol) ?? null : sorted[0];
  const [pick, setPick] = useState(prefill && !first ? OTHER : first ? first.symbol : OTHER);
  const [other, setOther] = useState(prefill && !first ? prefill.symbol : '');
  const [paidOn, setPaidOn] = useState(editing?.paid_on ?? '');
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
    if (paidOn > today) return setErr('The credit date cannot be after today.');
    if (!(sharesN > 0)) return setErr('Shares must be more than 0.');
    if (!(dpsN > 0)) return setErr('Rupees per share must be more than 0.');
    if (gross == null || net == null) return setErr('Withholding tax must be between 0 and 100%.');
    setErr(null);
    onSave({ symbol, paid_on: paidOn, shares: sharesN, dps: dpsN, gross, wht_pct: whtN, net, dividend_id: prefill?.dividend_id ?? null, note: editing?.note ?? null });
  }

  const title = editing ? `Edit the ${editing.symbol} dividend` : 'Add a dividend';
  return (
    <form className="space-y-3 rounded-control bg-surface-2 p-3" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={title}>
      <h4 className="text-16 font-semibold">{title}</h4>
      <Field label="Symbol">
        <select className={inputCls} value={pick} onChange={(e) => choose(e.target.value)} disabled={!!editing}>
          {sorted.map((h) => <option key={h.symbol} value={h.symbol}>{h.symbol}</option>)}
          <option value={OTHER}>Another symbol</option>
        </select>
      </Field>
      {pick === OTHER && (
        <Field label="Symbol (type it)">
          <input className={`${inputCls} uppercase`} value={other} autoCapitalize="characters" placeholder="e.g. MARI" disabled={!!editing} onChange={(e) => typeOther(e.target.value)} />
        </Field>
      )}
      <Field label="Credited on (required)" hint={bookClosure
        ? `The date on the credit advice or bank statement. Book closure started ${day(bookClosure)}; the credit comes after it.`
        : 'The date on the credit advice or bank statement, not today.'}>
        <input type="date" required className={inputCls} value={paidOn} min={bookClosure ?? undefined} max={today} onChange={(e) => setPaidOn(e.target.value)} />
      </Field>
      <Segmented label="What you know" value={mode} onChange={setMode}
        options={[{ value: 'dps', label: 'Rs per share' }, { value: 'net', label: 'Amount credited' }]} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Shares held" hint={bookClosure ? 'At book closure' : undefined}>
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
      <p className="num text-14" aria-live="polite">
        {gross == null ? <span className={muted}>Gross and net appear once shares and rupees per share are in.</span>
          : <>{sharesN} × {rs2(dpsN)} = gross <span className="font-semibold">{rs2(gross)}</span> · net <span className="font-semibold">{rs2(net)}</span> after {whtN}% tax</>}
      </p>
      <ErrorNote error={err} />
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={busy}>{editing ? 'Save changes' : 'Save'}</Button>
        <Button kind="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

/** One ledger line: label on the left, the figure (and an optional note under it) on the right. */
function Row({ label, value, tone = '', note }: { label: ReactNode; value: string; tone?: string; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className={`text-14 ${muted}`}>{label}</span>
      <span className="min-w-0 text-right">
        <span className={`num block text-14 font-semibold ${tone}`}>{value}</span>
        {note && <span className={`block text-12 ${muted}`}>{note}</span>}
      </span>
    </div>
  );
}

const W = 300;
const H = 140;
const PAD = 6;

/**
 * Your value (solid, info colour), the same money in the KSE-100 (dashed grey) and the money put in (dotted), one point per
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
  const label = `Your money vs the KSE-100 from ${day(series[0].day)} to ${day(last.day)}: put in ${rs(last.invested)}, the same money in the index ${orNa(last.index_value)}, your value ${lastMine ? `${rs(lastMine.v)} on ${day(series[lastMine.i].day)}` : `${rs(todayValue)} today, before the first daily snapshot`}.`;

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
      <p className="num text-12 text-ink" aria-live="polite">
        <span className="font-semibold">{day(p.day)}</span> · you {orNa(p.my_value)} · index {orNa(p.index_value)} · put in {rs(p.invested)}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-36 w-full touch-pan-y" role="img" aria-label={label}
        onPointerDown={pick} onPointerMove={pick} onPointerUp={stop} onPointerCancel={stop}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setAt(null); }}>
        {indexPts.length > 1 && <polyline points={path(indexPts)} fill="none" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" className="stroke-muted opacity-70" />}
        <polyline points={path(investedPts)} fill="none" strokeWidth="2.2" strokeDasharray="0.1 4.5" strokeLinecap="round" strokeLinejoin="round" className="stroke-ink" />
        {mine.length > 1 ? (
          <polyline points={path(mine)} fill="none" strokeWidth="2.5" className="stroke-info" strokeLinejoin="round" strokeLinecap="round" />
        ) : mine.length === 1 ? (
          <circle cx={x(mine[0].i)} cy={y(mine[0].v)} r="4" className="fill-info" />
        ) : (
          <circle cx={x(n - 1)} cy={y(todayValue)} r="4.5" strokeWidth="2" className="fill-info stroke-surface" />
        )}
        {at != null && (
          <>
            <line x1={x(idx)} x2={x(idx)} y1={PAD} y2={H - PAD} strokeWidth="1" className="stroke-muted" />
            {p.index_value != null && <circle cx={x(idx)} cy={y(p.index_value)} r="3.5" className="fill-muted" />}
            <circle cx={x(idx)} cy={y(p.invested)} r="3.5" className="fill-ink" />
            {p.my_value != null && <circle cx={x(idx)} cy={y(p.my_value)} r="4" className="fill-info" />}
          </>
        )}
      </svg>
      <div className={`flex items-center justify-between text-12 ${muted}`}>
        <span>{day(series[0].day)}</span>
        <span>{day(last.day)}</span>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-12 text-ink" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="h-0.5 w-5 rounded bg-info" aria-hidden="true" />You (solid)</li>
        <li className="flex items-center gap-1.5"><span className="w-5 border-t-2 border-dashed border-muted opacity-70" aria-hidden="true" />KSE-100, same money (dashed)</li>
        <li className="flex items-center gap-1.5"><span className="w-5 border-t-2 border-dotted border-ink" aria-hidden="true" />Put in (dotted)</li>
      </ul>
      {!mine.length && <p className={`mt-1.5 text-12 ${muted}`}>Your daily values start with tonight's check; the dot is today's value.</p>}
    </div>
  );
}
