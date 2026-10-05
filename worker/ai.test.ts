import { describe, expect, it } from 'vitest';
import { GeminiClient, guardInsight, numberSet, numbersGrounded, parseJsonLoose, type GuardContext } from './ai.ts';
import { buildFacts, runJob, type AiService } from './jobs.ts';
import { ConsoleNotifier } from './notify.ts';
import { MemoryStore, type UserCtx } from './store.ts';
import { buildPortfolio } from '../shared/portfolio.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';
import { findOpportunities } from '../shared/opportunities.ts';
import type { Snapshot } from './feed.ts';

const owner = (ai = true): UserCtx => ({
  id: 'owner-1', settings: { ...DEFAULT_SETTINGS, ai_enabled: ai }, holdings: SEED_HOLDINGS, watchlist: SEED_WATCHLIST,
  telegram_chat_id: null, subs: [],
});

const seedFacts = () => {
  const u = owner();
  const mine = new Set([...SEED_HOLDINGS.map((h) => h.symbol), ...SEED_WATCHLIST.map((w) => w.symbol)]);
  return buildFacts(u, buildPortfolio(u.holdings, SEED_PRICES, u.settings), mine, {
    today: '2026-10-06', idx: SEED_INDEX, prices: SEED_PRICES, news: [],
    screen: [{ symbol: 'ENGRO', sector: 'FERTILIZER', price: 300, change_pct: 0, pe: 7.5, dividend_yield_pct: 9.1, market_cap: 1e11, is_shariah: true }],
  });
};

describe('number grounding', () => {
  it('accepts numbers from the facts (and their roundings), rejects invented ones', () => {
    const known = numberSet({ price: 114.37, weight: 23.98, text: 'EPS Rs 41.20' });
    expect(numbersGrounded('SYS at Rs 114.37, about 24% of the portfolio', known).ok).toBe(true);
    expect(numbersGrounded('EPS 41.2', known).ok).toBe(true);
    expect(numbersGrounded('target price Rs 150', known)).toEqual({ ok: false, unknown: [150] });
    expect(numbersGrounded('tranche 2 on Oct 20, 2026', known).ok).toBe(true); // small ints and years
  });
  it('parses JSON wrapped in code fences', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('noise {"a":2} noise')).toEqual({ a: 2 });
    expect(parseJsonLoose('nope')).toBeNull();
  });
});

describe('AI guardrails', () => {
  const { facts, guard } = seedFacts();

  it('keeps grounded suggestions and drops ones that break your rules', () => {
    const raw = {
      headline: 'Banks and SYS are below cost; the plan already averages them down.',
      suggestions: [
        { action: 'add', symbol: 'MEBL', text: 'Add MEBL in tranche 1 as planned', why: 'Core holding 6% below your cost, weight 19.5%', confidence: 'high' },
        { action: 'add', symbol: 'EFERT', text: 'Average down EFERT', why: 'Down 9.9%', confidence: 'high' }, // hold_no_add
        { action: 'buy', symbol: 'LUCKX', text: 'Buy LUCKX', why: 'Cheap', confidence: 'high' }, // not a known symbol
        { action: 'buy', symbol: 'HUBC', text: 'Buy HUBC, target Rs 260', why: '8.57% yield', confidence: 'medium' }, // invented target
        { action: 'review', symbol: 'AVN', text: 'Re-check AVN after its results', why: 'Status review, 46.9% below its 52-week high', confidence: 'medium' },
      ],
      plan_note: 'Tranche 1 spends on SYS, MEBL, UBL, HUBC and PPL.',
      risks: 'Banks are 31% of the portfolio.',
    } as any;
    const r = guardInsight(raw, facts, guard);
    expect(r.insight.suggestions.map((s) => `${s.action} ${s.symbol}`)).toEqual(['add MEBL', 'review AVN']);
    expect(r.dropped).toBe(3);
    expect(r.reasons.join(' ')).toMatch(/EFERT is hold_no_add/);
    expect(r.reasons.join(' ')).toMatch(/LUCKX is not in your portfolio/);
    expect(r.reasons.join(' ')).toMatch(/numbers not in the data: 260/);
  });

  it('allows screen candidates but no buying on a rally day', () => {
    const rally: GuardContext = { ...guard, rulesSay: 'Wait' };
    const r = guardInsight({ headline: 'x', suggestions: [
      { action: 'buy', symbol: 'ENGRO', text: 'Consider ENGRO', why: '9.1% yield, P/E 7.5', confidence: 'medium' },
      { action: 'watch', symbol: 'ENGRO', text: 'Watch ENGRO', why: '9.1% yield', confidence: 'low' },
    ] } as any, facts, rally);
    expect(r.insight.suggestions.map((s) => s.action)).toEqual(['watch']);
    expect(r.reasons[0]).toMatch(/rules say Wait/);
  });

  it('blanks free text with invented numbers instead of showing it', () => {
    const r = guardInsight({ headline: 'KSE-100 will hit 180,000 soon', suggestions: [], risks: 'Downside to 140,000' } as any, facts, guard);
    expect(r.insight.headline).toMatch(/Nothing stands out/);
    expect(r.insight.risks).toBeNull();
  });
});

describe('Gemini client', () => {
  it('falls back to the next model on 429 and returns JSON', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('model-a')) return new Response('quota', { status: 429 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }));
    };
    const c = new GeminiClient({ apiKey: 'k', models: ['model-a', 'model-b'], fetchImpl, log: () => {} });
    const r = await c.json<{ ok: boolean }>([{ text: 'hi' }], {}, 'sys');
    expect(r).toEqual({ data: { ok: true }, model: 'model-b' });
    expect(calls).toHaveLength(2);
  });
  it('stops on a bad key instead of trying every model', async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => { n++; return new Response('API key not valid', { status: 400 }); };
    const c = new GeminiClient({ apiKey: 'bad', models: ['a', 'b', 'c'], fetchImpl, log: () => {} });
    await expect(c.json([{ text: 'x' }], {}, 's')).rejects.toThrow(/Gemini unavailable/);
    expect(n).toBe(1);
  });
});

describe('opportunity screen', () => {
  it('picks high-yield, low P/E KSE-100 names you do not own, Shariah filter on request', () => {
    const rows = [
      { symbol: 'A', sector: 'X', price: 10, change_pct: 0, pe: 5, dividend_yield_pct: 10, market_cap: 1, is_shariah: false },
      { symbol: 'B', sector: 'X', price: 10, change_pct: 0, pe: 6, dividend_yield_pct: 8, market_cap: 1, is_shariah: true },
      { symbol: 'C', sector: 'X', price: 10, change_pct: 0, pe: 30, dividend_yield_pct: 12, market_cap: 1, is_shariah: true }, // too expensive
      { symbol: 'SYS', sector: 'X', price: 10, change_pct: 0, pe: 5, dividend_yield_pct: 9, market_cap: 1, is_shariah: true }, // owned
    ];
    expect(findOpportunities(rows, new Set(['SYS']), false).map((o) => o.symbol)).toEqual(['A', 'B']);
    expect(findOpportunities(rows, new Set(['SYS']), true).map((o) => o.symbol)).toEqual(['B']);
  });
});

describe('AI inside the scheduled jobs', () => {
  const midday = new Date('2026-10-05T07:30:00Z');
  const snap = (): Snapshot => ({
    fetched_at: '2026-10-05T10:49:00.000Z', errors: [], screener: {},
    indices: { KSE100: { name: 'KSE100', value: SEED_INDEX.kse100, change: SEED_INDEX.change, change_pct: SEED_INDEX.change_pct } },
    quotes: Object.fromEntries(Object.values(SEED_PRICES).map((p) => [p.symbol, {
      ...p, open: null, high: null, low: null, as_of: '2026-10-05T10:49:00.000Z',
      announcements: p.symbol === 'MARI' ? [{ id: 'psx-doc-1', symbol: 'MARI', title: 'Financial results', kind: 'results' as const, published_at: '2026-10-05', pdf_url: 'https://dps.psx.com.pk/download/document/1.pdf' }] : [],
    }])),
  });
  const fakeAi = (fail = false): AiService => ({
    readAnnouncement: async () => { if (fail) throw new Error('Gemini unavailable: 429'); return { summary: 'MARI profit up; dividend Rs 10.', figures: [], verified: true, model: 'fake' }; },
    portfolioInsight: async () => {
      if (fail) throw new Error('Gemini unavailable: 429');
      return { model: 'fake', dropped: 1, reasons: ['x'], insight: { headline: 'Stick to the plan.', plan_note: null, risks: null,
        suggestions: [{ action: 'trim', symbol: 'EFERT', text: 'Consider trimming EFERT', why: '17% weight, hold_no_add', confidence: 'high' }] } };
    },
  });

  it('reads announcements, stores an insight, and notifies a strong AI suggestion', async () => {
    const store = new MemoryStore([owner()]);
    const n = new ConsoleNotifier(() => {});
    const r = await runJob('midday', { store, notifier: n, fetchSnapshot: async () => snap(), fetchPdf: async () => new Uint8Array([1]), ai: fakeAi(), now: () => midday, log: () => {} });
    expect(r.ai).toEqual({ announcements_read: 1, insights: 1, suggestions_dropped: 1 });
    expect(store.insights[0]).toMatchObject({ headline: 'Stick to the plan.', job: 'midday' });
    const sent = n.sent.flatMap((s) => s.n.alerts);
    expect(sent.find((a) => a.kind === 'ai_suggestion')?.message).toMatch(/^AI Assistant suggests: Consider trimming EFERT/);
    expect(sent.find((a) => a.kind === 'announcement_results')?.message).toBe('MARI: MARI profit up; dividend Rs 10.');
  });

  it('skips AI for users who did not opt in', async () => {
    const store = new MemoryStore([owner(false)]);
    const r = await runJob('midday', { store, notifier: new ConsoleNotifier(() => {}), fetchSnapshot: async () => snap(), ai: fakeAi(), now: () => midday, log: () => {} });
    expect(r.ai.insights).toBe(0);
  });

  it('keeps sending normal alerts when Gemini is down', async () => {
    const store = new MemoryStore([owner()]);
    const n = new ConsoleNotifier(() => {});
    const r = await runJob('midday', { store, notifier: n, fetchSnapshot: async () => snap(), fetchPdf: async () => new Uint8Array([1]), ai: fakeAi(true), now: () => midday, log: () => {} });
    expect(r.ai.insights).toBe(0);
    expect(r.errors.some((e) => e.startsWith('ai'))).toBe(true);
    expect(n.sent.flatMap((s) => s.n.alerts).some((a) => a.kind === 'below_cost')).toBe(true);
    expect(store.announcements[0].ai_summary).toBeUndefined(); // left for the next run to retry
  });
});
