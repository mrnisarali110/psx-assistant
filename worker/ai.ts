/**
 * AI tasks for the scheduled worker, on top of the shared Groq/Gemini router (shared/llm.ts):
 *   1. Read PSX announcement PDFs: summary, key figures, and any cash dividend with its book closure.
 *   2. "AI Assistant suggests": stance for the day, a call per holding, suggestions, rebalance, cash note.
 *   3. Discover picks: rank and explain undervalued and dividend candidates the rules found.
 * Guardrails: the AI only sees facts we compute. Anything citing a number not in those facts, naming a stock
 * outside the allowed set, or breaking the user's own rules is dropped. Failures never stop the worker.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import type { LlmRouter } from '../shared/llm.ts';
import type { AiSuggestion, HoldingCallKind } from '../shared/types.ts';

// ---------------------------------------------------------------------------
// Number grounding
// ---------------------------------------------------------------------------
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

export function numbersIn(text: string): number[] {
  return (text.match(NUM_RE) ?? []).map((s) => Number(s.replace(/,/g, ''))).filter(Number.isFinite);
}

/** Every number found anywhere in `facts` (JSON or text), plus rounded variants. */
export function numberSet(facts: unknown): number[] {
  const out = new Set<number>();
  const add = (n: number) => {
    for (const v of [n, Math.abs(n)]) for (const k of [1, 10, 100]) out.add(Math.round(v * k) / k);
    out.add(n);
  };
  const walk = (x: unknown) => {
    if (typeof x === 'number') add(x);
    else if (typeof x === 'string') numbersIn(x).forEach(add);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(facts);
  return [...out];
}

/** True if every number in `text` matches a known number (small integers like dates and counts are allowed). */
export function numbersGrounded(text: string, known: number[]): { ok: boolean; unknown: number[] } {
  const unknown = numbersIn(text).filter((n) => {
    if (Number.isInteger(n) && n <= 31) return false; // dates, counts
    if (Number.isInteger(n) && n >= 2020 && n <= 2035) return false; // years
    return !known.some((k) => Math.abs(k - n) <= Math.max(0.05, Math.abs(k) * 0.005));
  });
  return { ok: unknown.length === 0, unknown };
}

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
  model: string;
}

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

export async function readAnnouncement(ai: LlmRouter, pdf: Uint8Array, meta: { symbol: string; title: string }): Promise<AnnouncementDigest> {
  const text = await pdfText(pdf);
  const { data, model } = await ai.json<any>('pdf',
    'You read Pakistan Stock Exchange company announcements. Report only what the document says. Never guess, never give investment advice, never invent numbers.',
    [
      { pdf: { base64: Buffer.from(pdf).toString('base64'), text } },
      { text: `PSX announcement for ${meta.symbol}: "${meta.title}". Summarize what it means for a shareholder, list key figures exactly as printed, and fill the dividend fields only if a cash dividend is declared in it.` },
    ], ANN_SCHEMA);
  const known = text ? numberSet(text) : [];
  const checks = (s: string) => !!text && numbersGrounded(s, known).ok;
  const figures = (Array.isArray(data.figures) ? data.figures : []).slice(0, 5).map((f: any) => ({
    label: clamp(f.label, 60), value: clamp(f.value, 60),
    verified: numbersIn(String(f.value)).length > 0 && checks(String(f.value)),
  }));
  const summary = clamp(data.summary, 400);
  const dps = Number(data.cash_dividend_per_share);
  const dividend = Number.isFinite(dps) && dps > 0 && dps < 10_000 ? {
    dps: Math.round(dps * 100) / 100,
    type: ['interim', 'final', 'special'].includes(data.dividend_type) ? data.dividend_type : null,
    book_closure_from: isoDate(data.book_closure_from),
    book_closure_to: isoDate(data.book_closure_to),
    // "70%" on Rs 10 face value is printed as 70, so accept either the DPS or the percentage form.
    verified: !!text && (numbersGrounded(String(dps), known).ok || numbersGrounded(String(dps * 10), known).ok),
  } : null;
  return {
    summary, figures, dividend, model,
    verified: checks(summary || '0') && figures.every((f: { value: string; verified: boolean }) => f.verified || numbersIn(f.value).length === 0),
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
  portfolio: { total_value_pkr: number; total_pnl_pct: number | null; sectors: { sector: string; pct: number }[]; rebalance_flags: string[] };
  holdings: Record<string, unknown>[];
  watchlist: Record<string, unknown>[];
  screen_candidates: Record<string, unknown>[];
  upcoming_dividends: Record<string, unknown>[];
  recent_news: { symbol: string; date: string; summary: string }[];
}

const CALLS: HoldingCallKind[] = ['hold', 'average_down', 'opportunity', 'trim', 'review'];
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
Suggestions: at most 4, actions to DO or WATCH (skip plain holds). Mention screen_candidates only as "watch".
Plain short English for a non-expert ("profit/loss", not "PnL"). No guarantees, no hype.`;

export interface GuardContext {
  holdings: { symbol: string; status: string; weight_pct: number | null; is_shariah: boolean | null }[];
  universe: Set<string>; // holdings + watchlist + screen candidates
  shariahOf: (s: string) => boolean | null;
  maxPositionPct: number;
  shariahOnly: boolean;
  rulesSay: 'Buy' | 'Hold' | 'Wait';
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
    const reject = !ACTIONS.includes(action) ? `unknown action ${action}`
      : sym && !g.universe.has(sym) ? `${sym} is not in your portfolio, watchlist or screen`
      : !text ? 'empty'
      : buying ? buyBlocked(sym, g) ?? grounded(`${text} ${why}`)
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
    const reject = (adding ? buyBlocked(sym, { ...g, rulesSay: 'Hold' }) : null) ?? grounded(text);
    if (reject) { reasons.push(`call ${call} ${sym}: ${reject}`); continue; }
    holdingCalls.push({ symbol: sym, call, text });
  }

  const safe = (s: unknown, n: number) => { const t = clamp(s, n); return t && !grounded(t) ? t : null; };
  let stance: Insight['stance'] = ['buy', 'hold', 'wait'].includes(raw?.stance) ? raw.stance : null;
  if (stance === 'buy' && g.rulesSay === 'Wait') { reasons.push('stance buy on a Wait day'); stance = 'wait'; }
  return {
    insight: {
      headline: safe(raw?.headline, 130) ?? suggestions[0]?.text ?? 'Nothing stands out today. Stick to your plan.',
      stance, suggestions, holding_calls: holdingCalls,
      rebalance: safe(raw?.rebalance, 220), cash_note: safe(raw?.cash_note, 200), risks: safe(raw?.risks, 180),
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
          why: { type: 'STRING', description: 'At most 120 characters, citing only numbers from the facts.' },
          frequency: { type: 'STRING', enum: ['Quarterly', 'Half-yearly', 'Yearly', 'Irregular'], nullable: true, description: 'Dividend kind only: usual payout frequency if known.' },
        },
        required: ['symbol', 'why'],
      },
    },
  },
  required: ['items'],
};

/** Rank and explain candidates the rules found. Only those symbols, only their numbers. */
export async function discoverPicks(ai: LlmRouter, kind: 'undervalued' | 'dividend', candidates: Record<string, unknown>[]) {
  const ask = kind === 'undervalued'
    ? 'Pick up to 6 of these KSE-100 stocks that look most undervalued (low P/E against their sector, still profitable and paying dividends). Best first.'
    : 'Pick up to 8 of these KSE-100 dividend payers that look most attractive for steady income. Best first. Give the usual payout frequency only if you are confident; otherwise null.';
  const { data, model } = await ai.json<any>('text',
    'You help a retail investor on the Pakistan Stock Exchange. Use only the JSON facts. Never invent numbers, targets or forecasts. Plain short English.',
    [{ text: `${ask}\nFacts (JSON):\n${JSON.stringify(candidates)}` }], PICKS_SCHEMA);
  const known = numberSet(candidates);
  const allowed = new Set(candidates.map((c) => String(c.symbol)));
  const items: { symbol: string; why: string; frequency?: string | null }[] = [];
  for (const it of Array.isArray(data?.items) ? data.items : []) {
    const symbol = String(it?.symbol ?? '').toUpperCase().trim();
    const why = clamp(it?.why, 140);
    if (!allowed.has(symbol) || !why || !numbersGrounded(why, known).ok || items.some((x) => x.symbol === symbol)) continue;
    const frequency = kind === 'dividend' && ['Quarterly', 'Half-yearly', 'Yearly', 'Irregular'].includes(it?.frequency) ? it.frequency : null;
    items.push(kind === 'dividend' ? { symbol, why, frequency } : { symbol, why });
    if (items.length === (kind === 'undervalued' ? 6 : 8)) break;
  }
  return { items, model };
}
