# Review fixes and redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 14 data/logic problems from the owner's review and give the app one design system, a portfolio-first
Home, a stock page, calmer Market/News, a sectioned Profile and a first-run setup.

**Architecture:** Task 0 (foundation: types, rules, migration, data loaders, date/nav helpers, design tokens and UI
primitives) is done first by the lead. Then two waves of parallel agents, each owning a disjoint set of files:
wave 1 = pure logic (A, B) + Shell/Home + Profile; wave 2 (after logic lands) = Worker, Stock page, News/Discover,
Market, Portfolio. The lead integrates, runs everything, checks 375/1440 px light+dark, commits and deploys.

**Tech Stack:** React 19 + Vite + Tailwind v4 (CSS-first `@theme`), TypeScript, Vitest, Supabase (Postgres + RLS),
GitHub Actions worker (Node), Cloudflare Worker edge.

**Spec:** `docs/superpowers/specs/2026-10-23-review-fixes-and-redesign-design.md` (read it; this plan argues from it).

## Global Constraints

- App name is exactly **PSX Assist** everywhere user-visible.
- Every new threshold is a key in `shared/rules.json` with a `_note`; researched numbers carry "VERIFY".
- Colour semantics: `up`/`down` tokens only for price/return direction; `caution` only for warnings; `brand` (teal)
  only for actions/links/selection. Every change value shows ▲/▼ (use `<Change>`), never colour alone.
- All numbers tabular (`body` has `font-variant-numeric: tabular-nums`). Type scale 12/14/16/20/28/40; body text ≥ 14px
  on phones; secondary text uses `text-muted` token (≥ 4.5:1 both themes).
- All dates via `shared/format.ts` `day()`, `dayTime()`, `time()`; never `toLocaleDateString` or ad-hoc Intl in screens.
- One "not financial advice" line in the footer (sidebar on desktop, Profile bottom on phone) and one on the AI panel.
- Never show more history than is stored: charts with < 2 points show "Builds from <date>"; ranges show start date.
- Public Actions logs carry no symbols or messages. Never bypass a bot check. No new chart library (hand SVG).
- Do not edit a file you do not own (see each task's **Files**). Need a change elsewhere? Write it in your final report.
- Every task: `npm test` and `npm run typecheck` pass before reporting done. UI tasks also check their screen in the
  preview (`http://localhost:5173/?demo=1#/...`, own browser tab) at 375 px and 1440 px, light and dark.
- Commits are made by the lead only (agents leave changes in the tree).

## Review Focus

1. A holding imported as a baseline (no logged buys) with a dividend whose book closure is today → appears in Expected
   with shares from holdings (Task A test `expected uses holdings when log has a gap`).
2. A stock whose filing EPS is negative or zero → P/E shows "n/a (loss)" not a negative P/E, and rules treat it as no
   value check (Task B test `pe basis negative eps`).
3. Compass gap exactly at the band edges (−1.0, +1.0) → neutral band inclusive; no flip (Task B test `gap band edges`).
4. Demo mode / brand-new account with empty `price_daily`, `portfolio_ticks`, `portfolio_daily` → every chart shows its
   "builds from" empty state, no crash, no NaN (Shell/Home and Stock tasks: render check in demo + unit test of
   `seriesFor` with `[]`).
5. Watchlist symbol typed in lower case or as an alias with an XD marker ("ogdcl xd") → stored as `OGDC`
   (Task B test `normaliseWatchSymbol`).

---

### Task 0 (lead): Foundation

**Files (lead only):** `shared/types.ts`, `shared/rules.json`, `supabase/migrations/0012_review_redesign.sql`,
`src/lib/data.ts`, `shared/format.ts` (+ `shared/format.test.ts`), `src/lib/nav.ts` (new), `src/index.css`,
`src/components/ui.tsx`, `src/screens/Stock.tsx` (placeholder only), `shared/fixtures/seed.ts` (demo series).

**Produces (everyone relies on these names):**
- Types: `PriceDay { symbol; day; close; change_pct: number | null }`, `PortfolioTick { ts; value }`,
  `EpsBasis = 'consolidated' | 'unconsolidated' | 'not_stated'`,
  `QuarterEarnings` + `eps: number | null; eps_basis: EpsBasis | null; period_months: number | null`,
  `AnnouncementMetrics { headline: string | null; eps: number | null; eps_basis: EpsBasis | null; dps: number | null;
  profit_change_pct: number | null }`, `Announcement.ai_metrics?: AnnouncementMetrics | null`,
  `Settings.inflation_pct: number`, `Settings.onboarded: boolean`.
- `AppData` + `priceDaily: PriceDay[]` (oldest first, all symbols) and `portfolioTicks: PortfolioTick[]` (oldest first).
- rules.json keys: `holding.payout_warn_pct` 90; `undervalued.sector_min_peers` 5, `undervalued.sector_max_iqr_ratio`
  1.0; `compass.gap_basis` "money_market", `compass.spread_neutral_low` -1, `compass.spread_neutral_high` 1,
  `compass.spread_shares_above` 2 (VERIFY, re-based from 3.5 vs PIB), `performance.benchmark_min_days` 30,
  `growth.inflation_pct` 10 (VERIFY), `ai.eps_backfill_per_night` 4, `symbols.aliases` {"OGDCL":"OGDC"}.
- `shared/format.ts`: `day(iso, now?)` → "Today" | "Yesterday" | "Thu" (within 6 days) | "Oct 5" | "Oct 5, 2025";
  `dayTime(iso, now?)` → `${day} 3:49 PM`; `time(iso)` → "3:49 PM"; `sessionLabel(asOfIso, now?)` → "Today" when
  the price date is today PKT and a trading day, else "Last session (Thu)"; `greeting(now?)` → morning 05–12,
  afternoon 12–17, else evening. Old `asOfLabel`/`dateLabel`/`ago` kept as thin wrappers until screens move off them.
- `src/lib/nav.ts`: `parseHash(hash) → { route: Route; sub: string | null; query: URLSearchParams }`,
  `Route = 'home'|'market'|'portfolio'|'discover'|'news'|'profile'|'stock'`, `stockHref(symbol) = '#/stock/SYM'`,
  `openStock(symbol)`, `profileHref(section)`.
- CSS tokens (`@theme` + light/dark values): colours `--color-up`, `--color-down`, `--color-caution`, `--color-brand`,
  `--color-info`, `--color-surface`, `--color-surface-2`, `--color-line`, `--color-ink`, `--color-muted`; utilities
  usable as `text-up bg-caution/10 ring-line` etc.; type scale `text-12/14/16/20/28/40`; radii `rounded-sm/md/lg/xl`.
- `ui.tsx` adds: `<Change value pct? digits? size?>` (▲/▼ + sign + colour, "–" for 0/null),
  `<Chip kind="bluechip"|"not_bluechip"|"shariah"|"exdiv"|"ai"|"caution"|"estimate"|"provisional">` (fixed labels,
  "Blue chip" spelled out; not_bluechip is neutral grey), `<CompanyMark symbol sector size?>` (initials, sector colour
  from a fixed non-red/green/amber palette), `<InfoTip text>` (small (i) icon, tap/hover popover), `<HowItWorks
  title>{children}</HowItWorks>` (link that opens a Sheet), `<Sparkline>` stays.

- [ ] Write `shared/format.test.ts` for `day`, `dayTime`, `sessionLabel`, `greeting` (e.g. `day('2026-10-23',
  new Date('2026-10-23T10:00:00Z')) === 'Today'`; at Fri 00:41 PKT a price dated Thu 15:49 → `sessionLabel`
  "Last session (Thu)"; `greeting` at 00:41 PKT → "Good evening").
- [ ] Implement, add types/rules/migration/loaders/demo data, tokens and primitives; `npm test`, `npm run typecheck`.
- [ ] Commit "Foundation: tokens, formats, nav, migration 0012, data loaders".

### Task A (wave 1): Dividends & performance logic

**Files:** `shared/performance.ts`, `shared/performance.test.ts`, `shared/tax.ts` (only `sharesHeldOn` area),
`shared/calendar.ts`, `shared/calendar.test.ts`, `shared/growth.ts`.

**Produces:**
- `heldAtBookClosure(symbol, cutoff: string, txns: Txn[], holdings: Holding[]): { shares: number; basis: 'log' |
  'holdings' }` — log when `logGaps` shows no gap for the symbol, else holdings shares minus buys logged on/after cutoff
  (plus sells after cutoff).
- `expectedDividends(...)` keeps its signature + takes `announcements?: Announcement[]`; rows gain
  `basis: 'log' | 'holdings'`; a dividend row without `book_closure_from` uses the date the Home parser
  (`eventDates` in calendar.ts) finds in the matching announcement.
- `chargesSummary(txns, holdings, prices, settings) → { logged: number; logged_on: number; estimate_all: number;
  cost_basis: number; implied_include_charges: true }` (imported/implied buys add no extra charges).
- `benchmarkReady(snapshots: PortfolioDay[], today: string, rules) → { ready: boolean; starts_on: string | null;
  ready_on: string | null }` using `performance.benchmark_min_days`.
- `projection(settings, start, years) → { nominal: number; today_money: number; inflation_pct: number }` in growth.ts.
- Tests (names): `expected uses holdings when log has a gap`, `expected takes book closure from announcement text`,
  `expected excludes buys after cutoff`, `charges summary on partial log`, `benchmark hidden under 30 days`,
  `projection today money at 10% inflation` (Rs 11.5M nominal over 10y → ≈ Rs 4.43M at 10%).

### Task B (wave 1): Valuation, compass, discover logic

**Files:** `shared/quality.ts`, `shared/discover.ts`, `shared/portfolio.ts`, `shared/compass.ts`, `shared/regime.ts`,
`shared/symbols.ts`, new `shared/valuation.ts`, and their `*.test.ts`.

**Produces:**
- `valuation.ts`: `peFor(symbol, price: number | null, earnings: QuarterEarnings[], screenPe: number | null) →
  { pe: number | null; basis: EpsBasis | 'psx'; eps: number | null; label: string; outlier: boolean; loss: boolean }`
  — sum of last 4 quarters' EPS (same basis, prefer consolidated) else latest 12-month EPS, else screener P/E.
  `label` e.g. "consolidated, last 4 quarters" / "PSX figure, basis not stated". `peMap(...)` for many symbols.
- `RuleContext` gains `pe?: Record<string, ReturnType<typeof peFor>>`; `valueCheck`, `trimReason`, payout use it.
  `valueCheck` never says "no P/E figure" when a P/E exists (outlier → "P/E X looks unusual; check figures").
- `ruleCall` texts name their reference: "x% below your last buy (Rs P)"; P/L labels are UI (Tasks Stock/Portfolio).
- `sectorStats(screenWithPe) → Record<sector, { median: number; peers: number; comparable: boolean }>` with
  `sector_min_peers`, `sector_max_iqr_ratio`; `undervalued()` and `sectorPeMap()` use it; non-comparable sectors get
  `discount_pct: null` and `reason: 'sector too mixed to compare'`.
- `qualityChips`: payout > `payout_warn_pct` → `{ key: 'payout', label: 'High payout — may not last', tone: 'amber' }`;
  `oneOffYield(symbol, events, today) → boolean` (special inside trailing year, or latest results declared none);
  `dividendLeaders` ranks one-offs by regular yield and sets `one_off: true`.
- `compass()`: `gap.basis: 'money_market' | 'pib'`, spread = earnings yield − money-market estimate; neutral band
  inclusive [low, high] → `on_schedule`; `park_extra` only below low; `GAP_WORD.safe` = "Safe yield pays more".
  `trendOf()` returns `provisional: boolean` (true while MA missing); reasons text: "200-day average (needs 120 stored
  closes; N so far)".
- `symbols.ts`: `canonicalSymbol(s)` (upper, strip XD/XB/XR, alias map) and `normaliseWatchSymbol` alias.
- Tests (names): `pe basis consolidated four quarters`, `pe basis negative eps`, `valueCheck outlier wording`,
  `sector too mixed`, `sector min peers`, `payout over 90 caution`, `one-off yield special`, `gap band edges`,
  `gap uses money market`, `trend provisional flag`, `normaliseWatchSymbol`.

### Task S (wave 1): App shell + Home

**Files:** `src/App.tsx`, `src/screens/Home.tsx`, `src/screens/Onboarding.tsx`, new `src/screens/FirstRun.tsx`, new
`src/components/PortfolioChart.tsx`, new `src/components/HoldingsList.tsx`, new `src/components/Freshness.tsx`, new
`src/components/StatusLine.tsx`, `src/components/Splash.tsx`, `src/components/motion.ts`, `index.html`,
`public/manifest.webmanifest`, `public/sw.js`, `public/` icons/logo, `src/screens/Login.tsx`, `shared/llm.ts` (X-Title
string only).

- Routes via `nav.ts` incl. `stock` (renders `<Stock symbol={sub} {...props}/>`) and `profile` with `section={sub}`.
- Phone: bottom tabs Home, Market, Portfolio, Discover, News; avatar (initial) top-right → `#/profile`; desktop sidebar
  keeps all six. `<Freshness>` under the top bar on every screen: "Data as of {dayTime} · Market opens Mon 9:30" /
  "Market open · closes 3:30 PM" (from `market_hours_pkt` + calendar holidays).
- Home order and content per spec B7 (incl. owner decision); `StatusLine` + "What would change this?" sheet listing
  conditions for Add/Trim/Review from `todayState`/`signals` inputs; `PortfolioChart` ranges 1D (portfolioTicks
  today) / 1W / 1M / YTD / All (portfolioDaily + current value), `seriesFor(range, ticks, daily, now)` exported and
  unit-tested (empty → `[]`, shows "Builds from …"); `HoldingsList` rows: CompanyMark, ticker, sparkline (priceDaily,
  hidden < 5 points), price, `<Change>`, position value; tap → `openStock`.
- Per-screen skeletons (exported `ScreenSkeleton({ route })`), count-up for hero numbers (reduced-motion off).
- `FirstRun` when live, no holdings, `!settings.onboarded`: Import → Monthly investment → Rules; skip sets onboarded.
- Name "PSX Assist" everywhere; theme-color/manifest colours match runtime; SVG logo mark.
- The desktop sidebar footer keeps the one disclaimer line (it is the desktop footer).

### Task P (wave 1): Profile

**Files:** `src/screens/Profile.tsx`, new `src/screens/profile/*.tsx`, `src/components/Growth.tsx`,
`src/components/RefreshLatest.tsx`.

- Profile = summary list (Account, My plan, My rules "N rules active", Broker & tax, Alerts, AI, Appearance, Data) →
  sections at `#/profile/<plan|rules|broker|alerts|ai|appearance|data|account>`; each with back link.
- Goals & projection shows nominal and today's money with `settings.inflation_pct` (editable, default rules value,
  "latest CPI x%" hint). Phone footer: the one disclaimer line.

### Task W (wave 2): Worker

**Files:** `worker/*.ts` and tests, `edge/index.ts`.

- Filing extraction returns `ai_metrics` + EPS with basis and months; store into `announcements.ai_metrics` and
  `earnings.eps/eps_basis/period_months`; EPS backfill for held+watched symbols without EPS,
  `ai.eps_backfill_per_night` per night.
- Night job + refresh write `price_daily` (KSE-100 + held + watched from screener/quotes) and `portfolio_daily`
  (refresh too); market job writes `portfolio_ticks` (prune > 10 days).
- Compass alert text uses the new basis/wording; regime row stores `compass.gap_basis`.
- AI picks/insight facts add payout, one_off, suspect, latest results change, dividend cut; prompt: give one new fact,
  never repeat chip numbers; suspect excluded from dividend picks; grounding accepts the new fact numbers.
- Tests for each; public logs carry no symbols.

### Task K (wave 2): Stock page

**Files:** `src/screens/Stock.tsx`, new `src/components/PriceChart.tsx`, `src/components/Holding.tsx`,
`src/components/HoldingActions.tsx`, `src/components/SellPlanner.tsx`, `src/components/BcBadge.tsx`.

- Page per spec B8; `acts.open(symbol)` now navigates to `#/stock/SYM`; Buy/Edit/Plan sale reuse existing sheets;
  P/E with `peFor().label`; holdings P/L labelled "vs average cost", last-buy distance "vs last buy (Rs P)"; rules
  checklist; dividend history; recent filings; `PriceChart` from priceDaily (52-week bar until 5 closes).

### Task N (wave 2): News + Discover + AI card

**Files:** `src/screens/News.tsx`, `src/screens/Discover.tsx`, `src/components/AiCard.tsx`, `shared/news.ts`.

- News card per spec B10 (headline, ≤3 metric chips from `ai_metrics`, "Impact on you" via `heldAtBookClosure` +
  `whtPct`, scanned-PDF `<InfoTip>`); old filings: labels cleaned at word boundary. Every ticker → stock page.
- Discover: payout caution chip, one-off yield chip, "sector too mixed" text, P/E with basis; Blue chip chip spelled
  out; remove Disclaimer; AI card keeps its one disclaimer line.

### Task M (wave 2): Market

**Files:** `src/components/MarketMood.tsx`, `src/screens/Market.tsx`.

- Each card: light + number + one line; notes, sources, VERIFY tags, rule text inside `<HowItWorks>`; trend shows
  "Sideways · provisional" chip; gap light labelled vs money market, PIB as info; old rows "vs 10-year bond".

### Task F (wave 2): Portfolio

**Files:** `src/screens/Portfolio.tsx`, `src/components/PerformanceTab.tsx`, `TaxTab.tsx`, `Transactions.tsx`,
`Allocation.tsx`, `Donut.tsx`, `Breakdown.tsx`, `ImportSheet.tsx`.

- Charges row per `chargesSummary`; missing-buys prompt lists holdings + links to log; benchmark gated by
  `benchmarkReady`; receipt form: shares default `heldAtBookClosure`, no silent date, edit existing receipts, "check:
  you held N" note; watchlist add uses `normaliseWatchSymbol` + "did you mean"; Holdings row labels; donut palette not
  red; dates and colours per Global Constraints.

### Task Z (lead): Integrate, verify, ship

- [ ] `npm test`, `npm run typecheck`, `npm run build`; fix integration breaks.
- [ ] Preview every route at 375 and 1440, light and dark; fix.
- [ ] Code review (fresh reviewer on the diff); fix confirmed findings.
- [ ] Commit, push (migration 0012 applies), `npm run deploy`, `gh workflow run worker.yml -f job=refresh`, check run.
- [ ] Update HANDOFF.md and memory.
