import { describe, expect, it } from 'vitest';
import { discoverPicks, guardInsight, numberSet, numbersGrounded, readAnnouncement } from './ai.ts';
import { buildFacts, rulesPe } from './jobs.ts';
import { tinyPdf } from './fixtures/tiny-pdf.ts';
import type { UserCtx } from './store.ts';
import { GeminiProvider, GroqProvider, LlmHealth, LlmRouter, makeRouter, parseJsonLoose } from '../shared/llm.ts';
import { buildPortfolio } from '../shared/portfolio.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';
import { dispatchJob, handleImport, handleStatus, handleTick, importError, jobForTick, keyShape, whenPkt, type Env } from '../edge/index.ts';

const owner = (): UserCtx => ({ id: 'owner-1', settings: { ...DEFAULT_SETTINGS, ai_enabled: true }, holdings: SEED_HOLDINGS, watchlist: SEED_WATCHLIST, telegram_chat_id: null, subs: [] });
const seedFacts = () => {
  const u = owner();
  const mine = new Set([...SEED_HOLDINGS.map((h) => h.symbol), ...SEED_WATCHLIST.map((w) => w.symbol)]);
  return buildFacts(u, buildPortfolio(u.holdings, SEED_PRICES, u.settings, DEFAULT_RULES, {}, { sectorPe: { 'TECHNOLOGY & COMMUNICATION': 25, 'COMMERCIAL BANKS': 12 } }), mine, {
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
      cash_note: 'Put the remaining Rs 40,530 into SYS.',
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

  it('Discover picks keep only candidate symbols and reasons grounded in the new facts', async () => {
    const ai = { available: true, json: async () => ({ model: 'fake', data: { items: [
      { symbol: 'AAA', why: 'Pays out 64.5% of profit; profit fell 12.3% in its latest results', frequency: 'Quarterly' }, { symbol: 'ZZZ', why: 'great' },
      { symbol: 'BBB', why: 'will double to 300' },
    ] } }) } as unknown as LlmRouter;
    const r = await discoverPicks(ai, 'dividend', [
      { symbol: 'AAA', on_card: { pe: 4.2, dividend_yield_pct: 9.1 }, more: { payout_pct: 64.5, results_profit_change_pct: -12.3, suspect: false } },
      { symbol: 'BBB', on_card: { pe: 5 }, more: { payout_pct: 40 } },
    ]);
    expect(r.items).toEqual([{ symbol: 'AAA', why: 'Pays out 64.5% of profit; profit fell 12.3% in its latest results', frequency: 'Quarterly', facts: { payout_pct: 64.5, results_profit_change_pct: -12.3 } }]);
  });

  it('Discover picks add one new fact: a reason that repeats a card number, or picks a suspect payout, is dropped', async () => {
    const ai = { available: true, json: async () => ({ model: 'fake', data: { items: [
      { symbol: 'AAA', why: 'P/E 4.2 with a 9.1% yield' }, { symbol: 'BBB', why: 'Yield of 8% and pays out 40% of profit' },
      { symbol: 'CCC', why: 'Pays out 55.1% of profit' }, { symbol: 'DDD', why: 'Pays out 180% of profit' },
    ] } }) } as unknown as LlmRouter;
    const r = await discoverPicks(ai, 'dividend', [
      { symbol: 'AAA', on_card: { pe: 4.2, dividend_yield_pct: 9.1 }, more: { payout_pct: 64.5 } },
      { symbol: 'BBB', on_card: { pe: 5, dividend_yield_pct: 8 }, more: { payout_pct: 40 } },
      { symbol: 'CCC', on_card: { pe: 6, dividend_yield_pct: 7.5 }, more: { payout_pct: 55.1 } },
      { symbol: 'DDD', on_card: { pe: 9, dividend_yield_pct: 20 }, more: { payout_pct: 180, suspect: true } },
    ]);
    expect(r.items.map((i) => i.symbol)).toEqual(['CCC']);
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
    // key shapes, never keys: 'g' has the wrong prefix, 'k' too; nothing in the body equals a key value
    expect(body.keys).toEqual({ openrouter: { length: 1, expected_prefix: false, clean: true }, gemini: { length: 1, expected_prefix: false, clean: true }, groq: null });
    expect(keyShape('sk-or-v1-abc\n', /^sk-or-/)).toEqual({ length: 13, expected_prefix: true, clean: false });
    expect(keyShape('OPENROUTER_API_KEY=sk-or-v1-abc', /^sk-or-/)).toEqual({ length: 31, expected_prefix: false, clean: false });
    expect(keyShape(undefined, /^x/)).toBeNull();
    expect((await handleStatus(get('Bearer bad.token'), env, spy)).status).toBe(401);
  });
  it('cron ticks start the market job only while PSX trades (plus 20 min after the close), and the night job at 21:00 PKT', () => {
    const tick = '15,45 4-11 * * 1-5';
    const at = (iso: string) => jobForTick(new Date(iso), tick);
    expect(at('2026-10-13T04:45:00Z')).toBe('market'); // Tue 09:45 PKT
    expect(at('2026-10-13T04:15:00Z')).toBeNull(); // Tue 09:15: too early
    expect(at('2026-10-13T10:45:00Z')).toBe('market'); // Tue 15:45: closing prices
    expect(at('2026-10-13T11:15:00Z')).toBeNull(); // Tue 16:15: closed
    expect(at('2026-10-16T08:15:00Z')).toBeNull(); // Fri 13:15: prayer break
    expect(at('2026-10-16T11:45:00Z')).toBe('market'); // Fri 16:45
    expect(at('2026-10-17T05:00:00Z')).toBeNull(); // Saturday
    expect(jobForTick(new Date('2026-10-13T16:00:00Z'), '0 16 * * 1-5')).toBe('night');
  });
  it('a tick starts the GitHub job through the API with the token; without a token it does nothing', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const spy = (async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    expect(await dispatchJob(env, 'market', spy)).toEqual({ ok: false, status: 0 });
    expect(calls).toHaveLength(0);
    const withToken = { ...env, GITHUB_DISPATCH_TOKEN: 'ghp_x' };
    expect(await handleTick(withToken, Date.parse('2026-10-13T04:45:00Z'), '15,45 4-11 * * 1-5', spy)).toEqual({ ok: true, status: 204 });
    expect(calls[0].url).toBe('https://api.github.com/repos/mrnisarali110/psx-assistant/actions/workflows/worker.yml/dispatches');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ref: 'main', inputs: { job: 'market' } });
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer ghp_x');
    expect(await handleTick(withToken, Date.parse('2026-10-17T05:00:00Z'), '15,45 4-11 * * 1-5', spy)).toBeNull(); // Saturday: no call
    expect(calls).toHaveLength(1);
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

describe('blue chips in AI text', () => {
  it('the AI may not call a stock a blue chip unless the app\'s own checks say so', () => {
    const { facts, guard } = seedFacts();
    const raw = { headline: 'x', stance: 'hold', holding_calls: [], suggestions: [
      { action: 'watch', symbol: 'MARI', text: 'MARI is a blue chip worth watching', why: 'steady', confidence: 'low' },
      { action: 'watch', symbol: 'HUBC', text: 'Watch HUBC', why: 'yield', confidence: 'low' },
    ] };
    const notBc = guardInsight(raw, facts, { ...guard, blueChipOf: () => 'not_enough_data' });
    expect(notBc.insight.suggestions.map((s) => s.symbol)).toEqual(['HUBC']);
    const bc = guardInsight(raw, facts, { ...guard, blueChipOf: (s) => (s === 'MARI' ? 'bc' : 'not_bc') });
    expect(bc.insight.suggestions.map((s) => s.symbol)).toEqual(['MARI', 'HUBC']);
  });
});

describe('Refresh latest endpoint', () => {
  const env: Env = { ASSETS: { fetch: async () => new Response('asset') }, SUPABASE_URL: 'https://sb.example', SUPABASE_KEY: 'pk', GITHUB_DISPATCH_TOKEN: 'ghp' };
  const post = (auth = 'Bearer good.token') => new Request('https://app/api/refresh', { method: 'POST', headers: { Authorization: auth } });
  const NOW = new Date('2026-10-18T10:00:00Z');
  const make = (lastRun: unknown[]) => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes('/auth/v1/user')) return new Headers(init?.headers).get('Authorization') === 'Bearer good.token' ? new Response(JSON.stringify({ id: 'u1' })) : new Response('no', { status: 401 });
      if (String(url).includes('/rest/v1/worker_runs')) return new Response(JSON.stringify(lastRun));
      if (String(url).includes('api.github.com')) return new Response(null, { status: 204 });
      return new Response('?', { status: 404 });
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  it('needs a signed-in user and the dispatch token', async () => {
    const { handleRefresh } = await import('../edge/index.ts');
    expect((await handleRefresh(post('Bearer bad.token'), env, make([]).f, NOW)).status).toBe(401);
    const r = await handleRefresh(post(), { ...env, GITHUB_DISPATCH_TOKEN: undefined }, make([]).f, NOW);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: 'not_configured' });
  });
  it('starts the GitHub job "refresh", but not twice: a run going is reported, a recent one asks to wait', async () => {
    const { handleRefresh } = await import('../edge/index.ts');
    const none = make([]);
    const r = await handleRefresh(post(), env, none.f, NOW);
    expect(r.status).toBe(202);
    expect(none.calls.some((u) => u.includes('/actions/workflows/worker.yml/dispatches'))).toBe(true);
    const running = await handleRefresh(post(), env, make([{ started_at: '2026-10-18T09:58:00Z', finished_at: null }]).f, NOW);
    expect(await running.json()).toMatchObject({ status: 'running' });
    const recent = await handleRefresh(post(), env, make([{ started_at: '2026-10-18T09:55:00Z', finished_at: '2026-10-18T09:58:00Z' }]).f, NOW);
    expect(recent.status).toBe(429);
    expect(await recent.json()).toMatchObject({ status: 'recent', retry_in_min: 5 });
    expect((await handleRefresh(post(), env, make([{ started_at: '2026-10-18T09:40:00Z', finished_at: '2026-10-18T09:44:00Z' }]).f, NOW)).status).toBe(202);
  });
});

describe('filing reader: EPS and News card figures (owner review A2, B10)', () => {
  const answer = (data: Record<string, unknown>) => ({ available: true, json: async () => ({ model: 'fake', data: { summary: 'Results.', figures: [], ...data } }) }) as unknown as LlmRouter;

  it('reads the quarter EPS with its basis and months, and works out the profit change from printed figures', async () => {
    const pdf = tinyPdf('Quarter ended September 30, 2026. Consolidated profit after tax 1,234,567 (2025: 1,000,000) Rupees in thousand. '
      + 'Earnings per share - basic (Rupees) 7.42. Interim cash dividend Rs 5.00 per share (50%).');
    const d = await readAnnouncement(answer({
      headline: 'Profit up 23.5%, Rs 5 dividend', cash_dividend_per_share: 5, dividend_type: 'interim', quarter_end: '2026-09-30', quarter_profit_after_tax: 1234567000,
      eps: 7.42, eps_period_months: 3, eps_basis: 'consolidated', profit_this_period: 1234567, profit_same_period_last_year: 1000000,
    }), pdf, { symbol: 'AAA', title: 'Financial Results for the Quarter Ended September 30, 2026', published_at: '2026-10-20' });
    expect(d.metrics).toEqual({ headline: 'Profit up 23.5%, Rs 5 dividend', eps: 7.42, eps_basis: 'consolidated', dps: 5, profit_change_pct: 23.5 });
    expect(d.earnings).toMatchObject({ period_end: '2026-09-30', profit_after_tax: 1234567000, eps: 7.42, eps_basis: 'consolidated', period_months: 3 });
  });

  it('keeps a full-year EPS for the year; drops any figure the PDF does not print', async () => {
    const pdf = tinyPdf('Financial results for the year ended June 30, 2026 (unconsolidated). Profit after tax 5,000,000 thousand. Earnings per share 12.50');
    const d = await readAnnouncement(answer({
      headline: 'Profit up 22%', annual_year_end: '2026-06-30', annual_profit_after_tax: 5e9, annual_consolidated: false,
      eps: 12.5, eps_period_months: 12, eps_basis: 'unconsolidated', quarter_eps: 3.3, profit_this_period: 5000000, profit_same_period_last_year: 4100000,
    }), pdf, { symbol: 'AAA', title: 'Financial Results for the Year Ended June 30, 2026', published_at: '2026-08-20' });
    expect(d.annual).toMatchObject({ year: 2026, period_end: '2026-06-30', eps: 12.5, eps_basis: 'unconsolidated' });
    expect(d.earnings).toBeNull();
    expect(d.metrics).toEqual({ headline: null, eps: 12.5, eps_basis: 'unconsolidated', dps: null, profit_change_pct: null }); // 22% and 4,100,000 are not in it
    const wrong = await readAnnouncement(answer({ eps: 12.6, eps_period_months: 12, annual_year_end: '2026-06-30', annual_profit_after_tax: 5e9 }), pdf,
      { symbol: 'AAA', title: 'Financial Results', published_at: '2026-08-20' });
    expect(wrong.metrics.eps).toBeNull();
    expect(wrong.annual?.eps).toBeNull();
  });

  it('an EPS without a stated basis says so', async () => {
    const pdf = tinyPdf('Year ended June 30, 2026. Profit after tax 900,000. Earnings per share 4.75');
    const d = await readAnnouncement(answer({ eps: 4.75, eps_period_months: 12, annual_year_end: '2026-06-30', annual_profit_after_tax: 900000 }), pdf,
      { symbol: 'AAA', title: 'Financial Results', published_at: '2026-08-20' });
    expect(d.annual).toMatchObject({ eps: 4.75, eps_basis: 'not_stated' });
  });
});

describe('AI facts: payout, one-off, cuts and results (owner review A8, A10)', () => {
  it('holdings carry the P/E the app shows with its basis, the payout, a dividend cut and the latest results change', () => {
    const u = owner();
    const mine = new Set([...SEED_HOLDINGS.map((h) => h.symbol), ...SEED_WATCHLIST.map((w) => w.symbol)]);
    const earnings = [{ id: 'sys-fy', symbol: 'SYS', period_end: '2025-12-31', profit_after_tax: 1e10, verified: true, eps: 10, eps_basis: 'consolidated' as const, period_months: 12 }];
    const dividends = [
      { id: 'u1', symbol: 'UBL', announced_on: '2025-10-20', dps: 11, dividend_type: 'interim' as const, book_closure_from: null, book_closure_to: null, verified: true, pdf_url: null },
      { id: 'u2', symbol: 'UBL', announced_on: '2026-04-20', dps: 8, dividend_type: 'interim' as const, book_closure_from: null, book_closure_to: null, verified: true, pdf_url: null },
    ];
    const pe = rulesPe([], SEED_PRICES, earnings);
    const { facts } = buildFacts(u, buildPortfolio(u.holdings, SEED_PRICES, u.settings, DEFAULT_RULES, {}, { pe, earnings }), mine, {
      today: '2026-10-06', idx: SEED_INDEX, prices: SEED_PRICES, news: [], dividends, now: new Date('2026-10-06T07:00:00Z'), screen: [],
      pe, earnings, results: { MEBL: { on: '2026-10-05', profit_change_pct: 18.2 } },
    }, 0);
    const h = (s: string) => facts.holdings.find((x) => x.symbol === s) as Record<string, unknown>;
    expect(h('SYS')).toMatchObject({ pe: 11.44, pe_basis: 'consolidated, year to Dec 2025' });
    expect(h('UBL')).toMatchObject({ dividend_cut: true, dividend_latest_dps: 8, dividend_previous_dps: 11 });
    expect(h('MEBL')).toMatchObject({ results_profit_change_pct: 18.2, results_on: '2026-10-05' });
    expect(typeof h('MEBL').payout_pct).toBe('number');
    expect(h('MEBL').one_off).toBe(false);
  });
});
