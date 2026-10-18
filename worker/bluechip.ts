/**
 * Nightly blue-chip (BC) recheck. Universe: the KSE-100 rows of PSX's screener plus every symbol a user holds or
 * watches; nothing is listed here by name. For each company due a recheck (shared/bluechip.ts `bcDue`: weekly, after a
 * results or dividend filing, on an index membership change, when the config changes, once in the annual-results
 * season) the job gathers the facts from stored PSX data, evaluates the five checks and saves the state and a history
 * row. Company pages (annual profit table) are fetched for at most `pages_per_night` due companies per night, oldest
 * check first, so a full pass spreads over a few nights without hammering PSX.
 */
import {
  bcConfig, bcDue, configHash, evaluateBc, indexChanges, nextBcState, type AnnualProfit, type BcState,
} from '../shared/bluechip.ts';
import type { ScreenRow } from '../shared/discover.ts';
import { addDays } from '../shared/time.ts';
import { DEFAULT_RULES, type DividendEvent, type Rules } from '../shared/types.ts';
import type { Snapshot } from './feed.ts';
import type { Store } from './store.ts';

/**
 * The auditor's opinion from an annual report's text, without AI: ISA reports head a modified opinion "Basis for
 * Qualified Opinion" / "Adverse Opinion" / "Disclaimer of Opinion". "Unqualified opinion" is clean. Null when the
 * text has no auditor's report at all (a scanned or partial document): unknown, never assumed clean.
 */
export function auditOpinion(text: string): { qualified: boolean } | null {
  const t = text.replace(/\s+/g, ' ');
  if (!/independent auditor|auditor'?s report|audit report|opinion/i.test(t)) return null;
  const modified = /basis for (qualified|adverse) opinion|\badverse opinion\b|disclaimer of opinion|(?<!un)qualified opinion/i.test(t);
  if (modified) return { qualified: true };
  return /\bopinion\b/i.test(t) ? { qualified: false } : null;
}

/** "Annual Report for the year ended June 30, 2026" → 2026 (the year the financial year ends). */
export function reportYear(title: string, publishedAt: string): number {
  const m = /year ended[^0-9]*(?:\d{1,2}[^0-9]+)?(\d{4})/i.exec(title) ?? /\b(20\d{2})\b/.exec(title);
  return m ? Number(m[1]) : Number(publishedAt.slice(0, 4)) - (Number(publishedAt.slice(5, 7)) < 7 ? 1 : 0);
}

export interface BcRunDeps {
  store: Store;
  fetchSnapshot: (symbols: string[], opts?: { screener?: boolean }) => Promise<Snapshot>;
  log?: (m: string) => void;
  rules?: Rules;
}

/** Profit rows to store from a company page's Financials table (basis not stated by PSX). */
export const annualsFromPage = (symbol: string, rows: { year: number; profit_after_tax: number }[] | undefined): AnnualProfit[] =>
  (rows ?? []).map((r) => ({ symbol, year: r.year, profit_after_tax: r.profit_after_tax, consolidated: null, source: 'psx_financials' as const }));

export async function runBluechip(o: {
  today: string; screen: ScreenRow[]; previousScreen: ScreenRow[]; userSymbols: string[]; newFilingSymbols: Set<string>; dividends: DividendEvent[];
  force?: Set<string>; // recheck these now whatever the schedule says (the Refresh latest button: your own stocks)
}, deps: BcRunDeps): Promise<{ checked: number; pages: number; changes: { added: string[]; removed: string[] } }> {
  const rules = deps.rules ?? DEFAULT_RULES;
  const c = bcConfig(rules);
  const { store } = deps;
  const bySymbol = new Map(o.screen.map((r) => [r.symbol, r]));
  const universe = [...new Set([...o.screen.map((r) => r.symbol), ...o.userSymbols])].sort();
  // Index membership changes, from two readings of PSX's own constituent data.
  const members = (rows: ScreenRow[]) => rows.filter((r) => r.listed_in?.includes(c.index_code)).map((r) => r.symbol);
  const changes = o.previousScreen.some((r) => r.listed_in) ? indexChanges(members(o.previousScreen), members(o.screen)) : { added: [], removed: [] };
  const changed = new Set([...changes.added, ...changes.removed]);
  if (changed.size) deps.log?.(`bluechip: ${c.index_code} membership changed (${changes.added.length} in, ${changes.removed.length} out)`);

  const states = new Map((await store.bluechipStates()).map((s) => [s.symbol, s]));
  const hash = configHash(rules);
  const triggerOf = (s: string): string | null => {
    const prev = states.get(s) ?? null;
    if (o.force?.has(s)) return 'manual';
    if (!bcDue(prev, { today: o.today, newFiling: o.newFilingSymbols.has(s), membershipChanged: changed.has(s) }, rules)) return null;
    return !prev ? 'first' : prev.config_hash !== hash ? 'config' : changed.has(s) ? 'index_change' : o.newFilingSymbols.has(s) ? 'filing' : prev.checked_on <= addDays(o.today, -c.recheck_days) ? 'weekly' : 'annual_season';
  };
  const due = universe.map((s) => ({ s, trigger: triggerOf(s), last: states.get(s)?.checked_on ?? '' })).filter((x) => x.trigger)
    .sort((a, b) => Number(b.trigger === 'manual') - Number(a.trigger === 'manual') || a.last.localeCompare(b.last) || a.s.localeCompare(b.s))
    .slice(0, c.pages_per_night);
  if (!due.length) return { checked: 0, pages: 0, changes };

  // Company pages for the annual profit table: PSX's Financials, 4 years at a time.
  const snap = await deps.fetchSnapshot(due.map((d) => d.s), { screener: false });
  const pageRows = Object.values(snap.quotes).flatMap((q) => annualsFromPage(q.symbol, q.annual_profits));
  await store.saveAnnuals(pageRows);

  const syms = due.map((d) => d.s);
  const [annuals, audits, since] = await Promise.all([store.annuals(syms), store.audits(syms), store.filingsSince(syms)]);
  for (const { s, trigger } of due) {
    const row = bySymbol.get(s);
    const audit = audits.filter((a) => a.symbol === s).sort((a, b) => b.year - a.year)[0] ?? null;
    const result = evaluateBc({
      symbol: s, today: o.today, index_members: row?.listed_in ?? null, market_cap_rank: row?.mcap_rank ?? null,
      avg_volume_30d: row?.avg_volume_30d ?? null, price: row?.price ?? snap.quotes[s]?.price ?? null,
      trailing_yield_pct: row?.dividend_yield_pct ?? null,
      annual: annuals.filter((a) => a.symbol === s), dividends: o.dividends.filter((d) => d.symbol === s),
      filings_since: since[s] ?? null, audit,
    }, rules);
    await store.saveBluechip(nextBcState(states.get(s) ?? null, result, o.today, rules) as BcState, trigger as string);
  }
  return { checked: due.length, pages: Object.keys(snap.quotes).length, changes };
}
