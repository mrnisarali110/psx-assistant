/**
 * Cloudflare Worker in front of the static app. Everything is served from ./dist except:
 *   POST /api/import  — read holdings from broker screenshots with AI.
 * Screenshots exist only in this request's memory: never stored, never logged.
 * The AI keys are Worker secrets (wrangler secret put GEMINI_API_KEY / GROQ_API_KEY).
 */
import { makeRouter } from '../shared/llm.ts';
import { readPortfolioScreenshots } from '../shared/screenshots.ts';

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  SUPABASE_URL: string;
  SUPABASE_KEY: string; // publishable key, used only to verify the caller's session
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
}

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

export async function handleImport(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  if (!(await userFor(req, env, fetchImpl))) return json({ error: 'Please sign in again.' }, 401);
  const ai = makeRouter({ gemini: env.GEMINI_API_KEY, groq: env.GROQ_API_KEY }, { fetchImpl, log: () => {} });
  if (!ai.available) return json({ error: 'Screenshot reading is not set up yet (missing AI key).' }, 503);

  let body: { images?: { mime?: string; base64?: string }[] };
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const images = (body.images ?? []).filter((i) => i && typeof i.base64 === 'string' && IMAGE_TYPES.has(String(i.mime)));
  if (!images.length) return json({ error: 'Add at least one screenshot (JPEG, PNG or WebP).' }, 400);
  if (images.length > MAX_IMAGES) return json({ error: `Up to ${MAX_IMAGES} screenshots at a time.` }, 400);
  if (images.some((i) => (i.base64 as string).length > MAX_IMAGE_BYTES)) return json({ error: 'A screenshot is too large.' }, 413);

  try {
    const r = await readPortfolioScreenshots(ai, images.map((i) => ({ mime: i.mime as string, base64: i.base64 as string })));
    if (!r.isPortfolio || !r.rows.length) return json({ error: "Couldn't find a holdings list in these screenshots. Use the Portfolio screen of your broker app." }, 422);
    return json({ holdings: r.rows, dropped: r.dropped, model: r.model });
  } catch {
    return json({ error: 'The AI is busy right now. Try again in a minute.' }, 503);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/import') return handleImport(req, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(req);
  },
};
