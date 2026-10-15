/**
 * Blue-chip (BC) badge: computed only from real PSX data and filings, with every threshold in rules.json
 * (`bluechip`). There is deliberately no list of symbols anywhere in this module (a test fails if one appears).
 *
 * Five checks, all must pass:
 *   1 size        member of the configured PSX index (KSE-30 from the screener's "listed in"), or top N by market cap
 *   2 liquidity   average daily traded value at or above the threshold (PSX's 30-day average volume x price)
 *   3 profit      profit after tax above 0 in each of the last N financial years (consolidated when both are known)
 *   4 dividends   a cash dividend in at least K of the last N years, from dividend filings
 *   5 red flags   not suspended, not in the defaulter segment, no qualified audit opinion in the latest annual report
 * A check that cannot be worked out from data we have is `null` (unknown), never a guess; any unknown makes the
 * stock "not enough data" with no badge. Badges do not flicker: gained on the first full pass, lost only after
 * failing `lose_after_fails` checks in a row ("BC at risk" in between).
 */
import type { DividendEvent, Rules } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { addDays } from './time.ts';

export type BcConfig = Rules['bluechip'];
export const bcConfig = (rules: Rules = DEFAULT_RULES): BcConfig => rules.bluechip;

export type BcCheckKey = 'size' | 'liquidity' | 'profit' | 'dividends' | 'red_flags';
export interface BcCheck { key: BcCheckKey; label: string; ok: boolean | null; detail: string; source: string | null }

/** Profit after tax for one financial year, from PSX's Financials table or a results filing read by the AI. */
export interface AnnualProfit {
  symbol: string;
  year: number; // the financial year as PSX labels it (the calendar year it ends in)
  profit_after_tax: number; // rupees
  consolidated: boolean | null; // null = the source does not say
  source: 'psx_financials' | 'filing';
  filing_id?: string | null;
}

/** The latest annual report read for a company: whether the auditor's opinion was qualified (text search, no AI). */
export interface AuditFinding { symbol: string; year: number; qualified: boolean; filing_id: string }

export interface BcFacts {
  symbol: string;
  today: string;
  index_members: string[] | null; // PSX index codes the screener lists the stock in; null = not in the screener
  market_cap_rank: number | null; // 1 = largest, among the screener's stocks; null = no market cap
  avg_volume_30d: number | null; // PSX screener "30D VOLUME AVG."
  price: number | null;
  trailing_yield_pct?: number | null; // PSX screener dividend yield (last 12 months); 0 = no dividend in a year
  annual: AnnualProfit[];
  dividends: DividendEvent[];
  filings_since: string | null; // earliest filing date stored for this company: dividend years before it are unknown
  audit: AuditFinding | null;
}

export interface BcResult { symbol: string; status: 'pass' | 'fail' | 'unknown'; checks: BcCheck[] }

const fmtRs = (v: number) => (v >= 1e9 ? `Rs ${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `Rs ${Math.round(v / 1e6)}M` : `Rs ${Math.round(v).toLocaleString('en-PK')}`);

/** Market cap rank per symbol, 1 = largest. Rows without a market cap get no rank. */
export function marketCapRanks(screen: { symbol: string; market_cap: number | null }[]): Record<string, number> {
  const ranked = screen.filter((r) => r.market_cap != null && r.market_cap > 0).sort((a, b) => (b.market_cap as number) - (a.market_cap as number));
  return Object.fromEntries(ranked.map((r, i) => [r.symbol, i + 1]));
}

/** Who joined and who left an index between two readings of PSX's constituent data. */
export function indexChanges(before: Iterable<string>, after: Iterable<string>): { added: string[]; removed: string[] } {
  const a = new Set(before);
  const b = new Set(after);
  return { added: [...b].filter((s) => !a.has(s)).sort(), removed: [...a].filter((s) => !b.has(s)).sort() };
}

/** One profit figure per year: a consolidated figure wins, then any filing, then PSX's Financials table. */
export function profitByYear(annual: AnnualProfit[]): Map<number, AnnualProfit> {
  const rank = (p: AnnualProfit) => (p.consolidated === true ? 3 : p.source === 'filing' ? 2 : 1);
  const out = new Map<number, AnnualProfit>();
  for (const p of annual) {
    if (!Number.isFinite(p.profit_after_tax)) continue;
    const cur = out.get(p.year);
    if (!cur || rank(p) > rank(cur)) out.set(p.year, p);
  }
  return out;
}

function sizeCheck(f: BcFacts, c: BcConfig): BcCheck {
  const label = 'Big company';
  const member = f.index_members?.includes(c.index_code) ?? null;
  if (member) return { key: 'size', label, ok: true, detail: `${c.index_code} member`, source: 'PSX screener (listed in)' };
  if (f.market_cap_rank != null && f.market_cap_rank <= c.top_by_market_cap) {
    return { key: 'size', label, ok: true, detail: `#${f.market_cap_rank} by market cap`, source: 'PSX screener (market cap)' };
  }
  if (member === false && f.market_cap_rank != null) {
    return { key: 'size', label, ok: false, detail: `not in ${c.index_code}; #${f.market_cap_rank} by market cap (needs top ${c.top_by_market_cap})`, source: 'PSX screener' };
  }
  return { key: 'size', label, ok: null, detail: 'not in the PSX screener data yet', source: null };
}

function liquidityCheck(f: BcFacts, c: BcConfig): BcCheck {
  const label = 'Easy to trade';
  if (f.avg_volume_30d == null || f.price == null || !(f.price > 0)) return { key: 'liquidity', label, ok: null, detail: 'no average volume or price yet', source: null };
  const value = f.avg_volume_30d * f.price;
  return {
    key: 'liquidity', label, ok: value >= c.min_traded_value_pkr,
    detail: `avg traded ${fmtRs(value)}/day (needs ${fmtRs(c.min_traded_value_pkr)})`, source: 'PSX screener 30-day average volume x price',
  };
}

function profitCheck(f: BcFacts, c: BcConfig): BcCheck {
  const label = 'Profitable for years';
  const byYear = profitByYear(f.annual.filter((a) => a.symbol === f.symbol));
  if (!byYear.size) return { key: 'profit', label, ok: null, detail: 'no annual results read yet', source: null };
  const latest = Math.max(...byYear.keys());
  const years = Array.from({ length: c.profit_years }, (_, i) => latest - i);
  const known = years.filter((y) => byYear.has(y));
  const losses = known.filter((y) => (byYear.get(y) as AnnualProfit).profit_after_tax <= 0);
  const src = [...new Set(known.map((y) => (byYear.get(y) as AnnualProfit).source === 'filing' ? 'results filings' : 'PSX Financials'))].join(' + ');
  const basis = known.some((y) => (byYear.get(y) as AnnualProfit).consolidated === true) ? ', consolidated where reported' : '';
  if (losses.length) return { key: 'profit', label, ok: false, detail: `loss in ${losses.join(', ')}; profitable ${known.length - losses.length}/${c.profit_years} years`, source: src + basis };
  if (known.length < years.length) {
    const missing = years.filter((y) => !byYear.has(y));
    return { key: 'profit', label, ok: null, detail: `profitable ${known.length}/${c.profit_years} years read; ${missing.join(', ')} not read yet`, source: src + basis };
  }
  return { key: 'profit', label, ok: true, detail: `profitable ${c.profit_years}/${c.profit_years} years (${years[years.length - 1]}-${latest})`, source: src + basis };
}

function dividendCheck(f: BcFacts, c: BcConfig): BcCheck {
  const label = 'Pays dividends regularly';
  const n = c.dividend_years_window;
  const cash = f.dividends.filter((d) => d.symbol === f.symbol && d.dps != null && d.dps > 0 && d.dividend_type !== 'special');
  let paid = 0;
  let unknown = 0;
  for (let i = 0; i < n; i++) {
    const end = addDays(f.today, -365 * i);
    const start = addDays(end, -365);
    if (cash.some((d) => d.announced_on > start && d.announced_on <= end)) paid++;
    else if (!f.filings_since || f.filings_since > start) unknown++; // we have not read that year's filings: absence proves nothing
  }
  const detail = `dividends in ${paid} of the last ${n} years${unknown ? ` (${unknown} not covered by filings read so far)` : ''}`;
  const source = f.filings_since ? `dividend filings read since ${f.filings_since}` : null;
  if (c.dividend_mode === 'available') {
    // What PSX publishes now: its trailing yield says whether the company paid in the last 12 months; the filings we
    // have read must show no year without a dividend. Missing history is not held against it.
    const missed = n - paid - unknown;
    const allowed = n - c.dividend_years_needed;
    const y = f.trailing_yield_pct;
    const src = ['PSX trailing yield', source].filter(Boolean).join(' + ');
    if (y == null) return { key: 'dividends', label, ok: null, detail: 'no PSX dividend yield yet', source: src };
    if (y <= 0) return { key: 'dividends', label, ok: false, detail: 'no dividend in the last 12 months (PSX yield 0%)', source: src };
    const filed = paid + missed > 0 ? `; dividends in ${paid} of ${paid + missed} years covered by filings read so far` : '';
    return { key: 'dividends', label, ok: missed <= allowed, detail: `pays now (PSX trailing yield ${y.toFixed(1)}%)${filed}`, source: src };
  }
  if (paid >= c.dividend_years_needed) return { key: 'dividends', label, ok: true, detail, source };
  if (paid + unknown < c.dividend_years_needed) return { key: 'dividends', label, ok: false, detail, source };
  return { key: 'dividends', label, ok: null, detail, source };
}

function redFlagCheck(f: BcFacts, c: BcConfig): BcCheck {
  const label = 'No red flags';
  const notes: string[] = [];
  let ok: boolean | null = true;
  // Suspended: a stock nobody could trade for a month has a zero 30-day average volume.
  if (f.avg_volume_30d == null) { ok = null; notes.push('trading status unknown'); }
  else if (f.avg_volume_30d <= 0) return { key: 'red_flags', label, ok: false, detail: 'no trades in 30 days (suspended?)', source: 'PSX screener' };
  else notes.push('trading');
  // Defaulter segment: PSX does not publish it on a page we read, but its indices exclude defaulters, so membership proves it.
  if (f.index_members?.includes(c.index_code)) notes.push(`not a defaulter (${c.index_code} member)`);
  else { ok = null; notes.push('defaulter status not published'); }
  // A qualified opinion always fails once an annual report is read; a report not read yet blocks only when required.
  if (f.audit || c.require_audit_check) {
    if (!f.audit) { ok = null; notes.push('annual report not read yet'); }
    else if (f.audit.qualified) return { key: 'red_flags', label, ok: false, detail: `qualified audit opinion in the ${f.audit.year} annual report`, source: `annual report ${f.audit.filing_id}` };
    else notes.push(`clean audit opinion ${f.audit.year}`);
  }
  return { key: 'red_flags', label, ok, detail: notes.join(' · '), source: 'PSX screener, index membership' + (f.audit ? `, annual report ${f.audit.filing_id}` : '') };
}

/** All five checks with their numbers and sources. Any fail: fail; else any unknown: unknown ("not enough data"); else pass. */
export function evaluateBc(f: BcFacts, rules: Rules = DEFAULT_RULES): BcResult {
  const c = bcConfig(rules);
  const checks = [sizeCheck(f, c), liquidityCheck(f, c), profitCheck(f, c), dividendCheck(f, c), redFlagCheck(f, c)];
  const status = checks.some((x) => x.ok === false) ? 'fail' : checks.some((x) => x.ok === null) ? 'unknown' : 'pass';
  return { symbol: f.symbol, status, checks };
}

export type BcStatus = 'bc' | 'at_risk' | 'not_bc' | 'not_enough_data';
export interface BcState {
  symbol: string;
  status: BcStatus;
  badge: boolean; // show the BC pill (bc and at_risk)
  fails: number; // failed rechecks in a row while holding the badge
  reason: string | null; // why it is at risk / not BC / not enough data
  checks: BcCheck[];
  checked_on: string;
  config_hash: string;
  lost_on?: string | null; // the day it lost the badge (cleared when it regains it): Home warns about a recent loss
}

/** A short fingerprint of the thresholds: a full recheck runs whenever it changes. */
export function configHash(rules: Rules = DEFAULT_RULES): string {
  const c = bcConfig(rules);
  const s = JSON.stringify([c.index_code, c.top_by_market_cap, c.min_traded_value_pkr, c.profit_years, c.dividend_years_needed, c.dividend_years_window, c.require_audit_check, c.lose_after_fails, c.dividend_mode]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const firstBad = (r: BcResult, ok: boolean | null) => r.checks.filter((x) => x.ok === ok).map((x) => `${x.label}: ${x.detail}`).join('; ') || null;

/**
 * The badge after a recheck. Gains BC on the first full pass. A BC stock that fails is "at risk" (badge kept, reason
 * shown) until it has failed `lose_after_fails` rechecks in a row, then loses it. A stock that never had BC shows
 * "not enough data" when a check cannot be worked out; one that has BC keeps it ("at risk") while data is missing,
 * because missing data says nothing about the company.
 */
export function nextBcState(prev: BcState | null, r: BcResult, today: string, rules: Rules = DEFAULT_RULES): BcState {
  const c = bcConfig(rules);
  const base = { symbol: r.symbol, checks: r.checks, checked_on: today, config_hash: configHash(rules), lost_on: prev?.lost_on ?? null };
  if (r.status === 'pass') return { ...base, status: 'bc', badge: true, fails: 0, reason: null, lost_on: null };
  if (r.status === 'fail') {
    const fails = prev?.badge ? prev.fails + 1 : 0;
    if (prev?.badge && fails < c.lose_after_fails) return { ...base, status: 'at_risk', badge: true, fails, reason: firstBad(r, false) };
    return { ...base, status: 'not_bc', badge: false, fails: 0, reason: firstBad(r, false), lost_on: prev?.badge ? today : base.lost_on };
  }
  if (prev?.badge) return { ...base, status: 'at_risk', badge: true, fails: prev.fails, reason: `data incomplete: ${firstBad(r, null)}` };
  return { ...base, status: 'not_enough_data', badge: false, fails: 0, reason: firstBad(r, null) };
}

/**
 * Whether a stock is due a recheck: never checked, the thresholds changed, a week has passed (size and trading), a
 * results or dividend filing for it was read since the last check, its index membership changed, or the yearly full
 * run after annual-results season (the first night in a configured month since the last check).
 */
export function bcDue(prev: BcState | null, o: { today: string; newFiling?: boolean; membershipChanged?: boolean }, rules: Rules = DEFAULT_RULES): boolean {
  if (!prev || prev.config_hash !== configHash(rules) || o.newFiling || o.membershipChanged) return true;
  if (prev.checked_on <= addDays(o.today, -bcConfig(rules).recheck_days)) return true;
  const month = Number(o.today.slice(5, 7));
  return bcConfig(rules).annual_full_run_months.includes(month) && prev.checked_on.slice(0, 7) !== o.today.slice(0, 7);
}

/** One short line for a checklist summary: "Profitable 5/5 years · Dividends 5/5 · Avg traded Rs 820M/day · KSE30 member". */
export function bcSummary(checks: BcCheck[]): string {
  return checks.map((x) => `${x.ok === true ? '✓' : x.ok === false ? '✗' : '?'} ${x.detail}`).join(' · ');
}
