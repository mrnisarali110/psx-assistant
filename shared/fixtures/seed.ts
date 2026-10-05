/** Owner's seed portfolio (spec section 9) + PSX close of 2026-10-05. Used by tests and demo mode. */
import captured from './seed-prices.json' with { type: 'json' };
import type { Announcement, Holding, IndexSnapshot, PriceMap, WatchItem } from '../types.ts';
import { DEFAULT_SETTINGS } from '../types.ts';
import type { ScreenRow } from '../opportunities.ts';

export const SEED_HOLDINGS: Holding[] = [
  { symbol: 'SYS', shares: 118, avg_cost: 130.45, sector: 'Technology', is_shariah: true, status: 'core', note: 'Earnings growing, near the cap, so add small' },
  { symbol: 'MEBL', shares: 20, avg_cost: 583.06, sector: 'Banks', is_shariah: true, status: 'core', note: 'Quality bank, below cost' },
  { symbol: 'UBL', shares: 16, avg_cost: 442.93, sector: 'Banks', is_shariah: false, status: 'core', note: 'Dividend payer, below cost' },
  { symbol: 'DCR', shares: 170, avg_cost: 38.07, sector: 'REIT', is_shariah: true, status: 'core', note: 'Only holding in profit' },
  { symbol: 'EFERT', shares: 50, avg_cost: 212.68, sector: 'Fertilizer', is_shariah: true, status: 'hold_no_add', note: 'Large position, already the biggest loser' },
  { symbol: 'LUCK', shares: 10, avg_cost: 458.39, sector: 'Cement', is_shariah: true, status: 'hold_no_add', note: 'Waiting for rate cuts' },
  { symbol: 'FCCL', shares: 45, avg_cost: 52.3, sector: 'Cement', is_shariah: true, status: 'hold_no_add', note: 'Waiting for rate cuts' },
  { symbol: 'AVN', shares: 100, avg_cost: 29.31, sector: 'Technology', is_shariah: true, status: 'review', note: 'Weak earnings, re-check after its Oct 30 results' },
];

export const SEED_WATCHLIST: WatchItem[] = ['MARI', 'HUBC', 'FFC', 'OGDC', 'PPL'].map((symbol) => ({ symbol, note: 'Suggested candidate' }));

export const SEED_SETTINGS = { ...DEFAULT_SETTINGS };

export const SEED_PRICES = captured.prices as unknown as PriceMap;
export const SEED_INDEX = captured.index as IndexSnapshot;
export const SEED_ANNOUNCEMENTS = captured.announcements as Announcement[];
export const SEED_CAPTURED_AT = captured.captured_at;
export const SEED_SCREEN = ((captured as any).screen ?? []) as ScreenRow[];
