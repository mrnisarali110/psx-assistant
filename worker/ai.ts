/**
 * AI tasks for the scheduled worker, on top of the shared Groq/Gemini router (shared/llm.ts):
 *   1. Read PSX announcement PDFs: summary, key figures, any cash dividend with its book closure, and for results the
 *      EPS with its basis and months plus the News card figures (headline, EPS, dividend, profit change).
 *   2. "AI Assistant suggests": stance for the day, a call per holding, suggestions, rebalance, cash note.
 *   3. Discover picks: rank and explain undervalued and dividend candidates the rules found.
 * Guardrails: the AI only sees facts we compute. Anything citing a number not in those facts, naming a stock
 * outside the allowed set, or breaking the user's own rules is dropped. Failures never stop the worker.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import type { LlmRouter } from '../shared/llm.ts';
import type { AiSuggestion, AnnouncementMetrics, EpsBasis, HoldingCallKind } from '../shared/types.ts';

import { numberSet, numbersGrounded, numbersIn } from '../shared/grounding.ts';
import { dateSane, dateVerdict } from '../shared/calendar.ts';
import { aiLineAllowed } from '../shared/portfolio.ts';
export { numberSet, numbersGrounded, numbersIn };

const clamp = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isoDate = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);

// ---------------------------------------------------------------------------
// 1. Announcement reader
// ---------------------------------------------------------------------------
export interface AnnouncementDigest {
  summary: string;
  figures: { label: string; value: string; verified: boolean }[];
  verified: boolean; // every number in the summary and figures was found in the PDF text
  dividend: { dps: number; type: 'interim' | 'final' | 'special' | null; book_closure_from: string | null; book_closure_to: string | null; verified: boolean } | null;
  /** Profit after tax of the latest quarter, when the filing reports one (results only), with that quarter's EPS. */
  earnings: { period_end: string; profit_after_tax: number; verified: boolean; eps: number | null; eps_basis: EpsBasis | null; period_months: 3 } | null;
  /** Full-year profit after tax, consolidated when the filing gives both (blue-chip profit check), with the year's EPS. */
  annual: { year: number; period_end: string; profit_after_tax: number; consolidated: boolean | null; verified: boolean; eps: number | null; eps_basis: EpsBasis | null } | null;
  /** The News card figures. Every number in them is printed in the PDF (the profit change is worked out from two printed profits). */
  metrics: AnnouncementMetrics;
  /** The dates the AI wrote do not fit the filing date: a re-upload of an old notice, or a date that cannot be right (ISSUE-06). */
  date_note: 'older_document' | 'date_unclear' | null;
  model: string;
}

/** What a filing gives the News card when nothing could be read from it. */
export const NO_METRICS: AnnouncementMetrics = { headline: null, eps: null, eps_basis: null, dps: null, profit_change_pct: null };

const ANN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'At most 2 short plain-English sentences for a retail investor.' },
    figures: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, value: { type: 'STRING' } }, required: ['label', 'value'] },
      description: 'Up to 5 key figures exactly as printed: EPS, profit after tax, dividend per share, bonus %, book closure dates, meeting date.',
    },
    cash_dividend_per_share: { type: 'NUMBER', nullable: true, description: 'Rupees per share of any CASH dividend declared in this document (convert "70%" on Rs 10 face value to 7). null if none.' },
    dividend_type: { type: 'STRING', enum: ['interim', 'final', 'special'], nullable: true },
    book_closure_from: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD start of share transfer book closure for that dividend, or null.' },
    book_closure_to: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD end of book closure, or null.' },
    quarter_end: { type: 'STRING', nullable: true, description: 'Financial results only: YYYY-MM-DD last day of the latest THREE-MONTH quarter reported, else null.' },
    annual_year_end: { type: 'STRING', nullable: true, description: 'Annual (full-year) results only: YYYY-MM-DD last day of the financial year, else null.' },
    annual_profit_after_tax: { type: 'NUMBER', nullable: true, description: 'Full-year profit after tax in RUPEES (convert "thousand"/"million"), negative for a loss. CONSOLIDATED figure when the document gives both. null if not a full-year result.' },
    annual_consolidated: { type: 'BOOLEAN', nullable: true, description: 'true if annual_profit_after_tax is the consolidated figure, false if unconsolidated/standalone, null if not stated.' },
    quarter_profit_after_tax: { type: 'NUMBER', nullable: true, description: 'Profit after tax for that single three-month quarter in RUPEES (convert "thousand"/"million"), negative for a loss. Not the half-year or nine-month total. null if not printed.' },
    headline: { type: 'STRING', nullable: true, description: 'At most 60 characters, what the filing says in plain words, e.g. "Profit up 18%, Rs 8 dividend". No advice.' },
    eps: { type: 'NUMBER', nullable: true, description: 'Results only: basic earnings per share in rupees for the main period the filing reports (the period of its headline profit), exactly as printed, negative for a loss. The CONSOLIDATED figure when the document gives both. null if not printed.' },
    eps_period_months: { type: 'NUMBER', nullable: true, description: 'Months that eps covers: 3, 6, 9 or 12.' },
    quarter_eps: { type: 'NUMBER', nullable: true, description: 'Basic EPS in rupees for the single three-month quarter (quarter_end) when printed separately from a half-year or nine-month figure, same basis as eps, negative for a loss. null otherwise.' },
    eps_basis: { type: 'STRING', enum: ['consolidated', 'unconsolidated'], nullable: true, description: 'Which accounts the EPS figures are from; null if the document does not say.' },
    profit_this_period: { type: 'NUMBER', nullable: true, description: 'Profit after tax for the main period exactly as printed (in the document\'s own units, do not convert), negative for a loss. null if not printed.' },
    profit_same_period_last_year: { type: 'NUMBER', nullable: true, description: 'Profit after tax for the same period a year earlier, exactly as printed in the same units. null if not printed.' },
  },
  required: ['summary', 'figures'],
};

export async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join(' ') : text;
  } catch {
    return '';
  }
}

export async function readAnnouncement(ai: LlmRouter, pdf: Uint8Array, meta: { symbol: string; title: string; published_at?: string }): Promise<AnnouncementDigest> {
  const text = await pdfText(pdf);
  const { data, model } = await ai.json<any>('pdf',
    'You read Pakistan Stock Exchange company announcements. Report only what the document says. Never guess, never give investment advice, never invent numbers.',
    [
      { pdf: { base64: Buffer.from(pdf).toString('base64'), text } },
      { text: `PSX announcement for ${meta.symbol}: "${meta.title}". Summarize what it means for a shareholder, list key figures exactly as printed, and fill the dividend fields only if a cash dividend is declared in it. For financial results, also give the EPS with its basis and period, and the profit for this period and the same period last year exactly as printed.` },
    ], ANN_SCHEMA);
  return digestOf(data, text, meta, model);
}

/** True when the PDF text prints this figure (a loss in brackets counts): stricter than numbersGrounded, which passes small whole numbers. */
const printedIn = (raw: number[]) => (v: number) => raw.some((n) => Math.abs(n - Math.abs(v)) < 1e-6);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The AI's answer checked against the PDF text: anything not printed in it is dropped or marked unverified. */
export function digestOf(data: any, text: string, meta: { published_at?: string }, model: string): AnnouncementDigest {
  const known = text ? numberSet(text) : [];
  const checks = (s: string) => !!text && numbersGrounded(s, known).ok;
  const figures = (Array.isArray(data.figures) ? data.figures : []).slice(0, 5).map((f: any) => ({
    label: clamp(f.label, 60), value: clamp(f.value, 60),
    verified: numbersIn(String(f.value)).length > 0 && checks(String(f.value)),
  }));
  const summary = clamp(data.summary, 400);
  // A book closure far from the filing date is not this filing's (the model read an old notice or guessed): drop it.
  const plausible = (d: string | null) => (d && meta.published_at && !dateSane(d, meta.published_at) ? null : d);
  const dps = Number(data.cash_dividend_per_share);
  const dividend = Number.isFinite(dps) && dps > 0 && dps < 10_000 ? {
    dps: Math.round(dps * 100) / 100,
    type: ['interim', 'final', 'special'].includes(data.dividend_type) ? data.dividend_type : null,
    book_closure_from: plausible(isoDate(data.book_closure_from)),
    book_closure_to: plausible(isoDate(data.book_closure_to)),
    // "70%" on Rs 10 face value is printed as 70, so accept either the DPS or the percentage form.
    verified: !!text && (numbersGrounded(String(dps), known).ok || numbersGrounded(String(dps * 10), known).ok),
  } : null;
  // The quarter's profit counts only with a plausible quarter end (a quarter closes 0-120 days before the filing).
  const qEnd = isoDate(data.quarter_end);
  const qProfit = Number(data.quarter_profit_after_tax);
  const qOk = qEnd && Number.isFinite(qProfit) && qProfit !== 0 && (!meta.published_at || (qEnd <= meta.published_at && Date.parse(meta.published_at) - Date.parse(qEnd) <= 120 * 86400000));
  // Printed in rupees, thousands or millions: verified when one of those forms is in the PDF text.
  const qVerified = !!qOk && !!text && [1, 1e3, 1e6].some((u) => numbersGrounded(String(Math.round(Math.abs(qProfit) / u)), known).ok);
  const aEnd = isoDate(data.annual_year_end);
  const aProfit = Number(data.annual_profit_after_tax);
  const aOk = aEnd && Number.isFinite(aProfit) && aProfit !== 0 && (!meta.published_at || (aEnd <= meta.published_at && Date.parse(meta.published_at) - Date.parse(aEnd) <= 200 * 86400000));

  // EPS counts only when the PDF prints it: a wrong figure is worse than none (owner review A2).
  const raw = text ? numbersIn(text) : [];
  const printed = printedIn(raw);
  const epsOf = (v: unknown) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n !== 0 && Math.abs(n) < 10_000 && printed(n) ? Math.round(n * 10000) / 10000 : null;
  };
  const eps = epsOf(data.eps);
  const months = [3, 6, 9, 12].includes(Number(data.eps_period_months)) ? Number(data.eps_period_months) : null;
  const basis: EpsBasis = ['consolidated', 'unconsolidated'].includes(data.eps_basis) ? data.eps_basis
    : typeof data.annual_consolidated === 'boolean' && months === 12 ? (data.annual_consolidated ? 'consolidated' : 'unconsolidated') : 'not_stated';
  const quarterEps = epsOf(data.quarter_eps) ?? (months === 3 ? eps : null);
  const yearEps = months === 12 ? eps : null;

  const earnings = qOk ? { period_end: qEnd as string, profit_after_tax: Math.round(qProfit), verified: qVerified, eps: quarterEps, eps_basis: quarterEps == null ? null : basis, period_months: 3 as const } : null;
  const annual = aOk ? {
    year: Number((aEnd as string).slice(0, 4)), period_end: aEnd as string, profit_after_tax: Math.round(aProfit),
    consolidated: typeof data.annual_consolidated === 'boolean' ? data.annual_consolidated : null,
    verified: !!text && [1, 1e3, 1e6].some((u) => numbersGrounded(String(Math.round(Math.abs(aProfit) / u)), known).ok),
    eps: yearEps, eps_basis: yearEps == null ? null : basis,
  } : null;

  // Profit change vs the same period last year, worked out here from two printed profits (the AI's own % is not trusted).
  const inUnits = (v: number) => [1, 1e3, 1e6].some((u) => printed(Math.round((Math.abs(v) / u) * 100) / 100));
  const now = Number(data.profit_this_period), before = Number(data.profit_same_period_last_year);
  const change = data.profit_this_period != null && data.profit_same_period_last_year != null && Number.isFinite(now) && Number.isFinite(before)
    && before > 0 && inUnits(now) && inUnits(before) ? r1(((now - before) / before) * 100) : null;
  const metricsEps = eps ?? quarterEps;
  const metrics: AnnouncementMetrics = {
    headline: null, eps: metricsEps, eps_basis: metricsEps == null ? null : basis,
    dps: dividend?.verified ? dividend.dps : null, profit_change_pct: change != null && Math.abs(change) <= 10_000 ? change : null,
  };
  // The headline may quote the PDF and the figures above, nothing else; small numbers too ("up 22%" must be a real 22).
  const headline = clamp(data.headline, 80);
  const quoted = numberSet([text, metrics]);
  const strict = (n: number) => (Number.isInteger(n) && n >= 2020 && n <= 2035) || quoted.some((k) => Math.abs(k - n) <= Math.max(0.05, Math.abs(k) * 0.005));
  metrics.headline = headline && numbersIn(headline).every(strict) ? headline : null;

  const verdict = meta.published_at ? dateVerdict([summary, ...figures.map((f: { value: string }) => f.value)], meta.published_at) : 'ok';
  return {
    summary, figures, dividend, earnings, annual, metrics, model,
    verified: checks(summary || '0') && figures.every((f: { value: string; verified: boolean }) => f.verified || numbersIn(f.value).length === 0),
    date_note: verdict === 'ok' ? null : verdict,
  };
}

// ---------------------------------------------------------------------------
// 2. Portfolio assistant
// ---------------------------------------------------------------------------
export interface Insight {
  headline: string;
  stance: 'buy' | 'hold' | 'wait' | null;
  suggestions: AiSuggestion[];
  holding_calls: { symbol: string; call: HoldingCallKind; text: string }[];
  rebalance: string | null;
  cash_note: string | null;
  risks: string | null;
}

export interface InsightFacts {
  date: string;
  market: { kse100: number | null; change_pct: number | null; rules_say: string; rules_reason: string; crash_level: number; market_open: boolean };
  rules: { max_position_pct: number; opportunity_below_last_buy_pct: number; shariah_only: boolean; crash_fund_pkr: number };
  money: { monthly_budget_pkr: number; invested_this_month_pkr: number; cash_left_this_month_pkr: number };
  portfolio: { total_value_pkr: number; pnl_since_bought_pct: number | null; day_change_pct: number | null; sectors: { sector: string; pct: number }[]; rebalance_flags: string[] };
  holdings: Record<string, unknown>[];
  watchlist: Record<string, unknown>[];
  screen_candidates: Record<string, unknown>[];
  upcoming_dividends: Record<string, unknown>[];
  recent_news: { symbol: string; date: string; summary: string }[];
}

const CALLS: HoldingCallKind[] = ['hold', 'average_down', 'opportunity', 'trim', 'review', 'sell'];
const ACTIONS: AiSuggestion['action'][] = ['buy', 'add', 'hold', 'trim', 'sell', 'watch', 'review'];

const INSIGHT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: 'One sentence, at most 110 characters, what matters most today.' },
    stance: { type: 'STRING', enum: ['buy', 'hold', 'wait'], description: 'Overall: put cash to work today, hold, or wait.' },
    holding_calls: {
      type: 'ARRAY',
      description: 'One entry for EVERY holding.',
      items: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING' },
          call: { type: 'STRING', enum: CALLS },
          text: { type: 'STRING', description: 'At most 80 characters, e.g. "12.3% below your last buy of Rs 130.45".' },
        },
        required: ['symbol', 'call', 'text'],
      },
    },
    suggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', enum: ACTIONS },
          symbol: { type: 'STRING', nullable: true },
          text: { type: 'STRING', description: 'At most 140 characters.' },
          why: { type: 'STRING', description: 'Reason citing only numbers from the facts, at most 180 characters.' },
          confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
        },
        required: ['action', 'text', 'why', 'confidence'],
      },
    },
    rebalance: { type: 'STRING', nullable: true, description: 'One sentence on balance across sectors/stocks, or null if fine.' },
    cash_note: { type: 'STRING', nullable: true, description: 'Where this month\'s remaining cash could go, at most 160 characters.' },
    risks: { type: 'STRING', nullable: true, description: 'Main risk, at most 140 characters.' },
  },
  required: ['headline', 'stance', 'holding_calls', 'suggestions'],
};

const INSIGHT_SYSTEM = `You are a cautious assistant for a retail investor on the Pakistan Stock Exchange.
Use ONLY the JSON facts. Never estimate targets, forecasts or prices; only quote numbers present in the facts.
For each holding pick a call:
- "average_down": price is meaningfully below the investor's last buy (vs_last_buy_pct) and buying more is sensible.
- "opportunity": a strong chance, roughly opportunity_below_last_buy_pct or more below the last buy, fundamentals not broken.
- "hold": nothing to do. "trim": over max_position_pct or sector over its limit. "review": status review or weak recent results.
Never "average_down"/"opportunity"/"buy"/"add" for status hold_no_add or review, at or over max_position_pct, or non-Shariah when shariah_only.
When rules_say is "Wait" the stance must not be "buy". Use recent_news (AI summaries of company filings) when relevant.
Each stock also has facts the investor does not see at a glance: payout_pct (dividend as % of profit), one_off (the
yield will not repeat), suspect (pays out far more than it earns), dividend_cut, results_profit_change_pct (latest
results vs a year earlier). Prefer one of these over repeating the price, P/E or yield the app already shows.
pe is the app's own P/E (pe_basis says from which accounts); loss_making means there is no P/E.
Suggestions: at most 4, actions to DO or WATCH (skip plain holds). Mention screen_candidates only as "watch".
Plain short English for a non-expert ("profit/loss", not "PnL"). No guarantees, no hype.
Each holding and candidate has blue_chip, set only by the app's own checks ('bc' or 'at_risk' = blue chip; anything
else is not). You may mention it; never call a stock a blue chip unless blue_chip says so, and never change it.
Never compare numbers from different periods: portfolio.pnl_since_bought_pct is the profit/loss since the investor bought
(all time); market.change_pct and portfolio.day_change_pct are today only. Compare today with today, or say each on its own.`;

export interface GuardContext {
  holdings: { symbol: string; status: string; weight_pct: number | null; is_shariah: boolean | null; rules_call?: string }[];
  universe: Set<string>; // holdings + watchlist + screen candidates
  shariahOf: (s: string) => boolean | null;
  maxPositionPct: number;
  shariahOnly: boolean;
  rulesSay: 'Buy' | 'Hold' | 'Wait';
  /** Blue-chip status from the app's own checks ('bc', 'at_risk', 'not_bc', 'not_enough_data', 'not_checked'). */
  blueChipOf?: (sym: string) => string;
}

function buyBlocked(sym: string | null, g: GuardContext): string | null {
  if (g.rulesSay === 'Wait') return 'rules say Wait (do not chase a rally)';
  if (!sym) return null;
  const h = g.holdings.find((x) => x.symbol === sym);
  if (h && (h.status === 'hold_no_add' || h.status === 'review')) return `${sym} is ${h.status}`;
  if (h?.weight_pct != null && h.weight_pct >= g.maxPositionPct) return `${sym} is at the position cap`;
  if (g.shariahOnly && g.shariahOf(sym) !== true) return `${sym} not confirmed Shariah`;
  return null;
}

/** Drop anything the rules forbid or the facts don't support. */
export function guardInsight(raw: any, facts: unknown, g: GuardContext): { insight: Insight; dropped: number; reasons: string[] } {
  const known = numberSet(facts);
  const reasons: string[] = [];
  const grounded = (s: string) => {
    const chk = numbersGrounded(s, known);
    return chk.ok ? null : `numbers not in the data: ${chk.unknown.join(', ')}`;
  };

  const suggestions: AiSuggestion[] = [];
  const rawS: any[] = Array.isArray(raw?.suggestions) ? raw.suggestions.slice(0, 6) : [];
  for (const s of rawS) {
    const sym = s.symbol ? String(s.symbol).toUpperCase().trim() : null;
    const action = s.action as AiSuggestion['action'];
    const text = clamp(s.text, 180);
    const why = clamp(s.why, 220);
    const buying = action === 'buy' || action === 'add';
    const cutting = action === 'trim' || action === 'sell';
    const ruleCall = g.holdings.find((h) => h.symbol === sym)?.rules_call;
    const calledBlueChip = /blue[- ]?chip/i.test(`${text} ${why}`) && sym && !['bc', 'at_risk'].includes(g.blueChipOf?.(sym) ?? 'not_checked');
    const reject = !ACTIONS.includes(action) ? `unknown action ${action}`
      : calledBlueChip ? `${sym} is not a blue chip under the app's checks`
      : sym && !g.universe.has(sym) ? `${sym} is not in your portfolio, watchlist or screen`
      : !text ? 'empty'
      : buying ? buyBlocked(sym, g) ?? grounded(`${text} ${why}`)
      : cutting && ruleCall && ruleCall !== 'trim' && ruleCall !== 'sell' ? `${sym} is not a Trim under your rules`
      : grounded(`${text} ${why}`);
    if (reject) { reasons.push(`${action} ${sym ?? ''}: ${reject}`.trim()); continue; }
    if (suggestions.length < 4) suggestions.push({ action, symbol: sym, text, why, confidence: ['low', 'medium', 'high'].includes(s.confidence) ? s.confidence : 'low' });
  }

  const holdingCalls: Insight['holding_calls'] = [];
  for (const c of Array.isArray(raw?.holding_calls) ? raw.holding_calls : []) {
    const sym = String(c?.symbol ?? '').toUpperCase().trim();
    const call = c?.call as HoldingCallKind;
    const text = clamp(c?.text, 100);
    if (!g.holdings.some((h) => h.symbol === sym) || !CALLS.includes(call) || !text || holdingCalls.some((x) => x.symbol === sym)) continue;
    const adding = call === 'average_down' || call === 'opportunity';
    const ruleCall = g.holdings.find((h) => h.symbol === sym)?.rules_call;
    const raising = (call === 'trim' || call === 'review' || call === 'sell') && ruleCall && ruleCall !== call;
    const reject = (adding ? buyBlocked(sym, { ...g, rulesSay: 'Hold' }) : null) ?? (raising ? `${call} needs a reason from your rules` : null) ?? grounded(text);
    if (reject) { reasons.push(`call ${call} ${sym}: ${reject}`); continue; }
    holdingCalls.push({ symbol: sym, call, text });
  }

  const safe = (s: unknown, n: number) => { const t = clamp(s, n); return t && !grounded(t) ? t : null; };
  // Summary lines follow your rules too: money only towards a Buy more / Opportunity, cuts only of a Trim / Sell.
  const calls = Object.fromEntries(g.holdings.filter((h) => h.rules_call).map((h) => [h.symbol, h.rules_call as string]));
  const ruleOk = (t: string | null, kind: 'cash' | 'rebalance') => {
    if (t && !aiLineAllowed(t, kind, calls)) { reasons.push(`${kind} line breaks your rules`); return null; }
    return t;
  };
  let stance: Insight['stance'] = ['buy', 'hold', 'wait'].includes(raw?.stance) ? raw.stance : null;
  if (stance === 'buy' && g.rulesSay === 'Wait') { reasons.push('stance buy on a Wait day'); stance = 'wait'; }
  return {
    insight: {
      headline: safe(raw?.headline, 130) ?? suggestions[0]?.text ?? 'Nothing stands out today. Stick to your plan.',
      stance, suggestions, holding_calls: holdingCalls,
      rebalance: ruleOk(safe(raw?.rebalance, 220), 'rebalance'), cash_note: ruleOk(safe(raw?.cash_note, 200), 'cash'), risks: safe(raw?.risks, 180),
    },
    dropped: rawS.length - suggestions.length,
    reasons,
  };
}

export async function portfolioInsight(ai: LlmRouter, facts: InsightFacts, g: GuardContext) {
  const { data, model } = await ai.json<any>('text', INSIGHT_SYSTEM, [{ text: `Facts (JSON):\n${JSON.stringify(facts)}` }], INSIGHT_SCHEMA);
  return { ...guardInsight(data, facts, g), model };
}

// ---------------------------------------------------------------------------
// 3. Discover picks (market-wide, nightly)
// ---------------------------------------------------------------------------
const PICKS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING' },
          why: { type: 'STRING', description: 'At most 120 characters: ONE fact from the stock\'s "more" facts, never a number from "on_card".' },
          frequency: { type: 'STRING', enum: ['Quarterly', 'Half-yearly', 'Yearly', 'Irregular'], nullable: true, description: 'Dividend kind only: usual payout frequency if known.' },
        },
        required: ['symbol', 'why'],
      },
    },
  },
  required: ['items'],
};

/**
 * One Discover candidate: `on_card` holds the numbers its card already shows, `more` the facts the card does not
 * (payout, one-off yield, suspect payout, latest results, dividend cut). The reason must add one of those.
 */
export interface PickCandidate { symbol: string; sector?: string | null; on_card: Record<string, unknown>; more: Record<string, unknown> }
export interface PickItem { symbol: string; why: string; frequency?: string | null; facts: Record<string, number> }

/** Numbers a reason may not repeat: the card's. Years pass (they are dates). */
const repeatsCard = (why: string, card: number[]) =>
  numbersIn(why).some((n) => !(Number.isInteger(n) && n >= 2020 && n <= 2035) && card.some((k) => Math.abs(k - n) <= Math.max(0.05, Math.abs(k) * 0.005)));

/**
 * Rank and explain candidates the rules found (owner review A10). Only those symbols; each reason quotes only that
 * stock's `more` facts and never a number from its card; a dividend stock with a suspect payout is never picked.
 * Each item keeps the numbers of its `more` facts, so the app can check the reason against them.
 */
export async function discoverPicks(ai: LlmRouter, kind: 'undervalued' | 'dividend', candidates: PickCandidate[]) {
  const ask = kind === 'undervalued'
    ? 'Pick up to 6 of these KSE-100 stocks that look most undervalued (low P/E against their sector, still profitable and paying dividends). Best first.'
    : 'Pick up to 8 of these KSE-100 dividend payers that look most attractive for steady income. Best first. Never pick one whose more.suspect is true. Give the usual payout frequency only if you are confident; otherwise null.';
  const how = 'Each stock has "on_card" (numbers the investor already sees on its card) and "more" (facts the card does not show). '
    + 'For "why" give ONE fact from "more" in plain words, for example how much of its profit it pays out, its latest results, a dividend cut or a one-off yield. '
    + 'Never repeat a number from "on_card".';
  const { data, model } = await ai.json<any>('text',
    'You help a retail investor on the Pakistan Stock Exchange. Use only the JSON facts. Never invent numbers, targets or forecasts. Plain short English.',
    [{ text: `${ask}\n${how}\nFacts (JSON):\n${JSON.stringify(candidates)}` }], PICKS_SCHEMA);
  const bySymbol = new Map(candidates.map((c) => [c.symbol.toUpperCase(), c]));
  const items: PickItem[] = [];
  for (const it of Array.isArray(data?.items) ? data.items : []) {
    const symbol = String(it?.symbol ?? '').toUpperCase().trim();
    const c = bySymbol.get(symbol);
    const why = clamp(it?.why, 140);
    if (!c || !why || items.some((x) => x.symbol === symbol)) continue;
    if (kind === 'dividend' && c.more.suspect === true) continue;
    if (!numbersGrounded(why, numberSet(c.more)).ok || repeatsCard(why, numberSet(c.on_card))) continue;
    const facts = Object.fromEntries(Object.entries(c.more).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
    const frequency = kind === 'dividend' && ['Quarterly', 'Half-yearly', 'Yearly', 'Irregular'].includes(it?.frequency) ? it.frequency : null;
    items.push(kind === 'dividend' ? { symbol, why, frequency, facts } : { symbol, why, facts });
    if (items.length === (kind === 'undervalued' ? 6 : 8)) break;
  }
  return { items, model };
}
