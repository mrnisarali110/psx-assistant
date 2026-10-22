import { describe, expect, it } from 'vitest';
import { cleanFigures, cleanHeadline, cutAtWord, dividendImpact, groupByDay, metricChips } from './news.ts';
import { tradingCalendar } from './calendar.ts';
import { DEFAULT_RULES, type Announcement, type DividendEvent, type Txn } from './types.ts';

const ann = (o: Partial<Announcement>): Announcement => ({
  id: 'a1', symbol: 'OGDC', title: 'Dividend', kind: 'dividend', published_at: '2026-10-20', pdf_url: null, ...o,
});
const ev = (o: Partial<DividendEvent>): DividendEvent => ({
  id: 'a1', symbol: 'OGDC', announced_on: '2026-10-20', dps: 4, dividend_type: 'interim', book_closure_from: '2026-10-29',
  book_closure_to: '2026-10-31', verified: true, pdf_url: null, ...o,
});
const buy = (symbol: string, shares: number, executed_on: string): Txn =>
  ({ symbol, side: 'buy', shares, price: 100, executed_on } as Txn);
const cal = tradingCalendar(DEFAULT_RULES);

describe('cutAtWord', () => {
  it('leaves short text alone', () => expect(cutAtWord('Board meeting', 20)).toBe('Board meeting'));
  it('cuts at a word boundary, never mid-word', () => {
    const out = cutAtWord('Financial results for the quarter ended September 30, 2026', 30);
    expect(out).toBe('Financial results…');
    expect(out.length).toBeLessThanOrEqual(31);
  });
  it('drops a dangling small word and punctuation before the ellipsis', () =>
    expect(cutAtWord('Credit of interim cash dividend, for the year', 34)).toBe('Credit of interim cash dividend…'));
  it('keeps one long word whole rather than splitting it', () => expect(cutAtWord('Supercalifragilistic', 8)).toBe('Supercalifragilistic'));
});

describe('cleanHeadline', () => {
  it('strips the transmission lead-in and the trailing company name', () =>
    expect(cleanHeadline('Transmission of Annual Report for the Year Ended June 30, 2026 - The Hub Power Company Limited', 'HUBC'))
      .toBe('Annual Report for the Year Ended June 30, 2026'));
  it('strips PSX regulation references and notice codes, then tidies capitals', () =>
    expect(cleanHeadline('PUBLICATION OF NOTICES FOR THE CREDIT OF INTERIM CASH DIVIDEND (D-46) OF MEEZAN BANK', 'MEBL'))
      .toBe('Credit of Interim Cash Dividend of Meezan Bank'));
  it('drops a leading repeat of the ticker', () => expect(cleanHeadline('DCR | Dolmen City REIT Board Meeting', 'DCR')).toBe('Dolmen City REIT Board Meeting'));
  it('says plainly what a director-dealing disclosure is', () =>
    expect(cleanHeadline('Disclosure of Interest by a Director CEO, or Executive of a listed company and their Spouses and the Substantial Shareholders u/c 5.6.1.(d) of PSX Regulations', 'UBL'))
      .toBe('Shares traded by a director, officer or major shareholder'));
  it('prefers the AI headline when there is one', () =>
    expect(cleanHeadline('FINANCIAL RESULTS', 'OGDC', 'Profit up 18%, Rs 4 dividend')).toBe('Profit up 18%, Rs 4 dividend'));
  it('cuts a long title at a word boundary', () => {
    const out = cleanHeadline('CERTIFIED TRUE COPY OF THE RESOLUTIONS PASSED IN THE 33rd ANNUAL GENERAL MEETING OF LUCKY CEMENT LIMITED U/C 5.6.9.(b) OF PSX REGULATIONS', 'LUCK', null, 60);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out).not.toMatch(/U\/C|Regulations/i);
  });
});

describe('metricChips', () => {
  it('shows EPS with its basis, dividend per share and profit change', () => {
    const chips = metricChips({ headline: null, eps: 8.123, eps_basis: 'consolidated', dps: 4, profit_change_pct: 18.2 });
    expect(chips.map((c) => c.key)).toEqual(['eps', 'dps', 'profit']);
    expect(chips[0]).toMatchObject({ label: 'EPS', value: 'Rs 8.12', note: 'consolidated' });
    expect(chips[1]).toMatchObject({ label: 'Dividend', value: 'Rs 4/share' });
    expect(chips[2]).toMatchObject({ label: 'Profit vs last year', change: 18.2 });
  });
  it('a loss per share reads with a minus sign and no basis word when it is not stated', () =>
    expect(metricChips({ headline: null, eps: -2.1, eps_basis: 'not_stated', dps: null, profit_change_pct: null }))
      .toEqual([{ key: 'eps', label: 'EPS', value: '−Rs 2.10' }]));
  it('nothing for missing metrics', () => {
    expect(metricChips(null)).toEqual([]);
    expect(metricChips({ headline: 'x', eps: null, eps_basis: null, dps: 0, profit_change_pct: null })).toEqual([]);
  });
});

describe('cleanFigures', () => {
  it('keeps at most three, labels cut at a word boundary', () => {
    const out = cleanFigures([
      { label: 'Earnings per share for the nine months ended', value: 'Rs 12.4', verified: true },
      { label: 'Dividend', value: 'Rs 4', verified: false },
      { label: 'Dividend', value: 'Rs 4', verified: false },
      { label: 'Book closure', value: 'Oct 29', verified: true },
      { label: 'Payout date', value: 'Nov 20', verified: true },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].label).toBe('Earnings per share…');
    expect(out.map((f) => f.label)).toEqual(['Earnings per share…', 'Dividend', 'Book closure']);
  });
  it('empty list for none', () => expect(cleanFigures(null)).toEqual([]));
});

describe('dividendImpact', () => {
  const base = { events: [ev({})], txns: [] as Txn[], sector: null, filer: true, cal };
  it('holder of a baseline import: net after tax, book closure and buy-by', () => {
    const r = dividendImpact(ann({}), { ...base, holdings: [{ symbol: 'OGDC', shares: 40 }], today: '2026-10-23' });
    expect(r).not.toBeNull();
    expect(r!.shares).toBe(40);
    expect(r!.basis).toBe('holdings');
    expect(r!.book_closure).toBe('2026-10-29');
    expect(r!.buy_by).toBe('2026-10-27');
    expect(r!.past).toBe(false);
    expect(r!.net).toBeCloseTo(40 * 4 * (1 - r!.wht_pct / 100), 2);
  });
  it('nothing for someone who does not hold it', () =>
    expect(dividendImpact(ann({}), { ...base, holdings: [], today: '2026-10-23' })).toBeNull());
  it('buys after book closure do not count', () => {
    const r = dividendImpact(ann({}), { ...base, txns: [buy('OGDC', 10, '2026-10-01'), buy('OGDC', 30, '2026-10-30')], holdings: [{ symbol: 'OGDC', shares: 40 }], today: '2026-11-02' });
    expect(r!.shares).toBe(10);
    expect(r!.past).toBe(true);
    expect(r!.buy_by).toBeNull();
  });
  it('dividend per share from ai_metrics when there is no dividend row', () => {
    const r = dividendImpact(ann({ ai_metrics: { headline: null, eps: null, eps_basis: null, dps: 2, profit_change_pct: null },
      ai_figures: [{ label: 'Book closure', value: '29 October 2026', verified: true }] }), { ...base, events: [], holdings: [{ symbol: 'OGDC', shares: 100 }], today: '2026-10-23' });
    expect(r?.book_closure).toBe('2026-10-29');
    expect(r?.shares).toBe(100);
  });
  it('no book closure date, no line', () =>
    expect(dividendImpact(ann({}), { ...base, events: [ev({ book_closure_from: null })], holdings: [{ symbol: 'OGDC', shares: 40 }], today: '2026-10-23' })).toBeNull());
});

describe('groupByDay', () => {
  it('labels with the app date words', () => {
    const g = groupByDay(['2026-10-23', '2026-10-22', '2026-10-20', '2026-09-01'], (d) => d, '2026-10-23');
    expect(g.map((x) => x.label)).toEqual(['Today', 'Yesterday', 'Tue', 'Sep 1']);
  });
});
