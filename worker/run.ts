/**
 * Worker entry point.
 *   npm run worker -- <job> [--dry-run] [--email you@example.com] [--now ISO]
 * jobs: market | night | refresh | test | telegram | aicheck | aistatus | diag | auto
 * diag prints delivery settings and the last alerts per account: kinds, times, channels only (logs are public).
 * "auto" picks the job from the GitHub cron expression in $SCHEDULE.
 * --dry-run fetches live PSX data but uses the seed portfolio in memory and only prints alerts.
 * aicheck runs every AI task once on real PSX data and the seed portfolio, prints, and writes nothing.
 * aistatus checks every AI key with a free call (no tokens) and prints which providers are ready or cooling down.
 */
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';
import { llmHealth, makeRouter } from '../shared/llm.ts';
import { buildPortfolio } from '../shared/portfolio.ts';
import { undervalued } from '../shared/discover.ts';
import { pktDate } from '../shared/time.ts';
import { readFileSync } from 'node:fs';
import { readPortfolioScreenshots } from '../shared/screenshots.ts';
import { discoverPicks, portfolioInsight, readAnnouncement } from './ai.ts';
import { Fetcher, fetchSnapshot, toPrice, toScreenRows } from './feed.ts';
import { buildFacts, runJob, type JobName } from './jobs.ts';
import { ConsoleNotifier, RealNotifier } from './notify.ts';
import { MemoryStore, SupabaseStore, type UserCtx } from './store.ts';
import { processTelegramUpdates } from './telegram.ts';

/** GitHub cron (UTC) -> job. PKT = UTC+5. Keep in sync with .github/workflows/worker.yml. */
export const CRON_TO_JOB: Record<string, JobName> = {
  '45 4-10 * * 1-5': 'market', // 09:45 ... 15:45 PKT
  '15 5-10 * * 1-5': 'market', // 10:15 ... 15:15 PKT (15:15 Mon-Thu = before close)
  '15,45 11 * * 5': 'market', // Friday 16:15 (before close) and 16:45 PKT
  '0 16 * * 1-5': 'night', // 21:00 PKT night digest
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
let job = (args.find((a) => !a.startsWith('--') && a !== flag('--email') && a !== flag('--now')) ?? 'auto') as JobName | 'telegram' | 'aicheck' | 'aistatus' | 'diag' | 'auto';
if (job === 'auto') {
  const sched = process.env.SCHEDULE ?? '';
  job = CRON_TO_JOB[sched] ?? (sched.includes('*/20') ? 'telegram' : 'market');
  console.log(`auto: schedule "${sched}" -> ${job}`);
}
const env = process.env;
const email = flag('--email') || env.TEST_EMAIL || undefined;
const fetcher = new Fetcher();
const list = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);
const ai = makeRouter({
  gemini: env.GEMINI_API_KEY, groq: env.GROQ_API_KEY, openrouter: env.OPENROUTER_API_KEY,
  geminiModels: list(env.GEMINI_MODELS), groqModels: list(env.GROQ_MODELS), openrouterModels: list(env.OPENROUTER_MODELS),
});
const snapshot = (s: string[], o?: { screener?: boolean }) => fetchSnapshot(s, { fetcher, ...o });

const seedUser = (): UserCtx => ({
  id: 'seed-owner-0000', settings: { ...DEFAULT_SETTINGS, ai_enabled: true }, holdings: SEED_HOLDINGS,
  watchlist: SEED_WATCHLIST, telegram_chat_id: null, subs: [],
});

/** Live check of every AI task on real PSX data. Writes nothing. */
async function aiCheck(): Promise<number> {
  if (!ai.available) { console.error('No AI key set (OPENROUTER_API_KEY / GEMINI_API_KEY / GROQ_API_KEY)'); return 2; }
  const u = seedUser();
  const syms = [...SEED_HOLDINGS.map((h) => h.symbol), ...SEED_WATCHLIST.map((w) => w.symbol)];
  const snap = await snapshot(syms);
  const prices = Object.fromEntries(Object.values(snap.quotes).filter((q) => q.price != null).map((q) => [q.symbol, toPrice(q, snap.screener[q.symbol])]));
  const screen = toScreenRows(snap.screener);
  let ok = true;
  const ann = Object.values(snap.quotes).flatMap((q) => q.announcements).filter((a) => a.kind !== 'other' && a.pdf_url)
    .sort((a, b) => (b.title.match(/dividend|result/i) ? 1 : 0) - (a.title.match(/dividend|result/i) ? 1 : 0) || b.published_at.localeCompare(a.published_at))[0];
  if (ann) {
    try {
      const d = await readAnnouncement(ai, await fetcher.getBytes(ann.pdf_url!), { symbol: ann.symbol, title: ann.title, published_at: ann.published_at });
      console.log(`\n== Filing: ${ann.symbol} ${ann.published_at} "${ann.title}"\nmodel=${d.model} verified=${d.verified}${d.date_note ? ` dates=${d.date_note}` : ''}\n${d.summary}`);
      for (const f of d.figures) console.log(`  ${f.verified ? '✓' : '?'} ${f.label}: ${f.value}`);
      if (d.dividend) console.log(`  dividend: Rs ${d.dividend.dps} ${d.dividend.type ?? ''} book closure ${d.dividend.book_closure_from ?? '?'} verified=${d.dividend.verified}`);
    } catch (e) { ok = false; console.error('filing read failed:', (e as Error).message); }
  }
  const k = snap.indices.KSE100;
  const idx = k?.value ? { ts: snap.fetched_at, kse100: k.value, change: k.change, change_pct: k.change_pct } : null;
  const today = pktDate(new Date());
  const { facts, guard } = buildFacts(u, buildPortfolio(u.holdings, prices, u.settings), new Set(syms),
    { today, idx, prices, screen, news: [], dividends: [], now: new Date() }, 0);
  try {
    const r = await portfolioInsight(ai, facts, guard);
    console.log(`\n== AI Assistant (model=${r.model}, dropped=${r.dropped}) stance=${r.insight.stance}\n${r.insight.headline}`);
    for (const c of r.insight.holding_calls) console.log(`  ${c.symbol.padEnd(6)} ${c.call.padEnd(12)} ${c.text}`);
    for (const s of r.insight.suggestions) console.log(`  [${s.action}${s.symbol ? ' ' + s.symbol : ''} · ${s.confidence}] ${s.text} — ${s.why}`);
    for (const [k2, v] of [['rebalance', r.insight.rebalance], ['cash', r.insight.cash_note], ['risk', r.insight.risks]]) if (v) console.log(`  ${k2}: ${v}`);
    if (r.reasons.length) console.log(`  guardrails dropped: ${r.reasons.join(' | ')}`);
  } catch (e) { ok = false; console.error('insight failed:', (e as Error).message); }
  try {
    const uv = undervalued(screen).map((r) => ({ symbol: r.symbol, sector: r.sector, price: r.price, pe: r.pe, sector_pe: r.sector_pe, dividend_yield_pct: r.dividend_yield_pct, change_1y_pct: r.change_1y_pct }));
    const p = await discoverPicks(ai, 'undervalued', uv);
    console.log(`\n== Undervalued picks (${p.model})`);
    for (const i of p.items) console.log(`  ${i.symbol.padEnd(8)} ${i.why}`);
  } catch (e) { ok = false; console.error('picks failed:', (e as Error).message); }
  try {
    // Same code path as /api/import, on a mock broker screenshot of the seed portfolio.
    const shot = readFileSync(new URL('./fixtures/portfolio-sample.jpg', import.meta.url)).toString('base64');
    const r = await readPortfolioScreenshots(ai, [{ mime: 'image/jpeg', base64: shot }]);
    const want = new Map(SEED_HOLDINGS.map((h) => [h.symbol, h]));
    const right = r.rows.filter((x) => want.get(x.symbol)?.shares === x.shares && Math.abs(want.get(x.symbol)!.avg_cost - x.avg_cost) < 0.01).length;
    console.log(`
== Screenshot read (${r.model}): ${r.rows.length} rows, ${right}/${want.size} exactly right, unreadable ${r.dropped.length}`);
    if (right < want.size) ok = false;
  } catch (e) { ok = false; console.error('screenshot read failed:', (e as Error).message.slice(0, 300)); }
  printHealth();
  return ok ? 0 : 1;
}

/** Cooldowns remembered during this run (which models hit a limit and until when). */
function printHealth() {
  const cool = llmHealth.snapshot();
  console.log(cool.length ? `\n== Cooling down: ${cool.map((c) => `${c.key} until ${c.until} (${c.reason.slice(0, 80)})`).join('; ')}` : '\n== No model is cooling down.');
}

/** Free check of every configured AI key: list-models / key-info calls only, no prompts, no tokens. */
async function aiStatus(): Promise<number> {
  if (!ai.available) { console.error('No AI key set (OPENROUTER_API_KEY / GEMINI_API_KEY / GROQ_API_KEY)'); return 2; }
  const st = await ai.status({ probe: true });
  for (const p of st) console.log(`${p.name.padEnd(11)} ${p.state.padEnd(8)} ${p.detail ?? ''}${p.until ? ` (until ${p.until})` : ''}`);
  const readers = ['openrouter', 'gemini'].filter((n) => ai.names.includes(n));
  console.log(`providers: ${ai.names.join(', ')}; screenshots are read by: ${readers.join(' then ') || 'nobody (no vision-capable key)'}`);
  return st.some((p) => p.state === 'ready') ? 0 : 1;
}

async function main(): Promise<number> {
  if (job === 'aicheck') return aiCheck();
  if (job === 'aistatus') return aiStatus();

  if (dryRun) {
    const fakeNow = flag('--now'); // e.g. 2026-10-05T07:30:00Z to replay a trading day
    const clock = () => (fakeNow ? new Date(fakeNow) : new Date());
    const store = new MemoryStore([seedUser()], clock);
    store.emails['owner@example.com'] = 'seed-owner-0000';
    if (job === 'telegram') { console.log('dry run: telegram job skipped'); return 0; }
    const r = await runJob(job as JobName, {
      store, notifier: new ConsoleNotifier(), fetchSnapshot: snapshot, testEmail: email ?? 'owner@example.com',
      fetchPdf: (url) => fetcher.getBytes(url), ai: ai.available ? ai : undefined, now: clock,
    });
    console.log('\nreport:', r, `\nlogged alerts: ${store.alerts.length}, prices saved: ${Object.keys(store.prices).length}, insights: ${store.insights.length}, dividends: ${store.divs.length}`);
    return r.ok ? 0 : 1;
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (GitHub Actions secrets). Use --dry-run locally.');
    return 2;
  }
  const store = new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  if (job === 'telegram') {
    if (!env.TELEGRAM_BOT_TOKEN) { console.log('TELEGRAM_BOT_TOKEN not set, nothing to do'); return 0; }
    await processTelegramUpdates(env.TELEGRAM_BOT_TOKEN, store);
    return 0;
  }

  if (job === 'diag') {
    const users = await store.loadUsers();
    for (const [i, u] of users.entries()) {
      const recent = await store.recentAlerts(u.id, new Date(Date.now() - 2 * 86400000).toISOString());
      console.log(`account ${i + 1}: quiet ${JSON.stringify(u.settings.quiet_hours)} alerts=${u.settings.notifications_enabled} ai=${!!u.settings.ai_enabled} push_devices=${u.subs.length} telegram=${!!u.telegram_chat_id}`);
      for (const a of recent.sort((x, y) => y.sent_at.localeCompare(x.sent_at)).slice(0, 12)) console.log(`  ${a.sent_at}  ${a.kind.padEnd(22)} ${a.channel ?? '-'}${a.batch_id ? ' (pushed batch)' : ''}`);
    }
    return 0;
  }

  const notifier = new RealNotifier({
    vapidPublic: env.VAPID_PUBLIC_KEY, vapidPrivate: env.VAPID_PRIVATE_KEY, vapidSubject: env.VAPID_SUBJECT,
    telegramToken: env.TELEGRAM_BOT_TOKEN, appUrl: env.APP_URL,
  }, store);
  const report = await runJob(job as JobName, {
    store, notifier, fetchSnapshot: snapshot, testEmail: email, fetchPdf: (url) => fetcher.getBytes(url), ai: ai.available ? ai : undefined,
  });
  console.log('report:', JSON.stringify(report, null, 2));
  // A PSX outage or an AI hiccup is reported (and the user told once a day) but is not a workflow failure.
  return report.errors.some((e) => /^(user |no account|job=test|test alert)/.test(e)) || (job === 'test' && !report.ok) ? 1 : 0;
}

if (!process.env.VITEST) main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
