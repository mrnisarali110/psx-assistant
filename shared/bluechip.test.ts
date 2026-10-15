import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bcDue, configHash, evaluateBc, indexChanges, marketCapRanks, nextBcState, profitByYear, type AnnualProfit, type BcFacts } from './bluechip.ts';
import { DEFAULT_RULES, type DividendEvent, type Rules } from './types.ts';

const TODAY = '2026-10-16';
const div = (symbol: string, announced_on: string, dps = 5, type: DividendEvent['dividend_type'] = 'final'): DividendEvent =>
  ({ id: `${symbol}-${announced_on}`, symbol, announced_on, dps, dividend_type: type, book_closure_from: null, book_closure_to: null, verified: true, pdf_url: null });
const annual = (symbol: string, year: number, profit: number, source: AnnualProfit['source'] = 'psx_financials', consolidated: boolean | null = null): AnnualProfit =>
  ({ symbol, year, profit_after_tax: profit, source, consolidated });

/** A company that passes every check (made-up symbol: tests never use a real ticker list either). */
const strong = (o: Partial<BcFacts> = {}): BcFacts => ({
  symbol: 'AAA', today: TODAY, index_members: ['KSE100', 'KSE30'], market_cap_rank: 5, avg_volume_30d: 2_000_000, price: 400,
  annual: [2025, 2024, 2023, 2022, 2021].map((y) => annual('AAA', y, 1e9)),
  dividends: ['2026-08-20', '2025-08-20', '2024-08-20', '2023-08-20', '2022-08-20'].map((d) => div('AAA', d)),
  filings_since: '2021-01-01', audit: { symbol: 'AAA', year: 2025, qualified: false, filing_id: 'psx-doc-1' }, ...o,
});
/** Your original strict rule set (5 profit years, dividends from filings only, audit report required). */
const STRICT: Rules = { ...DEFAULT_RULES, bluechip: { ...DEFAULT_RULES.bluechip, profit_years: 5, dividend_mode: 'strict', require_audit_check: true } };
const check = (f: BcFacts, key: string, rules: Rules = STRICT) => evaluateBc(f, rules).checks.find((c) => c.key === key)!;

describe('each BC rule', () => {
  it('a company passing all five checks is a blue chip, with real numbers on every line', () => {
    const r = evaluateBc(strong(), STRICT);
    expect(r.status).toBe('pass');
    expect(r.checks.map((c) => c.detail)).toEqual([
      'KSE30 member', 'avg traded Rs 800M/day (needs Rs 50M)', 'profitable 5/5 years (2021-2025)',
      'dividends in 5 of the last 5 years', 'trading · not a defaulter (KSE30 member) · clean audit opinion 2025',
    ]);
  });
  it('1 size: index member, or top N by market cap; otherwise fail', () => {
    expect(check(strong({ index_members: ['KSE100'], market_cap_rank: 12 }), 'size')).toMatchObject({ ok: true, detail: '#12 by market cap' });
    expect(check(strong({ index_members: ['KSE100'], market_cap_rank: 45 }), 'size').ok).toBe(false);
  });
  it('2 liquidity: average traded value against the threshold', () => {
    expect(check(strong({ avg_volume_30d: 100_000, price: 400 }), 'liquidity')).toMatchObject({ ok: false, detail: 'avg traded Rs 40M/day (needs Rs 50M)' });
  });
  it('3 profit: a loss in any of the last 5 years fails', () => {
    const f = strong({ annual: [2025, 2024, 2023, 2022, 2021].map((y) => annual('AAA', y, y === 2023 ? -5e8 : 1e9)) });
    expect(check(f, 'profit')).toMatchObject({ ok: false, detail: 'loss in 2023; profitable 4/5 years' });
  });
  it('4 dividends: 4 of 5 years passes, 3 of 5 with every year covered fails, specials do not count', () => {
    expect(check(strong({ dividends: ['2026-08-20', '2025-08-20', '2024-08-20', '2023-08-20'].map((d) => div('AAA', d)) }), 'dividends').ok).toBe(true);
    expect(check(strong({ dividends: ['2026-08-20', '2025-08-20', '2024-08-20'].map((d) => div('AAA', d)) }), 'dividends').ok).toBe(false);
    expect(check(strong({ dividends: [...['2026-08-20', '2025-08-20', '2024-08-20'].map((d) => div('AAA', d)), div('AAA', '2023-08-20', 50, 'special')] }), 'dividends').ok).toBe(false);
  });
  it('5 red flags: suspended (no trades) or a qualified audit opinion fails', () => {
    expect(check(strong({ avg_volume_30d: 0 }), 'red_flags')).toMatchObject({ ok: false, detail: 'no trades in 30 days (suspended?)' });
    expect(check(strong({ audit: { symbol: 'AAA', year: 2025, qualified: true, filing_id: 'psx-doc-9' } }), 'red_flags'))
      .toMatchObject({ ok: false, detail: 'qualified audit opinion in the 2025 annual report' });
  });
  it('thresholds come from the config, not the code', () => {
    const loose: Rules = { ...DEFAULT_RULES, bluechip: { ...DEFAULT_RULES.bluechip, min_traded_value_pkr: 10_000_000 } };
    expect(evaluateBc(strong({ avg_volume_30d: 100_000, price: 400 }), loose).checks[1].ok).toBe(true);
  });
});

describe('missing data: "not enough data", never a guess', () => {
  it('four of five profit years read is unknown, not a pass', () => {
    const f = strong({ annual: [2025, 2024, 2023, 2022].map((y) => annual('AAA', y, 1e9)) });
    expect(check(f, 'profit')).toMatchObject({ ok: null, detail: 'profitable 4/5 years read; 2021 not read yet' });
    expect(evaluateBc(f, STRICT).status).toBe('unknown');
  });
  it('years before the first filing we read are unknown for dividends', () => {
    const f = strong({ dividends: [div('AAA', '2026-08-20')], filings_since: '2026-06-01' });
    expect(check(f, 'dividends')).toMatchObject({ ok: null, detail: 'dividends in 1 of the last 5 years (4 not covered by filings read so far)' });
  });
  it('no screener row, no annual report, no defaulter evidence: unknown', () => {
    const f = strong({ index_members: null, market_cap_rank: null, audit: null });
    const r = evaluateBc(f, STRICT);
    expect(r.status).toBe('unknown');
    expect(nextBcState(null, r, TODAY).status).toBe('not_enough_data');
    expect(nextBcState(null, r, TODAY).badge).toBe(false);
  });
});

describe('consolidated vs unconsolidated profit', () => {
  it('a consolidated figure wins over the unconsolidated one for the same year (a holding company booking investment gains)', () => {
    const rows = [annual('AAA', 2025, 4.4e10, 'psx_financials', null), annual('AAA', 2025, -2e9, 'filing', true), annual('AAA', 2025, 4.4e10, 'filing', false)];
    expect(profitByYear(rows).get(2025)).toMatchObject({ profit_after_tax: -2e9, consolidated: true });
    const f = strong({ annual: [...[2024, 2023, 2022, 2021].map((y) => annual('AAA', y, 1e9)), ...rows] });
    expect(check(f, 'profit').ok).toBe(false);
  });
});

describe('the badge does not flicker', () => {
  const fail = evaluateBc(strong({ avg_volume_30d: 10_000 }), STRICT);
  const pass = evaluateBc(strong(), STRICT);
  it('gains BC at once, is "at risk" after one failed recheck, loses it after the second', () => {
    const s1 = nextBcState(null, pass, TODAY);
    expect(s1).toMatchObject({ status: 'bc', badge: true, fails: 0 });
    const s2 = nextBcState(s1, fail, '2026-10-23');
    expect(s2).toMatchObject({ status: 'at_risk', badge: true, fails: 1 });
    expect(s2.reason).toMatch(/^Easy to trade: avg traded Rs 4M\/day/);
    const s3 = nextBcState(s2, fail, '2026-10-30');
    expect(s3).toMatchObject({ status: 'not_bc', badge: false, lost_on: '2026-10-30' });
    expect(nextBcState(s2, pass, '2026-10-30')).toMatchObject({ status: 'bc', fails: 0 }); // recovered: the count resets
  });
  it('a stock that never had BC is simply not BC on a fail', () => {
    expect(nextBcState(null, fail, TODAY)).toMatchObject({ status: 'not_bc', badge: false });
  });
});

describe('KSE-30 changes and the recheck schedule', () => {
  it('detects who joined and left the index from two readings of PSX data', () => {
    expect(indexChanges(['AAA', 'BBB', 'CCC'], ['BBB', 'CCC', 'DDD'])).toEqual({ added: ['DDD'], removed: ['AAA'] });
  });
  it('a stock leaving KSE-30 and outside the top 30 by market cap fails size on its next check', () => {
    expect(check(strong({ index_members: ['KSE100'], market_cap_rank: 31 }), 'size').ok).toBe(false);
  });
  it('ranks market caps from the screener, largest first', () => {
    expect(marketCapRanks([{ symbol: 'A', market_cap: 5 }, { symbol: 'B', market_cap: 9 }, { symbol: 'C', market_cap: null }])).toEqual({ B: 1, A: 2 });
  });
  it('rechecks weekly, after a filing, on a membership change, when the config changes and once in the annual season', () => {
    const s = nextBcState(null, evaluateBc(strong(), STRICT), '2026-08-03');
    expect(bcDue(null, { today: TODAY })).toBe(true);
    expect(bcDue(s, { today: '2026-08-05' })).toBe(false);
    expect(bcDue(s, { today: '2026-08-10' })).toBe(true); // 7 days
    expect(bcDue(s, { today: '2026-08-05', newFiling: true })).toBe(true);
    expect(bcDue(s, { today: '2026-08-05', membershipChanged: true })).toBe(true);
    expect(bcDue({ ...s, config_hash: 'old' }, { today: '2026-08-05' })).toBe(true);
    expect(configHash()).toBe(s.config_hash);
    const sept = nextBcState(null, evaluateBc(strong(), STRICT), '2026-09-01');
    expect(bcDue({ ...sept, checked_on: '2026-08-31' }, { today: '2026-09-01' })).toBe(true); // first check of the season month
  });
});

describe('no ticker list in the code', () => {
  it('the blue-chip code and its worker hold no hard-coded symbols', () => {
    const files = ['shared/bluechip.ts', 'worker/bluechip.ts', ...readdirSync('src/components').filter((f) => /^Bc|BlueChip/.test(f)).map((f) => `src/components/${f}`)];
    const words = new Set(['KSE', 'PSX', 'BC', 'AI', 'PDF', 'NCCPL', 'CGT', 'XD', 'XB', 'XR', 'ATL', 'PKT', 'UTC', 'JSON', 'HTML']);
    for (const f of files) {
      let src: string;
      try { src = readFileSync(f, 'utf8'); } catch { continue; }
      const quoted = [...src.matchAll(/['"`]([A-Z][A-Z0-9]{2,9})['"`]/g)].map((m) => m[1]).filter((w) => !words.has(w));
      expect({ file: f, quoted }).toEqual({ file: f, quoted: [] });
    }
  });
});

describe('relaxed defaults: what PSX publishes now', () => {
  const relaxed = (o: Partial<BcFacts> = {}) => strong({
    annual: [2025, 2024, 2023, 2022].map((y) => annual('AAA', y, 1e9)), dividends: [div('AAA', '2026-08-20')],
    filings_since: '2026-06-01', audit: null, trailing_yield_pct: 6.2, ...o,
  });
  it('4 of 4 PSX profit years, a dividend paid now (PSX trailing yield) and no annual report read yet: a blue chip', () => {
    const r = evaluateBc(relaxed());
    expect(r.status).toBe('pass');
    expect(r.checks.find((c) => c.key === 'profit')!.detail).toBe('profitable 4/4 years (2022-2025)');
    expect(r.checks.find((c) => c.key === 'dividends')!.detail).toBe('pays now (PSX trailing yield 6.2%); dividends in 1 of 1 years covered by filings read so far');
  });
  it('no dividend in the last 12 months fails; a qualified audit opinion still fails once a report is read', () => {
    expect(evaluateBc(relaxed({ trailing_yield_pct: 0 })).checks.find((c) => c.key === 'dividends')!.ok).toBe(false);
    expect(evaluateBc(relaxed({ audit: { symbol: 'AAA', year: 2025, qualified: true, filing_id: 'psx-doc-2' } })).status).toBe('fail');
  });
  it('missing PSX yield is still "not enough data", never a guess', () => {
    expect(evaluateBc(relaxed({ trailing_yield_pct: null })).status).toBe('unknown');
  });
  it('changing the rule set changes the config fingerprint, so everything is rechecked', () => {
    expect(configHash(STRICT)).not.toBe(configHash());
  });
});
