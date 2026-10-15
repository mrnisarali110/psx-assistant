/**
 * Sell Planner (FEATURE-10): pick holdings and quantities, see the FIFO gain or loss per stock, this plan's net,
 * the tax year after it, the capital gains tax NCCPL will take next month, and which losing holdings would cut it.
 * Everything is an estimate from the user's own transaction log and tax settings; NCCPL computes the real figure.
 */
import { useMemo, useState } from 'react';
import type { PortfolioView } from '../../shared/portfolio.ts';
import { buildLots, planSales, suggestOffsets, taxYear, type LotBook, type PlannedSale } from '../../shared/tax.ts';
import { tradeCosts, costRates } from '../../shared/costs.ts';
import { pct, rs, rs2, signedRs } from '../../shared/format.ts';
import { pktDate } from '../../shared/time.ts';
import type { Settings, Txn } from '../../shared/types.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Button, Tag, Toggle, changeTone, inputCls } from './ui.tsx';

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
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Tick what you would sell. Gains are matched against your oldest shares first (FIFO), the way NCCPL does, and netted across all your sales in tax year {year}.
      </p>
      {noLog && <p className="rounded-2xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">No buys are recorded yet, so every sale would count at the sell price (zero gain). Record your buys (or import a CSV) for a real figure.</p>}

      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {rows.map((r) => {
          const s = r.holding.symbol;
          const p = picks[s];
          const line = lineOf(s);
          return (
            <li key={s} className="py-2.5">
              <div className="flex items-center gap-3">
                <Toggle checked={p.on} onChange={(on) => set(s, { on })} label={`Sell ${s}`} />
                <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => set(s, { on: !p.on })}>
                  <span className="flex items-center gap-1.5 font-semibold">{s}{r.call.call === 'trim' && <Tag tone="amber">Trim</Tag>}{r.call.call === 'sell' && <Tag tone="red">Sell</Tag>}{r.call.call === 'review' && <Tag tone="amber">Review</Tag>}</span>
                  <span className="num block text-xs text-slate-500 dark:text-slate-400">{r.holding.shares} shares · {rs2(r.price!.price)} · {signedRs(r.pnl)} unrealised</span>
                </button>
                {p.on && line && (
                  <span className="num shrink-0 text-right">
                    <span className={`block text-sm font-semibold ${changeTone(line.gain)}`}>{signedRs(line.gain)}</span>
                    <span className="block text-[11px] text-slate-500 dark:text-slate-400">{line.from_average_cost > 0 ? 'estimate · ' : ''}{line.rate_pct}% rate</span>
                  </span>
                )}
              </div>
              {p.on && (
                <div className="mt-2 grid grid-cols-2 gap-2 pl-16">
                  <label className="block text-xs text-slate-500 dark:text-slate-400">Shares
                    <input className={`${inputCls} num mt-0.5`} inputMode="numeric" value={p.shares} max={r.holding.shares} onChange={(e) => set(s, { shares: e.target.value })} aria-label={`${s} shares to sell`} />
                  </label>
                  <label className="block text-xs text-slate-500 dark:text-slate-400">Sell price (Rs)
                    <input className={`${inputCls} num mt-0.5`} inputMode="decimal" value={p.price} onChange={(e) => set(s, { price: e.target.value })} aria-label={`${s} sell price`} />
                  </label>
                  {line?.warning && <p className="col-span-2 text-xs text-amber-700 dark:text-amber-400">{line.warning}</p>}
                  {line && Number(p.shares) > r.holding.shares && <p className="col-span-2 text-xs text-rose-600 dark:text-rose-400">You hold {r.holding.shares} shares.</p>}
                </div>
              )}
            </li>
          );
        })}
        {!rows.length && <li className="py-4 text-center text-sm text-slate-500">No priced holdings to plan with.</li>}
      </ul>

      {result ? (
        <div className="space-y-3 rounded-3xl bg-slate-50 p-4 dark:bg-slate-800/60" role="status">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="This plan, net" value={signedRs(result.net_gain)} tone={changeTone(result.net_gain)} />
            <Stat label={`Tax year ${year} after it`} value={signedRs(result.year_after.net)} tone={changeTone(result.year_after.net)} />
            <Stat label="Estimated CGT this year" value={rs(result.year_after.cgt_estimate)} sub={result.cgt_change !== 0 ? `${signedRs(result.cgt_change)} from this plan` : 'no change from this plan'} />
            <Stat label="Cash NCCPL takes next month" value={rs(result.cgt_next_month)} sub={result.year_after.cgt_paid > 0 ? `${rs(result.year_after.cgt_paid)} already deducted` : undefined} />
          </div>
          <p className="num text-sm">You receive about <b>{rs(result.proceeds_net)}</b> after {rs(plan.reduce((a, p) => a + tradeCosts(p.shares, p.price, rates).total, 0))} in charges.
            {result.year_after.cgt_due < 0 && <> NCCPL would owe you a refund of about {rs(-result.year_after.cgt_due)} after this.</>}
          </p>
          {result.year_after.carry_forward_in > 0 && <p className="text-xs text-slate-500 dark:text-slate-400">{rs(result.year_after.carry_forward_in)} of losses carried from earlier years offset gains first.</p>}
          {result.year_after.mixed_rates && <p className="text-xs text-slate-500 dark:text-slate-400">Lots bought in different years carry different rates ({result.year_after.rates_used.join('% / ')}%); the estimate nets losses against the highest rate first.</p>}
          {result.year_after.loss_to_carry > 0 && <p className="text-xs text-slate-500 dark:text-slate-400">A net loss of {rs(result.year_after.loss_to_carry)} would carry forward for 3 tax years (filers).</p>}
        </div>
      ) : <p className="text-sm text-slate-500 dark:text-slate-400">Nothing ticked yet.</p>}

      {offsets.length > 0 && (
        <div className="space-y-2">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Also worth a look</p>
          {offsets.map((o) => (
            <button key={o.symbol} type="button" onClick={() => set(o.symbol, { on: true, shares: String(o.shares), price: o.price.toFixed(2) })}
              className="flex w-full cursor-pointer items-start gap-2 rounded-2xl bg-teal-50 p-3 text-left text-sm active:opacity-70 dark:bg-teal-950/40">
              <Icon name="scale" className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
              <span>{o.text} <span className="text-xs text-slate-500 dark:text-slate-400">Only because it is already marked for review or trim.</span></span>
            </button>
          ))}
        </div>
      )}
      {unlogged && <p className="text-xs text-amber-700 dark:text-amber-400">{book.warnings[0]}</p>}

      <button type="button" onClick={() => setHelp(!help)} aria-expanded={help} className="flex min-h-11 w-full cursor-pointer items-center justify-between text-sm font-semibold text-teal-700 dark:text-teal-400">
        How capital gains tax works on PSX<Icon name="chevron" className={`h-4 w-4 transition-transform ${help ? 'rotate-90' : ''}`} />
      </button>
      {help && (
        <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
          <p>NCCPL matches each sale against your oldest shares (FIFO), nets gains and losses across every stock within the tax year (1 July to 30 June), and deducts the tax from your broker account monthly. Overpaid tax is adjusted automatically; a net loss carries forward for 3 years if you are on the Active Taxpayer List. Only realised losses count: a holding that is down reduces nothing until it is sold. Dividends are taxed separately.</p>
          <p><b>Example</b> (filer, 15%, five holdings bought after 1 July 2025: A +8,000, B +4,000, C −3,000, D −2,000, E −1,500 if sold):</p>
          <table className="num w-full text-left"><thead><tr className="text-slate-500 dark:text-slate-400"><th className="py-1 font-medium">Sell</th><th className="font-medium">Net</th><th className="font-medium">CGT</th></tr></thead>
            <tbody>
              <tr><td className="py-0.5">A + B</td><td>+12,000</td><td>Rs 1,800</td></tr>
              <tr><td className="py-0.5">A + B + C</td><td>+9,000</td><td>Rs 1,350</td></tr>
              <tr><td className="py-0.5">All five</td><td>+5,500</td><td>Rs 825</td></tr>
              <tr><td className="py-0.5">C + D + E only</td><td>−6,500</td><td>Rs 0, loss carried forward</td></tr>
            </tbody></table>
          <p>Rates here: {settings.tax_filer ? 'filer' : 'non-filer'}; change them under Profile → Broker & tax. {pct(0, 0) && ''}Estimates only, not tax advice.</p>
        </div>
      )}
      <Button kind="secondary" className="w-full" onClick={() => setPicks((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, on: false }])))}>Clear</Button>
    </div>
  );
}

const Stat = ({ label, value, sub, tone = '' }: { label: string; value: string; sub?: string; tone?: string }) => (
  <div>
    <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
    <p className={`num text-lg font-bold ${tone}`}>{value}</p>
    {sub && <p className="num text-[11px] text-slate-500 dark:text-slate-400">{sub}</p>}
  </div>
);
