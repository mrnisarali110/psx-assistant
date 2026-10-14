/**
 * Cloudflare Worker in front of the static app. Everything is served from ./dist except:
 *   POST /api/import     — read holdings from broker screenshots with AI.
 *   GET  /api/ai-status  — which AI providers are ready, cooling down or mis-configured (free checks, no tokens).
 * Screenshots exist only in this request's memory: never stored, never logged.
 * The AI keys are Worker secrets (wrangler secret put OPENROUTER_API_KEY / GEMINI_API_KEY / GROQ_API_KEY).
 */
import { PREFERENCE, makeRouter, type LlmRouter } from '../shared/llm.ts';
import { cleanKnownSymbols, importParts, readPortfolioScreenshots } from '../shared/screenshots.ts';
import { hhmmToMinutes, pktParts } from '../shared/time.ts';
import { DEFAULT_RULES } from '../shared/types.ts';

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  SUPABASE_URL: string;
  SUPABASE_KEY: string; // publishable key, used only to verify the caller's session
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODELS?: string; // optional comma list to pin models instead of discovering free ones
  /** Fine-grained GitHub token (Actions: read and write on the repo): lets the cron below start the worker on time. */
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPO?: string; // owner/name, default below
}

const DEFAULT_REPO = 'mrnisarali110/psx-assistant';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4_000_000; // base64 length, ~3 MB image; the app downsizes before upload
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** The signed-in Supabase user behind this bearer token, or null. */
async function userFor(req: Request, env: Env, fetchImpl: typeof fetch): Promise<{ id: string } | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer [\w.-]+$/.test(auth)) return null;
  const r = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_KEY, Authorization: auth } });
  if (!r.ok) return null;
  const u = (await r.json()) as { id?: string };
  return u.id ? { id: u.id } : null;
}

function router(env: Env, fetchImpl: typeof fetch): LlmRouter {
  const list = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean);
  return makeRouter(
    { gemini: env.GEMINI_API_KEY, groq: env.GROQ_API_KEY, openrouter: env.OPENROUTER_API_KEY, openrouterModels: list(env.OPENROUTER_MODELS) },
    { fetchImpl, log: (m) => console.log(m) }, // provider error text only; never images or holdings
  );
}

/** "3:05 PM" or "tomorrow 9:00 AM" in Pakistan time. */
export function whenPkt(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit' }).format(d);
  return day(d) === day(now) ? time : `tomorrow ${time}`;
}

type Reason = 'policy' | 'key' | 'limit' | 'busy' | 'bad_request' | 'other';

/** Strip our own "<provider> unavailable: " / "<provider> cooling down until …: " prefix: only the provider's words count. */
const bodyOf = (seg: string) => seg.replace(/^\w+ (unavailable|cooling down until \S+): /, '');

function classify(seg: string): Reason {
  const s = bodyOf(seg);
  if (/data policy|privacy/i.test(s)) return 'policy';
  if (/\b40[13]\b|api key/i.test(s)) return 'key';
  if (/\b429\b|\b402\b|quota|RESOURCE_EXHAUSTED|rate limit/i.test(s) || /cooling down/.test(seg)) return 'limit';
  if (/\b503\b|overload|high demand/i.test(s) || /\bUNAVAILABLE\b/.test(s)) return 'busy';
  if (/\b400\b|invalid|unsupported/i.test(s)) return 'bad_request';
  return 'other';
}

/**
 * A message the user can act on, from the router's error (one segment per provider, joined by " | "),
 * plus a short technical detail naming each provider's actual failure (status codes and error text, never images).
 */
export function importError(msg: string, retryAt: string | null = null): { error: string; reason: Reason; retry_at: string | null; detail: string } {
  const segs = msg.replace(/^AI unavailable: /, '').split(' | ').map((s) => s.trim()).filter(Boolean);
  const kinds = segs.map(classify);
  const all = (k: Reason) => kinds.length > 0 && kinds.every((x) => x === k);
  const reason: Reason = kinds.includes('policy') ? 'policy' : kinds.includes('key') ? 'key' : all('limit') ? 'limit'
    : kinds.includes('busy') ? 'busy' : all('bad_request') ? 'bad_request' : kinds.includes('limit') ? 'limit' : 'other';
  const again = retryAt ? ` Try again after ${whenPkt(retryAt)}.` : '';
  const error = {
    policy: 'OpenRouter is blocking its free models for this key. On openrouter.ai → Settings → Privacy, allow "Free model training", then try again.',
    key: "Screenshot reading isn't set up correctly (an AI key is wrong).",
    limit: `The free AI limits are used up for now.${again || ' Try again in a few minutes.'}`,
    busy: `The AI is busy right now.${again || ' Try again in a minute.'}`,
    bad_request: "The AI couldn't process these images. Try a clear screenshot of the holdings list.",
    other: "Couldn't read the screenshots this time. Try again.",
  }[reason];
  const detail = segs.map((s) => `${s.split(' ')[0]}: ${bodyOf(s)}`.replace(/\s+/g, ' ').slice(0, 120)).join(' · ');
  return { error, reason, retry_at: reason === 'limit' || reason === 'busy' ? retryAt : null, detail };
}

export async function handleImport(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  if (!(await userFor(req, env, fetchImpl))) return json({ error: 'Please sign in again.' }, 401);
  const ai = router(env, fetchImpl);
  if (!ai.available) return json({ error: 'Screenshot reading is not set up yet (missing AI key).' }, 503);

  let body: { images?: { mime?: string; base64?: string }[]; known?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const images = (body.images ?? []).filter((i) => i && typeof i.base64 === 'string' && IMAGE_TYPES.has(String(i.mime)));
  if (!images.length) return json({ error: 'Add at least one screenshot (JPEG, PNG or WebP).' }, 400);
  if (images.length > MAX_IMAGES) return json({ error: `Up to ${MAX_IMAGES} screenshots at a time.` }, 400);
  if (images.some((i) => (i.base64 as string).length > MAX_IMAGE_BYTES)) return json({ error: 'A screenshot is too large.' }, 413);
  const known = cleanKnownSymbols(body.known);
  const pics = images.map((i) => ({ mime: i.mime as string, base64: i.base64 as string }));

  try {
    const r = await readPortfolioScreenshots(ai, pics, { known });
    if (!r.isPortfolio || !r.rows.length) return json({ error: "Couldn't find a holdings list in these screenshots. Use the Portfolio screen of your broker app." }, 422);
    return json({ holdings: r.rows, dropped: r.dropped, model: r.model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('import failed:', msg.slice(0, 500)); // Cloudflare logs only; never the images
    return json(importError(msg, ai.nextReady('vision', importParts(pics))), 503);
  }
}

/** The shape of a stored key, never the key: enough to spot a paste gone wrong (line break, quotes, a NAME= prefix). */
export function keyShape(value: string | undefined, prefix: RegExp): { length: number; expected_prefix: boolean; clean: boolean } | null {
  if (!value) return null;
  return { length: value.length, expected_prefix: prefix.test(value), clean: !/[\s"'=]/.test(value) };
}

/** Provider states for the app: cooldowns from memory plus a free key check per provider (cached 10 min). */
export async function handleStatus(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'Use GET' }, 405);
  if (!(await userFor(req, env, fetchImpl))) return json({ error: 'Please sign in again.' }, 401);
  const ai = router(env, fetchImpl);
  const providers = await ai.status({ probe: true });
  const vision = PREFERENCE.vision.filter((n) => ai.names.includes(n));
  const cooling = providers.filter((p) => vision.includes(p.name) && p.state === 'cooling' && p.until).map((p) => p.until!).sort();
  return json({
    providers, vision,
    ready: providers.some((p) => vision.includes(p.name) && p.state === 'ready'),
    retry_at: cooling[0] ?? null,
    keys: { openrouter: keyShape(env.OPENROUTER_API_KEY, /^sk-or-/), gemini: keyShape(env.GEMINI_API_KEY, /^AIza/), groq: keyShape(env.GROQ_API_KEY, /^gsk_/) },
  });
}

// ---------------------------------------------------------------------------
// Schedule: Cloudflare's cron fires on time; GitHub's own cron can run hours late or not at all.
// Each tick starts the GitHub worker job (workflow_dispatch). The job skips itself if the same job already
// ran minutes ago, so GitHub's delayed cron, kept as a fallback, never doubles the work.
// Crons (UTC) are in wrangler.jsonc: "15,45 4-11 * * 1-5" (market ticks) and "0 16 * * 1-5" (21:00 PKT night).
// ---------------------------------------------------------------------------
export type CronJob = 'market' | 'night';

/** Which worker job a tick should start: market only while PSX trades (plus 20 min after the close for closing prices). */
export function jobForTick(now: Date, cron: string): CronJob | null {
  if (/^0 16\b/.test(cron)) return 'night';
  const h = DEFAULT_RULES.market_hours_pkt;
  const { weekday, minutes } = pktParts(now);
  if (weekday < 1 || weekday > 5) return null;
  const sessions = weekday === 5 ? h.fri : h.mon_thu;
  const close = hhmmToMinutes(weekday === 5 ? h.close_fri : h.close_mon_thu);
  const trading = sessions.some(([s, e]) => minutes >= hhmmToMinutes(s) + 15 && minutes <= hhmmToMinutes(e));
  const afterClose = minutes > close && minutes <= close + 20;
  return trading || afterClose ? 'market' : null;
}

export async function dispatchJob(env: Env, job: CronJob, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number }> {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    console.log('cron: GITHUB_DISPATCH_TOKEN not set, so GitHub\'s own cron is the only schedule');
    return { ok: false, status: 0 };
  }
  const r = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO ?? DEFAULT_REPO}/actions/workflows/worker.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'psx-assistant-cron', 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs: { job } }),
  });
  console.log(`cron: ${job} → GitHub HTTP ${r.status}${r.status === 204 ? '' : ` ${(await r.text().catch(() => '')).slice(0, 120)}`}`);
  return { ok: r.status === 204, status: r.status };
}

export async function handleTick(env: Env, scheduledTime: number, cron: string, fetchImpl: typeof fetch = fetch) {
  const job = jobForTick(new Date(scheduledTime), cron);
  if (!job) return null;
  return dispatchJob(env, job, fetchImpl);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/import') return handleImport(req, env);
    if (url.pathname === '/api/ai-status') return handleStatus(req, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(req);
  },
  async scheduled(event: { scheduledTime: number; cron: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(handleTick(env, event.scheduledTime, event.cron));
  },
};
