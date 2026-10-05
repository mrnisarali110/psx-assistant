/**
 * Worker entry point.
 *   npm run worker -- <job> [--dry-run] [--email you@example.com] [--now ISO]
 * jobs: morning | midday | preclose | eod | weekly | telegram | test | aicheck | auto
 * "auto" picks the job from the GitHub cron expression in $SCHEDULE.
 * --dry-run fetches live PSX data but uses the seed portfolio in memory and only prints alerts.
 * aicheck calls Gemini on a real PSX PDF and the seed portfolio, prints the result, writes nothing.
 */
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';
import { buildPortfolio } from '../shared/portfolio.ts';
import { GeminiClient, portfolioInsight, readAnnouncement } from './ai.ts';
import { Fetcher, fetchSnapshot, toPrice } from './feed.ts';
import { buildFacts, runJob, type AiService, type JobName } from './jobs.ts';
import { ConsoleNotifier, RealNotifier } from './notify.ts';
import { MemoryStore, SupabaseStore, type UserCtx } from './store.ts';
import { processTelegramUpdates } from './telegram.ts';

const CRON_TO_JOB: Record<string, JobName> = {
  '0 4 * * 1-5': 'morning', // 09:00 PKT
  '30 7 * * 1-5': 'midday', // 12:30 PKT
  '0 10 * * 1-5': 'preclose', // 15:00 PKT
  '0 12 * * 1-5': 'eod', // 17:00 PKT (after Friday's 16:50 post-close)
  '0 13 * * 0': 'weekly', // Sunday 18:00 PKT
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
let job = (args.find((a) => !a.startsWith('--') && a !== flag('--email') && a !== flag('--now')) ?? 'auto') as JobName | 'telegram' | 'aicheck' | 'auto';
if (job === 'auto') {
  const sched = process.env.SCHEDULE ?? '';
  job = CRON_TO_JOB[sched] ?? (sched.includes('*/20') ? 'telegram' : 'midday');
  console.log(`auto: schedule "${sched}" -> ${job}`);
}
const env = process.env;
const email = flag('--email') || env.TEST_EMAIL || undefined;
const fetcher = new Fetcher();

function makeAi(): AiService | undefined {
  if (!env.GEMINI_API_KEY) return undefined;
  const client = new GeminiClient({ apiKey: env.GEMINI_API_KEY, models: env.GEMINI_MODELS?.split(',').map((s) => s.trim()).filter(Boolean) });
  return {
    readAnnouncement: (pdf, meta) => readAnnouncement(client, pdf, meta),
    portfolioInsight: (facts, guard) => portfolioInsight(client, facts, guard),
  };
}

const seedUser = (): UserCtx => ({
  id: 'seed-owner-0000', settings: { ...DEFAULT_SETTINGS, ai_enabled: true }, holdings: SEED_HOLDINGS,
  watchlist: SEED_WATCHLIST, telegram_chat_id: null, subs: [],
});

/** Live check of both AI features on real PSX data. Writes nothing. */
async function aiCheck(): Promise<number> {
  const ai = makeAi();
  if (!ai) { console.error('GEMINI_API_KEY not set'); return 2; }
  const u = seedUser();
  const syms = [...SEED_HOLDINGS.map((h) => h.symbol), ...SEED_WATCHLIST.map((w) => w.symbol)];
  const snap = await fetchSnapshot(syms, { fetcher });
  const prices = Object.fromEntries(Object.values(snap.quotes).filter((q) => q.price != null).map((q) => [q.symbol, toPrice(q, snap.screener[q.symbol])]));
  const ann = Object.values(snap.quotes).flatMap((q) => q.announcements).filter((a) => a.kind !== 'other' && a.pdf_url)
    .sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
  let ok = true;
  if (ann) {
    try {
      const d = await ai.readAnnouncement(await fetcher.getBytes(ann.pdf_url!), { symbol: ann.symbol, title: ann.title });
      console.log(`\n== Announcement: ${ann.symbol} ${ann.published_at} "${ann.title}"\nmodel=${d.model} verified=${d.verified}\n${d.summary}`);
      for (const f of d.figures) console.log(`  ${f.verified ? '✓' : '?'} ${f.label}: ${f.value}`);
    } catch (e) { ok = false; console.error('announcement read failed:', (e as Error).message); }
  }
  const screen = Object.values(snap.screener).filter((s) => s.listed_in.includes('KSE100')).map((s) => ({
    symbol: s.symbol, sector: s.sector, price: s.price, change_pct: s.change_pct, pe: s.pe,
    dividend_yield_pct: s.dividend_yield_pct, market_cap: s.market_cap, is_shariah: s.listed_in.includes('KMIALLSHR'),
  }));
  const k = snap.indices.KSE100;
  const idx = k?.value ? { ts: snap.fetched_at, kse100: k.value, change: k.change, change_pct: k.change_pct } : null;
  const mine = new Set(syms);
  const { facts, guard } = buildFacts(u, buildPortfolio(u.holdings, prices, u.settings), mine, { today: snap.fetched_at.slice(0, 10), idx, prices, screen, news: [] });
  try {
    const r = await ai.portfolioInsight(facts, guard);
    console.log(`\n== AI Assistant suggests (model=${r.model}, dropped=${r.dropped})\n${r.insight.headline}`);
    for (const s of r.insight.suggestions) console.log(`  [${s.action}${s.symbol ? ' ' + s.symbol : ''} · ${s.confidence}] ${s.text}\n      why: ${s.why}`);
    if (r.insight.plan_note) console.log(`  plan: ${r.insight.plan_note}`);
    if (r.insight.risks) console.log(`  risk: ${r.insight.risks}`);
    if (r.reasons.length) console.log(`  guardrails dropped: ${r.reasons.join(' | ')}`);
  } catch (e) { ok = false; console.error('insight failed:', (e as Error).message); }
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  if (job === 'aicheck') return aiCheck();

  if (dryRun) {
    const store = new MemoryStore([seedUser()]);
    store.emails['owner@example.com'] = 'seed-owner-0000';
    if (job === 'telegram') { console.log('dry run: telegram job skipped'); return 0; }
    const fakeNow = flag('--now'); // e.g. 2026-10-05T07:30:00Z to replay a trading day
    const r = await runJob(job as JobName, {
      store, notifier: new ConsoleNotifier(), fetchSnapshot: (s) => fetchSnapshot(s, { fetcher }), testEmail: email ?? 'owner@example.com',
      fetchPdf: (url) => fetcher.getBytes(url), ai: makeAi(),
      now: fakeNow ? () => new Date(fakeNow) : undefined,
    });
    console.log('\nreport:', r, `\nlogged alerts: ${store.alerts.length}, prices saved: ${Object.keys(store.prices).length}, insights: ${store.insights.length}`);
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

  const notifier = new RealNotifier({
    vapidPublic: env.VAPID_PUBLIC_KEY, vapidPrivate: env.VAPID_PRIVATE_KEY, vapidSubject: env.VAPID_SUBJECT,
    telegramToken: env.TELEGRAM_BOT_TOKEN, appUrl: env.APP_URL,
  }, store);
  const report = await runJob(job as JobName, {
    store, notifier, fetchSnapshot: (s) => fetchSnapshot(s, { fetcher }), testEmail: email,
    fetchPdf: (url) => fetcher.getBytes(url), ai: makeAi(),
  });
  console.log('report:', JSON.stringify(report, null, 2));
  // A PSX outage or an AI hiccup is reported (and the user told once a day) but is not a workflow failure.
  return report.errors.some((e) => /^(user |no account|job=test|test alert)/.test(e)) || (job === 'test' && !report.ok) ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
