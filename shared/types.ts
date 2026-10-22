import rulesJson from './rules.json' with { type: 'json' };

export type Rules = typeof rulesJson;
export const DEFAULT_RULES: Rules = rulesJson;

export type HoldingStatus = 'core' | 'hold_no_add' | 'review';

export interface Holding {
  id?: string;
  symbol: string;
  shares: number;
  avg_cost: number;
  status: HoldingStatus;
  sector: string | null;
  is_shariah: boolean;
  note?: string | null;
  last_buy_price?: number | null; // price of the most recent buy; "x% below your last buy" uses it
  last_buy_on?: string | null;
  thesis?: string | null; // one line: why I own it
  review_on?: string | null; // YYYY-MM-DD: when to re-check the thesis
  target_price?: number | null; // a sell/trim trigger when the price reaches it
}

export interface WatchItem {
  id?: string;
  symbol: string;
  note?: string | null;
}

export interface Price {
  symbol: string;
  name: string | null;
  sector: string | null;
  price: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number | null;
  ldcp: number | null;
  high_52w: number | null;
  low_52w: number | null;
  dividend_yield_pct: number | null;
  pe: number | null;
  is_shariah: boolean | null;
  as_of: string | null;
  updated_at?: string;
  ex?: string | null; // PSX marker stripped from the symbol: XD (ex-dividend), XB (ex-bonus), XR (ex-right) or a combination
}

export interface IndexSnapshot {
  ts: string;
  kse100: number;
  change: number | null;
  change_pct: number | null;
}

export interface Settings {
  monthly_budget_pkr: number;
  sip_step_up_pct: number; // raise the monthly investment by this much every year (wealth projection)
  crash_fund_pkr: number;
  crash_trigger_kse: number;
  max_position_pct: number;
  drop_alert_pct: number;
  quiet_hours: { start: string; end: string };
  shariah_only: boolean;
  notifications_enabled: boolean;
  ai_enabled?: boolean;
  // Your rules (continued)
  max_sector_pct: number; // no new money into a sector above this share of the portfolio
  trim_pe_over_sector_pct: number; // "Trim" when a holding's P/E is this much above its sector's typical P/E
  trim_on_dividend_cut: boolean; // "Trim" when the latest declared dividend is below the previous one of its kind
  buy_more_below_pct: number; // "Buy more" when this far below your last buy AND the P/E is at or under its sector's
  hard_stock_cap_pct: number; // above this share of the portfolio a holding is a Trim (max_position_pct only stops new money)
  hard_sector_cap_pct: number; // above this a sector's biggest holding is a Trim (max_sector_pct only stops new money)
  review_after_loss_quarters: number; // Review after this many loss-making quarters in a row (0 = off)
  sell_after_loss_quarters: number; // Sell after this many loss-making quarters in a row (0 = off)
  // Broker & tax (every rate is a setting with a default from rules.json; never a constant in code)
  broker: string;
  commission_pct: number; // % of trade value per side
  min_commission_per_share: number; // rupees per share per side (PSX minimum: 3 paisa)
  sales_tax_pct: number; // provincial sales tax on the commission, %
  tax_filer: boolean; // on the Active Taxpayer List: drives CGT and dividend withholding rates
  match_nccpl: boolean; // cost basis without broker charges, to reconcile with NCCPL's monthly CGT statement
  cgt_paid: Record<string, number>; // tax year (e.g. "2026-27") -> CGT already deducted by NCCPL, rupees
  loss_carry_forward: Record<string, number>; // tax year -> net loss of that year still available to offset, rupees
  inflation_pct: number; // today-money projection (Goals & projection), default rules.growth.inflation_pct
  onboarded: boolean; // first-run setup finished or skipped
}

export const DEFAULT_SETTINGS: Settings = {
  monthly_budget_pkr: 50000,
  sip_step_up_pct: 0,
  crash_fund_pkr: 50000,
  crash_trigger_kse: 155000,
  max_position_pct: 25,
  drop_alert_pct: 10,
  quiet_hours: { start: '23:00', end: '07:00' },
  shariah_only: false,
  notifications_enabled: true,
  max_sector_pct: rulesJson.holding.sector_limit_pct,
  trim_pe_over_sector_pct: 50,
  trim_on_dividend_cut: true,
  buy_more_below_pct: rulesJson.holding.average_down_pct,
  hard_stock_cap_pct: rulesJson.holding.hard_stock_cap_pct,
  hard_sector_cap_pct: rulesJson.holding.hard_sector_cap_pct,
  review_after_loss_quarters: rulesJson.holding.review_after_loss_quarters,
  sell_after_loss_quarters: rulesJson.holding.sell_after_loss_quarters,
  broker: 'JS Global',
  commission_pct: rulesJson.costs.commission_pct,
  min_commission_per_share: rulesJson.costs.min_commission_per_share,
  sales_tax_pct: rulesJson.costs.sales_tax_pct,
  tax_filer: true,
  match_nccpl: false,
  cgt_paid: {},
  loss_carry_forward: {},
  inflation_pct: rulesJson.growth.inflation_pct,
  onboarded: false,
};

export type AnnouncementKind = 'dividend' | 'results' | 'board_meeting' | 'other';

export interface Announcement {
  id: string;
  symbol: string;
  title: string;
  kind: AnnouncementKind;
  published_at: string; // YYYY-MM-DD
  pdf_url: string | null;
  ai_summary?: string | null;
  ai_figures?: { label: string; value: string; verified: boolean }[] | null;
  ai_verified?: boolean | null;
  ai_date_note?: 'older_document' | 'date_unclear' | null; // the AI's dates do not fit the filing date (ISSUE-06)
  ai_metrics?: AnnouncementMetrics | null; // structured figures for the News card (migration 0012; null on older filings)
}

/** Which accounts an EPS figure comes from. 'not_stated' = PSX's own figure, basis unknown. */
export type EpsBasis = 'consolidated' | 'unconsolidated' | 'not_stated';

/** Structured figures read from one filing, for a clean News card (headline, 2-3 chips, impact line). */
export interface AnnouncementMetrics {
  headline: string | null; // short plain headline, e.g. "Profit up 18%, Rs 8 dividend"
  eps: number | null; // rupees per share for the period of the filing
  eps_basis: EpsBasis | null;
  dps: number | null; // cash dividend declared, rupees per share
  profit_change_pct: number | null; // profit after tax vs the same period last year, %
}

export interface AlertLogRow {
  id?: number;
  kind: string;
  symbol: string | null;
  message: string;
  channel: string | null;
  sent_at: string;
  dedupe_key: string;
}

/** One buy or sell, recorded when holdings change (manual edit, screenshot import, "record buy", CSV). */
export interface Txn {
  id?: string;
  symbol: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  amount: number; // shares x price, before charges
  executed_on: string; // YYYY-MM-DD (PKT)
  source: 'manual' | 'import' | 'csv';
  charges?: number | null; // broker commission + taxes + fees on this side, rupees; null = estimate from the cost settings
}

/** A cash dividend credited to the account (net of withholding tax), confirmed by the user or from a credit advice. */
export interface DividendReceipt {
  id?: string;
  symbol: string;
  paid_on: string; // YYYY-MM-DD
  shares: number;
  dps: number; // gross rupees per share
  gross: number;
  wht_pct: number; // withholding tax applied, %
  net: number;
  dividend_id?: string | null; // the declared dividend (announcement id) it came from, when known
  note?: string | null;
}

/** Profit after tax of one quarter, read by the AI from a results filing (negative = loss). */
export interface QuarterEarnings {
  id: string; symbol: string; period_end: string; profit_after_tax: number; verified: boolean; pdf_url?: string | null;
  eps?: number | null; // earnings per share for the period (migration 0012)
  eps_basis?: EpsBasis | null;
  period_months?: number | null; // months the figures cover: 3 = a quarter, 12 = a full year (cumulative filings say 6 or 9)
}

/** KSE-100 closing level for one trading day (written by the worker; backfilled from index_snapshots). */
export interface IndexDay { day: string; close: number }

/** One user's portfolio value at the close of a trading day (written by the night job). */
export interface PortfolioDay { day: string; value: number; invested: number }

/** One stock's close on a trading day (written nightly from PSX's screener; history builds from 2026-10-23). */
export interface PriceDay { symbol: string; day: string; close: number; change_pct: number | null }

/** One user's portfolio value at a market check during the day (1D chart; kept 10 days). */
export interface PortfolioTick { ts: string; value: number }

/** A cash dividend declared in a PSX announcement, read by the AI and checked against the PDF. */
export interface DividendEvent {
  id: string; // announcement id
  symbol: string;
  announced_on: string;
  dps: number | null; // rupees per share
  dividend_type: 'interim' | 'final' | 'special' | null;
  book_closure_from: string | null;
  book_closure_to: string | null;
  verified: boolean;
  pdf_url: string | null;
}

export type HoldingCallKind = 'hold' | 'average_down' | 'opportunity' | 'trim' | 'review' | 'sell';

export interface AiSuggestion {
  action: 'buy' | 'add' | 'hold' | 'trim' | 'sell' | 'watch' | 'review';
  symbol: string | null;
  text: string;
  why: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface AiInsight {
  created_at: string;
  job: string;
  headline: string;
  stance: 'buy' | 'hold' | 'wait' | null;
  suggestions: AiSuggestion[];
  holding_calls: { symbol: string; call: HoldingCallKind; text: string }[];
  rebalance: string | null;
  cash_note: string | null;
  risks: string | null;
  model: string | null;
}

/** Market-wide AI picks for the Discover tab (written nightly by the worker). */
export interface AiPicks {
  kind: 'undervalued' | 'dividend';
  created_at: string;
  model: string | null;
  items: { symbol: string; why: string; frequency?: string | null }[];
}

export type PriceMap = Record<string, Price>;
