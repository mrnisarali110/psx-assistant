# PSX Assistant — Work Handoff

_Last updated: 2026-10-15 (evening PKT). Read this first in a new chat; `README.md` describes the product and the
architecture in full. This file is about state, open issues and what to build next._

## Where everything is

- **App:** https://app.psxasst.workers.dev — Cloudflare Worker `app` (account subdomain `psxasst`; `psx` was taken).
  Deploy with `npm run deploy` (wrangler is logged in on this PC). Logs: `npx wrangler tail app --format json`.
- **Repo:** https://github.com/mrnisarali110/psx-assistant (public; Actions logs are public → never print symbols or messages).
- **Database:** Supabase project `tqggelxnrymytxmxftqn`; Site URL points at the app. Migrations apply on push
  (`migrate.yml`); latest is `0006_costs_tax_performance.sql` (new tables `dividend_receipts`, `index_daily`,
  `portfolio_daily`; new columns on `settings`, `holdings`, `transactions`, `announcements`, `prices`, `market_screen`).
- **Scheduled work:** GitHub Actions `worker.yml` (jobs: market, night, test, telegram, aicheck, aistatus, diag),
  `telegram.yml`, `migrate.yml`, `ci.yml`. The Cloudflare Worker carries the real schedule (see issue 1).
- **Secrets (names only; values are never pasted in chat — the owner runs the commands himself):**
  - GitHub: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
    `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`; variables `APP_URL`, `TELEGRAM_BOT`.
  - Worker: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`. **Missing: `GITHUB_DISPATCH_TOKEN`** (issue 1).
- **Owner:** Nisar. iPhone, app installed as a PWA, broker JS InvestPro (JS Global), quiet hours 02:00–12:00.
- **The brief this build came from:** `psx-assistant-issues-and-features.md` (owner's Downloads, 2026-10-15):
  10 issues (ISSUE-01..10) and 11 features (FEATURE-01..11) with acceptance criteria. All of it is implemented
  except where noted under "Known gaps".

## State right now

Build of 2026-10-15 (see git log for the commit): tests green, typecheck clean, CI green. What changed:

- **Data trust (ISSUE-01/02/03/04/05/06/07/10):** PSX's XD/XB/XR spellings are merged into one row per company
  (`shared/symbols.ts`, applied in the worker feed and the app data layer; the marker shows as a badge). A P/E
  under 2 or over 100 is an outlier: out of Undervalued and the sector medians, flagged "check figures" elsewhere.
  0 / blank is "n/a", never a value. Dividend lists rank on the regular payout when a special is in the trailing
  yield; frequency says "not enough history" under 2 filings. An AI sentence is shown only while its numbers match
  the card (`quality.aiTextMatches`). Filing dates far from the publish date drop the book closure and flag the
  summary "Older document" / "Date unclear" (`calendar.dateVerdict`, stored in `announcements.ai_date_note`).
  Buy-by = book closure − 2 trading days (T+1), skipping weekends and `rules.psx_holidays` plus the index's
  own trading days.
- **Costs and tax (FEATURE-08/10):** `shared/costs.ts` (per-side charges, order ticket, cheap-share warning),
  `shared/tax.ts` (FIFO lots, tax-year ledger, CGT bands by buy date, carry-forward, Sell Planner, offset
  suggestions). Settings: Profile → Broker & tax. UI: Portfolio → Tax tab, Sell Planner (header "Sell", holding menu
  "Plan a sale"), order ticket in "Record a buy" with an optional charges field from the contract note.
- **Performance (FEATURE-01/02, ISSUE-08):** `shared/performance.ts` (total return with dividends, XIRR, KSE-100
  benchmark from `index_daily`, expected and received dividends, value series). Portfolio → Performance tab; Home
  portfolio card shows total return and "vs KSE-100". The worker writes `index_daily` every tick (last tick after
  the close wins) and `portfolio_daily` per user in the night job; the migration backfilled `index_daily` from
  `index_snapshots` (history starts early Oct 2026, so older buys are "uncovered" in the benchmark).
- **Rules (FEATURE-03/04/05):** `settings.max_sector_pct` (default 30%) blocks new money and shows under Needs
  attention; thesis / review date / target price per holding; Trim triggers (over cap, target reached, P/E
  `trim_pe_over_sector_pct` (default 50%) above the sector median, dividend cut) and Review (date reached). Alerts:
  `trim` (market, weekly per stock) and `review_due` (digest). The AI cannot override Trim/Review.
- **Home / IA (FEATURE-07/11, ISSUE-09, §3):** Today card with three states (Add / Hold / Review), Needs
  attention, This week (`calendar.weekAhead`), Wealth growth moved to Profile → Goals & projection, sector donut
  moved to Portfolio → Allocation. News has "My week". Discover has filters and quality chips (FEATURE-06, with ROE
  and net debt left out: PSX's screener has no such fields, so they are not invented).
- **Transactions (FEATURE-09, HANDOFF issue 4):** Portfolio → Holdings → "Buys and sells": the full log, edit /
  delete / add, CSV import with a template (`shared/transactions-csv.ts`) and export. Screenshot import now asks for
  the trade date. Adding a holding defaults the Shariah toggle from PSX (KMI All Share) and the import does too.

## Issues to fix (priority order)

1. **Set `GITHUB_DISPATCH_TOKEN` on the Worker** (unchanged from before; nothing of the Cloudflare schedule has been
   seen live yet). Owner: GitHub → Settings → Developer settings → Fine-grained tokens → repo `psx-assistant` only,
   permission Actions: Read and write → `npx wrangler secret put GITHUB_DISPATCH_TOKEN`. Verify with `wrangler tail`.
2. **VERIFY the researched rates against one real document each** and change the setting if different: JS
   commission and any flat minimum (one buy + one sell contract note), sales tax 13% vs 15%, non-filer CGT from
   1 Jul 2026 (NCCPL), whether NCCPL's cost basis includes commission (toggle "Match NCCPL statement" if not), HUBC/
   KAPCO dividend WHT 7.5%, the T+1 last-day-to-buy rule (one book closure with JS). See README's table.
3. **Enter the real trade dates.** Holdings imported from screenshots are dated the import day; fix them under
   Portfolio → Holdings → Buys and sells (or import a CSV), otherwise XIRR, lots and the benchmark use wrong dates.
4. **Enter CGT deducted so far** (Profile → Broker & tax) from the NCCPL monthly statement, and any carry-forward
   losses, so Tax shows what is still due or refundable.
5. **Gemini key hygiene**, **CPU time of `/api/import`**, **stored sector text**, **OpenRouter model drift**,
   **Telegram cron**, **GitHub cron fallback**, **Ramadan hours**, **phone reinstall after the rename**: unchanged
   from the previous handoff (see git history of this file for the detail); none is blocking.

## Pending on Claude's side (not done, or done but not yet verified on the phone)

- **Phone check** of every new screen at real size: Home (Today card states, Needs attention, This week, vs KSE-100
  line), Portfolio tabs (Allocation bars, Performance chart, Tax ledger), Sell Planner, Buys and sells + CSV import,
  Profile → Broker & tax and Goals sheet, Discover filters and chips. Checked only in the desktop browser at 375 px
  on demo data and signed in.
- **First real `portfolio_daily` rows** appear after the first night job following the deploy; the Performance chart
  draws your value line only from then on (the index-equivalent and invested lines work from day one).
- **Verify the Cloudflare schedule end to end** once the token is set (issue 1).
- **Normalise stored sectors / Shariah backfill in the worker** (the app now defaults both from PSX; the worker
  backfills sectors only).
- **Measure a 4-screenshot import** CPU time; **Telegram linking on the Cloudflare schedule**; **token expiry
  reminder**; **retire the GitHub cron fallback**; **monthly `aicheck`** (next mid-November 2026): as before.

## Known gaps (deliberate)

- Quality chips show payout ratio, loss-making, 1-year trend, specials and P/E outliers; **ROE and net debt are not
  shown** because PSX's screener does not publish them and nothing is invented.
- "2 consecutive quarters of falling profit" is not a Trim trigger: there is no structured EPS history. Results
  filings do show in This week / News with AI summaries, and a review date covers the thesis check.
- Dividend receipts are confirmed by the user (one tap on an expected dividend) rather than read from credit
  advices; "Paste contract note / upload PDF" to auto-fill charges is not built (the charges field is manual).
- The benchmark cannot cover flows before the first `index_daily` row (early Oct 2026); it says so.

## Feature backlog

- Contract-note / NCCPL-statement PDF reading to fill charges, CGT deducted and dividend credits.
- Per-stock price targets delivered as alerts (the target price is a Trim trigger today; a push on reaching it is
  the `trim` alert).
- Discover: symbol search and "add to watchlist" from search; a "yours" filter.
- Night digest: one line on sector concentration (the rebalance tip already goes to the digest).
- Token/key expiry reminders in the `diag` job or the night digest.
- Dynamic Island / Live Activities need a native app (impossible as a PWA; owner was told).

## How to work on this (lessons that cost a day)

1. **Edge code runs in Cloudflare Workers, not Node.** Before deploying edge changes, run them under workerd
   (`npx wrangler dev --local`; cron: `npx wrangler dev --test-scheduled`). `shared/llm.test.ts` has a strict-`this`
   fetch stand-in; keep it.
2. **Never write third-party model or API names from memory.** Query the live list; only claim success with the real
   check (Actions → PSX worker → `aicheck`, `aistatus`).
3. **Keys never go through chat.** The owner runs `npx wrangler secret put NAME` and `gh secret set NAME`.
4. **Public logs:** `publicErrors` keeps symbols out. Keep it so.
5. **Every rate is a setting.** Defaults in `shared/rules.json`, user copies in `settings`; estimates say so in the
   UI; researched facts stay marked VERIFY until a real document confirms them.
6. **UI work:** use the `ui-ux-pro-max` skill (owner's standing request), then check in the browser at 375 px
   (`npm run dev` → `http://localhost:5173/?demo=1#/home`). Keep `npm test` and `npm run typecheck` green. The owner
   wants a "done / remaining" count during long builds and parallel agents where files do not overlap.
7. **Commits** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Push triggers CI and
   migrations; `npm run deploy` publishes the Worker and app.

## Commands

```
npm test                       # all suites
npm run typecheck
npm run dev                    # http://localhost:5173/?demo=1
npm run worker -- aistatus     # free key checks (needs the API keys in env; on GitHub use the aistatus job)
npm run deploy                 # build + deploy Worker and app
npx wrangler tail app --format json
gh workflow run worker.yml -f job=market|night|aicheck|aistatus|diag
```

## Files that changed most recently

- New shared modules: `shared/symbols.ts`, `costs.ts`, `tax.ts`, `performance.ts`, `calendar.ts`, `quality.ts`,
  `grounding.ts`, `transactions-csv.ts` (each with a test file). Changed: `shared/types.ts` (settings, receipts,
  index/portfolio days, thesis fields), `rules.json` (costs, tax, holidays, T+1, outlier bounds), `portfolio.ts`
  (sector cap, trim/review rules, `sectorPeMap`), `discover.ts` (dedupe, outliers, regular yield, calendar),
  `signals.ts` (trim and review alerts), `changes.ts` (Shariah on import).
- App: `src/screens/Home.tsx`, `Portfolio.tsx` (tabs), `Discover.tsx`, `News.tsx`, `Profile.tsx`;
  `src/components/PerformanceTab.tsx`, `TaxTab.tsx`, `Allocation.tsx`, `SellPlanner.tsx`, `Transactions.tsx`,
  `Holding.tsx` (order ticket, thesis), `HoldingActions.tsx`, `ImportSheet.tsx`, `Icon.tsx`; `src/lib/data.ts`.
- Worker: `worker/feed.ts` (symbol markers), `jobs.ts` (index/portfolio days, rule context), `store.ts`, `ai.ts`
  (date sanity). Migration `supabase/migrations/0006_costs_tax_performance.sql`; RLS test extended.
