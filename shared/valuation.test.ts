import { describe, expect, it } from 'vitest';
import { peFor, peMap, sectorStats } from './valuation.ts';
import { lossQuartersInARow, valueCheck } from './portfolio.ts';
import { undervalued, type ScreenRow } from './discover.ts';
import { DEFAULT_RULES, type EpsBasis, type Price, type QuarterEarnings } from './types.ts';

const q = (id: string, symbol: string, period_end: string, eps: number | null, eps_basis: EpsBasis | null = 'consolidated', period_months: number | null = 3): QuarterEarnings =>
  ({ id, symbol, period_end, profit_after_tax: (eps ?? 0) * 1e6, verified: true, eps, eps_basis, period_months });
const price = (symbol: string, over: Partial<Price> = {}): Price => ({
  symbol, name: null, sector: 'CEMENT', price: 100, change: null, change_pct: null, volume: null, ldcp: null,
  high_52w: null, low_52w: null, dividend_yield_pct: null, pe: null, is_shariah: null, as_of: null, ...over,
});

describe('peFor', () => {
  it('pe basis consolidated four quarters', () => {
    // Four consolidated quarters (EPS 2 + 3 + 2.5 + 2.5 = 10), plus an unconsolidated set and an older annual that must not win.
    const earnings = [
      q('c1', 'LUCK', '2025-12-31', 2), q('c2', 'LUCK', '2026-03-31', 3), q('c3', 'LUCK', '2026-06-30', 2.5), q('c4', 'LUCK', '2026-09-30', 2.5),
      q('u1', 'LUCK', '2026-09-30', 9, 'unconsolidated'), q('u2', 'LUCK', '2026-06-30', 9, 'unconsolidated'),
      q('a1', 'LUCK', '2025-06-30', 7, 'consolidated', 12),
      q('x1', 'OTHER', '2026-09-30', 50),
    ];
    const r = peFor('LUCK', 120, earnings, 4.2);
    expect(r).toMatchObject({ pe: 12, basis: 'consolidated', eps: 10, outlier: false, loss: false });
    expect(r.label).toBe('consolidated, last 4 quarters');
  });

  it('falls back to the latest 12-month EPS, then unconsolidated, then the PSX figure', () => {
    const annual = [q('a1', 'X', '2025-06-30', 8, 'consolidated', 12), q('a2', 'X', '2026-06-30', 10, 'consolidated', 12), q('q1', 'X', '2026-09-30', 3)];
    expect(peFor('X', 50, annual, 9)).toMatchObject({ pe: 5, basis: 'consolidated', eps: 10, label: 'consolidated, year to Jun 2026' });
    const unc = [q('u', 'X', '2026-06-30', 4, 'unconsolidated', 12)];
    expect(peFor('X', 50, unc, 9)).toMatchObject({ pe: 12.5, basis: 'unconsolidated', label: 'unconsolidated, year to Jun 2026' });
    // Half-year and nine-month figures are cumulative, never a full year.
    expect(peFor('X', 50, [q('h', 'X', '2026-06-30', 4, 'consolidated', 6)], 8)).toMatchObject({ pe: 8, basis: 'psx', eps: 6.25, label: 'PSX figure, basis not stated' });
    expect(peFor('X', 50, [], null)).toMatchObject({ pe: null, basis: 'psx', eps: null, outlier: false, loss: false });
  });

  it('four quarters must be the last four in a row: a gap year falls back to the annual figure', () => {
    const gap = [q('1', 'X', '2024-12-31', 1), q('2', 'X', '2025-03-31', 1), q('3', 'X', '2026-06-30', 1), q('4', 'X', '2026-09-30', 1), q('a', 'X', '2026-06-30', 6, 'consolidated', 12)];
    expect(peFor('X', 60, gap, null)).toMatchObject({ pe: 10, eps: 6, label: 'consolidated, year to Jun 2026' });
  });

  it('pe basis negative eps', () => {
    const loss = [q('a', 'X', '2026-06-30', -2.4, 'consolidated', 12)];
    const r = peFor('X', 50, loss, 7);
    expect(r).toMatchObject({ pe: null, basis: 'consolidated', eps: -2.4, loss: true, outlier: false });
    expect(peFor('X', 50, [q('z', 'X', '2026-06-30', 0, 'consolidated', 12)], 7)).toMatchObject({ pe: null, loss: true });
    // PSX's own negative P/E is a loss too; a 0 is a missing figure, not a loss.
    expect(peFor('X', 50, [], -4)).toMatchObject({ pe: null, basis: 'psx', loss: true });
    expect(peFor('X', 50, [], 0)).toMatchObject({ pe: null, basis: 'psx', loss: false });
    // The rules then make no value check from it.
    const v = valueCheck('X', price('X', { price: 50, pe: 7 }), 'CEMENT', { sectorPe: { CEMENT: 8 }, earnings: loss });
    expect(v.ok).toBe(false);
    expect(v.text).toBe('P/E n/a (loss): no value check');
  });

  it('eps max age: a basis whose newest figure is older than valuation.eps_max_age_months gives way to the next basis, then PSX', () => {
    const today = '2026-10-23'; // 15 months back is 2025-07-23
    const stale = q('c', 'X', '2024-06-30', 10, 'consolidated', 12);
    const unc = q('u', 'X', '2026-06-30', 5, 'unconsolidated', 12);
    expect(peFor('X', 50, [stale, unc], 9, DEFAULT_RULES, today)).toMatchObject({ pe: 10, basis: 'unconsolidated', label: 'unconsolidated, year to Jun 2026' });
    expect(peFor('X', 50, [stale], 9, DEFAULT_RULES, today)).toMatchObject({ pe: 9, basis: 'psx', label: 'PSX figure, basis not stated' });
    // Four old quarters are stale too.
    const oldQuarters = ['2023-12-31', '2024-03-31', '2024-06-30', '2024-09-30'].map((d, i) => q(`q${i}`, 'X', d, 2));
    expect(peFor('X', 50, oldQuarters, 9, DEFAULT_RULES, today).basis).toBe('psx');
    expect(peFor('X', 50, [q('f', 'X', '2025-09-30', 10, 'consolidated', 12)], 9, DEFAULT_RULES, today).basis).toBe('consolidated'); // inside 15 months
    // The setting decides.
    const rules = { ...DEFAULT_RULES, valuation: { ...DEFAULT_RULES.valuation, eps_max_age_months: 30 } };
    expect(peFor('X', 50, [stale], 9, rules, today)).toMatchObject({ pe: 5, basis: 'consolidated', label: 'consolidated, year to Jun 2024' });
    expect(DEFAULT_RULES.valuation.eps_max_age_months).toBe(15);
  });

  it('flags an unusual P/E from any basis, and peMap reads many symbols', () => {
    expect(peFor('X', 300, [q('a', 'X', '2026-06-30', 1, 'consolidated', 12)], null)).toMatchObject({ pe: 300, outlier: true });
    const m = peMap([{ symbol: 'A', price: 50, pe: 5 }, { symbol: 'B', price: null, pe: 6 }], [q('a', 'A', '2026-06-30', 10, 'consolidated', 12)]);
    expect(m.A).toMatchObject({ pe: 5, basis: 'consolidated' });
    expect(m.B).toMatchObject({ pe: 6, basis: 'psx', eps: null });
  });
});

describe('value check wording', () => {
  it('valueCheck outlier wording', () => {
    const v = valueCheck('AHCL', price('AHCL', { pe: 1.46 }), 'CEMENT', { sectorPe: { CEMENT: 8 } });
    expect(v).toEqual({ ok: false, text: 'P/E 1.5 looks unusual; check figures' });
    expect(v.text).not.toMatch(/no P\/E figure/);
    // No figure at all still says so.
    expect(valueCheck('X', price('X', { pe: null }), 'CEMENT', { sectorPe: { CEMENT: 8 } }).text).toBe('no P/E figure to check its value');
    // The filing-based P/E is the one checked when there is one: 100 / 20 = 5 against the sector's 8.
    const filed = valueCheck('X', price('X', { pe: 30 }), 'CEMENT', { sectorPe: { CEMENT: 8 }, earnings: [q('a', 'X', '2026-06-30', 20, 'consolidated', 12)] });
    expect(filed).toEqual({ ok: true, text: "P/E 5.0, at or under its sector's 8.0" });
  });
});

describe('quarters and cumulative figures', () => {
  it('half-year and full-year rows never count as quarters for the loss rules', () => {
    const rows = [q('q1', 'X', '2026-03-31', -1), q('q2', 'X', '2026-06-30', 2), q('h', 'X', '2026-06-30', -3, 'consolidated', 6), q('y', 'X', '2026-09-30', -5, 'consolidated', 12)];
    expect(lossQuartersInARow('X', rows)).toEqual({ count: 0, latest: '2026-06-30' });
    expect(lossQuartersInARow('X', [{ ...rows[0], period_months: null }])).toEqual({ count: 1, latest: '2026-03-31' }); // older rows were all quarters
  });
});

describe('sector P/E', () => {
  const row = (symbol: string, sector: string, pe: number | null) => ({ symbol, sector, pe });
  it('sector min peers', () => {
    const four = ['A', 'B', 'C', 'D'].map((s, i) => row(s, 'CEMENT', 6 + i));
    expect(sectorStats(four).CEMENT).toMatchObject({ peers: 4, comparable: false });
    const five = [...four, row('E', 'CEMENT', 10), row('F', 'CEMENT', 1.2), row('G', 'CEMENT', 0)]; // 1.2 and 0 are not trusted
    expect(sectorStats(five).CEMENT).toEqual({ median: 8, peers: 5, comparable: true });
    // The setting decides: with 4 peers needed, four is enough.
    const rules = { ...DEFAULT_RULES, undervalued: { ...DEFAULT_RULES.undervalued, sector_min_peers: 4 } };
    expect(sectorStats(four, rules).CEMENT.comparable).toBe(true);
  });

  it('sector too mixed', () => {
    // Median 10, quartiles 5 and 40: a spread of 35 is wider than the median.
    const mixed = [3, 5, 10, 40, 60].map((pe, i) => row(`M${i}`, 'TECH', pe));
    expect(sectorStats(mixed).TECH).toMatchObject({ median: 10, peers: 5, comparable: false });
    // Filing-based P/Es replace PSX's when given: the same sector, now tight.
    const pe = { M0: { pe: 9 }, M3: { pe: 11 }, M4: { pe: 12 } };
    expect(sectorStats(mixed, DEFAULT_RULES, pe).TECH).toMatchObject({ median: 10, comparable: true });
    // Discover then claims no discount for the cheap one, and says why.
    const screen: ScreenRow[] = mixed.map((r) => ({ ...r, price: 100, change_pct: 0, dividend_yield_pct: 6, market_cap: 1e10, is_shariah: true }));
    const [m0] = undervalued(screen);
    expect(m0).toMatchObject({ symbol: 'M0', sector_pe: null, discount_pct: null, sector_note: 'sector too mixed to compare' });
    expect(m0.reason).toBe('P/E 3.0 · sector too mixed to compare · 6.0% yield');
  });
});
