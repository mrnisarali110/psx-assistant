/**
 * Home's compact holdings list: company mark, ticker, a small price line, price, the day's change and your position's
 * value. Tap opens the stock page; long press keeps the quick menu (Buy, Edit, Plan sale...).
 */
import type { HoldingView } from '../../shared/portfolio.ts';
import type { PriceDay } from '../../shared/types.ts';
import { rs, rs2 } from '../../shared/format.ts';
import { openStock } from '../lib/nav.ts';
import { useLongPress } from '../lib/gestures.ts';
import { Change, CompanyMark } from './ui.tsx';

/** Fewer stored closes than this and the row shows no line (a 2-point line says nothing). */
const MIN_POINTS = 5;
const SPARK_DAYS = 30;

/** Each symbol's last closes, oldest first, from one pass over priceDaily (which is oldest first already). */
export function closesBySymbol(days: PriceDay[], symbols: string[], keep = SPARK_DAYS): Record<string, number[]> {
  const want = new Set(symbols);
  const out: Record<string, number[]> = {};
  for (const d of days) {
    if (!want.has(d.symbol) || !Number.isFinite(d.close)) continue;
    (out[d.symbol] ??= []).push(d.close);
  }
  for (const s of Object.keys(out)) out[s] = out[s].slice(-keep);
  return out;
}

export function HoldingsList({ rows, priceDaily, onMenu }: { rows: HoldingView[]; priceDaily: PriceDay[]; onMenu: (symbol: string) => void }) {
  const closes = closesBySymbol(priceDaily, rows.map((r) => r.holding.symbol));
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => <Row key={r.holding.symbol} row={r} closes={closes[r.holding.symbol] ?? []} onMenu={onMenu} />)}
    </ul>
  );
}

function Row({ row, closes, onMenu }: { row: HoldingView; closes: number[]; onMenu: (symbol: string) => void }) {
  const sym = row.holding.symbol;
  const press = useLongPress(() => onMenu(sym));
  const price = row.price?.price ?? null;
  const change = row.price?.change_pct ?? null;
  const said = [sym, price != null ? rs2(price) : 'no price yet',
    change != null ? `${change > 0 ? 'up' : change < 0 ? 'down' : 'unchanged'} ${Math.abs(change).toFixed(1)}%` : null,
    row.value != null ? `position ${rs(row.value)}` : null].filter(Boolean).join(', ');
  return (
    <li>
      <button type="button" {...press.handlers} onClick={() => { if (!press.consumed()) openStock(sym); }} aria-label={said}
        className="no-callout press flex min-h-14 w-full cursor-pointer items-center gap-3 py-2 text-left">
        <CompanyMark symbol={sym} sector={row.sector} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-16 font-semibold">{sym}</span>
          <span className="block truncate text-12 text-muted">{row.value != null ? rs(row.value) : `${row.holding.shares} shares`}</span>
        </span>
        <MiniLine values={closes} />
        <span className="w-24 shrink-0 text-right">
          <span className="block text-14 font-semibold">{price != null ? rs2(price) : 'No price yet'}</span>
          <Change value={change} className="text-12 font-semibold" />
        </span>
      </button>
    </li>
  );
}

/** The last month of closes as a thin line, coloured by its direction; a fixed-size gap when there are too few. */
function MiniLine({ values }: { values: number[] }) {
  if (values.length < MIN_POINTS) return <span aria-hidden="true" className="w-14 shrink-0" />;
  const w = 56, h = 24;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const first = values[0], last = values[values.length - 1];
  const tone = last > first ? 'text-up' : last < first ? 'text-down' : 'text-muted';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`h-6 w-14 shrink-0 ${tone}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
