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
  // Broker & tax (every rate is a setting with a default from rules.json; never a constant in code)
  broker: string;
  commission_pct: number; // % of trade value per side
  min_commission_per_share: number; // rupees per share per side (PSX minimum: 3 paisa)
  sales_tax_pct: number; // provincial sales tax on the commission, %
  tax_filer: boolean; // on the Active Taxpayer List: drives CGT and dividend withholding rates
  match_nccpl: boolean; // cost basis without broker charges, to reconcile with NCCPL's monthly CGT statement
  cgt_paid: Record<string, number>; // tax year (e.g. "2026-27") -> CGT already deducted by NCCPL, rupees
  loss_carry_forward: Record<string, number>; // tax year -> net loss of that year still available to offset, rupees
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
  broker: 'JS Global',
  commission_pct: rulesJson.costs.commission_pct,
  min_commission_per_share: rulesJson.costs.min_commission_per_share,
  sales_tax_pct: rulesJson.costs.sales_tax_pct,
  tax_filer: true,
  match_nccpl: false,
  cgt_paid: {},
  loss_carry_forward: {},
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

/** KSE-100 closing level for one trading day (written by the worker; backfilled from index_snapshots). */
export interface IndexDay { day: string; close: number }

/** One user's portfolio value at the close of a trading day (written by the night job). */
export interface PortfolioDay { day: string; value: number; invested: number }

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

export type HoldingCallKind = 'hold' | 'average_down' | 'opportunity' | 'trim' | 'review';

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
