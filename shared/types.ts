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

export interface TrancheSplitItem {
  pct: number;
  after_days: number;
}

export interface Settings {
  monthly_budget_pkr: number;
  crash_fund_pkr: number;
  crash_trigger_kse: number;
  max_position_pct: number;
  drop_alert_pct: number;
  tranche_split: TrancheSplitItem[];
  quiet_hours: { start: string; end: string };
  shariah_only: boolean;
  notifications_enabled: boolean;
  ai_enabled?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  monthly_budget_pkr: 50000,
  crash_fund_pkr: 50000,
  crash_trigger_kse: 155000,
  max_position_pct: 25,
  drop_alert_pct: 10,
  tranche_split: [
    { pct: 40, after_days: 0 },
    { pct: 40, after_days: 14 },
    { pct: 20, after_days: 25 },
  ],
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
  suggestions: AiSuggestion[];
  plan_note: string | null;
  risks: string | null;
  model: string | null;
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

export type PriceMap = Record<string, Price>;
