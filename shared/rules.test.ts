import { describe, expect, it } from 'vitest';
import { allocate, nextTradingDay, planToText } from './allocate.ts';
import { applyBuy, buildPortfolio } from './portfolio.ts';
import { holdingAlerts, marketAlerts, marketState, planDelivery, todayBanner } from './signals.ts';
import { isMarketOpen, isStale, isoWeek } from './time.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS, type PriceMap } from './types.ts';
import { SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_SETTINGS, SEED_WATCHLIST } from './fixtures/seed.ts';

const TODAY = '2026-10-06'; // a Tuesday

const seedPlan = (amount = 50000, extra: Partial<Parameters<typeof allocate>[0]> = {}) =>
  allocate({ amount, holdings: SEED_HOLDINGS, watchlist: SEED_WATCHLIST, prices: SEED_PRICES, settings: SEED_SETTINGS, today: TODAY, ...extra });

describe('portfolio', () => {
  it('values the seed portfolio like the spec says (about Rs 56k, SYS about 24%)', () => {
    const v = buildPortfolio(SEED_HOLDINGS, SEED_PRICES, SEED_SETTINGS);
    expect(v.total_value).toBeGreaterThan(54000);
    expect(v.total_value).toBeLessThan(59000);
    const sys = v.rows.find((r) => r.holding.symbol === 'SYS')!;
    expect(sys.weight_pct!).toBeGreaterThan(22);
    expect(sys.weight_pct!).toBeLessThanOrEqual(25);
    expect(v.missing_prices).toEqual([]);
    // P/L is value minus cost of the same holdings
    expect(v.total_pnl).toBeCloseTo(v.total_value - v.total_cost, 6);
  });

  it('flags below-cost holdings at the drop threshold', () => {
    const v = buildPortfolio(SEED_HOLDINGS, SEED_PRICES, SEED_SETTINGS);
    const below = v.rows.filter((r) => r.flags.below_cost).map((r) => r.holding.symbol).sort();
    // SYS 114.37 vs 130.45 (-12.3%), LUCK 407.54 vs 458.39 (-11.1%); EFERT is -9.9%, just inside
    expect(below).toEqual(['LUCK', 'SYS']);
  });

  it('shows "no data" (null), never a made-up value, when a price is missing', () => {
    const prices: PriceMap = { ...SEED_PRICES, SYS: { ...SEED_PRICES.SYS, price: null } };
    const v = buildPortfolio(SEED_HOLDINGS, prices, SEED_SETTINGS);
    const sys = v.rows.find((r) => r.holding.symbol === 'SYS')!;
    expect(sys.value).toBeNull();
    expect(sys.pnl).toBeNull();
    expect(v.missing_prices).toEqual(['SYS']);
  });
});

describe('mark as bought', () => {
  it('updates shares and weighted average cost', () => {
    const mebl = SEED_HOLDINGS.find((h) => h.symbol === 'MEBL')!; // 20 @ 583.06
    const after = applyBuy(mebl, 'MEBL', 8, 548.11);
    expect(after.shares).toBe(28);
    expect(after.avg_cost).toBeCloseTo((20 * 583.06 + 8 * 548.11) / 28, 2);
    expect(after.status).toBe('core');
  });
  it('starts a new core holding with PSX sector and Shariah flag', () => {
    const h = applyBuy(undefined, 'HUBC', 26, 195.57, SEED_PRICES.HUBC);
    expect(h).toMatchObject({ symbol: 'HUBC', shares: 26, avg_cost: 195.57, status: 'core', is_shariah: true, sector: 'POWER GENERATION & DISTRIBUTION' });
  });
  it('rejects bad input', () => {
    expect(() => applyBuy(undefined, 'X', 1.5, 10)).toThrow();
    expect(() => applyBuy(undefined, 'X', 1, 0)).toThrow();
  });
});

describe('section 9 acceptance test: seed portfolio + Rs 50,000', () => {
  const plan = seedPlan();
  const items = plan.tranches.flatMap((t) => t.items);

  it('splits the cash into three dated tranches (40/40/20, ~0, ~14, ~25 days)', () => {
    expect(plan.tranches).toHaveLength(3);
    expect(plan.tranches.map((t) => t.budget)).toEqual([20000, 20000, 10000]);
    expect(plan.tranches[0].date).toBe('2026-10-06');
    expect(plan.tranches[1].date).toBe('2026-10-20');
    expect(plan.tranches[2].date).toBe('2026-11-02'); // Oct 31 is a Saturday -> Monday
    expect(plan.tranches[2].is_buffer).toBe(true);
  });

  it('keeps every stock at or below the 25% cap after buying', () => {
    for (const [sym, w] of Object.entries(plan.weights_after)) {
      expect(w, sym).toBeLessThanOrEqual(25 + 1e-9);
    }
  });

  it('gives no new money to hold_no_add or review holdings', () => {
    const banned = SEED_HOLDINGS.filter((h) => h.status !== 'core').map((h) => h.symbol);
    expect(items.filter((i) => banned.includes(i.symbol))).toEqual([]);
    expect(plan.skipped.map((s) => s.symbol)).toEqual(expect.arrayContaining(banned));
  });

  it('buys whole shares only, and never spends more than the amount', () => {
    for (const i of items) {
      expect(Number.isInteger(i.shares)).toBe(true);
      expect(i.shares).toBeGreaterThan(0);
      expect(i.rupees).toBeCloseTo(i.shares * i.price, 2);
    }
    const spent = items.reduce((a, i) => a + i.rupees, 0);
    expect(spent + plan.unallocated).toBeCloseTo(50000, 2);
    expect(plan.unallocated).toBeGreaterThanOrEqual(0);
  });

  it('averages down only core holdings below cost, and adds SYS only a little now (near cap)', () => {
    const avg = items.filter((i) => i.kind === 'average_down').map((i) => i.symbol);
    expect(new Set(avg)).toEqual(new Set(['SYS', 'MEBL', 'UBL'])); // DCR is above cost
    // SYS starts at ~24%: tranche 1 can only add a little before it hits 25%.
    const sysNow = plan.tranches[0].items.find((i) => i.symbol === 'SYS')!;
    expect(sysNow.rupees).toBeLessThan(1000);
    expect(sysNow.reason).toMatch(/capped/);
  });

  it('warns if a sector would end above the sector limit', () => {
    expect(plan.warnings.filter((w) => w.includes('sector limit'))).toEqual([]);
    const heavyBanks = seedPlan(50000, { watchlist: [{ symbol: 'MEBL' }, { symbol: 'UBL' }] });
    expect(heavyBanks.warnings.some((w) => w.includes('sector limit'))).toBe(true);
  });

  it('sends roughly half of each tranche to watchlist names, every line has a reason', () => {
    const t1 = plan.tranches[0];
    const watch = t1.items.filter((i) => i.kind === 'watchlist').reduce((a, i) => a + i.rupees, 0);
    expect(watch).toBeGreaterThan(t1.available * 0.3);
    expect(items.every((i) => i.reason.length > 10)).toBe(true);
    expect(planToText(plan)).toContain('Not licensed financial advice');
  });
});

describe('allocation edge cases', () => {
  it('excludes an over-cap holding from new buys', () => {
    const holdings = SEED_HOLDINGS.map((h) => (h.symbol === 'SYS' ? { ...h, shares: 400 } : h));
    const plan = seedPlan(50000, { holdings });
    expect(plan.tranches.flatMap((t) => t.items).some((i) => i.symbol === 'SYS')).toBe(false);
  });

  it('respects shariah_only: UBL (not in KMI All Share) gets nothing', () => {
    const plan = seedPlan(50000, { settings: { ...SEED_SETTINGS, shariah_only: true } });
    expect(plan.tranches.flatMap((t) => t.items).some((i) => i.symbol === 'UBL')).toBe(false);
    expect(plan.skipped.find((s) => s.symbol === 'UBL')?.reason).toMatch(/Shariah/);
  });

  it('handles zero cash and tiny cash without crashing', () => {
    expect(seedPlan(0).tranches.flatMap((t) => t.items)).toEqual([]);
    const tiny = seedPlan(300);
    expect(tiny.unallocated).toBe(300);
  });

  it('skips watchlist names with no live price', () => {
    const prices: PriceMap = { ...SEED_PRICES, MARI: { ...SEED_PRICES.MARI, price: null } };
    const plan = seedPlan(50000, { prices });
    expect(plan.tranches.flatMap((t) => t.items).some((i) => i.symbol === 'MARI')).toBe(false);
  });

  it('moves weekend dates to Monday', () => {
    expect(nextTradingDay('2026-10-10')).toBe('2026-10-12');
    expect(nextTradingDay('2026-10-11')).toBe('2026-10-12');
    expect(nextTradingDay('2026-10-12')).toBe('2026-10-12');
  });
});

describe('market rules and banner', () => {
  const idx = (kse100: number, change_pct: number) => ({ ts: '2026-10-06T10:00:00Z', kse100, change: 0, change_pct });
  const s = DEFAULT_SETTINGS;

  it('classifies dip, crash, crash level and rally at the spec thresholds', () => {
    expect(marketState(idx(165000, -2), s)).toBe('dip');
    expect(marketState(idx(165000, -1.99), s)).toBe('normal');
    expect(marketState(idx(165000, -4), s)).toBe('crash');
    expect(marketState(idx(154000, -0.5), s)).toBe('crash_level');
    expect(marketState(idx(165000, 2.5), s)).toBe('rally');
    expect(marketState(null, s)).toBe('no_data');
  });

  it('banner answers buy / hold / wait with a reason', () => {
    expect(todayBanner(idx(165000, -3), s).action).toBe('Buy');
    expect(todayBanner(idx(165000, 3), s).action).toBe('Wait');
    const hold = todayBanner(SEED_INDEX, s);
    expect(hold.action).toBe('Hold');
    expect(hold.reason).toMatch(/Crash-fund trigger is 6\.\d% away/);
    expect(todayBanner(null, s).action).toBe('Wait');
    expect(todayBanner(SEED_INDEX, s, { trancheDue: { index: 2, date: TODAY } }).action).toBe('Buy');
  });

  it('crash and crash-level alerts are urgent; crash fund is half of it', () => {
    const a = marketAlerts(idx(150000, -5), s, TODAY);
    expect(a.map((x) => x.kind).sort()).toEqual(['crash', 'crash_level']);
    expect(a.every((x) => x.urgent)).toBe(true);
    expect(a[0].message).toContain('Rs 25,000');
  });
});

describe('holding alerts', () => {
  const view = buildPortfolio(SEED_HOLDINGS, SEED_PRICES, SEED_SETTINGS);

  it('below-cost alerts repeat at most every 7 days', () => {
    const never = holdingAlerts(view, SEED_SETTINGS, TODAY, () => null);
    expect(never.filter((a) => a.kind === 'below_cost').map((a) => a.symbol).sort()).toEqual(['LUCK', 'SYS']);
    const recent = holdingAlerts(view, SEED_SETTINGS, TODAY, () => '2026-10-01');
    expect(recent.filter((a) => a.kind === 'below_cost')).toEqual([]);
    const old = holdingAlerts(view, SEED_SETTINGS, TODAY, () => '2026-09-29');
    expect(old.filter((a) => a.kind === 'below_cost')).toHaveLength(2);
  });

  it('flags a 5% day move and an over-cap position', () => {
    const prices: PriceMap = { ...SEED_PRICES, DCR: { ...SEED_PRICES.DCR, change_pct: -5.2 } };
    const holdings = SEED_HOLDINGS.map((h) => (h.symbol === 'SYS' ? { ...h, shares: 400 } : h));
    const a = holdingAlerts(buildPortfolio(holdings, prices, SEED_SETTINGS), SEED_SETTINGS, TODAY, () => null);
    expect(a.find((x) => x.kind === 'big_move')?.symbol).toBe('DCR');
    expect(a.find((x) => x.kind === 'over_cap')?.symbol).toBe('SYS');
  });
});

describe('delivery limits', () => {
  const dip = { kind: 'dip', symbol: null, title: 't', message: 'm', dedupe_key: 'd', urgent: false, url: '/#/plan' };
  const crash = { ...dip, kind: 'crash', urgent: true, dedupe_key: 'c' };
  const noonPkt = new Date('2026-10-06T07:00:00Z');
  const midnightPkt = new Date('2026-10-06T19:00:00Z'); // 00:00 PKT
  const base = { now: noonPkt, sentToday: 0, quiet: { start: '23:00', end: '07:00' }, enabled: true };

  it('bundles several alerts into one notification', () => {
    const r = planDelivery([dip, { ...dip, symbol: 'SYS', kind: 'below_cost' }, { ...dip, symbol: 'LUCK', kind: 'below_cost' }], base);
    expect(r.send).toHaveLength(1);
    expect(r.send[0].alerts).toHaveLength(3);
  });

  it('stops at 3 a day, but crash always goes through', () => {
    const r = planDelivery([dip, crash], { ...base, sentToday: 3 });
    expect(r.send.map((n) => n.urgent)).toEqual([true]);
    expect(r.suppressed).toEqual([dip]);
  });

  it('respects quiet hours 23:00-07:00 PKT except for crash', () => {
    const r = planDelivery([dip, crash], { ...base, now: midnightPkt });
    expect(r.send).toHaveLength(1);
    expect(r.send[0].urgent).toBe(true);
    expect(r.suppressed).toEqual([dip]);
  });

  it('sends nothing when the user turned notifications off', () => {
    expect(planDelivery([crash], { ...base, enabled: false }).send).toEqual([]);
  });
});

describe('time helpers', () => {
  const hours = DEFAULT_RULES.market_hours_pkt;
  it('knows PSX hours (Mon-Thu, Friday split session, weekend closed)', () => {
    expect(isMarketOpen(new Date('2026-10-06T07:00:00Z'), hours)).toBe(true); // Tue 12:00 PKT
    expect(isMarketOpen(new Date('2026-10-09T08:00:00Z'), hours)).toBe(false); // Fri 13:00 PKT (prayer break)
    expect(isMarketOpen(new Date('2026-10-09T11:00:00Z'), hours)).toBe(true); // Fri 16:00 PKT
    expect(isMarketOpen(new Date('2026-10-10T07:00:00Z'), hours)).toBe(false); // Saturday
  });
  it('marks data stale only during market hours', () => {
    const asOf = '2026-10-06T05:00:00Z'; // 10:00 PKT
    expect(isStale(asOf, new Date('2026-10-06T07:00:00Z'), 30, hours)).toBe(true);
    expect(isStale(asOf, new Date('2026-10-06T05:20:00Z'), 30, hours)).toBe(false);
    expect(isStale('2026-10-05T10:49:00Z', new Date('2026-10-05T20:00:00Z'), 30, hours)).toBe(false); // after close
  });
  it('builds ISO week keys', () => {
    expect(isoWeek('2026-10-06')).toBe('2026-W41');
  });
});
