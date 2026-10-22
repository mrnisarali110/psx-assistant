/**
 * Sell Planner (FEATURE-10): pick holdings and quantities, see the FIFO gain or loss per stock, this plan's net,
 * the tax year after it, the capital gains tax NCCPL will take next month, and which losing holdings would cut it.
 * Everything is an estimate from the user's own transaction log and tax settings; NCCPL computes the real figure.
 */
import { useMemo, useState } from 'react';
import type { PortfolioView } from '../../shared/portfolio.ts';
import { buildLots, planSales, suggestOffsets, taxYear, type LotBook, type PlannedSale } from '../../shared/tax.ts';
import { tradeCosts, costRates } from '../../shared/costs.ts';
import { rs, rs2, signedRs } from '../../shared/format.ts';
import { pktDate } from '../../shared/time.ts';
import type { Settings, Txn } from '../../shared/types.ts';
import { CallChip } from './Holding.tsx';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Button, Change, Toggle, inputCls } from './ui.tsx';

interface Pick { on: boolean; shares: string; price: string }

/** Loss-making holdings the planner may suggest as offsets: under review, marked Trim, or past their review date. Tax alone never drives a sale. */
function offsetCandidates(view: PortfolioView, chosen: Set<string>) {
  return view.rows
    .filter((r) => !chosen.has(r.holding.symbol) && r.price?.price != null && (r.pnl ?? 0) < 0 && (r.holding.status === 'review' || r.call.call === 'trim' || r.call.call === 'sell' || r.call.call === 'review'))
    .map((r) => ({ symbol: r.holding.symbol, shares: r.holding.shares, price: r.price!.price as number, avg_cost: r.holding.avg_cost, bought_on: r.holding.last_buy_on ?? null }));
}

export function SellPlanner({ open, onClose, view, txns, settings, preselect }: {
  open: boolean; onClose: () => void; view: PortfolioView; txns: Txn[]; settings: Settings; preselect?: string | null;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Plan a sale">
      {open && <PlannerBody key={preselect ?? ''} view={view} txns={txns} settings={settings} preselect={preselect} />}
    </Sheet>
  );
}

function PlannerBody({ view, txns, settings, preselect }: { view: PortfolioView; txns: Txn[]; settings: Settings; preselect?: string | null }) {
  const today = pktDate(new Date());
  const year = taxYear(today);
  const rows = view.rows.filter((r) => r.price?.price != null);
  const [picks, setPicks] = useState<Record<string, Pick>>(() => Object.fromEntries(rows.map((r) => [r.holding.symbol, {
    on: r.holding.symbol === preselect, shares: String(r.holding.shares), price: (r.price!.price as number).toFixed(2),
  }])));
  const [help, setHelp] = useState(false);
  const book: LotBook = useMemo(() => buildLots(txns, settings), [txns, settings]);
  const plan: PlannedSale[] = rows
    .filter((r) => picks[r.holding.symbol]?.on)
    .map((r) => ({ symbol: r.holding.symbol, shares: Number(picks[r.holding.symbol].shares), price: Number(picks[r.holding.symbol].price), avg_cost: r.holding.avg_cost, bought_on: r.holding.last_buy_on ?? null }))
    .filter((p) => Number.isInteger(p.shares) && p.shares > 0 && p.price > 0);
  const result = useMemo(() => (plan.length ? planSales(book, plan, today, settings) : null), [book, plan, today, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = new Set(plan.map((p) => p.symbol));
  const offsets = useMemo(() => (result ? suggestOffsets(book, plan, offsetCandidates(view, chosen), today, settings) : []), [book, plan, view, today, settings, result]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (symbol: string, patch: Partial<Pick>) => setPicks((p) => ({ ...p, [symbol]: { ...p[symbol], ...patch } }));
  const rates = costRates(settings);
  const lineOf = (symbol: string) => result?.lines.find((l) => l.symbol === symbol);
  const unlogged = book.warnings.length > 0;
  const noLog = txns.length === 0;

  return (
    <div className="space-y-4 pb-2">
      <p className="text-14 text-muted">
        Tick what you would sell. Gains are matched against your oldest shares first (FIFO), the way NCCPL does, and netted across all your sales in tax year {year}.
      </p>
      {noLog && <p className="rounded-control bg-caution/10 p-3 text-14 text-ink">No buys are recorded yet, so every sale would count at the sell price (zero gain). Record your buys (or import a CSV) for a real figure.</p>}

      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const s = r.holding.symbol;
          const p = picks[s];
          const line = lineOf(s);
          return (
            <li key={s} className="py-2.5">
              <div className="flex items-center gap-3">
                <Toggle checked={p.on} onChange={(on) => set(s, { on })} label={`Sell ${s}`} />
                <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => set(s, { on: !p.on })}>
                  <span className="flex items-center gap-1.5 font-semibold">{s}{(r.call.call === 'trim' || r.call.call === 'sell' || r.call.call === 'review') && <CallChip call={r.call} />}</span>
                  <span className="num block text-12 text-muted">{r.holding.shares} shares · {rs2(r.price!.price)} · {signedRs(r.pnl)} unrealised</span>
                </button>
                {p.on && line && (
                  <span className="num shrink-0 text-right">
                    <Change kind="rs" value={line.gain} className="block text-14 font-semibold" label="gain" />
                    <span className="block text-12 text-muted">{line.from_average_cost > 0 ? 'estimate · ' : ''}{line.rate_pct}% rate</span>
                  </span>
                )}
              </div>
              {p.on && (
                <div className="mt-2 grid grid-cols-2 gap-2 pl-16">
                  <label className="block text-12 text-muted">Shares
                    <input className={`${inputCls} num mt-0.5`} inputMode="numeric" value={p.shares} max={r.holding.shares} onChange={(e) => set(s, { shares: e.target.value })} aria-label={`${s} shares to sell`} />
                  </label>
                  <label className="block text-12 text-muted">Sell price (Rs)
                    <input className={`${inputCls} num mt-0.5`} inputMode="decimal" value={p.price} onChange={(e) => set(s, { price: e.target.value })} aria-label={`${s} sell price`} />
                  </label>
                  {line?.warning && <p className="col-span-2 text-12 text-caution">{line.warning}</p>}
                  {line && Number(p.shares) > r.holding.shares && <p className="col-span-2 text-12 font-semibold text-caution">You hold {r.holding.shares} shares.</p>}
                </div>
              )}
            </li>
          );
        })}
        {!rows.length && <li className="py-4 text-center text-14 text-muted">No priced holdings to plan with.</li>}
      </ul>

      {result ? (
        <div className="space-y-3 rounded-card bg-surface-2 p-4" role="status">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="This plan, net" value={<Change kind="rs" value={result.net_gain} />} />
            <Stat label={`Tax year ${year} after it`} value={<Change kind="rs" value={result.year_after.net} />} />
            <Stat label="Estimated CGT this year" value={rs(result.year_after.cgt_estimate)} sub={result.cgt_change !== 0 ? `${signedRs(result.cgt_change)} from this plan` : 'no change from this plan'} />
            <Stat label="Cash NCCPL takes next month" value={rs(result.cgt_next_month)} sub={result.year_after.cgt_paid > 0 ? `${rs(result.year_after.cgt_paid)} already deducted` : undefined} />
          </div>
          <p className="num text-14">You receive about <b>{rs(result.proceeds_net)}</b> after {rs(plan.reduce((a, p) => a + tradeCosts(p.shares, p.price, rates).total, 0))} in charges.
            {result.year_after.cgt_due < 0 && <> NCCPL would owe you a refund of about {rs(-result.year_after.cgt_due)} after this.</>}
          </p>
          {result.year_after.carry_forward_in > 0 && <p className="text-12 text-muted">{rs(result.year_after.carry_forward_in)} of losses carried from earlier years offset gains first.</p>}
          {result.year_after.mixed_rates && <p className="text-12 text-muted">Lots bought in different years carry different rates ({result.year_after.rates_used.join('% / ')}%); the estimate nets losses against the highest rate first.</p>}
          {result.year_after.loss_to_carry > 0 && <p className="text-12 text-muted">A net loss of {rs(result.year_after.loss_to_carry)} would carry forward for 3 tax years (filers).</p>}
        </div>
      ) : <p className="text-14 text-muted">Nothing ticked yet.</p>}

      {offsets.length > 0 && (
        <div className="space-y-2">
          <p className="text-12 font-semibold uppercase tracking-wide text-muted">Also worth a look</p>
          {offsets.map((o) => (
            <button key={o.symbol} type="button" onClick={() => set(o.symbol, { on: true, shares: String(o.shares), price: o.price.toFixed(2) })}
              className="press flex w-full cursor-pointer items-start gap-2 rounded-control bg-surface-2 p-3 text-left text-14 ring-1 ring-line hover:ring-brand">
              <Icon name="scale" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <span>{o.text} <span className="text-12 text-muted">Only because it is already marked for review or trim.</span></span>
            </button>
          ))}
        </div>
      )}
      {unlogged && <p className="text-12 text-caution">{book.warnings[0]}</p>}

      <button type="button" onClick={() => setHelp(!help)} aria-expanded={help} className="flex min-h-11 w-full cursor-pointer items-center justify-between text-14 font-semibold text-brand">
        How capital gains tax works on PSX<Icon name="chevron" className={`h-4 w-4 transition-transform ${help ? 'rotate-90' : ''}`} />
      </button>
      {help && (
        <div className="space-y-2 text-14 text-muted">
          <p>NCCPL matches each sale against your oldest shares (FIFO), nets gains and losses across every stock within the tax year (1 July to 30 June), and deducts the tax from your broker account monthly. Overpaid tax is adjusted automatically; a net loss carries forward for 3 years if you are on the Active Taxpayer List. Only realised losses count: a holding that is down reduces nothing until it is sold. Dividends are taxed separately.</p>
          <p><b>Example</b> (filer, 15%, five holdings bought after 1 July 2025: A +8,000, B +4,000, C −3,000, D −2,000, E −1,500 if sold):</p>
          <table className="num w-full text-left"><thead><tr className="text-muted"><th className="py-1 font-medium">Sell</th><th className="font-medium">Net</th><th className="font-medium">CGT</th></tr></thead>
            <tbody>
              <tr><td className="py-0.5">A + B</td><td>+12,000</td><td>Rs 1,800</td></tr>
              <tr><td className="py-0.5">A + B + C</td><td>+9,000</td><td>Rs 1,350</td></tr>
              <tr><td className="py-0.5">All five</td><td>+5,500</td><td>Rs 825</td></tr>
              <tr><td className="py-0.5">C + D + E only</td><td>−6,500</td><td>Rs 0, loss carried forward</td></tr>
            </tbody></table>
          <p>Rates here: {settings.tax_filer ? 'filer' : 'non-filer'}; change them under Profile → Broker & tax. Estimates only, not tax advice.</p>
        </div>
      )}
      <Button kind="secondary" className="w-full" onClick={() => setPicks((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, on: false }])))}>Clear</Button>
    </div>
  );
}

const Stat = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
  <div>
    <p className="text-12 text-muted">{label}</p>
    <p className="num text-20 font-bold">{value}</p>
    {sub && <p className="num text-12 text-muted">{sub}</p>}
  </div>
);
