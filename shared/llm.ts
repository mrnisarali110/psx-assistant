/**
 * One way to ask an AI for JSON, with three free providers behind it:
 *   Groq (fast text models), Google Gemini (reads PDFs and images natively) and
 *   OpenRouter (free community models for text and images; the live model list decides which exist today).
 * Each task type has a preferred order; a provider that is missing, rate limited, overloaded or returns junk
 * is skipped and the next one is tried.
 *
 * Being frugal with free tiers:
 *   - Health memory: a model that answered 429 (limit) or 503 (busy) goes on a cooldown, until its limit resets
 *     (daily quotas: the provider's midnight), so later calls skip it WITHOUT spending a request. The memory
 *     lives as long as the process / Worker isolate.
 *   - Probes: each provider can be checked with a free "list models" / "key info" call that costs no tokens.
 *     Results are cached for 10 minutes. Nothing here ever sends a test prompt.
 * Server-side only (the API keys never reach the browser). Plain fetch: runs in Node and in Cloudflare Workers.
 */

export type LlmTask = 'text' | 'pdf' | 'vision';
export type LlmPart =
  | { text: string }
  | { pdf: { base64: string; text: string } } // text = extracted PDF text, for providers that can't read PDFs
  | { image: { mime: string; base64: string } };

export interface LlmResult<T> { data: T; model: string }

export interface ProbeResult { ok: boolean; detail: string }
export interface ProviderStatus {
  name: string;
  state: 'ready' | 'cooling' | 'bad_key' | 'error';
  detail?: string;
  until?: string; // ISO time the cooldown ends
}

export interface AskOpts {
  ms?: number; // per-request timeout
  /** Reject an answer that parsed but is useless (e.g. an empty holdings list); the next model / provider is tried. */
  accept?: (data: any) => boolean;
}

export interface Provider {
  name: string;
  can(task: LlmTask, parts: LlmPart[]): boolean;
  json<T>(task: LlmTask, system: string, parts: LlmPart[], schema: object, opts?: AskOpts): Promise<LlmResult<T>>;
  /** Earliest moment this provider is worth calling again, if it is cooling down. */
  cooldown(): { until: number; reason: string } | null;
  /** Free check that the key works (no tokens spent). */
  probe(): Promise<ProbeResult>;
}

type Fetch = typeof fetch;

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

export class ModelError extends Error {
  retryMs?: number; // what the provider asked us to wait (Retry-After header or message)
  daily = false; // a per-day quota: pointless to retry before the provider's midnight
  constructor(message: string, readonly fatal: boolean, readonly status = 0) { super(message); }
}

// ---------------------------------------------------------------------------
// Health memory (cooldowns + probe cache)
// ---------------------------------------------------------------------------
export interface Cooldown { until: number; reason: string; status: number }
export interface FreeModel { id: string; image: boolean; context: number }

const MAX_COOLDOWN_MS = 30 * 3600_000;
const PROBE_TTL_MS = 10 * 60_000;
const MODEL_LIST_TTL_MS = 6 * 3600_000;

export class LlmHealth {
  private cool = new Map<string, Cooldown>();
  probes = new Map<string, { at: number; result: ProbeResult }>();
  modelLists = new Map<string, { at: number; list: FreeModel[] }>();
  constructor(public now: () => number = Date.now) {}

  cooling(key: string): Cooldown | null {
    const c = this.cool.get(key);
    if (!c) return null;
    if (c.until <= this.now()) { this.cool.delete(key); return null; }
    return c;
  }
  mark(key: string, ms: number, reason: string, status: number) {
    const until = this.now() + Math.max(1000, Math.min(ms, MAX_COOLDOWN_MS));
    const cur = this.cool.get(key);
    if (!cur || cur.until < until) this.cool.set(key, { until, reason: reason.replace(/\s+/g, ' ').slice(0, 160), status });
  }
  clear(key?: string) { if (key) this.cool.delete(key); else this.cool.clear(); }
  /** Active cooldowns, for logs and the status endpoint. */
  snapshot(): { key: string; until: string; reason: string; status: number }[] {
    return [...this.cool].filter(([, c]) => c.until > this.now())
      .map(([key, c]) => ({ key, until: new Date(c.until).toISOString(), reason: c.reason, status: c.status }));
  }
  cachedProbe(name: string): ProbeResult | null {
    const p = this.probes.get(name);
    return p && this.now() - p.at < PROBE_TTL_MS ? p.result : null;
  }
}
/** Shared by every router made in this process (or Worker isolate). */
export const llmHealth = new LlmHealth();

/** Next midnight in a time zone, plus a minute of slack (free-tier daily quotas reset then). */
export function nextMidnight(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0) % (t === 'hour' ? 24 : 60);
  const elapsed = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
  return now - elapsed + 86_400_000 + 60_000;
}

/** How long to leave a model alone after an error. */
export function cooldownFor(e: ModelError, now: number, quotaZone: string): number {
  if (e.status === 429 || e.status === 402) {
    if (e.daily) return nextMidnight(now, quotaZone) - now;
    return Math.min(Math.max(e.retryMs ?? 90_000, 15_000), 2 * 3600_000);
  }
  if (e.status === 503) return 60_000;
  if (e.status >= 500) return 30_000;
  if (e.status === 0) return 20_000; // network / timeout
  return 0; // 4xx about our request: not the model's health
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
export interface ProviderOpts { models?: string[]; fetchImpl?: Fetch; log?: (m: string) => void; health?: LlmHealth }

/** Tries each model of one provider in order; remembers which ones are cooling down. */
abstract class BaseProvider implements Provider {
  abstract name: string;
  /** Where the provider's daily quota resets. */
  protected quotaZone = 'UTC';
  /** A daily limit applies to one model or the whole key. */
  protected dailyScope: 'model' | 'provider' = 'model';
  protected fetchImpl: Fetch;
  protected log: (m: string) => void;
  protected health: LlmHealth;
  /** Delay before retrying an overloaded model (tests set it to 0). */
  retryMs = 1500;

  constructor(protected apiKey: string, protected models: string[], opts: ProviderOpts = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? console.log;
    this.health = opts.health ?? llmHealth;
  }
  abstract can(task: LlmTask, parts: LlmPart[]): boolean;
  abstract probe(): Promise<ProbeResult>;
  protected abstract call(model: string, system: string, parts: LlmPart[], schema: object, ms: number): Promise<unknown>;
  /** Models to try for this task, best first. */
  protected async modelsFor(_task: LlmTask, _parts: LlmPart[]): Promise<string[]> { return this.models; }
  /** The model that actually answered (a provider may route to a fallback itself). */
  protected answeredBy(model: string) { return model; }
  protected key(model: string) { return `${this.name}/${model}`; }

  cooldown() {
    const all = this.health.cooling(this.key('*'));
    if (all) return { until: all.until, reason: all.reason };
    const known = this.models.length ? this.models : (this.health.modelLists.get(this.name)?.list.map((m) => m.id) ?? []);
    if (!known.length) return null;
    const cs = known.map((m) => this.health.cooling(this.key(m)));
    if (cs.some((c) => !c)) return null;
    const first = cs.reduce((a, c) => (c!.until < a!.until ? c : a))!;
    return { until: first.until, reason: first.reason };
  }

  async json<T>(task: LlmTask, system: string, parts: LlmPart[], schema: object, opts: AskOpts = {}): Promise<LlmResult<T>> {
    const ms = opts.ms ?? 90_000;
    const all = await this.modelsFor(task, parts);
    const whole = this.health.cooling(this.key('*'));
    const live = whole ? [] : all.filter((m) => !this.health.cooling(this.key(m)));
    if (!live.length) {
      const c = whole ?? all.map((m) => this.health.cooling(this.key(m))).filter(Boolean).sort((a, b) => a!.until - b!.until)[0];
      throw new Error(`${this.name} cooling down until ${c ? new Date(c.until).toISOString() : '?'}: ${c?.reason ?? 'no model'}`);
    }
    let last = 'no model';
    for (const model of live) {
      // "Overloaded" spikes usually pass within seconds: one short retry before moving to the next model.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await this.call(model, system, parts, schema, ms);
          if (data != null && typeof data === 'object') {
            if (!opts.accept || opts.accept(data)) return { data: data as T, model: `${this.name}/${this.answeredBy(model)}` };
            last = `${this.answeredBy(model)}: answer rejected (useless)`;
          } else {
            last = `${model}: unparseable response`;
          }
          this.log(`${this.name} ${last}; trying next`);
          break;
        } catch (e) {
          const err = e instanceof ModelError ? e : new ModelError((e as Error).message, false, 0);
          last = `${model}: ${err.message}`;
          if (err.fatal) { // bad key: nothing else will work either
            this.health.mark(this.key('*'), 10 * 60_000, `bad API key (${err.message})`, err.status);
            throw new Error(`${this.name} unavailable: ${last.slice(0, 200)}`);
          }
          if (err.status === 503 && attempt === 0) { await new Promise((r) => setTimeout(r, this.retryMs)); continue; }
          const cool = cooldownFor(err, this.health.now(), this.quotaZone);
          if (cool > 0) this.health.mark(this.key(err.daily && this.dailyScope === 'provider' ? '*' : model), cool, last, err.status);
          // OpenRouter refuses every free model until "Free model training" is allowed in its privacy settings: not a per-model matter.
          if (err.status === 404 && /data policy|privacy/i.test(err.message)) this.health.mark(this.key('*'), 2 * 60_000, last, err.status);
          this.log(`${this.name} ${last.slice(0, 160)}; trying next`);
          break;
        }
      }
      if (this.health.cooling(this.key('*'))) break; // the whole key is out for the day
    }
    throw new Error(`${this.name} unavailable: ${last.slice(0, 200)}`);
  }

  protected async post(url: string, headers: Record<string, string>, body: unknown, ms: number): Promise<any> {
    let r: Response;
    try {
      r = await this.fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      throw new ModelError(`network: ${(e as Error).message}`, false, 0);
    }
    const text = await r.text().catch(() => '');
    if (!r.ok) throw this.classify(r.status, text, r.headers.get('retry-after'));
    let j: any;
    try { j = JSON.parse(text); } catch { throw new ModelError('non-JSON response', false, 0); }
    if (j?.error && !j?.choices && !j?.candidates) { // OpenRouter reports some upstream errors with HTTP 200
      throw this.classify(Number(j.error.code) || 502, JSON.stringify(j.error), null);
    }
    return j;
  }

  /** Turn an error response into a ModelError with what to do about it. */
  protected classify(status: number, rawText: string, retryAfter: string | null): ModelError {
    const text = rawText.replace(/"user_id"\s*:\s*"[^"]*",?/g, ''); // OpenRouter echoes its account id; keep it out of public logs
    const short = text.slice(0, 300).replace(/\s+/g, ' ');
    const fatal = [401, 403].includes(status) || (status === 400 && /api key|apikey|credential|unauthori/i.test(text));
    const e = new ModelError(`HTTP ${status} ${short}`, fatal, status);
    if (status === 429 || status === 402) {
      e.daily = /per[ _-]?day|daily|free-models-per-day|\bRPD\b|\bTPD\b|requests per day|tokens per day/i.test(text);
      const header = retryAfter ? (Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - this.health.now())) : 0;
      const m = /retry(?:Delay|[^.]*?\bin)\D{0,6}([\d.]+)\s*(ms|s|m|min|h)?\b/i.exec(text);
      const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3600_000 };
      const inBody = m ? Number(m[1]) * (unit[(m[2] ?? 's').toLowerCase()] ?? 1000) : 0;
      e.retryMs = Math.max(header, inBody) || undefined;
    }
    return e;
  }

  protected async probeGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
    const r = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    const text = await r.text().catch(() => '');
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { status: r.status, body };
  }
  /** Runs the free check at most once per 10 minutes. */
  protected async cachedProbe(run: () => Promise<ProbeResult>): Promise<ProbeResult> {
    const hit = this.health.cachedProbe(this.name);
    if (hit) return hit;
    let result: ProbeResult;
    try { result = await run(); } catch (e) { result = { ok: false, detail: `unreachable: ${(e as Error).message.slice(0, 80)}` }; }
    this.health.probes.set(this.name, { at: this.health.now(), result });
    return result;
  }
  protected probeVerdict(status: number, okDetail: string): ProbeResult {
    if (status >= 200 && status < 300) return { ok: true, detail: okDetail };
    if ([400, 401, 403].includes(status)) return { ok: false, detail: `bad API key (HTTP ${status})` };
    if (status === 429) return { ok: false, detail: 'rate limited right now' };
    return { ok: false, detail: `HTTP ${status}` };
  }
}

export class GeminiProvider extends BaseProvider {
  name = 'gemini';
  protected quotaZone = 'America/Los_Angeles'; // Google's free-tier day
  static MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  constructor(apiKey: string, opts: ProviderOpts = {}) {
    super(apiKey, opts.models?.length ? opts.models : GeminiProvider.MODELS, opts);
  }
  can() { return true; }
  protected async call(model: string, system: string, parts: LlmPart[], schema: object, ms: number) {
    const gParts = parts.map((p) => 'text' in p ? { text: p.text }
      : 'pdf' in p ? { inline_data: { mime_type: 'application/pdf', data: p.pdf.base64 } }
      : { inline_data: { mime_type: p.image.mime, data: p.image.base64 } });
    const j = await this.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { 'x-goog-api-key': this.apiKey }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: gParts }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema },
    }, ms);
    return parseJsonLoose(j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join(''));
  }
  probe() {
    return this.cachedProbe(async () => {
      const r = await this.probeGet('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': this.apiKey });
      return this.probeVerdict(r.status, 'key valid');
    });
  }
}

export class GroqProvider extends BaseProvider {
  name = 'groq';
  static MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
  constructor(apiKey: string, opts: ProviderOpts = {}) {
    super(apiKey, opts.models?.length ? opts.models : GroqProvider.MODELS, opts);
  }
  /** Text only: PDFs work through their extracted text; images are not supported. */
  can(_task: LlmTask, parts: LlmPart[]) {
    return parts.every((p) => 'text' in p || ('pdf' in p && p.pdf.text.trim().length > 200));
  }
  protected async call(model: string, system: string, parts: LlmPart[], schema: object, ms: number) {
    const user = parts.map((p) => ('text' in p ? p.text : 'pdf' in p ? `Document text:\n${p.pdf.text.slice(0, 60_000)}` : '')).join('\n\n');
    const j = await this.post('https://api.groq.com/openai/v1/chat/completions', { Authorization: `Bearer ${this.apiKey}` }, {
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${system}\nReply with a single JSON object matching this schema (OpenAPI style): ${JSON.stringify(schema)}` },
        { role: 'user', content: user },
      ],
    }, ms);
    return parseJsonLoose(j?.choices?.[0]?.message?.content);
  }
  probe() {
    return this.cachedProbe(async () => {
      const r = await this.probeGet('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${this.apiKey}` });
      return this.probeVerdict(r.status, 'key valid');
    });
  }
}

/**
 * OpenRouter: one key, many free models (":free"). Which ones exist changes often, so the public model list
 * (a free call, cached 6 h) decides; the names below only set the order of preference.
 */
export class OpenRouterProvider extends BaseProvider {
  name = 'openrouter';
  protected dailyScope = 'provider' as const; // the free daily request limit is per key, across all free models
  /** Best first. Names from the 2026-10-14 free list come first; older names stay in case they return. */
  static VISION = [
    'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'thinkingmachines/inkling:free', 'thinkingmachines/inkling-small:free',
    'dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'meta-llama/llama-4-maverick:free', 'qwen/qwen2.5-vl-72b-instruct:free', 'google/gemma-3-27b-it:free',
    'mistralai/mistral-small-3.2-24b-instruct:free', 'meta-llama/llama-4-scout:free', 'qwen/qwen2.5-vl-32b-instruct:free',
  ];
  static TEXT = [
    'nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'thinkingmachines/inkling:free',
    'openai/gpt-oss-120b:free', 'meta-llama/llama-4-maverick:free', 'qwen/qwen3-235b-a22b:free', 'deepseek/deepseek-chat-v3.1:free',
    'meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free',
  ];
  /** OpenRouter's own "any free model that fits" router: the last resort. */
  static ANY_FREE = 'openrouter/free';
  /** Guardrail, music, speech and embedding models answer nothing useful however their modalities read. */
  static JUNK = /safety|guard|moderation|lyria|music|audio|tts|speech|whisper|embed|rerank|image-gen|diffusion/i;
  /** Models tried per request; a long chain of free models would make a request crawl. */
  static MAX_TRY = 4;
  static MODELS_URL = 'https://openrouter.ai/api/v1/models';

  private candidates: string[] = [];
  private usedModel?: string;

  constructor(apiKey: string, opts: ProviderOpts = {}) {
    super(apiKey, opts.models ?? [], opts); // explicit models (OPENROUTER_MODELS) switch discovery off
  }
  can(_task: LlmTask, parts: LlmPart[]) {
    return parts.every((p) => 'text' in p || 'image' in p || ('pdf' in p && p.pdf.text.trim().length > 200));
  }

  /** Free chat models right now: price 0 for prompt, completion, image and request; text out; no guardrail/music/speech models. */
  async freeModels(): Promise<FreeModel[]> {
    const cached = this.health.modelLists.get(this.name);
    if (cached && this.health.now() - cached.at < MODEL_LIST_TTL_MS) return cached.list;
    try {
      const r = await this.fetchImpl(OpenRouterProvider.MODELS_URL, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: any = await r.json();
      const zero = (v: unknown) => v == null || Number(v) === 0;
      const textOnly = (out: unknown) => !Array.isArray(out) || (out.includes('text') && out.every((o) => o === 'text'));
      const list: FreeModel[] = (Array.isArray(j?.data) ? j.data : [])
        .filter((m: any) => m?.id && m.pricing && zero(m.pricing.prompt) && zero(m.pricing.completion) && zero(m.pricing.image) && zero(m.pricing.request))
        .filter((m: any) => textOnly(m.architecture?.output_modalities) && !OpenRouterProvider.JUNK.test(String(m.id)))
        .map((m: any) => ({ id: String(m.id), image: (m.architecture?.input_modalities ?? []).includes('image'), context: Number(m.context_length) || 0 }));
      this.health.modelLists.set(this.name, { at: this.health.now(), list });
      return list;
    } catch (e) {
      this.log(`openrouter model list failed: ${(e as Error).message.slice(0, 100)}`);
      return cached?.list ?? [];
    }
  }

  protected async modelsFor(_task: LlmTask, parts: LlmPart[]) {
    if (this.models.length) return (this.candidates = this.models);
    const vision = parts.some((p) => 'image' in p);
    const prefs = vision ? OpenRouterProvider.VISION : OpenRouterProvider.TEXT;
    const free = await this.freeModels();
    if (!free.length) return (this.candidates = [...prefs.slice(0, OpenRouterProvider.MAX_TRY - 1), OpenRouterProvider.ANY_FREE]); // list unavailable
    const pool = free.filter((m) => !vision || m.image);
    const ids = new Set(pool.map((m) => m.id));
    const rest = pool.filter((m) => !prefs.includes(m.id) && m.id !== OpenRouterProvider.ANY_FREE).sort((a, b) => b.context - a.context).map((m) => m.id);
    const ordered = [...prefs.filter((id) => ids.has(id)), ...rest].slice(0, OpenRouterProvider.MAX_TRY - 1);
    if (ids.has(OpenRouterProvider.ANY_FREE) || !ordered.length) ordered.push(OpenRouterProvider.ANY_FREE);
    return (this.candidates = ordered);
  }

  protected async call(model: string, system: string, parts: LlmPart[], schema: object, ms: number) {
    const content = parts.map((p) => 'text' in p ? { type: 'text', text: p.text }
      : 'pdf' in p ? { type: 'text', text: `Document text:\n${p.pdf.text.slice(0, 60_000)}` }
      : { type: 'image_url', image_url: { url: `data:${p.image.mime};base64,${p.image.base64}` } });
    // OpenRouter falls back along `models` itself when the first one is down or rate limited: one round trip instead of several.
    // The API allows at most 3 entries.
    const at = this.candidates.indexOf(model);
    const fallbacks = at >= 0 ? this.candidates.slice(at, at + 3) : [model];
    this.usedModel = undefined;
    const j = await this.post('https://openrouter.ai/api/v1/chat/completions', {
      Authorization: `Bearer ${this.apiKey}`, 'HTTP-Referer': 'https://github.com/mrnisarali110/psx-assistant', 'X-Title': 'PSX Assistant',
    }, {
      model,
      ...(fallbacks.length > 1 ? { models: fallbacks } : {}),
      temperature: 0.2,
      messages: [
        { role: 'system', content: `${system}\nReply with only one JSON object (no prose, no markdown fences) matching this schema (OpenAPI style): ${JSON.stringify(schema)}` },
        { role: 'user', content },
      ],
    }, ms);
    if (typeof j?.model === 'string' && j.model) this.usedModel = j.model;
    const msg = j?.choices?.[0]?.message;
    const c = msg?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : '';
    return parseJsonLoose(text) ?? parseJsonLoose(typeof msg?.reasoning === 'string' ? msg.reasoning : ''); // reasoning models sometimes answer there
  }
  protected answeredBy(model: string) { return this.usedModel ?? model; }

  probe() {
    return this.cachedProbe(async () => {
      const r = await this.probeGet('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${this.apiKey}` });
      if (r.status < 200 || r.status >= 300) return this.probeVerdict(r.status, '');
      const free = await this.freeModels();
      const d = r.body?.data ?? {};
      const tier = d.is_free_tier === false ? 'paid tier' : 'free tier';
      const left = d.limit_remaining != null ? `, $${Number(d.limit_remaining).toFixed(2)} credit left` : '';
      return { ok: true, detail: `key valid (${tier}${left}); ${free.filter((m) => m.image).length} free vision models, ${free.length} free in all` };
    });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
/** Which provider goes first for each kind of task. */
export const PREFERENCE: Record<LlmTask, string[]> = {
  text: ['groq', 'gemini', 'openrouter'], // Groq's text limits are the most generous
  pdf: ['gemini', 'groq', 'openrouter'], // Gemini reads the PDF itself (including scans); the others get the extracted text
  vision: ['openrouter', 'gemini'], // screenshots: keep Gemini's small daily quota for filings
};

export class LlmRouter {
  constructor(private providers: Provider[]) {}
  get available() { return this.providers.length > 0; }
  get names() { return this.providers.map((p) => p.name); }

  private ordered(task: LlmTask, parts: LlmPart[]) {
    return PREFERENCE[task].map((n) => this.providers.find((p) => p.name === n)).filter((p): p is Provider => !!p && p.can(task, parts));
  }

  async json<T>(task: LlmTask, system: string, parts: LlmPart[], schema: object, opts: AskOpts = {}): Promise<LlmResult<T>> {
    const usable = this.ordered(task, parts);
    if (!usable.length) throw new Error(`no AI provider can handle a ${task} task`);
    const errors: string[] = [];
    for (const p of usable) {
      try {
        return await p.json<T>(task, system, parts, schema, opts);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    throw new Error(`AI unavailable: ${errors.join(' | ')}`);
  }

  /** When the first cooling provider for this task is back, or null if one is ready now / none is known. */
  nextReady(task: LlmTask, parts: LlmPart[]): string | null {
    const usable = this.ordered(task, parts);
    const cs = usable.map((p) => p.cooldown());
    if (!usable.length || cs.some((c) => !c)) return null;
    return new Date(Math.min(...cs.map((c) => c!.until))).toISOString();
  }

  /** Provider states; with probe, also a free key check (no tokens, cached 10 min). */
  async status(opts: { probe?: boolean } = {}): Promise<ProviderStatus[]> {
    return Promise.all(this.providers.map(async (p): Promise<ProviderStatus> => {
      const c = p.cooldown();
      if (c) return { name: p.name, state: 'cooling', until: new Date(c.until).toISOString(), detail: c.reason };
      if (!opts.probe) return { name: p.name, state: 'ready' };
      const r = await p.probe();
      return { name: p.name, state: r.ok ? 'ready' : /bad API key/.test(r.detail) ? 'bad_key' : 'error', detail: r.detail };
    }));
  }
}

export interface RouterKeys {
  gemini?: string; groq?: string; openrouter?: string;
  geminiModels?: string[]; groqModels?: string[]; openrouterModels?: string[];
}

export function makeRouter(keys: RouterKeys, opts: { fetchImpl?: Fetch; log?: (m: string) => void; health?: LlmHealth } = {}): LlmRouter {
  const list: Provider[] = [];
  if (keys.groq) list.push(new GroqProvider(keys.groq, { ...opts, models: keys.groqModels }));
  if (keys.gemini) list.push(new GeminiProvider(keys.gemini, { ...opts, models: keys.geminiModels }));
  if (keys.openrouter) list.push(new OpenRouterProvider(keys.openrouter, { ...opts, models: keys.openrouterModels }));
  return new LlmRouter(list);
}
