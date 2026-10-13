/**
 * One way to ask an AI for JSON, with two free providers behind it:
 *   Groq (fast text models)  and  Google Gemini (reads PDFs and images natively).
 * Each task type has a preferred order; if a provider is missing, overloaded, rate limited or
 * returns junk, the next one is tried. A model that was overloaded is skipped for the rest of the run.
 * Server-side only (the API keys never reach the browser). Uses plain fetch, so it runs in Node and in
 * Cloudflare Workers.
 */

export type LlmTask = 'text' | 'pdf' | 'vision';
export type LlmPart =
  | { text: string }
  | { pdf: { base64: string; text: string } } // text = extracted PDF text, for providers that can't read PDFs
  | { image: { mime: string; base64: string } };

export interface LlmResult<T> { data: T; model: string }

export interface Provider {
  name: string;
  can(task: LlmTask, parts: LlmPart[]): boolean;
  json<T>(system: string, parts: LlmPart[], schema: object, signalMs?: number): Promise<LlmResult<T>>;
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

class ModelError extends Error {
  constructor(message: string, readonly fatal: boolean) { super(message); }
}

/** Tries each model of one provider in order; remembers overloaded ones. */
abstract class BaseProvider implements Provider {
  abstract name: string;
  protected skip = new Set<string>();
  constructor(protected apiKey: string, protected models: string[], protected fetchImpl: Fetch, protected log: (m: string) => void) {}
  abstract can(task: LlmTask, parts: LlmPart[]): boolean;
  protected abstract call(model: string, system: string, parts: LlmPart[], schema: object, ms: number): Promise<unknown>;

  async json<T>(system: string, parts: LlmPart[], schema: object, ms = 90_000): Promise<LlmResult<T>> {
    let last = 'no model';
    const order = [...this.models.filter((m) => !this.skip.has(m)), ...this.models.filter((m) => this.skip.has(m))];
    for (const model of order) {
      try {
        const data = await this.call(model, system, parts, schema, ms);
        if (data != null && typeof data === 'object') return { data: data as T, model: `${this.name}/${model}` };
        last = `${model}: unparseable response`;
      } catch (e) {
        last = `${model}: ${(e as Error).message}`;
        if (e instanceof ModelError && e.fatal) break; // bad key: other models of this provider won't help
        if (!this.skip.has(model)) this.log(`${this.name} ${last.slice(0, 160)}; trying next`);
        this.skip.add(model);
      }
    }
    throw new Error(`${this.name} unavailable: ${last.slice(0, 200)}`);
  }

  protected async post(url: string, headers: Record<string, string>, body: unknown, ms: number) {
    const r = await this.fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
      const fatal = [401, 403].includes(r.status) || (r.status === 400 && /api key|apikey|credential/i.test(text));
      throw new ModelError(`HTTP ${r.status} ${text}`, fatal);
    }
    return r.json() as Promise<any>;
  }
}

export class GeminiProvider extends BaseProvider {
  name = 'gemini';
  static MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
  constructor(apiKey: string, opts: { models?: string[]; fetchImpl?: Fetch; log?: (m: string) => void } = {}) {
    super(apiKey, opts.models?.length ? opts.models : GeminiProvider.MODELS, opts.fetchImpl ?? fetch, opts.log ?? console.log);
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
}

export class GroqProvider extends BaseProvider {
  name = 'groq';
  static MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
  constructor(apiKey: string, opts: { models?: string[]; fetchImpl?: Fetch; log?: (m: string) => void } = {}) {
    super(apiKey, opts.models?.length ? opts.models : GroqProvider.MODELS, opts.fetchImpl ?? fetch, opts.log ?? console.log);
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
}

/** Which provider goes first for each kind of task. */
const PREFERENCE: Record<LlmTask, string[]> = {
  text: ['groq', 'gemini'], // fast text model first
  pdf: ['gemini', 'groq'], // Gemini reads the PDF itself (including scans); Groq gets the extracted text
  vision: ['gemini', 'groq'],
};

export class LlmRouter {
  constructor(private providers: Provider[]) {}
  get available() { return this.providers.length > 0; }

  async json<T>(task: LlmTask, system: string, parts: LlmPart[], schema: object): Promise<LlmResult<T>> {
    const ordered = PREFERENCE[task].map((n) => this.providers.find((p) => p.name === n)).filter(Boolean) as Provider[];
    const usable = ordered.filter((p) => p.can(task, parts));
    if (!usable.length) throw new Error(`no AI provider can handle a ${task} task`);
    const errors: string[] = [];
    for (const p of usable) {
      try {
        return await p.json<T>(system, parts, schema);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    throw new Error(`AI unavailable: ${errors.join(' | ')}`);
  }
}

export function makeRouter(keys: { gemini?: string; groq?: string; geminiModels?: string[]; groqModels?: string[] },
  opts: { fetchImpl?: Fetch; log?: (m: string) => void } = {}): LlmRouter {
  const list: Provider[] = [];
  if (keys.groq) list.push(new GroqProvider(keys.groq, { ...opts, models: keys.groqModels }));
  if (keys.gemini) list.push(new GeminiProvider(keys.gemini, { ...opts, models: keys.geminiModels }));
  return new LlmRouter(list);
}
