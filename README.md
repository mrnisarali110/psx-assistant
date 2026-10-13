# PSX Personal Investing Assistant

A free, installable phone app (PWA) for iPhone and Android. A scheduled worker checks the Pakistan
Stock Exchange every 30 minutes while it trades, sends actionable alerts to your locked phone, and a
digest at 9 PM. Two free AIs (Groq + Google Gemini) read company filings, suggest what to do with each
holding, and find undervalued and dividend stocks. **It never trades and never asks for broker logins.
You place orders yourself. Not licensed financial advice.**

Running cost: Rs 0 (free tiers of Supabase, GitHub Actions, Cloudflare Workers, Groq, Gemini, Telegram).

## How it works

```
 PSX data portal ──(cron)──▶ worker (GitHub Actions) ──▶ Supabase (prices, filings, dividends, AI, alerts)
 (public HTML pages)              │   ▲                              ▲
                                  │   └─ Groq / Gemini (AI)          │ reads (row-level security)
                                  ├──▶ Web Push ──▶ phone            │
                                  └──▶ Telegram ──▶ phone      PWA (React) on Cloudflare Workers
                                                               + /api/import (screenshot reader)
```

| Folder | What |
| --- | --- |
| `shared/` | Pure logic used by app and worker: portfolio + per-holding calls (`portfolio.ts`), transactions + screenshot diff (`changes.ts`), Discover screens and dividends (`discover.ts`), alerts and delivery (`signals.ts`), wealth projection (`growth.ts`), AI router (`llm.ts`), `rules.json`. Tested. |
| `worker/` | PSX feed (HTML parsing), jobs, AI tasks with guardrails (`ai.ts`), Supabase store, Web Push + Telegram. |
| `edge/` | Cloudflare Worker: serves the app, plus `POST /api/import` (reads broker screenshots with AI; never stores them). |
| `src/` | The app: Home, Portfolio, Discover, News, Profile. Hash routes like `/#/discover`. |
| `supabase/` | SQL migrations (applied automatically) and the privacy (RLS) test. |
| `.github/workflows/` | `worker.yml` (schedule), `telegram.yml` (link polling), `migrate.yml` (DB migrations), `ci.yml` (tests + build). |

## The app

- **Home:** Buy / Hold / Wait for today (the AI's stance when fresh, never "Buy" on a rally day), portfolio
  value, invested this month vs your monthly SIP, story-style circles per holding (ring = today's move),
  allocation donut (biggest slice red), rebalance tips, AI Assistant suggestions, KSE-100, wealth growth.
- **Portfolio:** each holding shows a call: *Hold*, *Buy more* (average down) or *Opportunity*, from how far
  the price is below **your last buy**, or *Trim* / *Review*. The AI can refine calls but never against your
  own rules (hold-no-add, review, cap, Shariah). Swipe left: edit / remove (with Undo). Swipe right: record a
  buy. Long-press: menu. Tap: details. Camera button: **update from JS InvestPro screenshots** (AI reads
  symbol, quantity, average cost; you review every change; screenshots are never stored).
- **Discover:** *Undervalued* (P/E well below sector, still paying dividends), *Dividends* (yield, yearly
  dividend per share, last declared amount, how often they pay), *Upcoming* (declared dividends with the last
  day to buy = book closure minus 3 working days, an estimate; confirm with your broker).
- **News:** company filings grouped by day, AI summaries with figures checked against the PDF, and your alert history.
- **Profile:** System / Light / Dark, monthly investment, crash fund, your rules, notifications, Telegram, AI on/off.

Gestures always have a button alternative (detail sheet buttons, `…` menu). Respects reduced motion.

## Schedule (PKT = UTC+5)

| Job | PKT | Sends |
| --- | --- | --- |
| market | every 30 min, 09:45–15:45 Mon–Thu; Fri to 16:45 | Actionable only: crash (always), dip, buying chances below your last buy, strong AI buy/trim calls, big moves. Last run before close is titled "Before close". Max 3 a day, bundled. |
| night | 21:00 Mon–Fri | One digest: close, your portfolio, company news, upcoming dividends, rebalance notes. Outside the 3-a-day limit. |
| telegram | every 20 min | Links Telegram chats. |

Crons and the job map live in `.github/workflows/worker.yml` and `worker/run.ts` (`CRON_TO_JOB`). PSX hours are
in `shared/rules.json` ([source](https://www.psx.com.pk/psx/exchange/general/trading-hours); Ramadan hours differ).
Nothing repeats: every alert has a dedupe key; buying chances repeat at most weekly per stock; quiet-hours alerts wait.

## AI (Groq + Gemini, free tiers)

`shared/llm.ts` routes each task: text (suggestions, Discover) → Groq first (`openai/gpt-oss-120b`,
`llama-3.3-70b-versatile`), Gemini as backup; PDFs → Gemini first (reads scans too), Groq gets the extracted text;
screenshots → Gemini. Overloaded models are skipped for the rest of a run; if both fail, everything else still runs.

Guardrails (`worker/ai.ts`, tests in `worker/ai.test.ts`): the AI only sees facts we compute; anything quoting a number
not in those facts, naming a stock outside your portfolio / watchlist / screen, or breaking your rules is dropped.
Filing figures are marked ✓ only when found in the PDF text. Privacy: free tiers may use inputs to improve the
providers' products; portfolio suggestions send symbols, share counts and costs (never names or emails) and are opt-in.

Live check: Actions → PSX worker → Run workflow → `aicheck` (prints every AI task; writes nothing).

## Data source (read this if prices stop updating)

No official free PSX API. The worker reads ordinary public pages with an honest User-Agent: the homepage
(indices), `/screener` (all stocks, P/E, yield, 1-year change, KMI All Share = Shariah) and `/company/<SYMBOL>`
(quote, 52-week range, filings). PSX's JSON endpoints and payouts data block scripts unless they imitate a
browser and replay an anti-bot token; **we deliberately don't**. Dividend amounts and book closures therefore come
from the AI reading the filings themselves. If PSX changes its layout: the app keeps the last good prices (marked
stale), you get one "data unavailable" notice a day, and `worker_runs` shows the errors. Fix the selectors in
`worker/feed.ts`, refresh `worker/fixtures/`, run `npm test`. If the pages get blocked too, stop; don't add browser impersonation.

## Setup and secrets

GitHub → Settings → Secrets and variables → Actions:

| Secret | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | worker database access (service key only here, never in the app) |
| `SUPABASE_DB_URL` | Session pooler URI; lets `migrate.yml` apply new migrations automatically |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push (generated once by `npm run vapid`; never regenerate) |
| `GROQ_API_KEY`, `GEMINI_API_KEY` | AI (either works alone; both is best) |
| `TELEGRAM_BOT_TOKEN` | optional Telegram backup |

Variables: `APP_URL`, `TELEGRAM_BOT` (bot username; turns on the Telegram workflow).

Cloudflare Worker secrets (screenshot import), set once: `npx wrangler secret put GEMINI_API_KEY` (and `GROQ_API_KEY`).
Public app config lives in `.env` (not committed): `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY`, `VITE_VAPID_PUBLIC_KEY`, `VITE_TELEGRAM_BOT`.

Supabase → Authentication → URL Configuration → Site URL = the app URL (for sign-up and reset emails).

## Commands

```
npm test                       # rules, AI guardrails, jobs, parsers, import endpoint
npm run dev                    # app at http://localhost:5173/?demo=1 (demo data, no account)
npm run worker -- market --dry-run --now 2026-10-13T07:30:00Z   # live PSX data, prints instead of sending
npm run deploy                 # build + deploy app and /api to Cloudflare
```

## Install on your phone
- **iPhone (iOS 16.4+):** Safari → Share → Add to Home Screen → open the installed app → Profile → Push on.
- **Android:** Chrome → Install → Profile → Push on.
- Dynamic Island / Live Activities need a native App Store app (paid Apple developer account), so this web app
  can't use them; notifications still show on the lock screen and in Notification Center.

## Free-tier notes (re-check; terms change)
- Supabase Free: 500 MB, pauses after 7 idle days; the worker's heartbeat keeps it awake.
- GitHub Actions: free for public repos; schedules pause after 60 days without commits (night run commits a keep-alive).
- Cloudflare Workers Free: static files free and unlimited; `/api/import` uses a tiny share of 100k requests/day.
- Groq / Gemini free tiers: daily limits shown in their consoles; the worker uses a handful of calls per run.
