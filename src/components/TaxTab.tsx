/**
 * Tax tab: the capital gains ledger for one tax year (FIFO lots replayed from your own buys and sells, netted
 * across stocks, CGT estimated at the rates in the rules), what was sold per stock, the dividends received in
 * that year, and any gaps in the history that make the estimate shaky. Everything here is an estimate: the
 * NCCPL statement is the real figure.
 */
import { useMemo, useState } from 'react';
import type { AppData } from '../lib/data.ts';
import { DEFAULT_RULES } from '../../shared/types.ts';
import { buildLots, previousTaxYears, taxYear, taxYearBounds, taxYearLedger } from '../../shared/tax.ts';
import { pktDate } from '../../shared/time.ts';
import { day, rs, signedRs } from '../../shared/format.ts';
import { Icon } from './Icon.tsx';
import { Button, Card, Change, Chips, changeTone } from './ui.tsx';

export function TaxTab({ data, onPlanSale, onTransactions }: { data: AppData; onPlanSale: () => void; onTransactions: () => void }) {
  const today = pktDate(new Date());
  const current = taxYear(today);
  const book = useMemo(() => buildLots(data.transactions, data.settings), [data.transactions, data.settings]);
  const years = useMemo(() => {
    const others = [...new Set(book.realized.map((r) => r.tax_year))].filter((y) => y !== current).sort().reverse();
    return [current, ...others];
  }, [book, current]);
  const [year, setYear] = useState(current);
  const ledger = useMemo(() => taxYearLedger(book, year, data.settings), [book, year, data.settings]);
  const bounds = taxYearBounds(year);
  const filer = data.settings.tax_filer;
  const carryYears = DEFAULT_RULES.tax.loss_carry_forward_years;
  const wht = DEFAULT_RULES.tax.dividend_wht.default;

  const sold = ledger.by_symbol.length > 0;
  const rateNote = ledger.rates_used.length === 0 ? 'estimate'
    : ledger.mixed_rates ? `mixed rates ${ledger.rates_used.map((r) => `${r}%`).join(' / ')}, estimate`
    : `at ${ledger.rates_used[0]}%`;
  const carriedFrom = previousTaxYears(year, carryYears).filter((y) => (data.settings.loss_carry_forward?.[y] ?? 0) > 0);

  const receipts = data.receipts.filter((r) => r.paid_on >= bounds.from && r.paid_on <= bounds.to);
  const gross = receipts.reduce((a, r) => a + r.gross, 0);
  const net = receipts.reduce((a, r) => a + r.net, 0);
  const withheld = gross - net;
  const whtLine = filer
    ? `Dividends are taxed at source: ${wht.filer_pct}% for you as a filer (${wht.non_filer_pct}% for non-filers). They are not capital gains.`
    : `Dividends are taxed at source: ${wht.non_filer_pct}% for you as a non-filer (${wht.filer_pct}% for filers). They are not capital gains.`;

  // Wide screens: capital gains and dividends side by side; the year picker, actions and notes span both.
  return (
    <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0 lg:[&>*:first-child]:col-span-2">
      <Chips options={years.map((y) => ({ value: y, label: y === current ? `${y} (now)` : y }))} value={year} onChange={setYear} label="Tax year" />

      <Card>
        <h2 className="font-semibold">Capital gains, {year}</h2>
        <p className="text-12 text-muted">
          {day(bounds.from)} to {day(bounds.to)}{filer ? '' : ' · non-filer rates'}
        </p>
        {sold ? (
          <div className="mt-2 divide-y divide-line">
            <Row label="Realized gains" value={rs(ledger.gains)} />
            <Row label="Realized losses" value={signedRs(-ledger.losses)} tone={changeTone(-ledger.losses)} />
            <Row label="Net" value={signedRs(ledger.net)} tone={changeTone(ledger.net)} bold />
            {ledger.carry_forward_in > 0 && (
              <Row label="Losses carried in" value={signedRs(-ledger.carry_forward_in)} tone={changeTone(-ledger.carry_forward_in)}
                note={carriedFrom.length ? `from ${carriedFrom.join(', ')}` : undefined} />
            )}
            <Row label="Taxable" value={rs(ledger.taxable)} />
            <Row label="Estimated CGT" value={rs(ledger.cgt_estimate)} note={rateNote} />
            <Row label="CGT already deducted" value={rs(ledger.cgt_paid)} />
            {ledger.cgt_due > 0 ? (
              <Row label="Due" value={`${rs(ledger.cgt_due)} still to be deducted`} tone="text-caution" bold />
            ) : ledger.cgt_due < 0 ? (
              <Row label="Refund due" value={`NCCPL owes you about ${rs(-ledger.cgt_due)} back`} bold />
            ) : (
              <Row label="Due" value="Settled" bold />
            )}
          </div>
        ) : (
          <div className="mt-2 divide-y divide-line">
            <p className="py-1.5 text-14 text-muted">Nothing sold in {year}{year === current ? ' yet' : ''}.</p>
            {ledger.carry_forward_in > 0 && (
              <Row label="Losses carried in" value={signedRs(-ledger.carry_forward_in)} tone={changeTone(-ledger.carry_forward_in)}
                note={carriedFrom.length ? `from ${carriedFrom.join(', ')}` : undefined} />
            )}
            {ledger.cgt_paid > 0 && <Row label="CGT already deducted" value={rs(ledger.cgt_paid)} note="no sells recorded behind it" />}
          </div>
        )}
        {ledger.loss_to_carry > 0 && (
          <div className="mt-3 rounded-control bg-surface-2 p-3 text-12 text-muted">
            <p className="text-14 font-medium text-ink">
              <span className="num">{rs(ledger.loss_to_carry)}</span> of net loss carries forward for {carryYears} tax years (filers).
            </p>
            <p className="mt-0.5">Record it under Profile → Broker &amp; tax when the year ends.</p>
          </div>
        )}
      </Card>

      {sold && (
        <Card>
          <h2 className="font-semibold">By stock</h2>
          <ul className="mt-1 divide-y divide-line">
            {ledger.by_symbol.map((s) => (
              <li key={s.symbol} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block font-medium">{s.symbol}</span>
                  <span className="num block text-12 text-muted">{s.shares} share{s.shares === 1 ? '' : 's'} sold</span>
                </span>
                <Change value={s.gain} kind="rs" label={`${s.symbol} gain or loss`} className="shrink-0 font-semibold" />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="font-semibold">Dividends, {year}</h2>
        {receipts.length > 0 ? (
          <div className="mt-2 divide-y divide-line">
            <Row label="Gross" value={rs(gross)} />
            <Row label="Withholding tax" value={signedRs(-withheld)} />
            <Row label="Net received" value={rs(net)} bold />
            <Row label="Payments" value={String(receipts.length)} />
          </div>
        ) : (
          <p className="mt-2 text-14 text-muted">None recorded yet.</p>
        )}
        <p className="mt-3 text-12 text-muted">{whtLine}</p>
      </Card>

      {book.warnings.length > 0 && (
        <Card>
          <ul className="space-y-1.5" aria-label="Problems in the transaction history">
            {book.warnings.map((w, i) => (
              <li key={`${i}-${w}`} className="flex items-start gap-2 text-14 text-caution">
                <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{w}</span>
              </li>
            ))}
          </ul>
          <Button kind="secondary" className="mt-3 w-full" onClick={onTransactions}>Fix the history</Button>
        </Card>
      )}

      <Button className="w-full lg:col-span-2 lg:w-auto lg:justify-self-start" onClick={onPlanSale}>Plan a sale</Button>

      <p className="max-w-2xl px-1 text-12 text-muted lg:col-span-2">
        FIFO per stock, gains and losses netted across every stock within the tax year (1 July to 30 June), deducted monthly by NCCPL.
        Estimates from your own transaction log; the NCCPL statement is the real figure. Not tax advice.
      </p>
    </div>
  );
}

/** One ledger line: label on the left, the figure (and an optional note under it) on the right. */
function Row({ label, value, tone = '', note, bold }: { label: string; value: string; tone?: string; note?: string; bold?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className={`text-14 ${bold ? 'font-semibold' : 'text-muted'}`}>{label}</span>
      <span className="min-w-0 text-right">
        <span className={`num block ${bold ? 'text-16 font-bold' : 'text-14 font-semibold'} ${tone}`}>{value}</span>
        {note && <span className="block text-12 text-muted">{note}</span>}
      </span>
    </div>
  );
}
