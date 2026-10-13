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

/** One buy or sell, recorded when holdings change (manual edit, screenshot import, "record buy"). */
export interface Txn {
  id?: string;
  symbol: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  amount: number;
  executed_on: string; // YYYY-MM-DD (PKT)
  source: 'manual' | 'import';
}

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
