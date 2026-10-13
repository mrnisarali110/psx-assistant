import { describe, expect, it } from 'vitest';
import { GroqProvider, LlmHealth, OpenRouterProvider, cooldownFor, makeRouter, nextMidnight, ModelError } from './llm.ts';

const okOpenAi = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const models = {
  data: [
    { id: 'meta-llama/llama-4-maverick:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, context_length: 1_000_000 },
    { id: 'some/text-only:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'] }, context_length: 32_000 },
    { id: 'paid/vision', pricing: { prompt: '0.001', completion: '0.002' }, architecture: { input_modalities: ['text', 'image'] }, context_length: 128_000 },
    { id: 'new/vision-model:free', pricing: { prompt: '0', completion: '0', image: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, context_length: 64_000 },
    { id: 'google/lyria-3-pro-preview', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] }, context_length: 1_048_576 }, // music model
    { id: 'nvidia/nemotron-3.5-content-safety:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, context_length: 128_000 }, // guardrail
    { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, context_length: 200_000 },
  ],
};
const image = { image: { mime: 'image/png', base64: 'AAAA' } };

describe('OpenRouter provider', () => {
  it('sends images as data URLs and asks for JSON; picks free vision models from the live list, preferred names first', async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify(models));
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return okOpenAi('```json\n{"is_portfolio":true,"holdings":[]}\n```');
    }) as unknown as typeof fetch;
    const health = new LlmHealth();
    const router = makeRouter({ openrouter: 'k' }, { fetchImpl, log: () => {}, health });
    const r = await router.json('vision', 'sys', [image, { text: 'read' }], { type: 'OBJECT' });
    expect(r).toEqual({ data: { is_portfolio: true, holdings: [] }, model: 'openrouter/meta-llama/llama-4-maverick:free' });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].body.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(calls[0].body.messages[0].content).toMatch(/JSON object .*"OBJECT"/);
    expect(calls[0].body.models).toEqual(['meta-llama/llama-4-maverick:free', 'new/vision-model:free', 'openrouter/free']); // OpenRouter falls back itself

    const p = new OpenRouterProvider('k', { fetchImpl, log: () => {}, health });
    // never paid, text-only, music or guardrail models; OpenRouter's own free router last
    expect(await (p as any).modelsFor('vision', [image])).toEqual(['meta-llama/llama-4-maverick:free', 'new/vision-model:free', 'openrouter/free']);
    expect(await (p as any).modelsFor('text', [{ text: 'x' }])).toEqual(['meta-llama/llama-4-maverick:free', 'new/vision-model:free', 'some/text-only:free', 'openrouter/free']);
    expect(calls.length).toBe(1); // the model list is cached: only the one completion request went out
  });

  it('sends at most 3 fallback models (the API limit) and moves on when an answer is rejected as useless', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify(models));
      bodies.push(JSON.parse(String(init?.body)));
      return okOpenAi(bodies.length === 1 ? '{"is_portfolio":true,"holdings":[]}' : '{"is_portfolio":true,"holdings":[{"symbol":"SYS"}]}');
    }) as unknown as typeof fetch;
    const router = makeRouter({ openrouter: 'k' }, { fetchImpl, log: () => {}, health: new LlmHealth() });
    const r = await router.json<any>('text', 's', [{ text: 'x' }], {}, { accept: (d) => d.holdings?.length > 0 });
    expect(bodies.map((b) => b.model)).toEqual(['meta-llama/llama-4-maverick:free', 'new/vision-model:free']);
    expect(bodies[0].models).toEqual(['meta-llama/llama-4-maverick:free', 'new/vision-model:free', 'some/text-only:free']); // 4 candidates, 3 sent
    expect(r.data.holdings).toHaveLength(1);
  });

  it('reports the model that actually answered and reads answers reasoning models hide in `reasoning`', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify(models));
      return new Response(JSON.stringify({ model: 'new/vision-model:free', choices: [{ message: { content: '', reasoning: 'thinking... {"ok":true}' } }] }));
    }) as unknown as typeof fetch;
    const router = makeRouter({ openrouter: 'k' }, { fetchImpl, log: () => {}, health: new LlmHealth() });
    expect(await router.json('vision', 's', [image], {})).toEqual({ data: { ok: true }, model: 'openrouter/new/vision-model:free' });
  });

  it('a privacy-policy refusal (HTTP 404) rests the whole key briefly instead of trying every model', async () => {
    const health = new LlmHealth(() => 5_000_000);
    let n = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify(models));
      n++;
      return new Response(JSON.stringify({ error: { code: 404, message: 'No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy' } }), { status: 404 });
    }) as unknown as typeof fetch;
    const router = makeRouter({ openrouter: 'k' }, { fetchImpl, log: () => {}, health });
    await expect(router.json('vision', 's', [image], {})).rejects.toThrow(/data policy/);
    expect(n).toBe(1);
    expect((await router.status())[0]).toMatchObject({ state: 'cooling', until: new Date(5_000_000 + 120_000).toISOString() });
  });

  it('falls back to the known names when the model list is unreachable, and pinned models skip discovery', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const p = new OpenRouterProvider('k', { fetchImpl, log: () => {}, health: new LlmHealth() });
    expect(await (p as any).modelsFor('vision', [image])).toEqual([...OpenRouterProvider.VISION.slice(0, OpenRouterProvider.MAX_TRY - 1), 'openrouter/free']);
    const pinned = new OpenRouterProvider('k', { fetchImpl, models: ['x/y:free'], health: new LlmHealth() });
    expect(await (pinned as any).modelsFor('vision', [image])).toEqual(['x/y:free']);
    expect(new OpenRouterProvider('k').can('vision', [image])).toBe(true);
    expect(new GroqProvider('q').can('vision', [image])).toBe(false);
  });

  it('a daily limit rests the whole key until UTC midnight; error bodies sent with HTTP 200 count too', async () => {
    const now = Date.parse('2026-10-14T20:00:00Z');
    const health = new LlmHealth(() => now);
    let n = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify(models));
      n++;
      return new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } })); // HTTP 200
    }) as unknown as typeof fetch;
    const router = makeRouter({ openrouter: 'k' }, { fetchImpl, log: () => {}, health });
    await expect(router.json('text', 's', [{ text: 'x' }], {})).rejects.toThrow(/AI unavailable/);
    expect(n).toBe(1); // the key is out for the day: no second model tried
    expect(await router.status()).toEqual([{ name: 'openrouter', state: 'cooling', until: '2026-10-15T00:01:00.000Z', detail: expect.stringMatching(/free-models-per-day/) }]);
    await expect(router.json('vision', 's', [image], {})).rejects.toThrow(/cooling down until 2026-10-15T00:01/);
    expect(n).toBe(1);
  });
});

describe('cooldowns (be frugal with free tiers)', () => {
  it('a Gemini daily quota rests that model until Google\'s midnight; the next call skips it without a request', async () => {
    let now = Date.parse('2026-10-14T10:00:00Z'); // 03:00 in Los Angeles
    const health = new LlmHealth(() => now);
    let geminiCalls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('googleapis')) {
        geminiCalls++;
        return new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: generate_requests_per_model_per_day, limit: 20. Please retry in 32.5s.', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 });
      }
      return okOpenAi('{"ok":1}');
    }) as unknown as typeof fetch;
    const router = makeRouter({ gemini: 'g', groq: 'q' }, { fetchImpl, log: () => {}, health });
    const parts = [{ pdf: { base64: 'x', text: 'profit '.repeat(50) } }];
    expect((await router.json('pdf', 's', parts, {})).model).toMatch(/^groq/);
    expect(geminiCalls).toBe(3); // every Gemini model tried once today
    expect((await router.json('pdf', 's', parts, {})).model).toMatch(/^groq/);
    expect(geminiCalls).toBe(3); // and not again
    expect((await router.status()).find((p) => p.name === 'gemini')).toMatchObject({ state: 'cooling', until: '2026-10-15T07:01:00.000Z' });
    expect(router.nextReady('vision', [image])).toBe('2026-10-15T07:01:00.000Z'); // only Gemini can read images here
    expect(router.nextReady('pdf', parts)).toBeNull(); // Groq is fine
    now = Date.parse('2026-10-15T08:00:00Z');
    await router.json('pdf', 's', parts, {});
    expect(geminiCalls).toBe(6);
  });

  it('a per-minute limit rests only as long as Retry-After says; a bad key stops the provider at once', async () => {
    let now = 1_000_000;
    const health = new LlmHealth(() => now);
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response('Rate limit reached. Please try again in 1m2.5s', { status: 429, headers: { 'retry-after': '63' } });
    }) as unknown as typeof fetch;
    const p = new GroqProvider('q', { fetchImpl, log: () => {}, health });
    await expect(p.json('text', 's', [{ text: 'x' }], {})).rejects.toThrow(/unavailable/);
    expect(n).toBe(2);
    await expect(p.json('text', 's', [{ text: 'x' }], {})).rejects.toThrow(/cooling down/);
    expect(n).toBe(2);
    expect(p.cooldown()!.until).toBe(now + 63_000);
    now += 64_000;
    await expect(p.json('text', 's', [{ text: 'x' }], {})).rejects.toThrow(/unavailable/);
    expect(n).toBe(4);

    const bad = new GroqProvider('bad', { fetchImpl: (async () => new Response('invalid api key', { status: 401 })) as unknown as typeof fetch, log: () => {}, health: new LlmHealth() });
    await expect(bad.json('text', 's', [{ text: 'x' }], {})).rejects.toThrow(/unavailable/);
    expect(bad.cooldown()).toMatchObject({ reason: expect.stringMatching(/bad API key/) });
  });

  it('cooldown lengths follow the error kind', () => {
    const at = Date.parse('2026-10-14T06:00:00Z');
    const e = (status: number, extra: Partial<ModelError> = {}) => Object.assign(new ModelError('x', false, status), extra);
    expect(cooldownFor(e(503), at, 'UTC')).toBe(60_000);
    expect(cooldownFor(e(500), at, 'UTC')).toBe(30_000);
    expect(cooldownFor(e(400), at, 'UTC')).toBe(0); // our request, not their health
    expect(cooldownFor(e(429, { retryMs: 5_000 }), at, 'UTC')).toBe(15_000); // never shorter than 15 s
    expect(cooldownFor(e(429), at, 'UTC')).toBe(90_000);
    expect(at + cooldownFor(e(429, { daily: true }), at, 'UTC')).toBe(Date.parse('2026-10-15T00:01:00Z'));
    expect(nextMidnight(Date.parse('2026-10-14T23:59:00Z'), 'Asia/Karachi')).toBe(Date.parse('2026-10-15T19:01:00Z'));
  });
});

describe('free probes (no tokens)', () => {
  it('uses list-models / key endpoints only and caches for 10 minutes', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('groq')) return new Response('nope', { status: 401 });
      if (String(url).includes('openrouter.ai/api/v1/key')) return new Response(JSON.stringify({ data: { is_free_tier: true, limit_remaining: null } }));
      if (String(url).endsWith('/models')) return new Response(JSON.stringify(models));
      return new Response(JSON.stringify({ models: [] }));
    }) as unknown as typeof fetch;
    const router = makeRouter({ gemini: 'g', groq: 'bad', openrouter: 'k' }, { fetchImpl, log: () => {}, health: new LlmHealth() });
    expect(await router.status({ probe: true })).toEqual([
      { name: 'groq', state: 'bad_key', detail: 'bad API key (HTTP 401)' },
      { name: 'gemini', state: 'ready', detail: 'key valid' },
      { name: 'openrouter', state: 'ready', detail: 'key valid (free tier); 3 free vision models, 4 free in all' },
    ]);
    expect(urls.some((u) => /generateContent|chat\/completions/.test(u))).toBe(false);
    const before = urls.length;
    await router.status({ probe: true });
    expect(urls.length).toBe(before); // cached
    expect(await router.status()).toEqual([{ name: 'groq', state: 'ready' }, { name: 'gemini', state: 'ready' }, { name: 'openrouter', state: 'ready' }]); // no probe: nothing is cooling
  });
});
