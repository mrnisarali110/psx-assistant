import { describe, expect, it } from 'vitest';
import {
  bookClosureDate, buyByDate, dateSane, dateVerdict, datesIn, isTradingDay, nextTradingDay, parseLooseDate, tradingCalendar, weekAhead, workingDaysBefore,
} from './calendar.ts';
import { workingDaysBefore as oldWorkingDaysBefore } from './discover.ts';
import { daysBetween } from './time.ts';
import { DEFAULT_RULES, type Announcement, type DividendEvent, type Holding, type Rules } from './types.ts';

// 2026-10-15 is a Thursday: Fri 16, Sat 17, Sun 18, Mon 19, Tue 20, Thu 22, Tue 27. 2026-11-09 (a listed holiday) is a Monday.
const TODAY = '2026-10-15';
const cal = tradingCalendar();
const withTraded = (...days: string[]) => tradingCalendar(DEFAULT_RULES, days.map((day) => ({ day, close: 165000 })));

describe('trading calendar', () => {
  it('loads holidays from rules and traded days from the index history', () => {
    expect(cal.holidays.has('2026-11-09')).toBe(true);
    expect(cal.traded).toBeUndefined();
    expect(withTraded('2026-11-09').traded?.has('2026-11-09')).toBe(true);
    expect(tradingCalendar(DEFAULT_RULES, []).traded?.size).toBe(0);
  });

  it('knows weekdays, weekends, holidays, and trusts a KSE-100 close over the rule', () => {
    expect(isTradingDay('2026-10-15', cal)).toBe(true); // Thu
    expect(isTradingDay('2026-10-16', cal)).toBe(true); // Fri
    expect(isTradingDay('2026-10-17', cal)).toBe(false); // Sat
    expect(isTradingDay('2026-10-18', cal)).toBe(false); // Sun
    expect(isTradingDay('2026-11-09', cal)).toBe(false); // listed holiday
    expect(isTradingDay('2026-11-09', withTraded('2026-11-09'))).toBe(true); // but the index closed that day
    expect(isTradingDay('2026-10-17', withTraded('2026-10-17'))).toBe(true); // a Saturday session
  });

  it('counts trading days back over weekends and holidays', () => {
    expect(workingDaysBefore('2026-10-17', 2, cal)).toBe('2026-10-15'); // Sat -> Fri 16 (1), Thu 15 (2)
    expect(workingDaysBefore('2026-10-17', 0, cal)).toBe('2026-10-17');
    expect(workingDaysBefore('2026-10-17', -1, cal)).toBe('2026-10-17');
    expect(workingDaysBefore('2026-10-19', 1, cal)).toBe('2026-10-16'); // Mon -> Fri
    expect(workingDaysBefore('2026-11-10', 2, cal)).toBe('2026-11-05'); // Tue -> Mon 9 is a holiday, Fri 6 (1), Thu 5 (2)
    expect(workingDaysBefore('2026-11-10', 2, withTraded('2026-11-09'))).toBe('2026-11-06'); // index closed on the 9th: Mon 9 (1), Fri 6 (2)
    // same answer as the old helper when no holiday is in the way
    expect(workingDaysBefore('2026-10-20', 3, cal)).toBe(oldWorkingDaysBefore('2026-10-20', 3));
    expect(workingDaysBefore('2026-10-20', 3, cal)).toBe('2026-10-15');
  });

  it('finds the next trading day strictly after a date', () => {
    expect(nextTradingDay('2026-10-15', cal)).toBe('2026-10-16');
    expect(nextTradingDay('2026-10-16', cal)).toBe('2026-10-19'); // Fri -> Mon
    expect(nextTradingDay('2026-10-17', cal)).toBe('2026-10-19'); // Sat -> Mon
    expect(nextTradingDay('2026-11-06', cal)).toBe('2026-11-10'); // Fri -> Tue, Mon 9 is a holiday
    expect(nextTradingDay('2026-11-06', withTraded('2026-11-09'))).toBe('2026-11-09');
  });

  it('DCR: book closure starts Sat Oct 17 -> buy by Thu Oct 15 under T+1, 0 days left today (ISSUE-07)', () => {
    expect(buyByDate('2026-10-17', cal)).toBe('2026-10-15');
    expect(daysBetween(TODAY, buyByDate('2026-10-17', cal))).toBe(0);
    expect(DEFAULT_RULES.dividends.buy_by_working_days).toBe(2);
    const t2: Rules = { ...DEFAULT_RULES, dividends: { ...DEFAULT_RULES.dividends, buy_by_working_days: 3 } };
    expect(buyByDate('2026-10-17', cal, t2)).toBe('2026-10-14'); // the old T+2 rule: one day earlier
    expect(buyByDate('2026-11-10', cal)).toBe('2026-11-05'); // skips the Nov 9 holiday
  });
});

describe('loose dates in filings', () => {
  it('reads every way a PSX filing writes 30 September 2026', () => {
    for (const s of [
      'September 30, 2026', 'Sept 30, 2026', 'Sept. 30 2026', 'Sep 30, 2026', '30 Sep 2026', '30 September 2026', '30th September, 2026',
      '30-Sep-2026', '30-09-2026', '30/09/2026', '30.09.2026', '2026-09-30', '2026/9/30', 'Book closure from 30-09-2026 to 05-10-2026',
    ]) expect(parseLooseDate(s), s).toBe('2026-09-30');
    expect(parseLooseDate('Credited by: October 02, 2024')).toBe('2024-10-02');
    expect(parseLooseDate('16 October 2026')).toBe('2026-10-16');
    expect(parseLooseDate('10/16/2026')).toBe('2026-10-16'); // 16 cannot be a month, so month-first
    expect(parseLooseDate('01/02/2026')).toBe('2026-02-01'); // both fit: day-first, as written in Pakistan
  });

  it('returns null for text without a real date', () => {
    expect(parseLooseDate('31-02-2026')).toBeNull(); // no 31 Feb
    expect(parseLooseDate('16-10-26')).toBeNull(); // two-digit year
    expect(parseLooseDate('Rs 10.55 per share')).toBeNull();
    expect(parseLooseDate('EPS 12.5, profit 44.48bn')).toBeNull();
    expect(parseLooseDate('results for the year 2026')).toBeNull();
    expect(parseLooseDate('')).toBeNull();
  });

  it('lists every distinct date in order', () => {
    expect(datesIn('Book closure from October 17, 2026 to October 22, 2026 (both days inclusive, from October 17, 2026)')).toEqual(['2026-10-17', '2026-10-22']);
    expect(datesIn('Meeting on 16-10-2026 about the quarter ended 2026-09-30')).toEqual(['2026-10-16', '2026-09-30']);
    expect(datesIn('nothing dated')).toEqual([]);
  });

  it('judges a date against its filing date at the rules.json limits (90 before, 365 after)', () => {
    expect(dateSane('2024-10-02', '2026-10-08')).toBe(false); // INDU: credited two years before the filing
    expect(dateSane('2026-10-16', '2026-10-08')).toBe(true);
    expect(dateSane('2026-07-10', '2026-10-08')).toBe(true); // 21 + 31 + 30 + 8 = 90 days before
    expect(dateSane('2026-07-09', '2026-10-08')).toBe(false); // 91
    expect(dateSane('2027-10-08', '2026-10-08')).toBe(true); // 365 after
    expect(dateSane('2027-10-09', '2026-10-08')).toBe(false); // 366
    expect(dateSane('2026-02-31', '2026-10-08')).toBe(false);
    expect(dateSane('2026-10-16', 'yesterday')).toBe(false);
  });

  it('INDU "October 02, 2024" on an October 2026 filing is an older document; AHCL\'s 2020 meeting date is unclear beside a real period end', () => {
    expect(dateVerdict(['Credited by: October 02, 2024'], '2026-10-08')).toBe('older_document');
    expect(dateVerdict(['The board will meet on September 30, 2020 to consider the accounts for the year ended June 30, 2026.'], '2026-09-22')).toBe('date_unclear');
    expect(dateVerdict(['The board will meet on September 30, 2020.'], '2026-09-22')).toBe('older_document'); // only the old date: nothing says it is current
    expect(dateVerdict(['Profit up 12%, EPS Rs 3.68'], '2026-09-22')).toBe('ok'); // no date at all
    expect(dateVerdict(['Book closure from October 17, 2026 to October 22, 2026'], '2026-10-08')).toBe('ok');
    expect(dateVerdict(['Payment by October 20, 2028'], '2026-10-08')).toBe('date_unclear'); // too far ahead
    expect(dateVerdict(['Meeting on 2026-08-20'], 'not a date')).toBe('ok');
    const strict: Rules = { ...DEFAULT_RULES, ai: { ...DEFAULT_RULES.ai, date_sanity: { max_days_before_filing: 30, max_days_after_filing: 365 } } };
    expect(dateVerdict(['Meeting on 2026-08-20'], '2026-10-08')).toBe('ok'); // 49 days before: fine at 90
    expect(dateVerdict(['Meeting on 2026-08-20'], '2026-10-08', strict)).toBe('older_document'); // not at 30
  });

  it('a reporting period is not an event: results filed months after the year end and compared with last year are fine', () => {
    // most PSX companies close the year on June 30 and file annual results through October: 100 days later here, past the 90-day window
    expect(dateVerdict(['Profit after tax for the year ended June 30, 2026 rose 12% to Rs 44.48bn; EPS Rs 3.68.'], '2026-10-08')).toBe('ok');
    expect(dateVerdict(['Profit after tax for the year ended June 30, 2026 rose 12% to Rs 44.48bn; EPS Rs 3.68.'], '2026-09-29')).toBe('ok'); // 91 days: no flip
    expect(dateVerdict(['Profit for the quarter ended September 30, 2026 rose 12% from the quarter ended September 30, 2025.'], '2026-10-28')).toBe('ok'); // last year's quarter is 393 days back
    expect(dateVerdict(['AGM on October 28, 2026 to approve the accounts for the year ended June 30, 2026'], '2026-10-08')).toBe('ok'); // the AGM is the event, 20 days ahead
    expect(dateVerdict(['Results for the period from July 1, 2025 to June 30, 2026'], '2026-10-08')).toBe('ok'); // the range end belongs to the period
    expect(dateVerdict(['Net assets as at June 30, 2026: Rs 12bn', 'Nine months ended 31-03-2026'], '2026-10-08')).toBe('ok');
    expect(dateVerdict(['Annual report for the year ended June 30, 2023'], '2026-10-08')).toBe('ok'); // a period alone never says the document is old: it may be a comparison
    expect(dateVerdict(['Outlook for the year ending June 30, 2029'], '2026-10-08')).toBe('date_unclear'); // a period 995 days ahead (over 365) is a misread
    // event dates still decide
    expect(dateVerdict(['Credited by: October 02, 2024', 'Quarter ended September 30, 2026'], '2026-10-08')).toBe('date_unclear'); // an old payment date beside a current period
    expect(dateVerdict(['Credited by: October 02, 2024', 'Year ended June 30, 2024'], '2026-10-08')).toBe('older_document'); // nothing current anywhere
    expect(dateVerdict(['Payment by October 20, 2026 for the year ended June 30, 2026'], '2026-10-08')).toBe('ok');
  });
});

describe('this week', () => {
  const div = (id: string, symbol: string, dps: number | null, from: string | null, to: string | null = null, verified = true): DividendEvent =>
    ({ id, symbol, announced_on: '2026-10-08', dps, dividend_type: 'interim', book_closure_from: from, book_closure_to: to, verified, pdf_url: null });
  const ann = (id: string, symbol: string, kind: Announcement['kind'], published_at: string, title: string, figures?: { label: string; value: string }[]): Announcement =>
    ({ id, symbol, kind, published_at, title, pdf_url: null, ai_figures: figures?.map((f) => ({ ...f, verified: true })) ?? null });
  const holding = (symbol: string, review_on: string | null, thesis: string | null = null): Holding =>
    ({ id: `h-${symbol}`, symbol, shares: 10, avg_cost: 100, status: 'core', sector: null, is_shariah: true, review_on, thesis });

  const base = {
    today: TODAY, cal,
    held: ['DCR', 'UBL', 'MEBL', 'AVN', 'FCCL'], watched: ['EFERT', 'HUBC'],
    dividends: [
      div('d-dcr', 'DCR', 2, '2026-10-17', '2026-10-22'), // buy by Thu 15 (today), closure Sat 17
      div('d-hubc', 'HUBC', 7.5, '2026-10-16'), // closure Fri 16: buy-by was Wed 14, already gone
      div('d-ogdc', 'OGDC', 5, '2026-10-20'), // not held or watched
      div('d-dcr-old', 'DCR', 1.5, null), // no book closure read yet
    ],
    announcements: [
      ann('a-ubl', 'UBL', 'board_meeting', '2026-10-09', 'NOTICE OF BOARD MEETING - UNITED BANK LIMITED', [{ label: 'Meeting date', value: 'October 16, 2026' }, { label: 'EPS', value: 'Rs 12.5' }]),
      ann('a-ubl2', 'UBL', 'board_meeting', '2026-10-10', 'Board meeting on 16-10-2026'), // same meeting, re-filed
      ann('a-efert', 'EFERT', 'board_meeting', '2026-10-12', 'Notice of Board Meeting on 19 Oct 2026 to consider accounts for the quarter ended September 30, 2026'),
      ann('a-mebl', 'MEBL', 'results', '2026-10-13', 'Financial results', [{ label: 'Result date', value: '22 Oct 2026' }]),
      ann('a-fccl', 'FCCL', 'board_meeting', '2026-10-14', 'Board meeting', [{ label: 'Meeting date', value: '2026-10-27' }]), // 12 days out
      ann('a-indu', 'MEBL', 'dividend', '2026-10-08', 'Dividend credit advice', [{ label: 'Credited by', value: 'October 02, 2024' }]), // old date
      ann('a-bafl', 'BAFL', 'board_meeting', '2026-10-14', 'Board meeting', [{ label: 'Meeting date', value: '2026-10-16' }]), // not followed
    ],
    holdings: [holding('AVN', '2026-10-20', 'Weak earnings; re-check after Q1'), holding('DCR', null), holding('MEBL', '2026-10-10')], // MEBL review already past
  };

  it('lists buy-by days, book closures, meetings, results and reviews soonest first, today = 0 days', () => {
    const { events, more } = weekAhead(base);
    expect(more).toBe(0);
    expect(events.map((e) => `${e.date} ${e.kind} ${e.symbol} ${e.days}`)).toEqual([
      '2026-10-15 buy_by DCR 0',
      '2026-10-16 board_meeting UBL 1', // mine before the watchlist on the same day
      '2026-10-16 book_closure HUBC 1',
      '2026-10-17 book_closure DCR 2',
      '2026-10-19 board_meeting EFERT 4',
      '2026-10-20 review_due AVN 5',
      '2026-10-22 results MEBL 7', // day 7 is still inside "the next 7 days"
    ]);
    expect(events.map((e) => e.mine)).toEqual([true, true, false, true, false, true, true]);
    const by = (kind: string, symbol: string) => events.find((e) => e.kind === kind && e.symbol === symbol)!;
    expect(by('buy_by', 'DCR')).toMatchObject({ title: 'Last day to buy for Rs 2/share', detail: 'Book closure Sat to Oct 22', source_id: 'd-dcr' });
    expect(by('book_closure', 'DCR')).toMatchObject({ title: 'Book closure starts (Rs 2/share)', detail: 'Buy by today' });
    expect(by('book_closure', 'HUBC')).toMatchObject({ title: 'Book closure starts (Rs 7.5/share)', detail: 'Last day to buy was yesterday' });
    expect(events.filter((e) => e.symbol === 'HUBC' && e.kind === 'buy_by')).toEqual([]);
    expect(by('board_meeting', 'UBL')).toMatchObject({ title: 'Board meeting', source_id: 'a-ubl2' }); // one row for the re-filed notice, the newer one
    expect(by('board_meeting', 'EFERT')).toMatchObject({ title: 'Board meeting', detail: expect.stringMatching(/^Notice of Board Meeting/) });
    expect(by('results', 'MEBL')).toMatchObject({ title: 'Results expected', detail: 'Result date: 22 Oct 2026', source_id: 'a-mebl' });
    expect(by('review_due', 'AVN')).toMatchObject({ title: 'Thesis review due', detail: 'Weak earnings; re-check after Q1', source_id: 'h-AVN' });
  });

  it('caps the rows and counts the rest; a shorter window drops later days', () => {
    const r = weekAhead({ ...base, max: 4 });
    expect(r.events).toHaveLength(4);
    expect(r.more).toBe(3);
    expect(r.events[3].symbol).toBe('DCR');
    expect(weekAhead({ ...base, max: 0 })).toEqual({ events: [], more: 7 });
    const short = weekAhead({ ...base, days: 3 }); // through Sun Oct 18
    expect(short.events.map((e) => e.date)).toEqual(['2026-10-15', '2026-10-16', '2026-10-16', '2026-10-17']);
    expect(short.more).toBe(0);
  });

  it('ignores a period end in a title, a date before today, and symbols it was not asked about', () => {
    // today Mon 2026-09-28: Sep 30 would be 2 days away, but it is the quarter end, not the meeting
    const r = weekAhead({ ...base, today: '2026-09-28', dividends: [], holdings: [], announcements: [
      ann('a-x', 'UBL', 'board_meeting', '2026-09-25', 'Board meeting on October 2, 2026 to consider accounts for the quarter ended September 30, 2026'),
      ann('a-y', 'MEBL', 'dividend', '2026-09-25', 'Dividend declared', [{ label: 'Book closure dates', value: 'October 1, 2026 to October 5, 2026' }]),
    ] });
    expect(r.events.map((e) => `${e.date} ${e.kind} ${e.symbol}`)).toEqual(['2026-10-01 book_closure MEBL', '2026-10-02 board_meeting UBL']);
    expect(weekAhead(base).events.some((e) => ['OGDC', 'BAFL'].includes(e.symbol))).toBe(false);
    expect(weekAhead(base).events.some((e) => e.date < TODAY)).toBe(false);
  });

  it('lists a meeting moved to a new date on the new date, not the old one', () => {
    const on = (title: string) => weekAhead({ ...base, dividends: [], holdings: [], announcements: [ann('a-m', 'UBL', 'board_meeting', '2026-10-14', title)] })
      .events.map((e) => `${e.date} ${e.kind}`);
    for (const t of [
      'Board meeting postponed to October 20, 2026',
      'Board meeting has been rescheduled to 20-10-2026',
      'Board meeting deferred to 20 October 2026',
      'Board meeting adjourned till October 20, 2026',
      'Board meeting postponed to Tuesday, October 20, 2026',
      'Board meeting rescheduled from October 16, 2026 to October 20, 2026', // the 16th is not a meeting any more
      'Change in date of board meeting from 16-10-2026 to 20-10-2026',
      'Board meeting postponed to October 20, 2026 to consider accounts for the quarter ended September 30, 2026',
    ]) expect(on(t), t).toEqual(['2026-10-20 board_meeting']);
    expect(on('Board meeting on October 16, 2026 to consider the accounts for the year ended June 30, 2026')).toEqual(['2026-10-16 board_meeting']);
  });

  it('lists a payment date from a figure, and a book closure or payment named in the title of a dividend or other notice', () => {
    const r = weekAhead({ ...base, dividends: [], holdings: [], announcements: [
      ann('a-pay', 'UBL', 'dividend', '2026-10-14', 'Final cash dividend', [{ label: 'Payment date', value: 'October 20, 2026' }]),
      ann('a-cr', 'MEBL', 'dividend', '2026-10-14', 'Interim dividend', [{ label: 'Credited by', value: 'October 21, 2026' }]), // the INDU label with a current date
      ann('a-bc', 'EFERT', 'dividend', '2026-10-14', 'Cash dividend; book closure from October 17, 2026 to October 22, 2026'), // kind read from the title
      ann('a-oth', 'HUBC', 'other', '2026-10-14', 'Dividend will be credited to shareholders on 19 October 2026'),
      ann('a-nk', 'FCCL', 'dividend', '2026-10-14', 'Dividend declared', [{ label: 'Date', value: 'October 20, 2026' }]), // nothing says what the date is for
    ] });
    expect(r.events.map((e) => `${e.date} ${e.kind} ${e.symbol} | ${e.title} | ${e.detail}`)).toEqual([
      '2026-10-17 book_closure EFERT | Book closure starts | Cash dividend; book closure from October 17, 2026 to October 22, 2026',
      '2026-10-19 payout HUBC | Dividend payment | Dividend will be credited to shareholders on 19 October 2026',
      '2026-10-20 payout UBL | Dividend payment | Payment date: October 20, 2026',
      '2026-10-21 payout MEBL | Dividend payment | Credited by: October 21, 2026',
    ]);
    expect(r.events.map((e) => e.source_id)).toEqual(['a-bc', 'a-oth', 'a-pay', 'a-cr']);
    expect(r.events.some((e) => e.date === '2026-10-22')).toBe(false); // the end of the book closure is not an event
    expect(r.more).toBe(0);
  });

  it('uses the buy-by rule from rules.json and marks unverified dividends', () => {
    const t3: Rules = { ...DEFAULT_RULES, dividends: { ...DEFAULT_RULES.dividends, buy_by_working_days: 3 } };
    const r = weekAhead({ ...base, rules: t3, dividends: [div('d', 'DCR', null, '2026-10-20', null, false)] });
    expect(r.events.filter((e) => e.symbol === 'DCR').map((e) => `${e.date} ${e.kind}`)).toEqual(['2026-10-15 buy_by', '2026-10-20 book_closure']); // Tue 20 -> Mon 19, Fri 16, Thu 15
    expect(r.events[0]).toMatchObject({ title: 'Last day to buy for the dividend', detail: 'Book closure starts Tue (unverified)' });
  });

  it('takes a dividend\'s book closure from its notice when the dividend row has none, as Expected does', () => {
    const notice = ann('d-dcr-old', 'DCR', 'dividend', '2026-10-08', 'Cash dividend; book closure from October 17, 2026 to October 22, 2026');
    const r = weekAhead({ ...base, dividends: [div('d-dcr-old', 'DCR', 1.5, null)], holdings: [], announcements: [notice] });
    expect(r.events.map((e) => `${e.date} ${e.kind} ${e.symbol} ${e.title} ${e.source_id}`)).toEqual([
      '2026-10-15 buy_by DCR Last day to buy for Rs 1.5/share d-dcr-old',
      '2026-10-17 book_closure DCR Book closure starts (Rs 1.5/share) d-dcr-old', // one row: the notice's own book closure row is the same event
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(weekAhead({ today: TODAY, held: [], watched: [], dividends: [], announcements: [], holdings: [], cal })).toEqual({ events: [], more: 0 });
    expect(weekAhead({ ...base, held: [], watched: [] })).toEqual({ events: [], more: 0 });
  });
});

describe('bookClosureDate', () => {
  const ann = (title: string, figures?: { label: string; value: string }[], published_at = '2026-10-08'): Announcement =>
    ({ id: 'a', symbol: 'DCR', kind: 'dividend', published_at, title, pdf_url: null, ai_figures: figures?.map((f) => ({ ...f, verified: true })) ?? null });
  it('reads the start of book closure the way This week does: AI figures, then the title', () => {
    expect(bookClosureDate(ann('Cash dividend; book closure from October 17, 2026 to October 22, 2026'))).toBe('2026-10-17');
    expect(bookClosureDate(ann('Dividend declared', [{ label: 'Book closure dates', value: '17-10-2026 to 22-10-2026' }]))).toBe('2026-10-17');
    // the earliest book closure date wins when a notice names the start and the end separately
    expect(bookClosureDate(ann('Dividend declared', [{ label: 'Book closure to', value: '22-10-2026' }, { label: 'Book closure from', value: '17-10-2026' }]))).toBe('2026-10-17');
    expect(bookClosureDate(ann('Dividend declared', [{ label: 'Payment date', value: 'October 30, 2026' }]))).toBeNull();
    expect(bookClosureDate(ann('Board meeting on October 17, 2026'))).toBeNull();
    expect(bookClosureDate(ann('Book closure from October 17, 2020'))).toBeNull(); // not plausible for a 2026 filing
    expect(bookClosureDate(undefined)).toBeNull();
  });
});
