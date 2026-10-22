/** News helpers shared by the night digest and the News screen. */
import type { Announcement, AnnouncementMetrics, DividendEvent, EpsBasis, Holding, Rules, Txn } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { bookClosureDate, buyByDate, type TradingCalendar } from './calendar.ts';
import { day } from './format.ts';
import { heldAtBookClosure, whtPct } from './performance.ts';

/** One filing per symbol and title (PSX often posts the same notice twice). */
export function dedupeFilings<T extends Pick<Announcement, 'symbol' | 'title'>>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = `${a.symbol}|${a.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Group items under the app's date words ("Today", "Yesterday", "Tue", "Sep 1"), newest group first. */
export function groupByDay<T>(items: T[], dayOf: (t: T) => string, today: string): { label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const it of items) groups.set(dayOf(it), [...(groups.get(dayOf(it)) ?? []), it]);
  const now = new Date(today + 'T12:00:00Z'); // midday UTC is the same calendar day in PKT
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, list]) => ({ label: day(d, now), items: list }));
}

/** PSX titles are often ALL CAPS; show them in headline case (names stay readable), keeping the ticker as is. */
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
export function tidyTitle(title: string, symbol: string): string {
  const letters = title.replace(/[^A-Za-z]/g, '');
  if (!letters || letters.replace(/[^A-Z]/g, '').length / letters.length < 0.8) return title;
  return title.toLowerCase().split(/(\s+)/).map((w, i) => {
    if (w.replace(/[^a-z0-9]/g, '').toUpperCase() === symbol) return w.toUpperCase();
    if (i > 0 && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}

/**
 * Text cut to at most `max` characters (plus "…") at a word boundary, never inside a word; a dangling small word
 * ("of", "the") or punctuation before the cut goes too. A single word longer than `max` is kept whole.
 */
export function cutAtWord(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const words = t.split(' ');
  const kept: string[] = [];
  let len = 0;
  for (const w of words) {
    if (kept.length && len + 1 + w.length > max) break;
    if (!kept.length && w.length > max) return w;
    len += (kept.length ? 1 : 0) + w.length;
    kept.push(w);
  }
  while (kept.length > 1 && SMALL.has(kept[kept.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) kept.pop();
  return `${kept.join(' ').replace(/[\s,;:.\-–|(]+$/, '')}…`;
}

/** Notices so common and so long that a plain rewrite reads better than any cut. */
const REWRITES: [RegExp, string][] = [
  [/^disclosure of interest by a director/i, 'Shares traded by a director, officer or major shareholder'],
];
/** Filler PSX puts in front of the real subject: "Transmission of", "Publication of notices for the", ... */
const LEAD_RE = /^(?:(?:newspaper\s+)?advertisement|transmission|submission|publication|intimation|notification|certified true copy)\s+(?:of|for|regarding|about)\s+(?:the\s+)?(?:notices?\s+(?:of|for)\s+(?:the\s+)?)?/i;
/** "u/c 5.6.1.(d) of PSX Regulations" and similar references to the rule a notice is filed under. */
const REG_RE = /\s*\(?\bu\/c\s+[\d.()a-z]+\s+of\s+(?:the\s+)?PSX\s+(?:Rule\s*Book|Regulations)\)?/gi;
/** Internal notice codes in brackets: "(D-46)". */
const CODE_RE = /\s*\([A-Z]{1,3}-?\d+\)/g;
/** A trailing " - The Hub Power Company Limited" (the company is already on the card). */
const TAIL_RE = /\s+[-–|]\s*(?:the\s+)?[^-–|]*\b(?:limited|ltd\.?|company|corporation|bank|reit|fund)\s*$/i;

/**
 * The line a News card leads with: the AI's headline when there is one, else the filing title with PSX's filler
 * removed (lead-in, regulation reference, notice code, trailing company name, a repeat of the ticker), in headline
 * case and cut at a word boundary to `max` characters.
 */
export function cleanHeadline(title: string, symbol: string, aiHeadline?: string | null, max = 80): string {
  if (aiHeadline?.trim()) return cutAtWord(aiHeadline.trim(), max);
  const raw = title.replace(/\s+/g, ' ').trim();
  for (const [re, text] of REWRITES) if (re.test(raw)) return text;
  let t = raw
    .replace(new RegExp(`^${symbol.replace(/[^A-Za-z0-9]/g, '')}\\s*[|:–-]\\s*`, 'i'), '')
    .replace(REG_RE, '')
    .replace(CODE_RE, '')
    .replace(LEAD_RE, '')
    .replace(TAIL_RE, '')
    .trim();
  if (!t) t = raw;
  t = tidyTitle(t, symbol);
  return cutAtWord(t.charAt(0).toUpperCase() + t.slice(1), max);
}

export interface MetricChip { key: 'eps' | 'dps' | 'profit'; label: string; value?: string; note?: string; change?: number }

const BASIS_WORD: Partial<Record<EpsBasis, string>> = { consolidated: 'consolidated', unconsolidated: 'unconsolidated' };
const money = (v: number, digits: number) => `${v < 0 ? '−' : ''}Rs ${Math.abs(v).toFixed(digits)}`;
const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Up to three figures for a News card from a filing's structured metrics: EPS with its basis word (none when the
 * basis is not stated), cash dividend per share (a 0 is no dividend, not a chip), and profit vs the same period last
 * year (the screen draws it with an arrow).
 */
export function metricChips(m: AnnouncementMetrics | null | undefined): MetricChip[] {
  if (!m) return [];
  const out: MetricChip[] = [];
  if (fin(m.eps)) {
    const note = m.eps_basis ? BASIS_WORD[m.eps_basis] : undefined;
    out.push({ key: 'eps', label: 'EPS', value: money(m.eps, 2), ...(note ? { note } : {}) });
  }
  if (fin(m.dps) && m.dps > 0) out.push({ key: 'dps', label: 'Dividend', value: `Rs ${Number(m.dps.toFixed(2))}/share` });
  if (fin(m.profit_change_pct)) out.push({ key: 'profit', label: 'Profit vs last year', change: m.profit_change_pct });
  return out;
}

type Figure = NonNullable<Announcement['ai_figures']>[number];

/** An older filing's AI figures for its card: no repeats, labels cut at a word boundary, at most `max`. */
export function cleanFigures(figs: Announcement['ai_figures'], max = 3, labelMax = 24): Figure[] {
  const seen = new Set<string>();
  const out: Figure[] = [];
  for (const f of figs ?? []) {
    const label = cutAtWord(f.label, labelMax);
    const key = `${label.toLowerCase()}|${f.value.trim().toLowerCase()}`;
    if (!f.value.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...f, label });
    if (out.length >= max) break;
  }
  return out;
}

export interface DividendImpact {
  shares: number; // held at book closure (heldAtBookClosure)
  basis: 'log' | 'holdings';
  dps: number;
  wht_pct: number;
  net: number; // shares x dps less withholding tax
  book_closure: string;
  buy_by: string | null; // last day to buy more and still get it; null once that day has gone
  past: boolean; // book closure has started
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * "Impact on you" for a dividend filing: the cash after withholding tax on the shares held at book closure
 * (performance.heldAtBookClosure, so a holding imported without its buys still counts), with the book closure day
 * and the last day to buy. Dividend per share from the filing's metrics, else its dividend row; book closure from
 * the dividend row, else the date the notice names (calendar.bookClosureDate). Null when the user holds none or
 * either figure is missing.
 */
export function dividendImpact(a: Announcement, o: {
  events: DividendEvent[]; txns: Txn[]; holdings: Pick<Holding, 'symbol' | 'shares'>[]; sector: string | null | undefined;
  filer: boolean; today: string; cal: TradingCalendar; rules?: Rules;
}): DividendImpact | null {
  const rules = o.rules ?? DEFAULT_RULES;
  const event = o.events.find((e) => e.id === a.id);
  const dps = fin(a.ai_metrics?.dps) && a.ai_metrics.dps > 0 ? a.ai_metrics.dps : event?.dps;
  if (!fin(dps) || dps <= 0) return null;
  const bc = event?.book_closure_from || bookClosureDate(a, rules);
  if (!bc) return null;
  const { shares, basis } = heldAtBookClosure(a.symbol, bc, o.txns, o.holdings);
  if (shares <= 0) return null;
  const wht_pct = whtPct(o.sector, o.filer, rules);
  const gross = shares * dps;
  const past = bc <= o.today;
  const buyBy = past ? null : buyByDate(bc, o.cal, rules);
  return { shares, basis, dps, wht_pct, net: r2(gross - (gross * wht_pct) / 100), book_closure: bc, buy_by: buyBy && buyBy >= o.today ? buyBy : null, past };
}
