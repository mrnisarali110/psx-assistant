import { describe, expect, it } from 'vitest';
import { allocationSlices, buildPortfolio, cleanInsight, mergeCall, sectorBreakdown, sectorSlices } from './portfolio.ts';
import { sectorLabel } from './format.ts';
import { applyBuy, cleanImported, describeChange, diffImport, investedThisMonth, txnFromChange, withLastBuy } from './changes.ts';
import { dividendLeaders, frequencyOf, sortDividends, sortUndervalued, sortUpcoming, undervalued, upcomingDividends, workingDaysBefore, type ScreenRow } from './discover.ts';
import { projectWealth, realValue } from './growth.ts';
import { payoutOf } from './quality.ts';
import { dayStance, holdingAlerts, marketAlerts, marketState, planDelivery, todayBanner, type AlertCandidate } from './signals.ts';
import { isMarketOpen, isStale, isoWeek, minutesToClose } from './time.ts';
import { DEFAULT_RULES, DEFAULT_SETTINGS, type AiInsight, type DividendEvent, type Holding, type PriceMap } from './types.ts';
import { SEED_HOLDINGS, SEED_INDEX, SEED_PRICES, SEED_SETTINGS, SEED_TXNS } from './fixtures/seed.ts';

const TODAY = '2026-10-06'; // a Tuesday
/** Sector P/Es where SYS, MEBL and UBL are cheap on earnings, so the price rules can be tested on their own. */
const CHEAP = { 'TECHNOLOGY & COMMUNICATION': 25, 'COMMERCIAL BANKS': 12 };
const view = () => buildPortfolio(SEED_HOLDINGS, SEED_PRICES, SEED_SETTINGS, DEFAULT_RULES, {}, { sectorPe: CHEAP });
const row = (sym: string, v = view()) => v.rows.find((r) => r.holding.symbol === sym)!;

describe('portfolio', () => {
  it('values the seed portfolio like the spec says (about Rs 56k, SYS about 24%)', () => {
    const v = view();
    expect(v.total_value).toBeGreaterThan(54000);
    expect(v.total_value).toBeLessThan(59000);
    expect(row('SYS', v).weight_pct!).toBeGreaterThan(22);
    expect(v.total_pnl).toBeCloseTo(v.total_value - v.total_cost, 6);
  });

  it('groups money by PSX sector for the Home donut and the full breakdown; unknown symbols take the screen\'s sector', () => {
    const v = view();
    const slices = sectorSlices(v);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100, 0);
    expect(slices[0].pct).toBeGreaterThanOrEqual(slices[1].pct);
    const groups = sectorBreakdown(v);
    expect(groups.reduce((a, g) => a + g.count, 0)).toBe(SEED_HOLDINGS.length);
    expect(groups.reduce((a, g) => a + g.value, 0)).toBeCloseTo(v.total_value, 2);
    const banks = groups.find((g) => g.rows.some((r) => r.holding.symbol === 'MEBL'))!;
    expect(banks.rows.map((r) => r.holding.symbol)).toContain('UBL');
    expect(banks.rows.reduce((a, r) => a + (r.sector_pct ?? 0), 0)).toBeCloseTo(100, 6);
    expect(v.sector_weights.find((w) => w.sector === banks.sector)).toMatchObject({ value: banks.value, count: banks.count });

    const noPrice: Holding = { symbol: 'HUBC', shares: 10, avg_cost: 100, sector: null, status: 'core', is_shariah: false, note: null };
    expect(buildPortfolio([noPrice], {}, SEED_SETTINGS, DEFAULT_RULES, { HUBC: 'POWER GENERATION & DISTRIBUTION' }).rows[0].sector).toBe('POWER GENERATION & DISTRIBUTION');
    expect(buildPortfolio([noPrice], {}, SEED_SETTINGS).rows[0].sector).toBe('Unknown');
    expect(sectorLabel('REAL ESTATE INVESTMENT TRUST')).toBe('Real Estate Investment Trust');
    expect(sectorLabel('REIT')).toBe('REIT');
  });

  it('shows "no data" (null), never a made-up value, when a price is missing', () => {
    const prices: PriceMap = { ...SEED_PRICES, SYS: { ...SEED_PRICES.SYS, price: null } };
    const v = buildPortfolio(SEED_HOLDINGS, prices, SEED_SETTINGS);
    expect(row('SYS', v).value).toBeNull();
    expect(v.missing_prices).toEqual(['SYS']);
  });

  it('calls each holding from how far it is below your LAST buy', () => {
    const v = view();
    expect(row('SYS', v).call).toMatchObject({ call: 'opportunity', source: 'rules' }); // 12.3% below
    // The seed records no buy, so the reference is the average cost, and the text names it with its price.
    expect(row('SYS', v).call.text).toMatch(/12\.3% below your average cost \(Rs 130\.45\)/);
    expect(row('MEBL', v).call.call).toBe('average_down'); // 6.0% below, core
    expect(row('DCR', v).call.call).toBe('hold'); // above
    expect(row('LUCK', v).call.call).toBe('hold'); // 11% below but hold_no_add
    expect(row('LUCK', v).call.text).toBe('11.1% below your average cost (Rs 458.39) · hold only');
    expect(row('AVN', v).call.call).toBe('review');
  });

  it('uses the last buy price, not the average cost, once a buy is recorded', () => {
    const holdings: Holding[] = SEED_HOLDINGS.map((h) => (h.symbol === 'MEBL' ? { ...h, last_buy_price: 550 } : h));
    const r = row('MEBL', buildPortfolio(holdings, SEED_PRICES, SEED_SETTINGS));
    expect(r.ref_price).toBe(550);
    expect(r.call.call).toBe('hold'); // 548.11 is only 0.3% below 550
    expect(r.call.text).toBe('0.3% below your last buy (Rs 550.00)');
  });

  it('lets the AI call a holding, unless it breaks your own rules or raises a Trim your rules do not support', () => {
    const v = view();
    const ai = { holding_calls: [
      { symbol: 'DCR', call: 'trim', text: '5.9% below last buy' }, // no rule says trim: refused, so a Trim always has a real reason
      { symbol: 'EFERT', call: 'average_down', text: 'cheap' }, // hold_no_add: refused
      { symbol: 'SYS', call: 'hold', text: 'wait for results' },
    ] } as AiInsight;
    expect(mergeCall(row('DCR', v), ai, SEED_SETTINGS)).toEqual(row('DCR', v).call);
    expect(mergeCall(row('EFERT', v), ai, SEED_SETTINGS).source).toBe('rules');
    expect(mergeCall(row('SYS', v), ai, SEED_SETTINGS)).toEqual({ call: 'hold', text: 'wait for results', source: 'ai' });
    // Saved suggestions are cleaned the same way: no "Reduce" without a rule, no add where new money is blocked.
    const clean = cleanInsight({ suggestions: [
      { action: 'trim', symbol: 'DCR', text: 'Reduce DCR', why: '', confidence: 'high' },
      { action: 'add', symbol: 'EFERT', text: 'Add EFERT', why: '', confidence: 'high' },
      { action: 'add', symbol: 'SYS', text: 'Add SYS', why: '', confidence: 'high' },
    ] } as AiInsight, v, SEED_SETTINGS)!;
    expect(clean.suggestions.map((x) => x.symbol)).toEqual(['SYS']);
    // The summary lines too: no money towards a Hold, no cut of a holding that is not a Trim.
    const hold = { ...v, rows: v.rows.map((r) => (r.holding.symbol === 'UBL' ? { ...r, call: { call: 'hold' as const, text: 'x', source: 'rules' as const } } : r)) };
    const lines = cleanInsight({ suggestions: [], cash_note: 'Remaining Rs 6,386 could be used to add to UBL if price stays below last buy.', rebalance: 'Reduce MEBL to cut bank weight.' } as unknown as AiInsight, hold, SEED_SETTINGS)!;
    expect(lines.cash_note).toBeNull();
    expect(lines.rebalance).toBeNull();
    expect(cleanInsight({ suggestions: [], cash_note: 'Keep the cash for a dip.', rebalance: 'Spread new money across sectors.' } as unknown as AiInsight, hold, SEED_SETTINGS)).toMatchObject({ cash_note: 'Keep the cash for a dip.', rebalance: 'Spread new money across sectors.' });
  });

  it('suggests rebalancing over-cap stocks and heavy sectors, with the sector cap from your settings', () => {
    const holdings = SEED_HOLDINGS.map((h) => (h.symbol === 'MEBL' ? { ...h, shares: 60 } : h));
    const v = buildPortfolio(holdings, SEED_PRICES, SEED_SETTINGS);
    expect(v.rebalance.map((t) => `${t.kind}:${t.name}`)).toEqual(expect.arrayContaining(['position:MEBL', 'sector:COMMERCIAL BANKS']));
    expect(view().rebalance).toEqual([]); // 35% sector limit: banks at 31% are fine
    // The default 30% cap flags the banks and blocks new money into them (the AI cannot override it either).
    const tight = buildPortfolio(SEED_HOLDINGS, SEED_PRICES, DEFAULT_SETTINGS);
    expect(tight.sector_limit_pct).toBe(30);
    expect(tight.rebalance.map((t) => t.kind)).toEqual(['sector']);
    expect(tight.rebalance[0].text).toMatch(/Commercial Banks is 31% of your money \(your sector cap is 30%\)/);
    const mebl = tight.rows.find((r) => r.holding.symbol === 'MEBL')!;
    expect(mebl.flags.over_sector).toBe(true);
    expect(mebl.sector_pct!).toBeGreaterThan(30);
    expect(mebl.call).toMatchObject({ call: 'hold' });
    expect(mebl.call.text).toMatch(/sector at cap/);
    expect(mergeCall(mebl, { holding_calls: [{ symbol: 'MEBL', call: 'opportunity', text: 'cheap' }] } as AiInsight, DEFAULT_SETTINGS).source).toBe('rules');
  });

  it('builds at most 6 donut slices, biggest first, rest as Other', () => {
    const s = allocationSlices(view());
    expect(s).toHaveLength(6);
    expect(s[0].label).toBe('SYS');
    expect(s[5].label).toBe('Other (3)');
    expect(s.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100, 6);
  });
});

describe('sell, trim and review rules', () => {
  const screen = SEED_PRICES; // sector P/Es come from the KSE-100 screen; here a hand-made map
  it('marks Trim at the target price, when the P/E runs far ahead of the sector, and on a dividend cut; Review when the review date arrives', () => {
    const sectorPe = { 'TECHNOLOGY & COMMUNICATION': 15, 'COMMERCIAL BANKS': 10 }; // MEBL's 10.8 is only 8% above 10: no P/E trim
    const holdings: Holding[] = SEED_HOLDINGS.map((h) =>
      h.symbol === 'DCR' ? { ...h, target_price: 38 } // price 38.76 >= 38
        : h.symbol === 'UBL' ? { ...h, review_on: '2026-10-01' }
          : h);
    const divs: DividendEvent[] = [
      { id: 'm2', symbol: 'MEBL', announced_on: '2026-09-01', dps: 3, dividend_type: 'interim', book_closure_from: null, book_closure_to: null, verified: true, pdf_url: null },
      { id: 'm1', symbol: 'MEBL', announced_on: '2026-06-01', dps: 4, dividend_type: 'interim', book_closure_from: null, book_closure_to: null, verified: true, pdf_url: null },
    ];
    const v = buildPortfolio(holdings, screen, SEED_SETTINGS, DEFAULT_RULES, {}, { today: TODAY, sectorPe, dividends: divs });
    const call = (s: string) => v.rows.find((r) => r.holding.symbol === s)!.call;
    expect(call('DCR')).toMatchObject({ call: 'trim' });
    expect(call('DCR').text).toMatch(/target price of Rs 38\.00/);
    expect(call('SYS')).toMatchObject({ call: 'trim' }); // P/E 22.7 is 52% above the sector's 15 (rule: 30%)
    expect(call('SYS').text).toMatch(/P\/E 22\.7 is 52% above its sector's 15\.0/); // rule: 50%
    expect(call('MEBL')).toMatchObject({ call: 'trim' });
    expect(call('MEBL').text).toBe('Dividend cut: Rs 3 vs Rs 4 before');
    expect(call('UBL')).toMatchObject({ call: 'review' });
    expect(call('UBL').text).toMatch(/Review date reached/);
    // Each trigger is a setting: off, and the calls fall back to the price rules.
    const off = buildPortfolio(holdings, screen, { ...SEED_SETTINGS, trim_pe_over_sector_pct: 0, trim_on_dividend_cut: false }, DEFAULT_RULES, {}, { today: TODAY, sectorPe, dividends: divs });
    // With the trims off they are Hold, not Buy more: their P/E is above the sector's, so they are not cheap on earnings.
    expect(off.rows.find((r) => r.holding.symbol === 'SYS')!.call).toMatchObject({ call: 'hold', text: "12.3% below your average cost (Rs 130.45) · P/E 22.7 is above its sector's 15.0" });
    expect(off.rows.find((r) => r.holding.symbol === 'MEBL')!.call.call).toBe('hold');
    const cheap = buildPortfolio(holdings, screen, { ...SEED_SETTINGS, trim_pe_over_sector_pct: 0, trim_on_dividend_cut: false }, DEFAULT_RULES, {}, { today: TODAY, sectorPe: { 'TECHNOLOGY & COMMUNICATION': 25, 'COMMERCIAL BANKS': 12 } });
    expect(cheap.rows.find((r) => r.holding.symbol === 'SYS')!.call).toMatchObject({ call: 'opportunity', text: "12.3% below your average cost (Rs 130.45) · P/E 22.7, at or under its sector's 25.0" });
    expect(cheap.rows.find((r) => r.holding.symbol === 'MEBL')!.call.call).toBe('average_down');
    // The AI cannot talk a Trim or Review back into a buy.
    const ai = { holding_calls: [{ symbol: 'DCR', call: 'opportunity', text: 'cheap' }] } as AiInsight;
    expect(mergeCall(v.rows.find((r) => r.holding.symbol === 'DCR')!, ai, SEED_SETTINGS).call).toBe('trim');
    // Alerts: a trim is a market alert once a week; a review date a digest item.
    const alerts = holdingAlerts(v, SEED_SETTINGS, TODAY, null, () => null);
    expect(alerts.find((a) => a.kind === 'trim' && a.symbol === 'DCR')?.message).toMatch(/Plan the sale/);
    expect(alerts.find((a) => a.kind === 'review_due' && a.symbol === 'UBL')?.level).toBe('digest');
  });
});

describe('P/E trim needs a second signal', () => {
  it('a bank richer than its sector is not Trim while it is down, far from its high and well under the cap', () => {
    const v = buildPortfolio(SEED_HOLDINGS, SEED_PRICES, SEED_SETTINGS, DEFAULT_RULES, {}, { today: TODAY, sectorPe: { 'COMMERCIAL BANKS': 6.5 } });
    const mebl = v.rows.find((r) => r.holding.symbol === 'MEBL')!; // P/E 10.8 is 66% above 6.5; price 548 vs high 605; 19.5% of a 25% cap
    expect(mebl.call.call).not.toBe('trim');
    const near = buildPortfolio(SEED_HOLDINGS, { ...SEED_PRICES, MEBL: { ...SEED_PRICES.MEBL, high_52w: 560 } }, SEED_SETTINGS, DEFAULT_RULES, {}, { today: TODAY, sectorPe: { 'COMMERCIAL BANKS': 6.5 } });
    expect(near.rows.find((r) => r.holding.symbol === 'MEBL')!.call.text).toMatch(/near its 52-week high/);
  });
});

describe('hard caps and loss quarters', () => {
  const q = (symbol: string, period_end: string, profit_after_tax: number) => ({ id: `${symbol}-${period_end}`, symbol, period_end, profit_after_tax, verified: true });
  it('the soft cap only stops new money; Trim comes above the hard cap, with the reason', () => {
    const holdings = SEED_HOLDINGS.map((h) => (h.symbol === 'SYS' ? { ...h, shares: 150 } : h)); // about 28%: over 25% soft, under 30% hard
    const soft = buildPortfolio(holdings, SEED_PRICES, SEED_SETTINGS).rows.find((r) => r.holding.symbol === 'SYS')!;
    expect(soft.flags.over_cap).toBe(true);
    expect(soft.call.call).not.toBe('trim');
    const big = SEED_HOLDINGS.map((h) => (h.symbol === 'SYS' ? { ...h, shares: 250 } : h));
    const hard = buildPortfolio(big, SEED_PRICES, SEED_SETTINGS).rows.find((r) => r.holding.symbol === 'SYS')!;
    expect(hard.call).toMatchObject({ call: 'trim' });
    expect(hard.call.text).toMatch(/over your 30% hard cap/);
  });
  it('a sector over its hard cap trims its biggest holding', () => {
    const v = buildPortfolio(SEED_HOLDINGS, SEED_PRICES, { ...SEED_SETTINGS, hard_sector_cap_pct: 25 });
    const banks = v.rows.filter((r) => r.sector === 'COMMERCIAL BANKS');
    expect(banks.find((r) => r.holding.symbol === 'MEBL')!.call.text).toMatch(/sector is 31% of your money, over your 25% hard cap/);
    expect(banks.find((r) => r.holding.symbol === 'UBL')!.call.call).not.toBe('trim');
  });
  it('Review after 2 loss quarters in a row, Sell after 4; a profit in between resets the count', () => {
    const earnings = [q('AVN', '2026-06-30', -5e6), q('AVN', '2026-03-31', -2e6), q('AVN', '2025-12-31', -1e6), q('AVN', '2025-09-30', -3e6),
      q('FCCL', '2026-06-30', -1e6), q('FCCL', '2026-03-31', -1e6), q('FCCL', '2025-12-31', 4e6), q('FCCL', '2025-09-30', -1e6)];
    const holdings = SEED_HOLDINGS.map((h) => ({ ...h, status: 'core' as const }));
    const v = buildPortfolio(holdings, SEED_PRICES, SEED_SETTINGS, DEFAULT_RULES, {}, { today: TODAY, earnings });
    expect(v.rows.find((r) => r.holding.symbol === 'AVN')!.call).toMatchObject({ call: 'sell', text: 'Loss in each of the last 4 quarters (your rule: sell after 4)' });
    expect(v.rows.find((r) => r.holding.symbol === 'FCCL')!.call).toMatchObject({ call: 'review', text: 'Loss in each of the last 2 quarters: re-check why you own it' });
    const off = buildPortfolio(holdings, SEED_PRICES, { ...SEED_SETTINGS, review_after_loss_quarters: 0, sell_after_loss_quarters: 0 }, DEFAULT_RULES, {}, { today: TODAY, earnings });
    expect(off.rows.find((r) => r.holding.symbol === 'AVN')!.call.call).not.toBe('sell');
  });
});

describe('holding changes and transactions', () => {
  const mebl = SEED_HOLDINGS.find((h) => h.symbol === 'MEBL')!; // 20 @ 583.06

  it('records a buy with the implied price when shares go up', () => {
    const after = applyBuy(mebl, 'MEBL', 8, 548.11);
    const t = txnFromChange(mebl, after, TODAY, 548.11, 'manual')!;
    expect(t).toMatchObject({ side: 'buy', shares: 8, executed_on: TODAY });
    expect(t.price).toBeCloseTo(548.11, 1);
    expect(withLastBuy(after, t).last_buy_price).toBe(t.price);
  });

  it('records a sell at market price, and nothing for an average-cost correction', () => {
    expect(txnFromChange(mebl, { ...mebl, shares: 15 }, TODAY, 548.11, 'manual')).toMatchObject({ side: 'sell', shares: 5, price: 548.11 });
    expect(txnFromChange(mebl, { ...mebl, avg_cost: 580 }, TODAY, 548.11, 'manual')).toBeNull();
    expect(txnFromChange(mebl, null, TODAY, 548.11, 'manual')).toMatchObject({ side: 'sell', shares: 20 });
  });

  it('sums buys in the current month only', () => {
    expect(investedThisMonth(SEED_TXNS, TODAY)).toBeCloseTo(9469.7, 1);
    expect(investedThisMonth(SEED_TXNS, '2026-11-02')).toBe(0);
  });

  it('cleans what the AI read from screenshots', () => {
    const r = cleanImported([
      { symbol: 'sys', shares: '118', avg_cost: '130.45' }, { symbol: 'MEBL', shares: 20.5, avg_cost: 583 },
      { symbol: 'SYS', shares: 118, avg_cost: 130.45 }, { symbol: '', shares: 1, avg_cost: 1 }, { symbol: 'UBL', shares: 16, avg_cost: 0 },
    ]);
    expect(r.rows).toEqual([{ symbol: 'SYS', shares: 118, avg_cost: 130.45 }]);
    expect(r.dropped).toHaveLength(3);
  });

  it('diffs an import: new, changed, missing; first import of an existing portfolio records no buys', () => {
    const imported = [{ symbol: 'SYS', shares: 130, avg_cost: 128.5 }, { symbol: 'HUBC', shares: 26, avg_cost: 195.57 }, ...SEED_HOLDINGS.filter((h) => !['SYS', 'AVN'].includes(h.symbol)).map((h) => ({ symbol: h.symbol, shares: h.shares, avg_cost: h.avg_cost }))];
    const keep = diffImport(SEED_HOLDINGS, imported, TODAY, SEED_PRICES, { removeMissing: false, recordTxns: true });
    expect(keep.filter((c) => c.kind !== 'same').map((c) => `${c.kind}:${c.symbol}`)).toEqual(['new:HUBC', 'changed:SYS', 'missing:AVN']);
    const sys = keep.find((c) => c.symbol === 'SYS')!;
    expect(sys.txn).toMatchObject({ side: 'buy', shares: 12, source: 'import' });
    expect(sys.after!.last_buy_price).toBe(sys.txn!.price);
    expect(keep.find((c) => c.symbol === 'AVN')!.after).not.toBeNull();
    const removeAll = diffImport(SEED_HOLDINGS, imported, TODAY, SEED_PRICES, { removeMissing: true, recordTxns: true });
    expect(removeAll.find((c) => c.symbol === 'AVN')).toMatchObject({ after: null, txn: { side: 'sell', shares: 100 } });
    const baseline = diffImport([], imported, TODAY, SEED_PRICES, { removeMissing: false, recordTxns: false });
    expect(baseline.every((c) => c.kind === 'new' && c.txn === null)).toBe(true);
  });

  it('describes each change in plain words, including sells and stocks that are gone', () => {
    const imported = [{ symbol: 'SYS', shares: 130, avg_cost: 128.5 }, { symbol: 'MEBL', shares: 15, avg_cost: 583.06 }, { symbol: 'HUBC', shares: 26, avg_cost: 195.57 }];
    const d = diffImport(SEED_HOLDINGS, imported, TODAY, SEED_PRICES, { removeMissing: true, recordTxns: true });
    const by = (s: string) => d.find((c) => c.symbol === s)!;
    expect(describeChange(by('HUBC'))).toBe('26 shares at Rs 195.57 average');
    expect(describeChange(by('SYS'))).toMatch(/^118 → 130 shares · bought 12 more at about Rs /);
    expect(describeChange(by('MEBL'))).toBe('20 → 15 shares · sold 5 at Rs 548.11');
    expect(by('MEBL').txn).toMatchObject({ side: 'sell', shares: 5 });
    expect(describeChange(by('AVN'))).toMatch(/^Sold all 100 shares at Rs /);
    expect(describeChange(by('AVN'), false)).toBe('100 shares kept; not in these screenshots');
  });

  it('rejects bad buys', () => {
    expect(() => applyBuy(undefined, 'X', 1.5, 10)).toThrow();
    expect(() => applyBuy(undefined, 'X', 1, 0)).toThrow();
  });
});

describe('discover', () => {
  const row = (symbol: string, sector: string, pe: number, dy: number, extra: Partial<ScreenRow> = {}): ScreenRow =>
    ({ symbol, sector, price: 100, change_pct: 0, change_1y_pct: -5, pe, dividend_yield_pct: dy, market_cap: 1e10, is_shariah: true, ...extra });
  const screen = [
    row('BANKA', 'BANKS', 3.5, 12), row('BANKB', 'BANKS', 6, 9), row('BANKC', 'BANKS', 7, 8), row('BANKD', 'BANKS', 8, 7, { is_shariah: false }),
    row('TECHA', 'TECH', 20, 1), row('TECHB', 'TECH', 25, 2), row('TECHC', 'TECH', 14, 3), row('LOSS', 'TECH', -4, 0),
    // Low-yield peers: never candidates, but they make 5 trusted P/Es per sector, enough to compare against.
    row('BANKE', 'BANKS', 9, 1), row('TECHD', 'TECH', 22, 1), row('TECHE', 'TECH', 18, 1),
  ];

  it('sorts every Discover list strongest first, with the AI order as just one option', () => {
    const u = undervalued(screen).map((r, n) => ({ ...r, ai: n === 2 ? { n: 0 } : null })); // AI liked the weakest one
    expect(sortUndervalued(u, 'score').map((x) => x.symbol)).toEqual(['BANKA', 'BANKB', 'TECHC']);
    expect(sortUndervalued(u, 'yield').map((x) => x.symbol)).toEqual(['BANKA', 'BANKB', 'TECHC']);
    expect(sortUndervalued(u, 'pe').map((x) => x.symbol)).toEqual(['BANKA', 'BANKB', 'TECHC']);
    expect(sortUndervalued(u, 'discount')[0].discount_pct).toBe(Math.max(...u.map((x) => x.discount_pct ?? -1)));
    expect(sortUndervalued(u, 'ai')[0].symbol).toBe('TECHC');
    const d = dividendLeaders(screen, [], '2026-10-06').map((r) => ({ ...r, ai: r.symbol === 'BANKC' ? { n: 0, frequency: 'Quarterly' } : null }));
    expect(sortDividends(d, 'yield').map((x) => x.dividend_yield_pct)).toEqual([...d.map((x) => x.dividend_yield_pct)].sort((a, b) => b - a));
    expect(sortDividends(d, 'frequency')[0].symbol).toBe('BANKC'); // AI estimate counts when filings say nothing
    expect(sortDividends(d, 'price')[0].price).toBe(Math.min(...d.map((x) => x.price)));
    expect(sortDividends(d, 'dps')[0].annual_dps).toBe(Math.max(...d.map((x) => x.annual_dps)));
    const ev = (id: string, symbol: string, dps: number, from: string): DividendEvent => ({ id, symbol, announced_on: '2026-10-01', dps, dividend_type: 'interim', book_closure_from: from, book_closure_to: from, verified: true, pdf_url: null });
    const up = upcomingDividends([ev('a', 'AAA', 2, '2026-10-20'), ev('b', 'BBB', 9, '2026-10-28')], '2026-10-06');
    expect(sortUpcoming(up, 'soonest').map((x) => x.symbol)).toEqual(['AAA', 'BBB']);
    expect(sortUpcoming(up, 'dps').map((x) => x.symbol)).toEqual(['BBB', 'AAA']);
  });

  it('finds profitable stocks well below their sector P/E that still pay dividends', () => {
    const u = undervalued(screen);
    expect(u.map((x) => x.symbol)).toEqual(['BANKA', 'BANKB', 'TECHC']);
    expect(u[0].reason).toMatch(/P\/E 3\.5 · sector 7\.0 · 12\.0% yield · 1y -5%/);
    expect(undervalued(screen, { exclude: new Set(['BANKA']) }).map((x) => x.symbol)).not.toContain('BANKA');
    // With four bank peers there is no sector figure: BANKA is still cheap outright, but no discount is claimed.
    const few = undervalued(screen.filter((r) => r.symbol !== 'BANKE'));
    expect(few[0]).toMatchObject({ symbol: 'BANKA', sector_pe: null, discount_pct: null, sector_note: 'too few sector peers to compare' });
    expect(few[0].reason).toBe('P/E 3.5 · too few sector peers to compare · 12.0% yield · 1y -5%');
  });

  const events: DividendEvent[] = [
    { id: 'a', symbol: 'BANKA', announced_on: '2026-08-10', dps: 4, dividend_type: 'interim', book_closure_from: '2026-10-20', book_closure_to: '2026-10-22', verified: true, pdf_url: null },
    { id: 'b', symbol: 'BANKA', announced_on: '2026-04-20', dps: 4, dividend_type: 'interim', book_closure_from: '2026-05-05', book_closure_to: null, verified: true, pdf_url: null },
    { id: 'c', symbol: 'BANKB', announced_on: '2026-02-15', dps: 9, dividend_type: 'final', book_closure_from: '2026-10-09', book_closure_to: null, verified: true, pdf_url: null },
  ];

  it('ranks dividend payers with annual DPS from yield, last declared DPS and frequency', () => {
    const d = dividendLeaders(screen, events, TODAY);
    expect(d.map((x) => x.symbol)).toEqual(['BANKA', 'BANKB', 'BANKC', 'BANKD']);
    expect(d[0]).toMatchObject({ annual_dps: 12, frequency: 'Half-yearly', last: { id: 'a' } });
    expect(frequencyOf(events, 'BANKB', TODAY).label).toBe('Yearly');
    expect(dividendLeaders(screen, events, TODAY, { shariahOnly: true }).map((x) => x.symbol)).not.toContain('BANKD');
  });

  it('the payout on a dividend card is the one every screen shows: filings first, then PSX yield x price', () => {
    const d = dividendLeaders(screen, events, TODAY);
    const a = d.find((x) => x.symbol === 'BANKA')!;
    expect(a.payout_pct).toBe(28); // regular Rs 8 from filings against EPS 100 / 3.5, not PSX's 12% yield (42%)
    expect(a.payout_pct).toBe(payoutOf('BANKA', events, TODAY, { price: 100, psxYieldPct: 12, pe: 3.5 }).pct);
    expect(d.find((x) => x.symbol === 'BANKC')!.payout_pct).toBe(56); // no filings: 8% x Rs 100 against 100 / 7
  });

  it('lists upcoming dividends with the last day to buy (book closure minus 2 working days under T+1)', () => {
    expect(workingDaysBefore('2026-10-20', 3)).toBe('2026-10-15'); // Tue -> previous Thu
    expect(workingDaysBefore('2026-10-12', 3)).toBe('2026-10-07'); // Mon -> previous Wed
    expect(DEFAULT_RULES.dividends.buy_by_working_days).toBe(2); // T+1 settlement since 2026-02-09
    const up = upcomingDividends(events, TODAY);
    expect(up.map((x) => `${x.symbol}:${x.buy_by}`)).toEqual(['BANKB:2026-10-07', 'BANKA:2026-10-16']); // Fri 9 Oct -> Wed; Tue 20 Oct -> Fri
    expect(up[0].days_left).toBe(1);
  });
});

describe('news tidy-up', () => {
  it('puts ALL CAPS titles in sentence case and keeps the ticker', async () => {
    const { tidyTitle } = await import('./news.ts');
    expect(tidyTitle('NOTICE OF BOARD MEETING AND CLOSED PERIOD - MEEZAN BANK LIMITED (MEBL)', 'MEBL')).toBe('Notice of Board Meeting and Closed Period - Meezan Bank Limited (MEBL)');
    expect(tidyTitle('DIVIDEND FOR MEBL', 'MEBL')).toBe('Dividend for MEBL');
    expect(tidyTitle('Results of Emergent Board Meeting', 'MARI')).toBe('Results of Emergent Board Meeting');
  });
});

describe('wealth growth', () => {
  it('compounds today\'s value plus a monthly SIP', () => {
    const g = projectWealth({ start: 56000, monthly: 50000, annualReturnPct: 15, years: 10 });
    expect(g.points).toHaveLength(11);
    expect(g.invested).toBe(56000 + 50000 * 120);
    expect(g.final).toBeGreaterThan(g.invested);
    expect(g.final).toBeGreaterThan(13_000_000);
    expect(g.final).toBeLessThan(14_500_000);
    expect(projectWealth({ start: 1000, monthly: 0, annualReturnPct: 0, years: 5 }).final).toBe(1000);
    expect(realValue(1_000_000, 10, 1)).toBe(909091);
  });
  it('a yearly step-up raises the monthly amount each year', () => {
    const flat = projectWealth({ start: 0, monthly: 10000, annualReturnPct: 0, years: 3 });
    const up = projectWealth({ start: 0, monthly: 10000, annualReturnPct: 0, years: 3, stepUpPct: 10 });
    expect(flat.invested).toBe(360_000);
    expect(up.points.map((p) => p.invested)).toEqual([0, 120_000, 252_000, 397_200]);
    expect(up.final).toBe(397_200);
  });
});

describe('market rules and stance', () => {
  const idx = (kse100: number, change_pct: number) => ({ ts: '2026-10-06T10:00:00Z', kse100, change: 0, change_pct });
  const s = DEFAULT_SETTINGS;
  const now = new Date('2026-10-06T08:00:00Z');
  const ai = (stance: 'buy' | 'hold' | 'wait', created_at = '2026-10-06T07:30:00Z') => ({ stance, headline: 'AI says so', created_at } as AiInsight);

  it('classifies dip, crash, crash level and rally at the spec thresholds', () => {
    expect(marketState(idx(165000, -2), s)).toBe('dip');
    expect(marketState(idx(165000, -1.99), s)).toBe('normal');
    expect(marketState(idx(165000, -4), s)).toBe('crash');
    expect(marketState(idx(154000, -0.5), s)).toBe('crash_level');
    expect(marketState(idx(165000, 2.5), s)).toBe('rally');
    expect(todayBanner(SEED_INDEX, s).reason).toMatch(/Crash level is 6\.\d% away/);
  });

  it('uses a fresh AI stance, but never Buy on a rally day and never over crash wording', () => {
    expect(dayStance(todayBanner(SEED_INDEX, s), ai('buy'), now)).toMatchObject({ action: 'Buy', source: 'ai', reason: 'AI says so' });
    expect(dayStance(todayBanner(idx(165000, 3), s), ai('buy'), now)).toMatchObject({ action: 'Wait', source: 'rules' });
    expect(dayStance(todayBanner(idx(165000, -5), s), ai('hold'), now)).toMatchObject({ action: 'Buy', source: 'rules' });
    expect(dayStance(todayBanner(SEED_INDEX, s), ai('buy', '2026-10-04T07:30:00Z'), now).source).toBe('rules'); // stale
  });

  it('crash alerts are urgent; dips are market-hours alerts', () => {
    const a = marketAlerts(idx(150000, -5), s, TODAY);
    expect(a.map((x) => `${x.kind}:${x.level}`).sort()).toEqual(['crash:urgent', 'crash_level:urgent']);
    expect(a[0].message).toContain('Rs 25,000');
    expect(marketAlerts(idx(165000, -2.4), s, TODAY)[0]).toMatchObject({ kind: 'dip', level: 'market' });
  });
});

describe('holding alerts', () => {
  it('flags buy chances below your last buy, repeating at most weekly', () => {
    const v = view();
    const first = holdingAlerts(v, SEED_SETTINGS, TODAY, null, () => null).filter((a) => a.kind === 'buy_chance');
    expect(first.map((a) => a.symbol).sort()).toEqual(['MEBL', 'SYS', 'UBL']);
    expect(first.find((a) => a.symbol === 'SYS')!.title).toBe('Opportunity: SYS');
    expect(holdingAlerts(v, SEED_SETTINGS, TODAY, null, () => '2026-10-01').filter((a) => a.kind === 'buy_chance')).toEqual([]);
    expect(holdingAlerts(v, SEED_SETTINGS, TODAY, null, () => '2026-09-29').filter((a) => a.kind === 'buy_chance')).toHaveLength(3);
  });

  it('flags a 5% day move, an over-cap position, and a heavy sector for the night digest', () => {
    const prices: PriceMap = { ...SEED_PRICES, DCR: { ...SEED_PRICES.DCR, change_pct: -5.2 } };
    const holdings = SEED_HOLDINGS.map((h) => (h.symbol === 'MEBL' ? { ...h, shares: 60 } : h));
    const a = holdingAlerts(buildPortfolio(holdings, prices, SEED_SETTINGS), SEED_SETTINGS, TODAY, null, () => null);
    expect(a.find((x) => x.kind === 'big_move')?.symbol).toBe('DCR');
    expect(a.find((x) => x.kind === 'over_cap')?.symbol).toBe('MEBL');
    expect(a.find((x) => x.kind === 'rebalance')?.level).toBe('digest');
  });
});

describe('delivery', () => {
  const c = (kind: string, level: AlertCandidate['level']): AlertCandidate => ({ kind, symbol: null, title: kind, message: kind, dedupe_key: kind, level, url: '/#/home' });
  const noon = new Date('2026-10-06T07:00:00Z');
  const night = new Date('2026-10-06T16:00:00Z'); // 21:00 PKT
  const midnight = new Date('2026-10-06T19:00:00Z');
  const base = { now: noon, sentToday: 0, quiet: { start: '23:00', end: '07:00' }, enabled: true };

  it('bundles market alerts into one notification, with an optional "Before close" title', () => {
    const r = planDelivery([c('dip', 'market'), c('buy_chance', 'market')], { ...base, titlePrefix: 'Before close: ' });
    expect(r.send).toHaveLength(1);
    expect(r.send[0].title).toMatch(/^Before close: 2 updates/);
  });

  it('stops market alerts at 3 a day, but crash always goes through', () => {
    const r = planDelivery([c('dip', 'market'), c('crash', 'urgent')], { ...base, sentToday: 3 });
    expect(r.send.map((n) => n.urgent)).toEqual([true]);
    expect(r.suppressed.map((x) => x.kind)).toEqual(['dip']);
  });

  it('holds digest items for the night run, which sends them outside the daily limit', () => {
    const items = [c('night_digest', 'digest'), c('announcement_results', 'digest')];
    expect(planDelivery(items, base).deferred).toHaveLength(2);
    const r = planDelivery(items, { ...base, now: night, sentToday: 3, digestRun: true });
    expect(r.send).toHaveLength(1);
    expect(r.send[0].title).toBe('night_digest');
  });

  it('defers in quiet hours (except crash), and sends nothing when notifications are off', () => {
    const r = planDelivery([c('dip', 'market'), c('crash', 'urgent')], { ...base, now: midnight });
    expect(r.send.map((n) => n.urgent)).toEqual([true]);
    expect(r.deferred.map((x) => x.kind)).toEqual(['dip']);
    expect(planDelivery([c('crash', 'urgent')], { ...base, enabled: false }).send).toEqual([]);
  });
});

describe('time helpers', () => {
  const hours = DEFAULT_RULES.market_hours_pkt;
  it('knows PSX hours, Friday split session and the close', () => {
    expect(isMarketOpen(new Date('2026-10-06T07:00:00Z'), hours)).toBe(true); // Tue 12:00 PKT
    expect(isMarketOpen(new Date('2026-10-09T08:00:00Z'), hours)).toBe(false); // Fri prayer break
    expect(isMarketOpen(new Date('2026-10-10T07:00:00Z'), hours)).toBe(false); // Saturday
    expect(minutesToClose(new Date('2026-10-06T10:15:00Z'), hours)).toBe(15); // Tue 15:15 -> 15:30
    expect(minutesToClose(new Date('2026-10-09T11:15:00Z'), hours)).toBe(15); // Fri 16:15 -> 16:30
    expect(minutesToClose(new Date('2026-10-06T11:00:00Z'), hours)).toBeNull(); // after close
  });
  it('marks data stale only during market hours; builds ISO week keys', () => {
    expect(isStale('2026-10-06T05:00:00Z', new Date('2026-10-06T07:00:00Z'), 30, hours)).toBe(true);
    expect(isStale('2026-10-05T10:49:00Z', new Date('2026-10-05T20:00:00Z'), 30, hours)).toBe(false);
    expect(isoWeek('2026-10-06')).toBe('2026-W41');
  });
});
