# Review fixes and redesign — design

_2026-10-23. Source: the owner pasted an outside review (15 bugs/logic/UX points + 10 design points) and asked for it
all, built fast with parallel agents. Owner decisions: one name **PSX Assist**; no custom domain for now (owner's
to-do); quiet hours stay 02:00–12:00; on phones Profile moves to an avatar top-right._

## Why

The app is used daily by one owner on an iPhone PWA and a desktop browser. The review found figures that are wrong or
contradict each other (missing expected dividends, two P/Es for one stock, charges far too low, a cash rule that
recommends the lower-yielding option) and a UI that reads like an alarm and an essay. Trust in the numbers is the
product: a wrong figure is worse than a missing one. The redesign should make it look and feel like a serious finance
app without becoming busier.

## Goals

1. Every figure the review called wrong is either correct, labelled with its basis, or hidden until it means something.
2. The two pages never disagree about the same number (P/E, dividends, charges).
3. One visual language: semantic colour tokens, ▲▼ arrows on every change, tabular numbers, one type scale, one date
   format, light mode as finished as dark.
4. Home leads with the portfolio (value chart + compact holdings list); Market and News show the answer first and the
   method on demand.
5. A real stock page, reachable from every ticker.

## Non-goals

- Custom domain (owner buys it later). Quiet-hours change. Company logo images (no honest source; initials instead).
- Back-filling price history from PSX's bot-checked timeseries. History builds from now on, and charts say so.
- Contract-note / NCCPL PDF reading (still backlog).

## Anti-goals (a failure even if it "works")

- A chart or figure that implies more history or certainty than is stored (e.g. a 1-year line drawn from 5 days).
- Hard-coded rates: every new threshold is a `rules.json` setting, research numbers marked VERIFY.
- Bypassing any bot check; logging symbols in public Actions logs.
- Anything new on Home beyond what this review asked for (the owner approves Home changes; this list is his request).
- Phones regress while desktop improves, or vice versa.

## Part A — Data and logic fixes

**A1 Expected dividends.** Expected and Home "This week" must use the same book-closure events. Expected currently
needs a `dividends` row with `dps` and `book_closure_from` and counts shares from the transactions log only, so stocks
imported as a baseline (no logged buys) get 0 shares. Fix: shares at book closure = transactions log when the log
explains the holding; otherwise current holding shares minus buys logged on/after the cut-off. When the dividend row has
no book-closure date but the announcement text yields one (the same parser Home uses), use it. Each Expected row says
which basis it used ("from your holdings" when the log is incomplete).

**A2 P/E basis.** Extend filing extraction to read EPS with its basis (consolidated / unconsolidated) and period
(months covered). Store it per company (new columns). Default P/E = price ÷ latest full-year **consolidated** EPS
(falling back to unconsolidated, then PSX's screener P/E), with the basis shown in small text ("P/E 3.7 · consolidated
FY25 EPS"). The outlier rule (outside 2–100) stays, but every screen shows the same figure with the same "unusual,
check" marker; Holdings never says "no P/E figure" when one exists.
- _Owner decision:_ the rules (Buy more value check, Trim on P/E vs sector, payout) use the same P/E that is shown.
  Sector medians use each peer's filing-based P/E where stored, PSX's figure otherwise.
- _Claude's call:_ "full-year" = sum of the last four quarterly EPS when all four are stored, else the latest annual
  EPS. Backfill: the night job reads the latest annual and up to three quarterly result filings for held and watched
  symbols that have no stored EPS, a few per night within the AI budget (setting). PSX's company-page Annual EPS row
  is the last fallback before the screener, labelled "basis not stated".

**A3 Charges.** "Charges paid" counts logged trades only and says so ("on Rs 30k of logged buys"); next to it an
estimate on the whole cost basis at the user's rates, labelled estimate. Screenshot-implied buy prices are treated as
including charges (broker average cost does), so no charges are added on top of those; the row explains this. The
"missing older buys" prompt lists the holdings and links to the Buys and sells log.

**A4 Received dividends form.** Shares default to shares held at book closure (A1 rule), date defaults to the
dividend's expected credit date if known else empty (no silent "today"); entry blocked when date is empty. Existing
rows whose shares differ from what was held get a "check: you held N" note and are editable (edit + delete).

**A5 Trend provisional.** Rule text, counter and light agree: "200-day average (needs 120 stored closes; N so far)".
While the average is missing the Trend light reads "Sideways · provisional" everywhere it appears.

**A6 Symbols.** Alias map in `shared/symbols.ts` (OGDCL→OGDC and any other common long forms found in PSX's list);
watchlist add validates against known symbols and suggests the PSX symbol; existing aliased rows are read through
the map.

**A7 Compass cash rule.** _Owner decision:_ both the "Shares vs safe yield" light and the cash advice compare the
earnings yield with the money-market estimate (3-month T-bill minus fee), the place the advice actually sends money.
The 10-year PIB stays on the page as information. A neutral band (settings, default −1 to +1 point) changes nothing;
"park extra" needs the gap below −1; "shares pay more" threshold re-set for the new basis (setting, VERIFY; the old
3.5 was against the PIB, which sits ~1.5–2 points above money market). Stored past readings are not recomputed; the
compass record gains a `gap_basis` field and old rows are labelled "vs 10-year bond". Same in the night-digest text.

**A8 Dividend sustainability.** Payout over 90% (setting) gets a "High payout — may not last" caution chip; over 150%
stays "suspect". A trailing yield that includes a special dividend, or whose latest results declared no dividend, is
marked "one-off" and ranked by the regular yield. AI picks receive payout, special and suspect flags and may not pick a
dividend stock flagged suspect.

**A9 Sector P/E.** Sector comparison uses the median of at least 5 comparable peers (setting) with trusted P/Es, and is
skipped when the peers are too spread out (setting: interquartile range wider than the median). Otherwise the chip
says "sector too mixed to compare".

**A10 AI reasons add something new.** Picks and insights get extra facts (payout, latest results change vs last year,
dividend cut/raise, special flag). The prompt forbids repeating chip numbers and asks for one new fact; the
number-grounding filter accepts numbers from the new facts.

**A11 Holdings labels.** "1.1% below your last buy" and "P/L +2.3% vs average cost" each say their reference.

**A12 Benchmark.** Hidden until 30 days of portfolio history (setting), with "Comparison with the KSE-100 starts on
<date>".

**A13 Projection.** Show future rupees and today's money side by side, inflation a setting (default 10%, VERIFY; the
latest CPI shown for reference).

**A14 Time words.** Greeting by PKT hour (05–12 morning, 12–17 afternoon, else evening). "Today" only when the price
date is today's trading session; otherwise "Last session (Thu)".

## Part B — Design

**B1 Tokens (Tailwind v4 `@theme` in `src/index.css`).** Colours as semantic tokens with light and dark values:
`up` (green), `down` (red), `caution` (amber), `brand` (teal, actions and links only), `info`, plus surface/text
tiers. Spacing on a 4/8 px grid, radii (sm 8, md 12, lg 16, xl 24), two shadows. Type scale 12/14/16/20/28/40 with
body ≥ 14 px on phones; secondary text contrast ≥ 4.5:1 in both themes. `tabular-nums` set globally on `body`.

**B2 Colour rules.** Green/red only for price direction; amber only for caution; teal only for actions. Every change
shows ▲/▼ (shared `Change` component). Offenders fixed: "Today" dates, "Not a blue chip", News dot, ticker rings,
donut's first slice, buy-by tiles, hero gradients.

**B3 Chips.** One fixed set: Blue chip (spelled out), Shariah, Ex-dividend, AI, Caution, Estimate. Shared component.

**B4 Dates.** One module in `shared/format.ts`: relative for recent ("Today", "Yesterday", "Thu"), "Oct 5" this year,
"Oct 5, 2025" otherwise; times "3:49 PM"; all in PKT. Every screen uses it (11 formats today).

**B5 Company marks.** Initials in a circle, colour fixed per PSX sector (a small palette that is not red/green/amber).

**B6 App shell.** Phone bottom tabs: Home, Market, Portfolio, Discover, News; avatar button top-right opens Profile.
A slim global freshness line: "Data as of Thu 3:49 PM · Market opens Mon 9:30" (or "Market open · closes 3:30").
One name "PSX Assist" in the title, manifest, service worker, login, AI header. Theme colours consistent between
`index.html`, manifest and runtime. A proper SVG logo mark. Per-screen skeletons; hero numbers count up smoothly;
pull-to-refresh stays.

**B7 Home.** Order: freshness line → status line (calm: one line "Hold — nothing to do today" + "What would change
this?" opening a sheet with the conditions for Add / Trim / Review) → portfolio value + chart (1D / 1W / 1M / YTD /
All) → holdings list (mark, ticker, sparkline, price, day change ▲▼, position value; tap = stock page) → Needs
attention → This week → Market card (compact) → AI card (desktop: these two in the right column). _Owner decision:_
phone Home keeps everything it has today, tidied: the "Invested this month" bar and the total-return line live inside
the portfolio card; market open/closed moves into the freshness line. Chart data: new intraday `portfolio_ticks` written on
each market run (1D) and `portfolio_daily` (others, also written by Refresh); ranges with too little data show what
exists and the start date.

**B8 Stock page `#/stock/SYMBOL`.** Price chart from new `price_daily` (built nightly from the screener for KSE-100,
held and watched symbols; shows the 52-week range bar until 5 closes exist), your position and cost, P/E with basis,
dividend history, recent filings, and a "Your rules" checklist (buy more, trim, caps, value check, blue-chip checks)
pass/fail with reasons; Buy / Edit / Plan sale actions. Every ticker opens it (Home, Portfolio, Discover, News, AI,
watchlist, This week). Long-press menu stays. _Claude's call:_ the page replaces today's tap-to-open stock sheet;
Buy / Edit / Plan sale open the existing forms and sheets from the page, so there is one detail view.

**B9 Market page.** Each card: light, number, one line. Methodology, sources, "to verify" notes, rule text move into a
"How this works" sheet per card.

**B10 News cards.** Clean headline (AI headline, or the title tidied and cut at a word boundary) → 2–3 metric chips
(EPS, dividend per share, profit change vs last year) from structured fields → "Impact on you" for holders (e.g.
"≈ Rs 128 after tax if you hold on Oct 27 — buy by Oct 24"). Scanned-PDF note becomes a small icon with a tooltip.
Structured fields come from the extraction change in A2 (new `ai_metrics`); older filings fall back to cleaned labels.

**B11 Disclaimers.** Once in the footer (sidebar on desktop, Profile bottom on phone) and once on the AI panel.
Market's "rule of thumb" line stays in its How-this-works sheet only.

**B12 Profile.** Summary list → sub-pages `#/profile/<section>`: Account, My plan (SIP, step-up, crash fund, goals),
My rules ("N rules active"), Broker & tax, Alerts (push, quiet hours, Telegram), AI, Appearance, Data (Refresh).

**B13 First-run setup.** When signed in with no holdings (not demo): Import holdings → Set monthly investment → Set
rules, skippable, remembered.

## Data changes (migration 0012)

- `price_daily (symbol, day, close, change_pct)` — written by the night job and Refresh.
- `portfolio_ticks (user_id, ts, value)` — written by each market run; keep 10 days.
- Filing EPS: `earnings.eps`, `eps_basis ('consolidated'|'unconsolidated')`, `period_months`; `announcements.ai_metrics
  jsonb` ({headline, eps, eps_basis, dps, profit_change_pct}).
- `settings.inflation_pct` (default from rules.json).
- RLS like the existing tables (read own / read public market data).

## Constraints

- Edge code runs in Workers; tests under `npm test`; typecheck clean; 375 px and 1440 px checked in light and dark.
- Keys never in chat; public logs carry no symbols.
- New thresholds go to `rules.json` with notes; researched numbers VERIFY.

## Left to the builder

Exact component APIs, chart drawing (hand-rolled SVG like the existing charts; no new chart library unless needed),
sector palette, skeleton shapes, wording of short labels within the rules above.
