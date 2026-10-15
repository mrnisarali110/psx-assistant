/**
 * PSX symbol normalisation (ISSUE-02).
 *
 * While a corporate action is pending PSX appends a marker to the symbol: XD (ex-dividend), XB (ex-bonus),
 * XR (ex-right) or a combination (XDXB, XDXR, XBXR, XDXBXR; the compact XBR is also seen). The screener then shows
 * APLXD where APL used to be, and a holding saved as HUBC stops matching HUBCXD. This module splits a symbol into
 * its base and its markers, and merges rows that are the same company under different markers.
 *
 * Pure logic: no DOM, no Node. The marker table below is PSX notation, not a rate or threshold, so it lives here
 * rather than in rules.json.
 */

export interface SymbolParts {
  /** The company's symbol without any marker: upper case, trimmed. */
  base: string;
  /** The markers found, in the fixed order XD, XB, XR ("XD", "XDXB", "XDXBXR"), or null when there were none. */
  ex: string | null;
}

/** PSX's ex markers in the order they are written when combined, the letter that follows the X, and a plain label. */
export const EX_MARKERS = [
  { code: 'XD', letter: 'D', label: 'ex-dividend' },
  { code: 'XB', letter: 'B', label: 'ex-bonus' },
  { code: 'XR', letter: 'R', label: 'ex-right' },
] as const;

const LETTERS = EX_MARKERS.map((m) => m.letter).join(''); // "DBR"
const GROUP = new RegExp(`X[${LETTERS}]+`, 'g'); // one X with its letters: XD, XB, XR, also compact XBR / XDBR
const TRAILING = new RegExp(`(?:X[${LETTERS}]+)+$`); // the run of groups at the end of a symbol
const ONLY_MARKERS = new RegExp(`^(?:X[${LETTERS}]+)+$`);

const clean = (s: string) => s.trim().toUpperCase();
const knownSet = (known: Iterable<string> | undefined) => (known ? new Set(Array.from(known, clean)) : null);

/** "XBXD" -> "XDXB": markers in the fixed order, each once; null when `run` is empty or not purely markers. */
function normaliseMarkers(run: string): string | null {
  if (!ONLY_MARKERS.test(run)) return null;
  const letters = new Set(run.replace(/X/g, ''));
  const codes = EX_MARKERS.filter((m) => letters.has(m.letter)).map((m) => m.code);
  return codes.length ? codes.join('') : null;
}

/** One way to cut a symbol: the base and the trailing run of marker groups taken off it. */
interface Cut {
  base: string;
  tail: string;
}

/** The split itself, on an already cleaned symbol, with the known set prepared once by the caller. */
function split(full: string, known: Set<string> | null): SymbolParts {
  const run = TRAILING.exec(full)?.[0];
  if (!run || run === full) return { base: full, ex: null }; // no marker, or nothing but markers
  // Every cut of the run at a group boundary, the whole run first, then one group fewer each time; the base must
  // keep at least 2 characters, so the base is never a single letter.
  const groups = run.match(GROUP) ?? [];
  const cuts: Cut[] = groups
    .map((_, i) => groups.slice(i).join(''))
    .map((tail) => ({ base: full.slice(0, full.length - tail.length), tail }))
    .filter((c) => c.base.length >= 2);
  const parts = (c: Cut | undefined): SymbolParts => (c ? { base: c.base, ex: normaliseMarkers(c.tail) } : { base: full, ex: null });
  if (known) {
    // The longest listed base wins: FOXBXD with FOXB listed is FOXB going ex-dividend, not a marked "FO".
    const listed = cuts.findLast((c) => known.has(c.base));
    if (listed) return parts(listed);
    // No base is listed but the full symbol is: a real symbol that happens to end in markers, kept whole.
    if (known.has(full)) return { base: full, ex: null };
  }
  // Nothing listed to guide the cut: strip the whole run (greedy), backing off only to keep 2 characters.
  return parts(cuts.at(0));
}

/**
 * "APLXD" -> {base:"APL", ex:"XD"}; "HUBC" -> {base:"HUBC", ex:null}; "APLXBR" -> {base:"APL", ex:"XBXR"} (markers
 * come back in the fixed order XD, XB, XR). Upper-cases and trims first.
 *
 * Markers are stripped only when what remains is at least 2 characters, and never from a symbol that is nothing but
 * markers. With `known` (the symbols PSX really lists) the longest base that is listed wins, so FOXBXD with FOXB
 * listed is FOXB going ex-dividend rather than a marked "FO"; when no base is listed, a listed full symbol is a real
 * one that happens to end in XD/XB/XR and is kept whole; anything else is stripped. Without `known` the whole
 * trailing run of markers is stripped.
 */
export function splitSymbol(symbol: string, known?: Iterable<string>): SymbolParts {
  return split(clean(symbol), knownSet(known));
}

/** The symbol without its markers: baseSymbol("HUBCXD") === "HUBC". Idempotent. */
export const baseSymbol = (symbol: string, known?: Iterable<string>) => splitSymbol(symbol, known).base;

/** "XD" -> "ex-dividend", "XDXB" -> "ex-dividend, ex-bonus"; null for null, empty or anything that is not markers. */
export function exLabel(ex: string | null | undefined): string | null {
  if (!ex) return null;
  const norm = normaliseMarkers(clean(ex));
  if (!norm) return null;
  return EX_MARKERS.filter((m) => norm.includes(m.code)).map((m) => m.label).join(', ');
}

/** How much data a row carries: its fields that are not null or undefined, ignoring `symbol` and `ex`. */
function filledFields(row: object): number {
  let n = 0;
  for (const [k, v] of Object.entries(row)) if (k !== 'symbol' && k !== 'ex' && v != null) n++;
  return n;
}

/**
 * Merge rows that are the same company under different markers: one row per base symbol. When both `APL` and
 * `APLXD` exist keep the row with more non-null fields (tie: the marked one, it is newer; still tied: the later row),
 * with `symbol` = base and `ex` set from whichever row carried a marker (several markers are combined, so `APLXD` +
 * `APLXB` gives "XDXB"; an `ex` already on a row counts too). Rows that needed no change are returned as the same
 * object. Input order is kept for the survivors. `known` is passed through to splitSymbol.
 */
export function dedupeBySymbol<T extends { symbol: string; ex?: string | null }>(rows: T[], known?: Iterable<string>): T[] {
  const set = knownSet(known);
  type Member = { idx: number; row: T; ex: string | null; fields: number };
  const byBase = new Map<string, Member[]>();
  rows.forEach((row, idx) => {
    const { base, ex } = split(clean(row.symbol), set);
    const list = byBase.get(base) ?? [];
    list.push({ idx, row, ex, fields: filledFields(row) });
    byBase.set(base, list);
  });
  const better = (m: Member, kept: Member) => (m.fields !== kept.fields ? m.fields > kept.fields : m.ex != null || kept.ex == null);
  const out: { idx: number; row: T }[] = [];
  for (const [base, members] of byBase) {
    let kept = members[0];
    for (const m of members.slice(1)) if (better(m, kept)) kept = m;
    const codes = members.flatMap((m) => [m.ex, m.row.ex ? normaliseMarkers(clean(m.row.ex)) : null]).filter((c): c is string => c != null);
    const ex = codes.length ? normaliseMarkers(codes.join('')) : null;
    const same = kept.row.symbol === base && (ex == null || kept.row.ex === ex);
    const row: T = same ? kept.row : ex == null ? { ...kept.row, symbol: base } : { ...kept.row, symbol: base, ex };
    out.push({ idx: kept.idx, row });
  }
  return out.sort((a, b) => a.idx - b.idx).map((o) => o.row);
}

/**
 * Re-key a price map by base symbol (same merge rule as dedupeBySymbol); the `ex` field is set on the kept row.
 * A row whose `symbol` is blank takes its key. Keys come out upper case.
 */
export function normalisePriceMap<T extends { symbol: string; ex?: string | null }>(map: Record<string, T>, known?: Iterable<string>): Record<string, T> {
  const rows = Object.entries(map).map(([key, row]) => (row.symbol.trim() ? row : { ...row, symbol: key }));
  const out: Record<string, T> = {};
  for (const row of dedupeBySymbol(rows, known)) out[row.symbol] = row;
  return out;
}
