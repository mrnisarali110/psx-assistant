# PSX Assistant — Work Handoff

_Last updated: 2026-10-18 (evening PKT). Read this first in a new chat. `README.md` describes the product, every
rule and the data sources in full; this file is about state, open items and how to work on it._

## Where everything is

- **App:** https://app.psxasst.workers.dev — Cloudflare Worker `app` (account subdomain `psxasst`). Serves the PWA,
  `/api/import` (screenshot reading), `/api/ai-status`, `/api/refresh` (Refresh latest) and the cron schedule.
  Deploy with `npm run deploy` (wrangler is logged in on this PC). Logs: `npx wrangler tail app --format json`.
- **Repo:** https://github.com/mrnisarali110/psx-assistant (public: Actions logs are public, so never print stock
  symbols or messages; `publicErrors` in `worker/jobs.ts` enforces it).
- **Database:** Supabase project `tqggelxnrymytxmxftqn`. Migrations apply on push (`migrate.yml`); latest is
  `0011_market_compass.sql` (applied 2026-10-18).
- **Worker jobs:** GitHub Actions `worker.yml`, input `job` = market | night | refresh | test | telegram | aicheck |
  aistatus | diag. Also `ci.yml`, `migrate.yml`, `telegram.yml`.
- **Schedule:** the Cloudflare Worker's crons (`wrangler.jsonc`) start the GitHub jobs through `workflow_dispatch`.
  GitHub's own cron in `worker.yml` stays as a fallback; a repeat guard stops double runs.
- **Secrets (names only; values never go through chat, the owner runs the commands himself):**
  - GitHub: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
    `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`; variables `APP_URL`, `TELEGRAM_BOT`.
  - Worker: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, **`GITHUB_DISPATCH_TOKEN` (set by the owner 2026-10-18; a
    fine-grained token, repo psx-assistant, Actions read/write; it expires, renew before its date)**.
- **Owner:** Nisar. iPhone PWA plus desktop browser; broker JS InvestPro (JS Global); quiet hours 02:00–12:00.
  Claude in Chrome is installed, so the signed-in live app can be checked directly.

## State right now (all green)

- **Live:** commit on `main` after `7255b46` (this handoff), Worker version `36cf603b`, 395 tests, typecheck clean,
  CI green, migrations green. Refresh latest verified live twice on 2026-10-18 (workflow_dispatch runs succeeded).
- **Market Compass live reading (2026-10-18, for Friday's close):** value Fair (P/E 8.2x), shares vs bonds "Bonds pay
  more" (−0.7 pts vs 10-year PIB 12.85%), trend Sideways (KSE-100 +1.2% on a year), policy 11.5% tightening, CPI
  10.3% (Sep), real rate +1.2%; advice "Safe yield pays more: park extra cash", SIP stays on.

### What was built since the 2026-10-15 handoff
1. **Owner's review list (2026-10-15/16):** Sell Planner average-cost basis; Trim always has a rule and a reason
   (two signals); one return figure; hard stock/sector caps and loss-quarter rules; **Buy more is the owner's rule**
   with a P/E value check and a reason; the AI may not set Buy more / Trim / Review and its lines must follow the
   rules (`portfolio.aiLineAllowed`); News date fixes; Discover fixes.
2. **Blue-chip (BC) badge** from real PSX data only (`shared/bluechip.ts`, `worker/bluechip.ts`, migration 0009):
   five checks, history, checklist sheet; relaxed defaults (profit 4 of 4 years from PSX Financials, dividends
   `available`, audit check optional). Splash screen and app-wide motion (`src/components/motion.ts`, `Splash.tsx`).
3. **Refresh latest** (Profile → Data): `/api/refresh` → job `refresh` (night pipeline, BC recheck forced for your
   stocks, no notifications; one per 10 minutes). Weekend runs store market readings for the last trading day.
4. **Desktop web layout** (≥1024 px): sidebar nav (Home, Market, Portfolio, Discover, News, Profile), Home as a
   12-column dashboard (money left; Market card + AI right), one-column News feed, equal-height Discover cards,
   Portfolio tabs side by side, centred sheets, `2xl` wider pages. Phones unchanged (bottom tabs).
5. **Market Compass** (replaces the first "Bull market ON/OFF" version; research by three agents: Pakistani research
   houses, global advisors, honest data sources):
   - `shared/compass.ts`: three separate lights — **Value** (KSE-100 P/E vs ~8.5x long-run average; cheap < 6.5x,
     expensive > 10.5x), **Shares vs safe yield** (earnings yield minus 10-year PIB), **Trend** (Up / Sideways /
     Down) — plus one **action for extra money only**: add extra / buy in steps / stick to plan / park extra.
     Thresholds in `rules.json` `compass` and `regime`; research-based numbers marked VERIFY.
   - `worker/macro.ts`: SBP T-bill and PIB auction PDFs, FX reserves, PKR/USD (M2M), KIBOR; PBS monthly CPI PDF;
     PSX home page KSE-100 1-year/YTD. `worker/sbp.ts`: SBP policy-rate history PDF (read by x-position).
   - Stored in `macro_readings` and `market_regime` (one row per trading day, compass columns); alerts
     `market_compass`, `market_trend`, `policy_rate` in the night digest, link `#/market`.
   - App: Market card on Home, **Market page** `#/market` (Compass, Value gauge, Shares vs safe yield bars, Trend
     chart + periods, Where spare cash could go, Pakistan at a glance, Rates & inflation with rate chart/cycles).

## Open items for the owner

1. **VERIFY the researched rates** against one real document each and change the setting if different: JS
   commission and minimum, sales tax 13% vs 15%, non-filer CGT from 1 Jul 2026, whether NCCPL's cost basis includes
   commission, power-company dividend WHT 7.5%, the T+1 last-day-to-buy rule. Compass numbers marked "to verify":
   P/E long-run average and bands, the PIB spread average, savings and money-market estimates.
2. **Older buys and real trade dates** (optional): until the Buys and sells log explains every holding, Performance
   shows average-cost P/L only and Tax/Sell Planner gains are incomplete.
3. **CGT deducted so far and carry-forward losses** (Profile → Broker & tax) from the NCCPL statement.
4. **Renew `GITHUB_DISPATCH_TOKEN`** before it expires (date chosen when it was made).

## Pending on Claude's side

- **Confirm the Cloudflare schedule end to end on Monday 2026-10-19:** market ticks from 09:45 PKT should appear
  in Actions as `workflow_dispatch` runs (`gh run list --workflow worker.yml`); the 21:00 night run should log a
  `market:` line and send the digest.
- **Phone check** of the new Market card and Market page on the owner's iPhone (checked at 375 px in the desktop
  browser, demo and live desktop only). After a deploy the PWA may need one reopen to pick up the new version.
- **Data that only builds over time:** the 200-day average starts after 120 stored closes (9 so far); the PKR 30-day
  change and FX 4-week change fill in as daily/weekly readings accumulate; trend periods count from Oct 16.
- **SBP home page** shows a Cloudflare bot check to the worker; it is reported plainly in run errors and never
  bypassed. The history PDF already lists every rate change, so nothing is lost.
- Earlier, not blocking: normalise stored sectors in the worker; measure a 4-screenshot import's CPU time; token
  expiry reminder in the `diag` job; retire the GitHub cron fallback once the Cloudflare schedule is proven; monthly
  `aicheck` (next mid-November 2026); Ramadan trading hours.

## Known gaps (deliberate)

- **Not shown because the sources are bot-checked:** mutual fund returns (MUFAP), foreign/local flows (NCCPL), PSX
  sector summary and long KSE-100 history (XHR-gated). The app says so; nothing is spoofed.
- ROE and net debt are not in PSX's screener, so not shown. Dividend receipts are confirmed by the user; contract-note
  reading is not built. The KSE-100 benchmark starts at the first stored close (early Oct 2026).
- Compass P/E is trailing (from PSX's screener) while the research averages are forward P/E: expect about a turn of
  difference; it is labelled.

## Feature backlog

- Contract-note / NCCPL-statement PDF reading (charges, CGT deducted, dividend credits).
- Compass: own valuation percentile once a year of daily P/E is stored; month-end trend check (two closes below
  the average) to cut whipsaws; rebalancing bands for the spare-cash split (check every 6–12 months, act on a 5-point
  drift).
- Discover: symbol search; when the Compass says park/expensive, put dividend payers and blue chips first.
- Token/key expiry reminders; night-digest line on sector concentration.

## How to work on this (lessons that cost a day)

1. **Edge code runs in Cloudflare Workers, not Node.** Test under workerd (`npx wrangler dev --local`; cron:
   `--test-scheduled`).
2. **Never write third-party model or API names from memory.** Check the live list; prove with `aicheck`/`aistatus`.
3. **Keys never go through chat.** The owner runs `npx wrangler secret put NAME` and `gh secret set NAME`.
4. **Public logs:** no symbols or messages in Actions output.
5. **Every rate is a setting** (defaults in `shared/rules.json`); researched facts stay VERIFY until a real document
   confirms them; estimates say so in the UI.
6. **Never bypass bot checks.** Honest User-Agent only. SBP `/assets/document/*` files work with Node fetch, SBP HTML
   pages do not; a missing SBP file answers HTTP 200 with an HTML page, so check content-type and `%PDF`.
7. **Home stays clean**: the owner approves anything new on Home (the Market card was his request).
8. **UI work:** use the `ui-ux-pro-max` skill, then check at 375 px and 1440 px (`npm run dev` →
   `http://localhost:5173/?demo=1#/home`); when agents share the preview, each uses its own tab.
9. **Long builds:** show "N of M done" and use parallel agents on non-overlapping files.
10. **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push triggers CI and migrations;
    `npm run deploy` publishes the Worker and app; `gh workflow run worker.yml -f job=refresh` runs a live refresh.

## Commands

```
npm test                       # all suites (395)
npm run typecheck
npm run dev                    # http://localhost:5173/?demo=1
npm run worker -- night --dry-run   # live PSX/SBP/PBS data, seed portfolio in memory, prints alerts
npm run deploy                 # build + deploy Worker and app
npx wrangler tail app --format json
gh workflow run worker.yml -f job=market|night|refresh|aicheck|aistatus|diag
gh run list --workflow worker.yml --limit 5
```

## Key files

- Shared logic: `shared/compass.ts`, `regime.ts`, `portfolio.ts`, `bluechip.ts`, `performance.ts`, `tax.ts`,
  `costs.ts`, `calendar.ts`, `quality.ts`, `discover.ts`, `signals.ts`, `rules.json` (all defaults and notes).
- Worker: `worker/jobs.ts` (pipeline, `updateMarket`, alerts), `macro.ts`, `sbp.ts`, `bluechip.ts`, `feed.ts`,
  `ai.ts`, `store.ts`, `run.ts`. Edge: `edge/index.ts`.
- App: `src/App.tsx` (routes, sidebar, desktop widths), `src/screens/*` (Home, Market, Portfolio, Discover, News,
  Profile), `src/components/MarketMood.tsx` (Market card and page), `RefreshLatest.tsx`, `src/lib/data.ts`.
