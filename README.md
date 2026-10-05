# PSX Personal Investing Assistant

A free, installable phone app (PWA) for iPhone and Android. A scheduled worker checks the
Pakistan Stock Exchange on weekdays, sends alerts to your locked phone, and turns each month's
cash into a concrete plan: stock, rupees, whole shares and a reason. **It never trades and never
asks for broker logins. You place orders yourself in your broker app. Not licensed financial advice.**

Running cost: Rs 0 (free tiers of Supabase, GitHub Actions, Cloudflare Pages or Vercel Hobby, Telegram).

## How it works

```
 PSX data portal ──(weekday cron)──▶ worker (GitHub Actions) ──▶ Supabase (prices, alerts, plans)
 (public HTML pages)                    │                                 ▲
                                        ├──▶ Web Push ──▶ phone           │ reads (row-level security)
                                        └──▶ Telegram bot ──▶ phone       │
                                                                  PWA (React) on Cloudflare/Vercel
```

| Folder | What |
| --- | --- |
| `shared/` | Rules engine: allocation, alert rules, notification limits, `rules.json`. Pure functions with unit tests. Used by both app and worker. |
| `worker/` | PSX feed (HTML parsing), jobs, Supabase store, Web Push + Telegram delivery. |
| `src/` | The app: Today, Portfolio, Plan, News, Settings. Hash routes like `/#/plan`. |
| `public/` | Manifest, service worker (`sw.js`, offline shell + push), icons. |
| `supabase/` | SQL migrations and the privacy (RLS) test. |
| `.github/workflows/` | `worker.yml` (schedule), `telegram.yml` (link polling), `ci.yml` (tests + build). |

### Schedule (PKT = UTC+5)

| Job | PKT | UTC cron | Does |
| --- | --- | --- | --- |
| morning | 09:00 Mon–Fri | `0 4 * * 1-5` | Refresh data and announcements, morning brief |
| midday | 12:30 Mon–Fri | `30 7 * * 1-5` | Refresh prices, market + holding alerts |
| preclose | 15:00 Mon–Fri | `0 10 * * 1-5` | Same, last dip warning of the day |
| eod | 17:00 Mon–Fri | `0 12 * * 1-5` | Closing snapshot, daily summary |
| weekly | Sun 18:00 | `0 13 * * 0` | Weekly plan, review of past suggestions, keep-alive |
| telegram | every 20 min, 08:00–23:59 | `*/20 3-18 * * *` | Link Telegram chats |

End of day runs at 17:00, not 16:30: on Fridays PSX trades until 16:30 with a post-close session to 16:50
([PSX trading hours](https://www.psx.com.pk/psx/exchange/general/trading-hours), checked 2026-10-06).
Session hours live in `shared/rules.json` (`market_hours_pkt`); Ramadan hours differ, so update them then.

### Notification rules

At most 3 notifications per user per day. Alerts found in the same run are bundled into one.
Quiet hours 23:00–07:00 PKT. Crash alerts (KSE-100 down 4%+ in a day, or below your crash level)
always go through. Everything, including alerts held back by these limits, appears under News → Alert history.
Every alert has a `dedupe_key`, so nothing repeats; "below cost" repeats at most every 7 days.

## Data source (read this if prices stop updating)

There is no official free PSX API. The worker reads the portal's ordinary public pages with an
honest User-Agent (`psx-personal-assistant/1.0`), about 15 requests per run:

- `https://dps.psx.com.pk/`: KSE-100 and other indices
- `https://dps.psx.com.pk/screener`: all stocks: price, P/E, dividend yield, index membership (KMI All Share = Shariah)
- `https://dps.psx.com.pk/company/<SYMBOL>`: live quote, 52-week range, "as of" time, announcements with PDF links

The portal's JSON endpoints (`/timeseries`, `/market-watch`, `/symbols`) block scripts since 2026-09-24
unless they imitate a browser and replay an anti-bot token. **We deliberately don't**, and that is also
why the `psxdata` library is not used.

If PSX changes its layout:
1. The app keeps showing the last good prices with their "as of" time, marked stale during market hours.
2. Users get one "PSX data unavailable" notice per day (not per run).
3. `worker_runs` rows in Supabase show `ok = false` with the errors.
4. Fix: run `npx tsx scripts/capture-fixture.ts` to see what parses, update the selectors in
   `worker/feed.ts`, refresh the saved pages (`worker/fixtures/`) and run `npm test`.
5. If the HTML pages also get blocked, stop. Do not add browser impersonation; look for an
   official or licensed source instead.

## Setup (one time)

### 1. Supabase (database + login)
1. Create a free project at supabase.com.
2. SQL Editor → run `supabase/migrations/0001_schema.sql`, then `0002_worker_columns.sql`.
3. SQL Editor → run `supabase/tests/rls_test.sql`. Expect "RLS test passed".
4. Authentication → URL Configuration → **Site URL** = your app URL (e.g. `https://psx-assistant.pages.dev`)
   and add it under Redirect URLs. Confirmation and password-reset emails link there.
5. Create your account in the app (or Authentication → Users → Add user), then in SQL Editor:
   `select public.seed_owner_portfolio('you@example.com');`

### 2. Keys
- Web Push: `npm run vapid` (once). Writes the public key to `.env` and the private key to
  `.secrets/github-secrets.txt`. Never regenerate it: that breaks every phone's subscription.
- Telegram (optional backup): message [@BotFather](https://t.me/BotFather), `/newbot`, keep the token.
- Gemini (optional): free key from aistudio.google.com. Only rewords the weekly summary; numbers
  never change (the reworded text is rejected if any number differs).

### 3. GitHub (the worker)
Public repository (free scheduled runs). Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API keys → service_role / secret key. **Only here, never in the app or repo.** |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | from `.secrets/github-secrets.txt` |
| `TELEGRAM_BOT_TOKEN` | from BotFather (optional) |
| `GEMINI_API_KEY` | optional |

| Variable | Value |
| --- | --- |
| `APP_URL` | your app URL, used in Telegram links and as the VAPID contact |
| `TELEGRAM_BOT` | bot username without `@` (turns on the Telegram link workflow) |

### 4. The app
`.env` (not committed) holds the public values bundled into the app:
`VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (publishable/anon key), `VITE_VAPID_PUBLIC_KEY`, `VITE_TELEGRAM_BOT`.

```
npm install
npm run deploy       # builds dist/ and uploads it with wrangler (first time: npx wrangler login)
```

Hosting is Cloudflare Workers static assets (Cloudflare folded Pages into Workers), configured in
`wrangler.jsonc`: no server code, just the built files. Static asset requests are free and unlimited
on the Workers Free plan. Live at https://psx-assistant.psx-assistant.workers.dev.
`public/_headers` keeps `sw.js` and `index.html` uncached so phones pick up new versions.

## Install on your phone
- **iPhone (iOS 16.4+):** open the site in **Safari** → Share → **Add to Home Screen** → open the
  installed app → Settings → **Enable notifications**. iOS only shows the permission prompt after a tap,
  and only inside the installed app. Link Telegram too, as a backup.
- **Android:** open in Chrome → **Install** (or menu → Add to Home screen) → Settings → Enable notifications.

## Running things by hand
- GitHub → Actions → **PSX worker** → Run workflow → pick a job. `test` + your email sends a test
  crash alert to your phone (enable notifications first).
- Locally, without the database: `npm run worker -- midday --dry-run` fetches live PSX data, runs the
  rules on the seed portfolio and prints what would be sent. Add `--now 2026-10-05T07:30:00Z` to replay a time.
- Tests: `npm test` (rules incl. the section 9 acceptance test, parsers on saved PSX pages, jobs, Telegram linking).
- App with demo data: `npm run dev`, then open `http://localhost:5173/?demo=1`.

## Free-tier notes (checked 2026-10-06; terms change, so re-check)
- **Supabase Free:** $0, 500 MB database, paused after 1 week of inactivity. The worker writes a
  `worker_runs` heartbeat every weekday run, which keeps it awake.
- **GitHub Actions:** free for public repos. Scheduled runs can start late; schedules are disabled after
  60 days without repo activity. The Sunday run commits `.github/keepalive` after 40 quiet days.
  If a schedule is ever disabled, Actions → the workflow → **Enable workflow**.
- **Supabase built-in email** is rate limited (a few per hour). Fine for you and a few friends.
- If any service starts asking for payment, stop and decide before continuing.

## Security
- Row-level security on every table: each user sees only their own portfolio, settings, alerts and plans.
  Market tables are read-only for signed-in users; anonymous visitors see nothing.
- Users can't set their own Telegram chat ID (only the worker can, after a valid one-time code).
- The service-role key exists only in GitHub Actions secrets. The app uses the publishable key.
