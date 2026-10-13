import { describe, expect, it } from 'vitest';
import { discoverPicks, guardInsight, numberSet, numbersGrounded } from './ai.ts';
import { buildFacts } from './jobs.ts';
import type { UserCtx } from './store.ts';
import { GeminiProvider, GroqProvider, LlmHealth, LlmRouter, makeRouter, parseJsonLoose } from '../shared/llm.ts';
import { buildPortfolio } from '../shared/portfolio.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';
import { handleImport, handleStatus, importError, whenPkt, type Env } from '../edge/index.ts';

const owner = (): UserCtx => ({ id: 'owner-1', settings: { ...DEFAULT_SETTINGS, ai_enabled: true }, holdings: SEED_HOLDINGS, watchlist: SEED_WATCHLIST, telegram_chat_id: null, subs: [] });
const seedFacts = () => {
  const u = owner();
  const mine = new Set([...SEED_HOLDINGS.map((h) => h.symbol), ...SEED_WATCHLIST.map((w) => w.symbol)]);
  return buildFacts(u, buildPortfolio(u.holdings, SEED_PRICES, u.settings), mine, {
    today: '2026-10-06', idx: SEED_INDEX, prices: SEED_PRICES, news: [], dividends: [], now: new Date('2026-10-06T07:00:00Z'),
    screen: [{ symbol: 'ENGRO', sector: 'FERTILIZER', price: 300, change_pct: 0, change_1y_pct: -10, pe: 4, dividend_yield_pct: 9.1, market_cap: 1e11, is_shariah: true },
      { symbol: 'FFX', sector: 'FERTILIZER', price: 100, change_pct: 0, change_1y_pct: 0, pe: 9, dividend_yield_pct: 5, market_cap: 1e11, is_shariah: true },
      { symbol: 'FFY', sector: 'FERTILIZER', price: 100, change_pct: 0, change_1y_pct: 0, pe: 10, dividend_yield_pct: 5, market_cap: 1e11, is_shariah: true }],
  }, 9469.7);
};

describe('number grounding', () => {
  it('accepts numbers from the facts (and their roundings), rejects invented ones', () => {
    const known = numberSet({ price: 114.37, weight: 23.98, text: 'EPS Rs 41.20' });
    expect(numbersGrounded('SYS at Rs 114.37, about 24% of the portfolio', known).ok).toBe(true);
    expect(numbersGrounded('target price Rs 150', known)).toEqual({ ok: false, unknown: [150] });
    expect(numbersGrounded('tranche 2 on Oct 20, 2026', known).ok).toBe(true);
  });
  it('parses JSON wrapped in code fences', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('noise {"a":2} noise')).toEqual({ a: 2 });
    expect(parseJsonLoose('nope')).toBeNull();
  });
});

describe('facts for the AI', () => {
  it('carries last-buy distances, this month\'s cash and the undervalued screen', () => {
    const { facts } = seedFacts();
    expect(facts.money).toEqual({ monthly_budget_pkr: 50000, invested_this_month_pkr: 9470, cash_left_this_month_pkr: 40530 });
    expect(facts.holdings.find((h) => h.symbol === 'SYS')).toMatchObject({ last_buy_price: 130.45, vs_last_buy_pct: -12.3, rules_call: 'opportunity' });
    expect(facts.screen_candidates.map((c) => c.symbol)).toContain('ENGRO');
  });
});

describe('AI guardrails', () => {
  const { facts, guard } = seedFacts();

  it('keeps grounded suggestions and drops ones that break your rules', () => {
    const r = guardInsight({
      headline: 'Banks and SYS are below your last buys.', stance: 'buy',
      suggestions: [
        { action: 'add', symbol: 'MEBL', text: 'Add MEBL', why: '6% below your last buy, weight 19.5%', confidence: 'high' },
        { action: 'add', symbol: 'EFERT', text: 'Average down EFERT', why: 'Down 9.9%', confidence: 'high' },
        { action: 'buy', symbol: 'LUCKX', text: 'Buy LUCKX', why: 'Cheap', confidence: 'high' },
        { action: 'buy', symbol: 'HUBC', text: 'Buy HUBC, target Rs 260', why: '8.57% yield', confidence: 'medium' },
        { action: 'watch', symbol: 'ENGRO', text: 'Watch ENGRO', why: 'P/E 4, 9.1% yield', confidence: 'low' },
      ],
      holding_calls: [
        { symbol: 'SYS', call: 'opportunity', text: '12.3% below your last buy' },
        { symbol: 'LUCK', call: 'average_down', text: '11.1% below' }, // hold_no_add
        { symbol: 'DCR', call: 'hold', text: 'up 1.8%' },
        { symbol: 'NOPE', call: 'hold', text: 'x' },
      ],
      cash_note: 'Put the remaining Rs 40,530 into MEBL and UBL.',
      rebalance: 'Banks would reach 99% if you only buy banks.', // invented number -> blanked
    }, facts, guard);
    expect(r.insight.suggestions.map((s) => `${s.action} ${s.symbol}`)).toEqual(['add MEBL', 'watch ENGRO']);
    expect(r.insight.holding_calls.map((c) => c.symbol)).toEqual(['SYS', 'DCR']);
    expect(r.insight.stance).toBe('buy');
    expect(r.insight.cash_note).toMatch(/40,530/);
    expect(r.insight.rebalance).toBeNull();
    expect(r.reasons.join(' ')).toMatch(/EFERT is hold_no_add.*LUCKX is not in your portfolio.*numbers not in the data: 260/);
  });

  it('turns a Buy stance into Wait on a rally day', () => {
    const r = guardInsight({ headline: 'x', stance: 'buy', suggestions: [], holding_calls: [] }, facts, { ...guard, rulesSay: 'Wait' });
    expect(r.insight.stance).toBe('wait');
  });

  it('Discover picks keep only candidate symbols and grounded reasons', async () => {
    const ai = { available: true, json: async () => ({ model: 'fake', data: { items: [
      { symbol: 'AAA', why: 'P/E 4.2 vs sector 8.1', frequency: 'Quarterly' }, { symbol: 'ZZZ', why: 'great' }, { symbol: 'BBB', why: 'will double to 300' },
    ] } }) } as unknown as LlmRouter;
    const r = await discoverPicks(ai, 'dividend', [{ symbol: 'AAA', pe: 4.2, sector_pe: 8.1 }, { symbol: 'BBB', pe: 5 }]);
    expect(r.items).toEqual([{ symbol: 'AAA', why: 'P/E 4.2 vs sector 8.1', frequency: 'Quarterly' }]);
  });
});

describe('AI router (Groq + Gemini)', () => {
  const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], choices: [{ message: { content: text } }] }));
  const recorder = (handler: (url: string) => Response) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => { calls.push(String(url)); return handler(String(url)); }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('text tasks go to Groq first and fall back to Gemini', async () => {
    const r = recorder((u) => (u.includes('groq') ? new Response('rate limited', { status: 429 }) : ok('{"ok":1}')));
    const router = makeRouter({ gemini: 'g', groq: 'q' }, { fetchImpl: r.fetchImpl, log: () => {}, health: new LlmHealth() });
    expect(await router.json('text', 's', [{ text: 'hi' }], {})).toEqual({ data: { ok: 1 }, model: 'gemini/gemini-3.8-flash' });
    expect(r.calls.filter((c) => c.includes('groq'))).toHaveLength(2); // both Groq models tried
  });

  it('PDFs go to Gemini first; Groq only gets them when there is extracted text', async () => {
    const r = recorder((u) => (u.includes('googleapis') ? new Response('overloaded', { status: 503 }) : ok('{"via":"groq"}')));
    const router = makeRouter({ gemini: 'g', groq: 'q' }, { fetchImpl: r.fetchImpl, log: () => {}, health: new LlmHealth() });
    const withText = await router.json('pdf', 's', [{ pdf: { base64: 'x', text: 'profit '.repeat(50) } }, { text: 'q' }], {});
    expect(withText.model).toBe('groq/openai/gpt-oss-120b');
    expect(r.calls[0]).toContain('googleapis');
    await expect(router.json('pdf', 's', [{ pdf: { base64: 'x', text: '' } }], {})).rejects.toThrow(/AI unavailable/);
  });

  it('images are never sent to Groq; a bad key stops that provider at once', async () => {
    expect(new GroqProvider('q').can('vision', [{ image: { mime: 'image/png', base64: 'x' } }])).toBe(false);
    const r = recorder(() => new Response('API key not valid', { status: 400 }));
    const g = new GeminiProvider('bad', { fetchImpl: r.fetchImpl, log: () => {}, health: new LlmHealth() });
    await expect(new LlmRouter([g]).json('vision', 's', [{ image: { mime: 'image/png', base64: 'x' } }], {})).rejects.toThrow();
    expect(r.calls).toHaveLength(1);
  });
});

describe('screenshot import endpoint', () => {
  const env: Env = { ASSETS: { fetch: async () => new Response('asset') }, SUPABASE_URL: 'https://sb.example', SUPABASE_KEY: 'pk', GEMINI_API_KEY: 'g' };
  const req = (body: unknown, auth = 'Bearer good.token') => new Request('https://app/api/import', {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/auth/v1/user')) {
      return new Headers(init?.headers).get('Authorization') === 'Bearer good.token' ? new Response(JSON.stringify({ id: 'u1' })) : new Response('no', { status: 401 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ is_portfolio: true, holdings: [
      { symbol: 'SYS', shares: 118, avg_cost: 130.45 }, { symbol: 'MEBL', shares: 20, avg_cost: 583.06 }, { symbol: '??', shares: 1, avg_cost: 1 },
    ] }) }] } }] }));
  }) as unknown as typeof fetch;
  const img = { mime: 'image/jpeg', base64: 'aGVsbG8=' };

  it('needs a signed-in user', async () => {
    expect((await handleImport(req({ images: [img] }, 'Bearer bad.token'), env, fetchImpl)).status).toBe(401);
  });
  it('validates the images', async () => {
    expect((await handleImport(req({ images: [] }), env, fetchImpl)).status).toBe(400);
    expect((await handleImport(req({ images: [{ mime: 'application/pdf', base64: 'x' }] }), env, fetchImpl)).status).toBe(400);
    expect((await handleImport(req({ images: [img, img, img, img, img] }), env, fetchImpl)).status).toBe(400);
  });
  it('returns cleaned holdings read by the AI', async () => {
    const r = await handleImport(req({ images: [img] }), env, fetchImpl);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ holdings: [{ symbol: 'SYS', shares: 118, avg_cost: 130.45 }, { symbol: 'MEBL', shares: 20, avg_cost: 583.06 }], dropped: ['(unreadable row)'] });
  });
  it('says clearly when the AI key is missing', async () => {
    expect((await handleImport(req({ images: [img] }), { ...env, GEMINI_API_KEY: undefined }, fetchImpl)).status).toBe(503);
  });
  it('an empty answer from the first reader is not accepted: the next provider gets the screenshots', async () => {
    const order: string[] = [];
    const spy = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'x/vision:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, context_length: 1000 }] }));
      if (u.includes('openrouter.ai/api/v1/chat')) { order.push('openrouter'); return new Response(JSON.stringify({ choices: [{ message: { content: '{"is_portfolio":true,"holdings":[]}' } }] })); }
      if (u.includes('generateContent')) order.push('gemini');
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const r = await handleImport(req({ images: [img] }), { ...env, OPENROUTER_API_KEY: 'k' }, spy);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).model).toBe('gemini/gemini-3.8-flash');
    expect(order).toEqual(['openrouter', 'gemini']);
  });
  it('passes the symbols you already hold as reading hints, never quantities or costs', async () => {
    let prompt = '';
    const spy = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('generateContent')) prompt = String(init?.body);
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const r = await handleImport(req({ images: [img], known: ['sys', 'MEBL', 'bad symbol!', 'MEBL'] }), env, spy);
    expect(r.status).toBe(200);
    expect(prompt).toMatch(/already holds these symbols: MEBL, SYS\./);
    expect(prompt).not.toMatch(/118|583/);
  });
  it('GET /api/ai-status reports each provider from free checks only', async () => {
    const urls: string[] = [];
    const spy = (async (url: string, init?: RequestInit) => { urls.push(String(url)); return fetchImpl(url, init); }) as unknown as typeof fetch;
    const get = (auth: string) => new Request('https://app/api/ai-status', { headers: { Authorization: auth } });
    const r = await handleStatus(get('Bearer good.token'), { ...env, OPENROUTER_API_KEY: 'k' }, spy);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.vision).toEqual(['openrouter', 'gemini']);
    expect(body.ready).toBe(true);
    expect(body.providers.map((p: any) => `${p.name}:${p.state}`)).toEqual(['gemini:ready', 'openrouter:ready']);
    expect(urls.some((u) => /generateContent|chat\/completions/.test(u))).toBe(false);
    expect((await handleStatus(get('Bearer bad.token'), env, spy)).status).toBe(401);
  });
  it('turns provider errors into advice with a time to come back', () => {
    expect(importError('AI unavailable: openrouter cooling down until 2026-10-15T00:01:00.000Z: HTTP 429 free-models-per-day', '2026-10-15T00:01:00.000Z'))
      .toMatchObject({ reason: 'limit', retry_at: '2026-10-15T00:01:00.000Z', error: expect.stringMatching(/^The free AI limits are used up for now\. Try again after /) });
    expect(importError('HTTP 503 overloaded')).toMatchObject({ reason: 'busy', retry_at: null });
    expect(importError('openrouter unavailable: x: HTTP 404 No endpoints found matching your data policy')).toMatchObject({ reason: 'policy' });
    // one provider over its limit does not mean "limits used up": the other failure wins and both are named
    const mixed = importError('AI unavailable: openrouter unavailable: google/lyria-3-pro-preview: HTTP 404 no such model | gemini unavailable: gemini-3.8-flash: HTTP 400 API key not valid', '2026-10-15T00:01:00.000Z');
    expect(mixed).toMatchObject({ reason: 'key', retry_at: null });
    expect(mixed.detail).toBe('openrouter: google/lyria-3-pro-preview: HTTP 404 no such model · gemini: gemini-3.8-flash: HTTP 400 API key not valid');
    expect(importError('AI unavailable: openrouter unavailable: m: HTTP 429 upstream | gemini unavailable: m: HTTP 429 quota')).toMatchObject({ reason: 'limit' });
    expect(importError('AI unavailable: openrouter unavailable: m: unparseable response | gemini unavailable: m: HTTP 429 quota')).toMatchObject({ reason: 'limit', detail: 'openrouter: m: unparseable response · gemini: m: HTTP 429 quota' });
    expect(whenPkt('2026-10-14T05:30:00Z', new Date('2026-10-14T03:00:00Z'))).toBe('10:30 AM');
    expect(whenPkt('2026-10-15T00:01:00Z', new Date('2026-10-14T03:00:00Z'))).toBe('tomorrow 5:01 AM');
  });
});
