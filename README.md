# PSX Personal Investing Assistant

A free, installable phone app (PWA) for iPhone and Android. A scheduled worker checks the Pakistan
Stock Exchange every 30 minutes while it trades, sends actionable alerts to your locked phone, and a
digest at 9 PM. Three free AI services (Groq, Google Gemini, OpenRouter) read company filings and broker
screenshots, suggest what to do with each holding, and find undervalued and dividend stocks. **It never trades and never asks for broker logins.
You place orders yourself. Not licensed financial advice.**

Running cost: Rs 0 (free tiers of Supabase, GitHub Actions, Cloudflare Workers, Groq, Gemini, OpenRouter, Telegram).

## How it works

```
 PSX data portal ──(cron)──▶ worker (GitHub Actions) ──▶ Supabase (prices, filings, dividends, AI, alerts)
 (public HTML pages)              │   ▲                              ▲
                                  │   └─ Groq / Gemini / OpenRouter  │ reads (row-level security)
                                  ├──▶ Web Push ──▶ phone            │
                                  └──▶ Telegram ──▶ phone      PWA (React) on Cloudflare Workers
                                                               + /api/import (screenshot reader)
```

| Folder | What |
| --- | --- |
| `shared/` | Pure logic used by app and worker: portfolio, caps and sell/trim/review rules (`portfolio.ts`), transactions + screenshot diff (`changes.ts`), Discover screens and dividends (`discover.ts`), data trust (`quality.ts`), PSX symbol markers (`symbols.ts`), trading costs (`costs.ts`), FIFO lots, CGT ledger and Sell Planner (`tax.ts`), total return, XIRR, KSE-100 benchmark and dividends (`performance.ts`), trading days, buy-by dates, "this week" and filing-date sanity (`calendar.ts`), CSV import (`transactions-csv.ts`), alerts and delivery (`signals.ts`), wealth projection (`growth.ts`), AI router (`llm.ts`), `rules.json` (every rate and threshold). Tested. |
| `worker/` | PSX feed (HTML parsing), jobs, AI tasks with guardrails (`ai.ts`), Supabase store, Web Push + Telegram. |
| `edge/` | Cloudflare Worker: serves the app, plus `POST /api/import` (reads broker screenshots with AI; never stores them) and `GET /api/ai-status` (which AI keys are ready; free checks). |
| `src/` | The app: Home, Portfolio, Discover, News, Profile. Hash routes like `/#/discover`. |
| `supabase/` | SQL migrations (applied automatically) and the privacy (RLS) test. |
| `.github/workflows/` | `worker.yml` (schedule), `telegram.yml` (link polling), `migrate.yml` (DB migrations), `ci.yml` (tests + build). |

## The app

Home = what to do today. Portfolio = what I own and how it is doing. Discover = what to look at. News = what
happened. Profile = settings, rules, broker and tax. Anything you look at once a month is one tap deep.

- **Home:** one of three clear states for today: **Add** (with how much is left this month and what may take it),
  **Hold** (nothing to do) or **Review** (one of your rules is broken), never "Hold" with a buy suggestion. The
  portfolio card shows value, **total return with dividends**, today's move and **vs KSE-100** (what the same money in
  the index would have done, from the daily closes the worker keeps); tap it for Performance. Story-style circles per
  holding (ring = today's move). **Needs attention** appears only when a rule is broken: a stock over its cap, a sector
  over its cap, a Trim trigger, a thesis review due. **This week**: results dates, board meetings, book closures and
  last days to buy for your holdings and watchlist in the next 7 days. Then AI Assistant suggestions and KSE-100.
- **Portfolio:** four views. *Holdings*: each holding shows a call: *Hold*, *Buy more* (average down) or
  *Opportunity*, from how far the price is below **your last buy**, or *Trim* (over the per-stock cap, target price
  reached, P/E running far ahead of its sector, a dividend cut: each a setting) or *Review* (status, or the review date
  of your thesis arrived). The AI can refine calls but never against your own rules (hold-no-add, review, stock and
  sector caps, Shariah, trim). Swipe left: edit / remove (with Undo). Swipe right: record a buy, with an **order ticket**
  (commission, sales tax, exchange fees, all-in cost per share, round-trip cost and a cheap-share warning). Long-press:
  menu. Tap: details, with "Why I own it", the review date and the target price. Camera button: **update from JS
  InvestPro screenshots** (tick every change; set the trade date; screenshots are never stored). "Buys and sells": the
  full transaction log, editable, with **CSV import** (template provided) and export. *Allocation*: sector donut and
  per-stock bars against your caps. *Performance*: total return with dividends, XIRR, your money against the KSE-100
  over time, dividends expected (declared for shares you held at book closure) and received (net of withholding tax).
  *Tax*: the tax-year ledger (realized gains, losses, net, carry-forward, estimated capital gains tax, what NCCPL has
  deducted, what is still due or refundable) and the **Sell Planner** (also under "Sell" and in each holding's menu):
  tick what you would sell and see the FIFO gain per stock, this year's tax after it, the cash NCCPL takes next month,
  and which losing holdings already marked Review or Trim would cut it. Estimates from your own log; not tax advice.
- **Discover:** *Undervalued* (P/E well below sector, still paying dividends; a P/E under 2 or over 100 is a quirk
  of the figures, not a bargain, and is left out), *Dividends* (yield, yearly dividend per share, last declared amount,
  how often they pay; a yield built on a one-off special payout is ranked on the regular payout, with the special shown),
  *Upcoming* (declared dividends with the last day to buy = book closure minus 2 working days under T+1 settlement,
  skipping weekends and PSX holidays, an estimate; confirm with your broker). Filters: hide loss-making, hide special
  dividends, Shariah only. Quality chips: payout above 100% of profit, loss-making, special dividend, "check figures".
  One row per company (PSX's XD/XB/XR spellings are merged and shown as a badge). "0" from PSX is shown as n/a, never
  as a value. An AI sentence is shown only while every number in it matches the card beside it. Every list is ranked
  strongest first with sort chips; "AI picks first" is one option, not the default.
- **News:** company filings grouped by day, AI summaries with figures checked against the PDF (and flagged when the
  dates inside do not fit the filing date), a **My week** list, and your alert history.
- **Profile:** appearance; money (monthly investment, yearly increase, crash fund, crash level, **Goals & projection**);
  your rules (max per stock, **max per sector**, opportunity alert, Shariah only, **trim rules**); **Broker & tax**
  (broker, commission %, minimum per share, sales tax on commission, filer / non-filer, match NCCPL statement, CGT
  deducted this tax year, losses carried forward); notifications; Telegram; AI on/off.
  **Data → Refresh latest** runs the whole system now on the server (PSX prices and screen, company pages, filings
  read by the AI, fresh AI suggestions and Discover picks, a blue-chip recheck of your own stocks), follows the run
  and reloads when it finishes (usually 3 to 8 minutes). At most one every 10 minutes; it never sends notifications.
  It needs `GITHUB_DISPATCH_TOKEN` on the Worker (see Schedule); without it the button says so.

**On a computer** (1024 px and wider) the app becomes a web layout: a sidebar instead of the bottom tabs, Home and
Profile in two columns, Portfolio/Discover/News as grids, and sheets open as centred dialogs. Phones are unchanged.

Gestures always have a button alternative (detail sheet buttons, `…` menu). Respects reduced motion.

## Schedule (PKT = UTC+5)

| Job | PKT | Sends |
| --- | --- | --- |
| market | every 30 min, 09:45–15:45 Mon–Thu; Fri to 16:45 | Actionable only: crash (always), dip, buying chances below your last buy, strong AI buy/trim calls, big moves. Last run before close is titled "Before close". Max 3 a day, bundled. |
| night | 21:00 Mon–Fri | One digest: close, your portfolio, company news, upcoming dividends, rebalance notes, bull market ON/OFF and State Bank rate changes. Outside the 3-a-day limit. |
| telegram | every 20 min | Links Telegram chats. |
| refresh | on demand (Profile → Refresh latest) | Nothing: runs the night job's work now, no notifications. |

**Who rings the bell:** GitHub's own cron is unreliable for this cadence (runs hours late or not at all), so the
Cloudflare Worker carries the schedule (`triggers.crons` in `wrangler.jsonc`, UTC) and each tick starts the GitHub job
through the API (`workflow_dispatch`). That needs one secret on the Worker: a fine-grained GitHub token for this repo
with **Actions: Read and write** (github.com → Settings → Developer settings → Fine-grained tokens), stored with
`npx wrangler secret put GITHUB_DISPATCH_TOKEN`. Tokens expire (a year at most): make a new one before then. GitHub's
cron stays in `worker.yml` as a fallback; a job that finished fine within the last 20 minutes (night: 6 hours) skips
a duplicate tick, so the two never double up. Market ticks start the job only while PSX trades, plus 20 minutes
after the close for closing prices. The job map lives in `worker/run.ts` (`CRON_TO_JOB`). PSX hours are
in `shared/rules.json` ([source](https://www.psx.com.pk/psx/exchange/general/trading-hours); Ramadan hours differ).
Nothing repeats: every alert has a dedupe key; buying chances repeat at most weekly per stock; quiet-hours alerts wait.
The app itself reloads every 5 minutes while it is open during trading hours, and on every reopen or pull-down.

## AI (Groq + Gemini + OpenRouter, free tiers)

`shared/llm.ts` routes each task: text (suggestions, Discover) → Groq first (`openai/gpt-oss-120b`,
`llama-3.3-70b-versatile`), then Gemini, then OpenRouter; PDFs → Gemini first (reads scans too), the others get the
extracted text; screenshots → OpenRouter first (free vision models), Gemini as backup. OpenRouter's free models come
and go, so the public model list (a free call, cached 6 h) decides which exist; `OPENROUTER_MODELS` can pin a list.

Being frugal with free tiers: a model that answers 429 (limit) or 503 (busy) goes on a cooldown, until its limit
resets for daily quotas, so later calls skip it without spending a request. `npm run worker -- aistatus` (or Actions →
PSX worker → `aistatus`) checks every key with a free list-models / key-info call and prints who is ready or cooling;
the app does the same check through `/api/ai-status` when the screenshot sheet opens. No test prompts are ever sent.
If every provider fails, everything else still runs.

Guardrails (`worker/ai.ts`, tests in `worker/ai.test.ts`): the AI only sees facts we compute; anything quoting a number
not in those facts, naming a stock outside your portfolio / watchlist / screen, or breaking your rules is dropped.
Filing figures are marked ✓ only when found in the PDF text. Privacy: free tiers may use inputs to improve the
providers' products; portfolio suggestions send symbols, share counts and costs (never names or emails) and are opt-in.

Live check: Actions → PSX worker → Run workflow → `aicheck` (prints every AI task; writes nothing).

## Costs, tax and performance (every rate is a setting)

Defaults live in `shared/rules.json` and are editable under Profile → Broker & tax; nothing is a constant in code.
Researched 2026-10-15; items marked VERIFY need one real document to confirm.

| What | Default | Source / note |
| --- | --- | --- |
| Broker commission | max(0.15% of value, Rs 0.03 per share) per side | PSX notice N-1026 minimum; JS slab matches. VERIFY on a contract note |
| Sales tax on commission | 15% | Sindh; some brokers show 13%. VERIFY |
| PSX trading fee, SECP levy, CDC | 0.0035%, 0.00065%, Rs 0.005/share | PSX notice N-1026 |
| Capital gains tax (Section 37A) | 15% filer / 15% non-filer for shares bought from 1 Jul 2025; older bands by buy date | NCCPL; non-filer rate from 1 Jul 2026 VERIFY |
| Dividend withholding (Section 150) | 15% filer / 30% non-filer; power companies 7.5% / 15%; REITs 15% / 30% | VERIFY power rate per company |
| Settlement | T+1 since 9 Feb 2026 → last day to buy = book closure − 2 working days | VERIFY once with the broker |

How the tax figure is built: FIFO lots per stock from your transaction log; gains and losses netted across every stock
within the tax year (1 July–30 June); each lot taxed at the rate of its buy-date band; losses of the year and the
carry-forward (filers, 3 years) offset the highest-rate gains first; minus what NCCPL already deducted (you enter it
from the monthly statement). "Match NCCPL statement" drops broker charges from the cost basis for reconciliation.
Performance: total return = value now + sales (net of charges) + dividends (net of withholding) − buys (including
charges); XIRR is money-weighted over the same flows; the KSE-100 benchmark puts every rupee into the index on the
day it moved (daily closes in `index_daily`, written by the worker and backfilled from the 30-minute snapshots), and
flows before the index history begins are left out of both sides and counted in the coverage note. The night job
also stores one portfolio value per trading day (`portfolio_daily`) for the chart.

## Blue-chip (BC) badge

Worked out by the night job from PSX data only (`shared/bluechip.ts`, `worker/bluechip.ts`; thresholds in
`rules.json` → `bluechip`; no ticker list anywhere, a test enforces it). All five must pass:

| Check | Data used |
| --- | --- |
| Big company | KSE-30 membership from the screener's "listed in", or top 30 by market cap |
| Easy to trade | PSX's 30-day average volume × price ≥ Rs 50M/day (PSX publishes no 60-day daily series on a page we can read) |
| Profitable for years | Profit after tax > 0 in each of the last 4 years (PSX's Financials table; results filings add years, consolidated preferred) |
| Pays dividends regularly | Paid in the last 12 months (PSX trailing yield > 0), and no year without a dividend among the years covered by filings read so far |
| No red flags | Traded in the last 30 days; not a defaulter (implied by KSE-30 membership); no qualified audit opinion once an annual report is read (PDF text, no AI) |

These are the relaxed defaults the owner chose on 2026-10-16 to match what PSX publishes now. The original strict rule
(5 profit years; dividends in 4 of 5 years from filings only; annual report required) is one config change away:
`profit_years: 5`, `dividend_mode: "strict"`, `require_audit_check: true`.

Anything that cannot be worked out is "not enough data": no badge, no guess. Badges are gained on the first full pass
and lost only after two failed rechecks in a row ("BC at risk" in between). Rechecks: weekly, after a results or
dividend filing, when KSE-30 members change, when the config changes, once in Sept–Oct. Every recheck is stored in
`bluechip_history`. PSX's payouts history, listing status and 5-year report pages load behind a captcha, so they are not
used; dividend and profit history therefore fill in from filings over time.

## Bull market ON/OFF and the interest rate

The KSE-100 card on Home shows **Bull market ON/OFF** with how long it has lasted and the **State Bank policy rate**;
tap it for the charts, the reasons and where spare cash could go. Every threshold is in `shared/rules.json` (`regime`).

- **ON** when the KSE-100 is up 20% on a year (PSX's own 1-year change of the index stocks, weighted by market cap,
  from the screener) or 20% above its 12-month low, and not below its 200-day average. **OFF** after a 20% fall from
  the 12-month high, or below the average with the year negative. In between it keeps its last state (no flicker).
  The average and the high/low use the KSE-100 closes the worker stores each trading day (PSX publishes no index
  history on a page we read honestly), so they switch on once 120 days are stored; until then the 1-year change leads.
- **Interest rate:** the State Bank's own [rate history PDF](https://www.sbp.org.pk/assets/document/OVR-Repo-History.pdf)
  (every decision since 1991, read by position because its text scrambles the columns) plus the rate box and latest
  meeting on [sbp.org.pk](https://www.sbp.org.pk/). Cycle: easing after a cut, tightening after a hike, on hold after
  9 months without a change. Before 25 May 2015 the reverse repo rate was the policy rate (SBP's footnote).
- **Where spare cash could go** (a rule of thumb, never advice; your SIP and crash fund stay as they are): bull ON and
  stocks out-earn the policy rate (market-cap-weighted earnings yield of the KSE-100 stocks) → shares 60 / equity
  funds 20 / money market 20; bull ON but stocks earn less → 40/20/40; bull OFF → 15/10/75, or 40/20/40 while rates
  are being cut. Savings and money-market returns are **VERIFY** estimates: SBP's minimum savings profit is 0.5%
  below its repo floor ([BPRD Circular 07 of 2013](https://www.sbp.org.pk/bprd/2013/c7.htm)), i.e. policy − 1.5%;
  money-market funds about policy − 0.75%, before fees and tax.
- **Checked every night** (and by Refresh latest): the night job reads SBP, saves `policy_rates`, saves one
  `market_regime` row per trading day, and puts **Bull market ON/OFF** or **State Bank cut/raised the rate** in the
  night digest when either changes (once each).

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
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | AI (any one works alone; all three is best; OpenRouter or Gemini needed for screenshots) |
| `TELEGRAM_BOT_TOKEN` | optional Telegram backup |

Variables: `APP_URL`, `TELEGRAM_BOT` (bot username; turns on the Telegram workflow).

Cloudflare Worker secrets, set once: `npx wrangler secret put OPENROUTER_API_KEY` and `GEMINI_API_KEY` (screenshot
import), `GITHUB_DISPATCH_TOKEN` (the schedule, see above).
Public app config lives in `.env` (not committed): `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY`, `VITE_VAPID_PUBLIC_KEY`, `VITE_TELEGRAM_BOT`.

Supabase → Authentication → URL Configuration → Site URL = the app URL (for sign-up and reset emails).

## Commands

```
npm test                       # rules, costs, tax, performance, calendar, quality, symbols, CSV, AI guardrails, jobs, parsers
npm run dev                    # app at http://localhost:5173/?demo=1 (demo data, no account)
npm run worker -- market --dry-run --now 2026-10-13T07:30:00Z   # live PSX data, prints instead of sending
npm run worker -- aistatus     # which AI keys are ready / cooling down (free checks, no tokens)
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
- Groq / Gemini / OpenRouter free tiers: daily limits shown in their consoles; the worker uses a handful of calls per
  run. OpenRouter's free tier allows about 50 requests a day (more after a one-off $10 credit purchase), so it reads
  screenshots first and is the last resort for text.
