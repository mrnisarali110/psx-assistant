/**
 * Transactions as CSV: the template people fill in, a tolerant parser (comma or semicolon, quotes, LF / CRLF / CR,
 * a BOM, column aliases, several date formats, decimal commas in semicolon files), duplicate detection against what
 * is already recorded, and export in the same shape. Pure: no DOM, no Node, so it runs in the app and in tests.
 */
import { baseSymbol } from './symbols.ts';
import { pktDate } from './time.ts';
import type { Txn } from './types.ts';

type Column = 'date' | 'symbol' | 'side' | 'shares' | 'price' | 'charges';
const COLUMNS: Column[] = ['date', 'symbol', 'side', 'shares', 'price', 'charges'];
const REQUIRED: Column[] = ['date', 'symbol', 'side', 'shares', 'price'];

/** Header + two example rows, in the column order the parser and the export use. Charges may be left blank. */
export const TXN_CSV_TEMPLATE = [
  COLUMNS.join(','),
  '2026-10-06,MEBL,buy,8,548.11,9.45',
  '2026-09-22,SYS,sell,10,120.50,',
].join('\n') + '\n';

/** Header names accepted for each column, after normalisation (lower case, punctuation and underscores → one space). */
const ALIASES: Record<Column, string[]> = {
  date: ['date', 'executed on', 'executed', 'trade date', 'traded on', 'transaction date'],
  symbol: ['symbol', 'scrip', 'ticker', 'stock', 'security'],
  side: ['side', 'type', 'buy/sell', 'buy sell', 'transaction type', 'trade type', 'action'],
  shares: ['shares', 'qty', 'quantity', 'volume', 'no of shares', 'number of shares'],
  price: ['price', 'rate', 'unit price', 'price per share', 'avg price', 'average price'],
  charges: ['charges', 'commission', 'fees', 'fee', 'costs', 'brokerage'],
};

/** A Map, not an object literal: a side of "constructor" or "__proto__" must not find Object.prototype. */
const SIDES = new Map<string, Txn['side']>([
  ['buy', 'buy'], ['b', 'buy'], ['purchase', 'buy'], ['bought', 'buy'],
  ['sell', 'sell'], ['s', 'sell'], ['sale', 'sell'], ['sold', 'sell'],
]);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const r2 = (v: number) => Math.round(v * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const normHeader = (s: string) => s.trim().toLowerCase().replace(/[.\s_-]+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------
interface Rec { line: number; cells: string[] }

/** Comma unless the header line has more semicolons than commas (European spreadsheet exports). */
function detectDelimiter(text: string): ',' | ';' {
  const first = text.split(/\r\n|\r|\n/).find((l) => l.trim() !== '') ?? '';
  const commas = (first.match(/,/g) ?? []).length;
  const semis = (first.match(/;/g) ?? []).length;
  return semis > commas ? ';' : ',';
}

/**
 * Records with the file line they start on (1 = first line). A record ends on LF, CRLF or a lone CR (classic Mac /
 * Excel "CSV (Macintosh)"). Quotes may wrap a cell, "" is a literal quote, line breaks inside quotes stay in the cell.
 */
function tokenise(text: string, delim: string): Rec[] {
  const out: Rec[] = [];
  let cells: string[] = [];
  let cell = '';
  let blank = true; // nothing but whitespace in `cell` so far (a quote may still open it); a flag so the scan stays linear
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRecord = () => { cells.push(cell); out.push({ line: start, cells }); cells = []; cell = ''; blank = true; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const crlf = ch === '\r' && text[i + 1] === '\n';
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (ch === '\n' || (ch === '\r' && !crlf)) line++;
        cell += ch;
      }
    } else if (ch === '"' && blank) { quoted = true; cell = ''; blank = false; }
    else if (ch === delim) { cells.push(cell); cell = ''; blank = true; }
    else if (ch === '\n' || ch === '\r') { if (crlf) i++; endRecord(); line++; start = line; }
    else { cell += ch; if (blank && ch !== ' ' && ch !== '	') blank = false; }
  }
  if (cell !== '' || cells.length) endRecord();
  return out;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------
function monthNumber(name: string): number {
  const n = name.toLowerCase();
  if (n.length < 3) return 0;
  return MONTHS.findIndex((m) => m.startsWith(n)) + 1;
}

/** YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, "6 Oct 2026", "06-Oct-2026", "Oct 6, 2026" → YYYY-MM-DD, else null. */
function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y = 0, m = 0, d = 0;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else if ((r = /^(\d{1,2})[\s-]+([a-z]+)[\s,-]+(\d{4})$/i.exec(s))) { d = +r[1]; m = monthNumber(r[2]); y = +r[3]; }
  else if ((r = /^([a-z]+)[\s-]+(\d{1,2}),?[\s-]+(\d{4})$/i.exec(s))) { m = monthNumber(r[1]); d = +r[2]; y = +r[3]; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso; // 31 Feb and friends
}

/**
 * "1,234.5", "Rs 548.11" → number; null when it is not one (blank is the caller's business). A comma followed by one
 * or two digits is a decimal comma ("548,11": no thousands group is that short), and in a semicolon-delimited file,
 * which is what spreadsheets write in decimal-comma locales, every comma is one and dots group thousands ("1.234,56";
 * "1.000" with no comma is a thousand there, while "548.11" keeps its decimal point: PSX prices have two decimals).
 * A cell with a comma that fits neither reading ("12.34,5") is not a number rather than a guess.
 */
function parseNum(raw: string, decimalComma: boolean): number | null {
  const s = raw.trim().replace(/^(rs|pkr)\.?\s*/i, '').replace(/\s+/g, '');
  if (s === '') return null;
  let plain: string;
  if (decimalComma ? s.includes(',') : /,\d{1,2}$/.test(s)) {
    if (!/^[-+]?\d+(\.\d{3})*,\d+$/.test(s)) return null;
    plain = s.replace(/\./g, '').replace(',', '.');
  } else if (decimalComma && /^[-+]?[1-9]\d{0,2}(\.\d{3})+$/.test(s)) {
    plain = s.replace(/\./g, ''); // "1.000" shares in a semicolon file: dots group thousands
  } else {
    plain = s.replace(/,/g, ''); // thousands separators, including lakh grouping "1,00,000"
  }
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

function mapHeader(cells: string[]): Partial<Record<Column, number>> {
  const map: Partial<Record<Column, number>> = {};
  cells.forEach((cell, i) => {
    const name = normHeader(cell);
    const col = COLUMNS.find((c) => map[c] == null && ALIASES[c].includes(name));
    if (col) map[col] = i;
  });
  return map;
}

interface RowContext { decimalComma: boolean; today: string }

/** One data record → a transaction, or the reason it is unusable (the caller prefixes the line number). */
function parseRow(cells: string[], cols: Partial<Record<Column, number>>, ctx: RowContext): Txn | string {
  const get = (c: Column) => { const i = cols[c]; return i == null ? '' : (cells[i] ?? '').trim(); };
  const num = (raw: string) => parseNum(raw, ctx.decimalComma);
  const rawDate = get('date');
  const executed_on = parseDate(rawDate);
  if (!executed_on) return rawDate ? `date "${rawDate}" not understood (use YYYY-MM-DD, DD/MM/YYYY or 6 Oct 2026)` : 'date is blank';
  if (executed_on > ctx.today) return `date "${rawDate}" is after today (${ctx.today})`;
  const rawSymbol = get('symbol');
  const symbol = baseSymbol(rawSymbol);
  if (!symbol) return 'symbol is blank';
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return `symbol "${rawSymbol}" is not a PSX symbol (letters and numbers, like MEBL)`;
  const rawSide = get('side');
  const side = SIDES.get(rawSide.toLowerCase());
  if (!side) return rawSide ? `side "${rawSide}" not understood (use buy or sell)` : 'side is blank (buy or sell)';
  const rawShares = get('shares');
  const shares = num(rawShares);
  if (shares == null || !Number.isInteger(shares) || shares <= 0) return `shares "${rawShares}" must be a whole number above 0`;
  const rawPrice = get('price');
  const price = num(rawPrice);
  if (price == null || price <= 0) return `price "${rawPrice}" must be a number above 0`;
  const rawCharges = get('charges');
  const charges = rawCharges === '' ? null : num(rawCharges);
  if (rawCharges !== '' && (charges == null || charges < 0)) return `charges "${rawCharges}" must be a number, or blank to estimate`;
  return { symbol, side, shares, price, amount: r2(shares * price), executed_on, source: 'csv', charges };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Parse a CSV (comma or semicolon, optional quotes, LF / CRLF / CR). Header row required; columns matched
 * case-insensitively by name with aliases: date|executed_on|trade date, symbol|scrip|ticker, side|type|buy/sell
 * (buy|b|purchase, sell|s|sale), shares|qty|quantity|volume, price|rate, charges|commission|fees (optional). Dates:
 * YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, "6 Oct 2026"; a date after `today` (YYYY-MM-DD, default the current PKT date) is
 * rejected, as the manual form rejects it. Numbers: "1,234.5"; in a semicolon file "548,11" and "1.234,56" (decimal
 * comma). Symbols upper-cased, PSX markers stripped with baseSymbol() from shared/symbols.ts. amount = shares x price
 * (2 dp). Bad rows are skipped with a reason that names the line number (1 = the header line). A file with a header
 * and no rows is an error, never an empty success.
 */
export function parseTxnCsv(text: string, { today = pktDate(new Date()) }: { today?: string } = {}): { rows: Txn[]; errors: string[] } {
  const src = text.replace(/^﻿/, '');
  const delim = detectDelimiter(src);
  const recs = tokenise(src, delim).filter((r) => r.cells.some((c) => c.trim() !== ''));
  const hint = `The first line should name the columns: ${COLUMNS.join(',')}.`;
  const header = recs[0];
  if (!header) return { rows: [], errors: [`The file is empty. ${hint}`] };
  const cols = mapHeader(header.cells);
  const missing = REQUIRED.filter((c) => cols[c] == null);
  if (missing.length) return { rows: [], errors: [`Line ${header.line}: no column for ${missing.join(', ')}. ${hint}`] };
  if (recs.length === 1) return { rows: [], errors: [`No rows found after the header line (line ${header.line}). Add one line per buy or sell, like the template.`] };
  const ctx: RowContext = { decimalComma: delim === ';', today };
  const rows: Txn[] = [];
  const errors: string[] = [];
  for (const r of recs.slice(1)) {
    const res = parseRow(r.cells, cols, ctx);
    if (typeof res === 'string') errors.push(`Line ${r.line}: ${res}`);
    else rows.push(res);
  }
  return { rows, errors };
}

const txnKey = (t: Txn) => `${t.executed_on}|${t.symbol.trim().toUpperCase()}|${t.side}|${t.shares}|${Math.round(t.price * 100)}`;

/**
 * Rows already in `existing` on (executed_on, symbol, side, shares, price) are duplicates. Each existing row matches
 * at most one imported row, so two identical fills on the same day stay two when only one of them is recorded.
 * Input order is kept in both lists.
 */
export function dedupeTxns(rows: Txn[], existing: Txn[]): { fresh: Txn[]; duplicates: Txn[] } {
  const seen = new Map<string, number>();
  for (const t of existing) { const k = txnKey(t); seen.set(k, (seen.get(k) ?? 0) + 1); }
  const fresh: Txn[] = [];
  const duplicates: Txn[] = [];
  for (const r of rows) {
    const k = txnKey(r);
    const left = seen.get(k) ?? 0;
    if (left > 0) { seen.set(k, left - 1); duplicates.push(r); } else fresh.push(r);
  }
  return { fresh, duplicates };
}

const csvNum = (v: number) => String(Number(v.toFixed(4)));
const csvCell = (s: string) => (/[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** CSV text of the given transactions in the template's column order (for export). Blank charges stay blank. */
export function txnsToCsv(txns: Txn[]): string {
  const lines = txns.map((t) =>
    [t.executed_on, t.symbol, t.side, String(t.shares), csvNum(t.price), t.charges == null ? '' : csvNum(t.charges)].map(csvCell).join(','));
  return [COLUMNS.join(','), ...lines].join('\n') + '\n';
}
