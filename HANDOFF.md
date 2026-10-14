# PSX Assistant — Work Handoff

_Last updated: 2026-10-15, 02:10 PKT. Read this first in a new chat; `README.md` describes the product and the
architecture in full. This file is about state, open issues and what to build next._

## Where everything is

- **App:** https://app.psxasst.workers.dev — Cloudflare Worker `app` (account subdomain `psxasst`; `psx` was taken).
  Deploy with `npm run deploy` (wrangler is logged in on this PC). Logs: `npx wrangler tail app --format json`.
- **Repo:** https://github.com/mrnisarali110/psx-assistant (public; Actions logs are public → never print symbols or messages).
- **Database:** Supabase project `tqggelxnrymytxmxftqn`; Site URL points at the app. Migrations apply on push
  (`migrate.yml`); latest is `0005_sip_step_up.sql`.
- **Scheduled work:** GitHub Actions `worker.yml` (jobs: market, night, test, telegram, aicheck, aistatus, diag),
  `telegram.yml`, `migrate.yml`, `ci.yml`. The Cloudflare Worker carries the real schedule (see issue 1).
- **Secrets (names only; values are never pasted in chat — the owner runs the commands himself):**
  - GitHub: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
    `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`; variables `APP_URL`, `TELEGRAM_BOT`.
  - Worker: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`. **Missing: `GITHUB_DISPATCH_TOKEN`** (issue 1).
- **Owner:** Nisar. iPhone, app installed as a PWA, broker JS InvestPro, quiet hours 02:00–12:00 (mutes morning alerts).

## State right now

Commit `9c87797`, Worker version `5437aa72`, 88 tests green, CI green. Everything below is deployed and was
checked on the phone or in the browser at phone width on 2026-10-14:

- Three free AI providers (Groq, Gemini, OpenRouter) behind one router (`shared/llm.ts`): screenshots go to
  OpenRouter's free vision models first, Gemini second; text to Groq first. Models that answer 429/503 rest until
  their limit resets; free key checks (`aistatus`, `GET /api/ai-status`) cost no tokens.
- Screenshot import compares the pictures with saved holdings: more shares = bought, fewer = sold, stock gone =
  "sold all" (unticked by default); every change has its own tick; errors name the provider that failed.
  Confirmed working with 3 screenshots on the phone.
- Profile → "Yearly increase (%)" feeds the Home wealth projection.
- Home shows money by PSX sector (donut + "Show more" breakdown with the stocks inside each sector). Sectors come
  from PSX (price row → market screen → worker backfill); nobody is asked.
- Discover lists are ranked strongest first with sort chips per tab; the AI's order is an option.
- Schedule: Worker cron triggers `15,45 4-11 * * 1-5` and `0 16 * * 1-5` (UTC) start the GitHub job through
  `workflow_dispatch`; a job that finished fine within 20 min (night: 6 h) skips a duplicate tick. The app reloads
  every 5 min while open in market hours.

## Issues to fix (priority order)

1. **Set `GITHUB_DISPATCH_TOKEN` on the Worker.** Without it the Cloudflare ticks only log "token not set" and the
   30-minute checks still depend on GitHub's cron, which ran 5 times on 2026-10-14 (14:43, 15:12, 19:40, 20:11,
   01:03 PKT) instead of 15. Owner: GitHub → Settings → Developer settings → Fine-grained tokens → repo
   `psx-assistant` only, permission Actions: Read and write, expiry up to a year → `npx wrangler secret put
   GITHUB_DISPATCH_TOKEN`. Verify: Actions shows runs with event `workflow_dispatch` at :15/:45 PKT during trading;
   `wrangler tail` shows `cron: market → GitHub HTTP 204`. Add a reminder before the token expires.
2. **Gemini key hygiene.** The previous Gemini key value was exposed (it had been stored as a secret *name* on
   Cloudflare; deleted 2026-10-14). The Worker has a new key; GitHub may still hold the old one (it works). If the
   old key is revoked, run `gh secret set GEMINI_API_KEY`.
3. **CPU time of `/api/import` on the Free plan.** One image cost ~16 ms CPU (nominal limit 10 ms; outcome still
   "ok"). If 3–4-image imports start failing with no provider error in the grey detail line, shrink harder in
   `src/lib/importer.ts` (`MAX_SIDE` 1600 → 1280, JPEG quality) or send images one request at a time.
4. **Import transactions are dated the import day**, not the real purchase day (screenshots carry no dates).
   Options: a date picker in the review sheet, or reading the broker's order/trade history screen.
5. **Stored sector text.** Older holdings keep the owner's hand-typed sector (e.g. `Technology`); views prefer PSX's
   name and the worker only fills NULLs. Optional one-off: normalise stored sectors to PSX's taxonomy.
6. **OpenRouter free models drift.** Preference lists in `shared/llm.ts` are dated 2026-10-14 (Nemotron Omni read
   the sample 8/8; Gemma 4 was rate-limited upstream). Discovery copes with disappearances; re-check quality
   monthly with Actions → PSX worker → `aicheck`.
7. **Telegram linking** still runs on GitHub's unreliable `*/20` cron (`telegram.yml`), so linking can take hours.
   A third Cloudflare cron could dispatch it (Free plan: 5 triggers per account).
8. **GitHub cron fallback + keep-alive step** in `worker.yml`: keep for a week after the token is set, then decide
   whether to remove the schedule block and the keep-alive commit step.
9. **Ramadan hours** differ from `shared/rules.json` `market_hours_pkt`; manual update when they apply.
10. **Phone reinstall after the rename**: confirm the owner reinstalled the PWA at the new address and turned push
    on again (stale subscriptions 404/410 are deleted automatically by `worker/notify.ts`).

## Pending on Claude's side (not done, or done but not yet verified)

Owner actions above are numbered; these are the assistant's own loose ends, in the order to take them up.

- **Verify the Cloudflare schedule end to end** once the token is set (issue 1): watch `wrangler tail app` for
  `cron: market → GitHub HTTP 204` at a :15/:45 slot, confirm the Actions run appears within a minute and that the
  duplicate guard logs "duplicate tick" when GitHub's own cron lands next to it. Nothing of this has been seen live yet;
  only the local workerd probe (HTTP 401 with a dummy token) and unit tests.
- **Shariah flag should be automatic too.** Sectors are now filled from PSX without asking, but the "Shariah compliant"
  toggle in the add/edit form still defaults to off and is set by hand. PSX's KMI All Share membership is already in the
  market screen and price rows (`is_shariah`): default the toggle from it when adding, use it in screenshot import for
  new symbols (today `diffImport` only looks at the price row), and backfill holdings in the worker like sectors.
- **Normalise stored sectors** (issue 5): one-off update of `holdings.sector` to PSX's name where it differs, so the
  stored value and the displayed value stop diverging.
- **Measure a 4-screenshot import** (issue 3): read `cpuTime` in the tail log for a 3–4 image import; if it exceeds
  ~40 ms, shrink images client-side or send them one by one. Not measured yet; only a 1-image import (16 ms) was seen.
- **Telegram linking on the Cloudflare schedule** (issue 7): third cron trigger dispatching `telegram.yml`.
- **Token expiry reminder** for `GITHUB_DISPATCH_TOKEN`: a `diag`/night-digest line when the token is within 30 days
  of expiry (store the expiry date as a Worker var, e.g. `GITHUB_TOKEN_EXPIRES=2027-10-14`).
- **Retire the GitHub cron fallback and keep-alive step** (issue 8) after a week of clean Cloudflare-driven runs.
- **Check the `aistatus` wording** "$100.00 credit left": OpenRouter's `limit_remaining` is the key's spending cap,
  not purchased credit; reword to "spend cap" or drop it.
- **Monthly `aicheck`** to catch OpenRouter model drift (issue 6); the next one is due mid-November 2026.
- **Not verified on the phone:** the sector breakdown sheet, Discover sort chips and the yearly-increase row were
  checked only in the desktop browser at 375 px; the import sheet's "AI ready" line and key-shape warnings were seen on
  the phone. Push after the rename (issue 10) is unconfirmed.

## Feature backlog

- Portfolio value over time (needs a daily per-user snapshot written by the night job, then a chart on Home).
- Transactions screen: all buys and sells, edit/delete, so "invested this month" can be corrected by hand.
- Dividend income: expected yearly income from holdings (yield × value) and a log of dividends received.
- Per-stock price targets set by the user, delivered through the existing alert pipeline (dedupe keys).
- Per-sector limits in Settings (today one global 35%).
- Discover: symbol search and "add to watchlist" from search; a "yours" filter.
- Night digest: one line on sector concentration.
- Token/key expiry reminders in the `diag` job or the night digest.
- Dynamic Island / Live Activities need a native app (impossible as a PWA; owner was told).

## How to work on this (lessons that cost a day)

1. **Edge code runs in Cloudflare Workers, not Node.** Node tests passed while every AI request in the deployed
   Worker died with "Illegal invocation" (global `fetch` called as a method) for a week. Before deploying edge
   changes, run them under workerd: a throwaway probe with `npx wrangler dev --local`, and for cron handlers
   `npx wrangler dev --test-scheduled` then `curl "http://127.0.0.1:8799/__scheduled?cron=15,45+4-11+*+*+1-5"`.
   `shared/llm.test.ts` has a strict-`this` fetch stand-in; keep it.
2. **Never write third-party model or API names from memory.** Query the live list (OpenRouter
   `GET /api/v1/models`, no key needed) and read the limits (e.g. `models` fallback array max 3). Only claim
   success with the real check: Actions → PSX worker → `aicheck` (reads the sample screenshot; expect 8/8) and
   `aistatus` (free key checks).
3. **Keys never go through chat.** The owner runs `npx wrangler secret put NAME` and `gh secret set NAME`. Worker
   secrets do not survive a Worker rename.
4. **Public logs:** `publicErrors` keeps symbols out; OpenRouter's `user_id` is stripped from error text. Keep it so.
5. **UI work:** use the `ui-ux-pro-max` skill (owner's standing request), then check in the browser at 375 px
   (`npm run dev` → `http://localhost:5173/?demo=1#/home`, demo data, no account). Keep `npm test` and `npm run
   typecheck` green.
6. **Commits** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Push triggers CI and
   migrations; `npm run deploy` publishes the Worker and app.

## Commands

```
npm test                       # 88 tests
npm run typecheck
npm run dev                    # http://localhost:5173/?demo=1
npm run worker -- aistatus     # free key checks (needs the API keys in env; on GitHub use the aistatus job)
npm run deploy                 # build + deploy Worker and app
npx wrangler tail app --format json
gh workflow run worker.yml -f job=market|night|aicheck|aistatus|diag
```

## Files that changed most recently

- `shared/llm.ts` (router, OpenRouter, cooldowns, probes), `shared/screenshots.ts`, `shared/changes.ts`
  (`diffImport`, `describeChange`), `shared/portfolio.ts` (sectors, breakdown), `shared/discover.ts` (sorts),
  `shared/growth.ts`, `shared/format.ts` (`sectorLabel`).
- `edge/index.ts` (import, ai-status, key shapes, cron dispatch), `wrangler.jsonc` (name `app`, crons).
- `src/components/ImportSheet.tsx`, `Breakdown.tsx`, `Growth.tsx`, `Donut.tsx`, `ui.tsx` (`Chips`);
  `src/screens/Home.tsx`, `Discover.tsx`, `Profile.tsx`; `src/App.tsx` (auto-refresh); `src/lib/importer.ts`, `data.ts`.
- `worker/run.ts` (`aistatus`), `worker/jobs.ts` (sector backfill, duplicate-tick guard), `worker/store.ts`.
- `supabase/migrations/0005_sip_step_up.sql`, `.github/workflows/worker.yml` (OPENROUTER key, aistatus option).
