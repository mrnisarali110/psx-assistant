/**
 * AI layer (Google Gemini, free tier). Two jobs:
 *   1. Read PSX announcement PDFs: plain summary + key figures, each figure checked against the PDF text.
 *   2. "AI Assistant suggests": a second opinion on the portfolio, built only from facts we pass in.
 * Guardrails: the rules engine stays in charge. Suggestions that cite numbers not in the facts, name a
 * stock outside the user's universe, or break the user's own rules are dropped. The AI never changes
 * plan amounts, and every failure falls back to "no AI" without affecting alerts.
 */
import { extractText, getDocumentProxy } from 'unpdf';

export const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

export interface GeminiOptions { apiKey: string; models?: string[]; fetchImpl?: typeof fetch; log?: (m: string) => void }

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

export class GeminiClient {
  private models: string[];
  private fetchImpl: typeof fetch;
  private log: (m: string) => void;
  calls = 0;

  constructor(private opts: GeminiOptions) {
    this.models = opts.models?.length ? opts.models : DEFAULT_MODELS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? console.log;
  }

  /** Ask for JSON matching `schema`. Tries each model in turn on rate limits, missing models or server errors. */
  async json<T>(parts: Part[], schema: object, system: string): Promise<{ data: T; model: string }> {
    let last = 'no model tried';
    for (const model of this.models) {
      this.calls++;
      let r: Response;
      try {
        r = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
          }),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (e) {
        last = `${model}: ${(e as Error).message}`;
        continue;
      }
      if (!r.ok) {
        const body = (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
        last = `${model}: HTTP ${r.status} ${body}`;
        if ([400, 401, 403].includes(r.status) && !/model|not found|not supported/i.test(body)) break; // bad key/request: other models won't help
        this.log(`gemini ${last}; trying next model`);
        continue;
      }
      const j = (await r.json()) as any;
      const text: string | undefined = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('');
      const data = parseJsonLoose(text);
      if (data != null) return { data: data as T, model };
      last = `${model}: unparseable response (${j?.candidates?.[0]?.finishReason ?? 'no candidates'})`;
    }
    throw new Error(`Gemini unavailable: ${last}`);
  }
}

export function parseJsonLoose(text: string | undefined | null): unknown {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = /\{[\s\S]*\}/.exec(t);
    try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
  }
}

// ---------------------------------------------------------------------------
// Number checking (shared by both guardrails)
// ---------------------------------------------------------------------------
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

export function numbersIn(text: string): number[] {
  return (text.match(NUM_RE) ?? []).map((s) => Number(s.replace(/,/g, ''))).filter(Number.isFinite);
}

/** Every number found anywhere in `facts` (JSON or text), plus rounded variants. */
export function numberSet(facts: unknown): number[] {
  const out = new Set<number>();
  const add = (n: number) => {
    for (const v of [n, Math.abs(n)]) {
      out.add(v);
      out.add(Math.round(v));
      out.add(Math.round(v * 10) / 10);
      out.add(Math.round(v * 100) / 100);
    }
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
    if (Number.isInteger(n) && n <= 31) return false; // dates, counts, tranche numbers
    if (n >= 2020 && n <= 2035 && Number.isInteger(n)) return false; // years
    return !known.some((k) => Math.abs(k - n) <= Math.max(0.05, Math.abs(k) * 0.005));
  });
  return { ok: unknown.length === 0, unknown };
}

// ---------------------------------------------------------------------------
// 1. Announcement reader
// ---------------------------------------------------------------------------
export interface AnnouncementDigest {
  summary: string;
  figures: { label: string; value: string; verified: boolean }[];
  verified: boolean; // all numbers in the summary and figures were found in the PDF text
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

export async function readAnnouncement(ai: GeminiClient, pdf: Uint8Array, meta: { symbol: string; title: string }): Promise<AnnouncementDigest & { model: string }> {
  const text = await pdfText(pdf);
  const { data, model } = await ai.json<{ summary: string; figures: { label: string; value: string }[] }>(
    [
      { inline_data: { mime_type: 'application/pdf', data: Buffer.from(pdf).toString('base64') } },
      { text: `PSX announcement for ${meta.symbol}: "${meta.title}". Summarize what it means for a shareholder and list the key figures exactly as printed. If it is only a notice of a future meeting, say so and give the date.` },
    ],
    ANN_SCHEMA,
    'You read Pakistan Stock Exchange company announcements. Report only what the document says. Never guess, never give investment advice, never invent numbers.',
  );
  const known = text ? numberSet(text) : [];
  const figures = (data.figures ?? []).slice(0, 5).map((f) => ({
    label: String(f.label).slice(0, 60),
    value: String(f.value).slice(0, 60),
    verified: !!text && numbersIn(String(f.value)).length > 0 && numbersGrounded(String(f.value), known).ok,
  }));
  const summary = String(data.summary ?? '').slice(0, 400);
  const verified = !!text && numbersGrounded(summary, known).ok && figures.every((f) => f.verified || numbersIn(f.value).length === 0);
  return { summary, figures, verified, model };
}

// ---------------------------------------------------------------------------
// 2. Portfolio assistant
// ---------------------------------------------------------------------------
export type SuggestionAction = 'buy' | 'add' | 'hold' | 'trim' | 'sell' | 'watch' | 'review';
export interface Suggestion { action: SuggestionAction; symbol: string | null; text: string; why: string; confidence: 'low' | 'medium' | 'high' }
export interface Insight { headline: string; suggestions: Suggestion[]; plan_note: string | null; risks: string | null }

export interface InsightFacts {
  date: string;
  market: { kse100: number | null; change_pct: number | null; rules_say: string; rules_reason: string; crash_level: number };
  rules: { max_position_pct: number; below_cost_alert_pct: number; shariah_only: boolean; monthly_budget_pkr: number; crash_fund_pkr: number };
  portfolio: { total_value_pkr: number; total_pnl_pct: number | null; sectors: { sector: string; pct: number }[] };
  holdings: Record<string, unknown>[];
  watchlist: Record<string, unknown>[];
  screen_candidates: Record<string, unknown>[];
  plan_tranche_1: { symbol: string; shares: number; rupees: number; kind: string }[];
  recent_news: { symbol: string; date: string; summary: string }[];
}

const INSIGHT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: 'One sentence, at most 120 characters.' },
    suggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', enum: ['buy', 'add', 'hold', 'trim', 'sell', 'watch', 'review'] },
          symbol: { type: 'STRING', nullable: true },
          text: { type: 'STRING', description: 'The suggestion, at most 160 characters.' },
          why: { type: 'STRING', description: 'Reason citing only numbers from the facts, at most 200 characters.' },
          confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
        },
        required: ['action', 'text', 'why', 'confidence'],
      },
    },
    plan_note: { type: 'STRING', description: "Comment on this month's rule-based plan, at most 250 characters.", nullable: true },
    risks: { type: 'STRING', description: 'Main risk to watch, at most 160 characters.', nullable: true },
  },
  required: ['headline', 'suggestions'],
};

const INSIGHT_SYSTEM = `You are a cautious assistant for a retail investor on the Pakistan Stock Exchange.
You give a second opinion on their portfolio using ONLY the JSON facts provided.
Rules you must follow:
- Use only numbers that appear in the facts. Do not estimate targets, forecasts or prices.
- Only mention symbols that appear in the facts.
- Respect the investor's own rules: never suggest adding to a holding whose status is hold_no_add or review, never suggest buying a stock already at or above max_position_pct, and when rules_say is "Wait" do not suggest buying.
- "trim" or "sell" only with a concrete reason from the facts (e.g. over the position cap, sector over limit, weak results in recent_news, status review).
- At most 4 suggestions, most important first. Skip plain "hold" lines unless holding is itself the point; say what to DO or WATCH.
- recent_news contains AI summaries of company announcements: use them when relevant (results, dividends).
- screen_candidates are high-yield, low-P/E KSE-100 stocks the investor does not own; you may suggest "watch" for one if it fits a sector they lack.
- plan_note: comment on plan_tranche_1 itself (which stocks get the money and whether that mix looks sensible), not on the market.
- Plain, short English for a non-expert. Say "profit/loss" not "PnL". No guarantees, no hype.`;

export interface GuardContext {
  holdings: { symbol: string; status: string; weight_pct: number | null; is_shariah: boolean | null }[];
  universe: Set<string>; // holdings + watchlist + screen candidates
  shariahOf: (s: string) => boolean | null;
  maxPositionPct: number;
  shariahOnly: boolean;
  rulesSay: 'Buy' | 'Hold' | 'Wait';
}

/** Drop anything the rules forbid or the facts don't support. Returns the kept suggestions and how many were dropped. */
export function guardInsight(raw: Partial<Insight>, facts: unknown, g: GuardContext): { insight: Insight; dropped: number; reasons: string[] } {
  const known = numberSet(facts);
  const reasons: string[] = [];
  const clamp = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const kept: Suggestion[] = [];
  for (const s of (raw.suggestions ?? []).slice(0, 6)) {
    const sym = s.symbol ? String(s.symbol).toUpperCase().trim() : null;
    const action = s.action as SuggestionAction;
    const text = clamp(s.text, 200);
    const why = clamp(s.why, 240);
    const h = sym ? g.holdings.find((x) => x.symbol === sym) : undefined;
    const buying = action === 'buy' || action === 'add';
    let reject: string | null = null;
    if (!['buy', 'add', 'hold', 'trim', 'sell', 'watch', 'review'].includes(action)) reject = `unknown action ${action}`;
    else if (sym && !g.universe.has(sym)) reject = `${sym} is not in your portfolio, watchlist or screen`;
    else if (!text) reject = 'empty';
    else if (buying && h && (h.status === 'hold_no_add' || h.status === 'review')) reject = `${sym} is ${h.status}`;
    else if (buying && h?.weight_pct != null && h.weight_pct >= g.maxPositionPct) reject = `${sym} is at the position cap`;
    else if (buying && g.shariahOnly && sym && g.shariahOf(sym) !== true) reject = `${sym} not confirmed Shariah`;
    else if (buying && g.rulesSay === 'Wait') reject = 'rules say Wait (do not chase a rally)';
    else {
      const chk = numbersGrounded(`${text} ${why}`, known);
      if (!chk.ok) reject = `numbers not in the data: ${chk.unknown.join(', ')}`;
    }
    if (reject) { reasons.push(`${action} ${sym ?? ''}: ${reject}`.trim()); continue; }
    kept.push({ action, symbol: sym, text, why, confidence: (['low', 'medium', 'high'].includes(s.confidence as string) ? s.confidence : 'low') as Suggestion['confidence'] });
    if (kept.length === 4) break;
  }
  const headline = clamp(raw.headline, 140);
  const planNote = raw.plan_note ? clamp(raw.plan_note, 300) : null;
  const risks = raw.risks ? clamp(raw.risks, 200) : null;
  // Free-text fields must also stay grounded; drop them rather than show an invented number.
  const safe = (s: string | null) => (s && numbersGrounded(s, known).ok ? s : null);
  return {
    insight: {
      headline: safe(headline) ?? (kept[0]?.text ?? 'Nothing stands out today. Stick to your plan.'),
      suggestions: kept,
      plan_note: safe(planNote),
      risks: safe(risks),
    },
    dropped: (raw.suggestions?.length ?? 0) - kept.length,
    reasons,
  };
}

export async function portfolioInsight(ai: GeminiClient, facts: InsightFacts, g: GuardContext) {
  const { data, model } = await ai.json<Partial<Insight>>([{ text: `Facts (JSON):\n${JSON.stringify(facts)}` }], INSIGHT_SCHEMA, INSIGHT_SYSTEM);
  return { ...guardInsight(data, facts, g), model };
}
