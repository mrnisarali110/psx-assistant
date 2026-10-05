/**
 * Worker entry point.
 *   npm run worker -- <job> [--dry-run] [--email you@example.com]
 * jobs: morning | midday | preclose | eod | weekly | telegram | test | auto
 * "auto" picks the job from the GitHub cron expression in $SCHEDULE.
 * --dry-run fetches live PSX data but uses the seed portfolio in memory and only prints alerts.
 */
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { SEED_HOLDINGS, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';
import { fetchSnapshot } from './feed.ts';
import { makeGeminiReword, runJob, type JobName } from './jobs.ts';
import { ConsoleNotifier, RealNotifier } from './notify.ts';
import { MemoryStore, SupabaseStore } from './store.ts';
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
let job = (args.find((a) => !a.startsWith('--') && a !== flag('--email') && a !== flag('--now')) ?? 'auto') as JobName | 'telegram' | 'auto';
if (job === 'auto') {
  const sched = process.env.SCHEDULE ?? '';
  job = CRON_TO_JOB[sched] ?? (sched.includes('*/20') ? 'telegram' : 'midday');
  console.log(`auto: schedule "${sched}" -> ${job}`);
}
const env = process.env;
const email = flag('--email') || env.TEST_EMAIL || undefined;

async function main(): Promise<number> {
  if (dryRun) {
    const store = new MemoryStore([{
      id: 'seed-owner-0000', settings: { ...DEFAULT_SETTINGS }, holdings: SEED_HOLDINGS,
      watchlist: SEED_WATCHLIST, telegram_chat_id: null, subs: [],
    }]);
    store.emails['owner@example.com'] = 'seed-owner-0000';
    if (job === 'telegram') { console.log('dry run: telegram job skipped'); return 0; }
    const fakeNow = flag('--now'); // e.g. 2026-10-05T07:30:00Z to replay a trading day
    const r = await runJob(job as JobName, {
      store, notifier: new ConsoleNotifier(), fetchSnapshot: (s) => fetchSnapshot(s), testEmail: email ?? 'owner@example.com',
      now: fakeNow ? () => new Date(fakeNow) : undefined,
    });
    console.log('\nreport:', r, `\nlogged alerts: ${store.alerts.length}, prices saved: ${Object.keys(store.prices).length}`);
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
    store, notifier, fetchSnapshot: (s) => fetchSnapshot(s), testEmail: email,
    reword: env.GEMINI_API_KEY ? makeGeminiReword(env.GEMINI_API_KEY, env.GEMINI_MODEL || undefined) : undefined,
  });
  console.log('report:', JSON.stringify(report, null, 2));
  // A PSX outage is reported (and the user told once a day) but is not a workflow failure.
  return report.errors.some((e) => /^(user |no account|job=test|test alert)/.test(e)) || (job === 'test' && !report.ok) ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
