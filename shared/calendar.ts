/**
 * PSX calendar logic: trading days around weekends and holidays, the last day to buy for a dividend under T+1
 * settlement (ISSUE-07), the "This week" card (FEATURE-07), and the loose dates people write in PSX filings with
 * a sanity check against the filing date (ISSUE-06). Every day count and threshold comes from rules.json.
 */
import type { Announcement, DividendEvent, Holding, IndexDay, Rules } from './types.ts';
import { DEFAULT_RULES } from './types.ts';
import { addDays, daysBetween } from './time.ts';
import { day } from './format.ts';

// ---------------------------------------------------------------------------
// Trading days
// ---------------------------------------------------------------------------

export interface TradingCalendar {
  holidays: Set<string>; // YYYY-MM-DD closures from rules.psx_holidays
  traded?: Set<string>; // days with a KSE-100 close; when present a day in it is always a trading day
}

/** The calendar from rules.json holidays, plus the days the index actually closed when `indexDays` is given. */
export function tradingCalendar(rules: Rules = DEFAULT_RULES, indexDays?: IndexDay[]): TradingCalendar {
  const cal: TradingCalendar = { holidays: new Set(rules.psx_holidays.dates) };
  if (indexDays) cal.traded = new Set(indexDays.map((d) => d.day));
  return cal;
}

const weekday = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday

/** Mon-Fri and not a listed holiday; a day with a KSE-100 close in `traded` counts whatever the rule says. */
export function isTradingDay(date: string, cal: TradingCalendar): boolean {
  if (cal.traded?.has(date)) return true;
  const wd = weekday(date);
  return wd >= 1 && wd <= 5 && !cal.holidays.has(date);
}

/** The trading day `n` trading days before `date` (weekends and holidays skipped). n <= 0 returns `date` itself. */
export function workingDaysBefore(date: string, n: number, cal: TradingCalendar): string {
  let d = date;
  for (let left = n; left > 0; ) {
    d = addDays(d, -1);
    if (isTradingDay(d, cal)) left--;
  }
  return d;
}

/** The first trading day strictly after `date`. */
export function nextTradingDay(date: string, cal: TradingCalendar): string {
  let d = addDays(date, 1);
  while (!isTradingDay(d, cal)) d = addDays(d, 1);
  return d;
}

/** Last day to buy to receive a dividend: book closure start minus rules.dividends.buy_by_working_days trading days (T+1 settlement). */
export function buyByDate(bookClosureFrom: string, cal: TradingCalendar, rules: Rules = DEFAULT_RULES): string {
  return workingDaysBefore(bookClosureFrom, rules.dividends.buy_by_working_days, cal);
}

// ---------------------------------------------------------------------------
// Loose dates in filings
// ---------------------------------------------------------------------------

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// Groups: 1-3 year-month-day, 4-6 day-month-year numeric, 7-9 month-name day year, 10-12 day month-name year.
const DATE_RE = new RegExp(
  '\\b(?:(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})' // 2026-09-30, 2026/9/30
  + '|(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})' // 30-09-2026, 30/09/2026, 30.09.2026
  + `|${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})` // September 30, 2026; Sept. 30 2026
  + `|(\\d{1,2})(?:st|nd|rd|th)?[\\s,.-]*${MONTH_RE}\\.?[\\s,.-]*(\\d{4}))\\b`, // 30 Sep 2026; 30-Sep-2026; 30th September, 2026
  'gi',
);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthNo = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/** YYYY-MM-DD for a real calendar date, else null (31 Feb is not a date). */
function makeIso(y: number, m: number, d: number): string | null {
  if (!(y >= 1000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() + 1 === m && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}

/** True for a real date written as YYYY-MM-DD. */
const validIso = (s: string | null | undefined): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && makeIso(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)) === s;

/** Every real date in `text`, in order, with where it starts and ends. Numeric dates read day-first (Pakistan); when the second number cannot be a month (over 12) the date is read month-first instead. */
function dateMatches(text: string): { date: string; index: number; end: number }[] {
  const out: { date: string; index: number; end: number }[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    let iso: string | null = null;
    if (m[1]) iso = makeIso(+m[1], +m[2], +m[3]);
    else if (m[4]) {
      const a = +m[4], b = +m[5], y = +m[6];
      iso = b > 12 && a <= 12 ? makeIso(y, a, b) : makeIso(y, b, a);
    } else if (m[7]) iso = makeIso(+m[9], monthNo(m[7]), +m[8]);
    else if (m[10]) iso = makeIso(+m[12], monthNo(m[11]), +m[10]);
    const index = m.index ?? 0;
    if (iso) out.push({ date: iso, index, end: index + m[0].length });
  }
  return out;
}

/** The words before a date that make it a reporting period ("quarter ended", "as at", "period from"), not an event. */
const PERIOD_RE = /\b(ended|ending|as at|as of|period|quarter|year|months?)\b(\s+(on|from|of|the|to|till|until|through|beginning|starting|commencing|between))*\s*$/i;
/** Nothing but a connector between two dates: the second closes a range the first starts ("from Oct 17 to Oct 22"). */
const RANGE_RE = /^\s*(to|till|until|through|[-–—])\s*$/i;
/** The word before the old date in "rescheduled from Oct 16 to Oct 20". */
const FROM_RE = /\bfrom\s*$/i;
/** A notice that moves an event: "postponed to", "rescheduled from ... to", "change in date ... to", "adjourned till". */
const MOVED_RE = /\b(postpon|reschedul|defer|adjourn|chang)/i;

interface FoundDate {
  date: string;
  period: boolean; // names a reporting period, or closes a range that one starts
  range_end: boolean; // closes a range the previous date starts
  from: boolean; // written right after "from"
}

/** Every real date in `text` with what the words around it say about it. */
function foundDates(text: string): FoundDate[] {
  const ms = dateMatches(text);
  const out: FoundDate[] = [];
  ms.forEach((m, i) => {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const range_end = i > 0 && RANGE_RE.test(text.slice(ms[i - 1].end, m.index));
    out.push({ date: m.date, range_end, from: FROM_RE.test(before), period: PERIOD_RE.test(before) || (range_end && out[i - 1].period) });
  });
  return out;
}

/** Parse the dates people write in PSX filings: "September 30, 2026", "30-09-2026", "30 Sep 2026", "2026-09-30", "30/09/2026" -> "2026-09-30"; null otherwise (the first real date wins; a two-digit year is not accepted). */
export function parseLooseDate(text: string): string | null {
  return dateMatches(text)[0]?.date ?? null;
}

/** Every distinct date in `text` (same formats as parseLooseDate), in order of appearance. */
export function datesIn(text: string): string[] {
  return [...new Set(dateMatches(text).map((m) => m.date))];
}

/** ISSUE-06: a date more than rules.ai.date_sanity.max_days_before_filing days before the filing or more than max_days_after_filing after it is not plausible for that filing. A malformed date is never sane. */
export function dateSane(date: string, filedOn: string, rules: Rules = DEFAULT_RULES): boolean {
  if (!validIso(date) || !validIso(filedOn)) return false;
  const gap = daysBetween(filedOn, date);
  return gap >= -rules.ai.date_sanity.max_days_before_filing && gap <= rules.ai.date_sanity.max_days_after_filing;
}

/**
 * Classify an AI summary / figure set against its filing date. Event dates (a meeting, a payment, a book closure)
 * decide: 'older_document' when every one is more than max_days_before_filing days before the filing and no
 * reporting period in the text is within the plausible window (a re-upload of an old notice: INDU's lone
 * "Credited by: October 02, 2024" on a 2026-10 filing); 'date_unclear' when some date is implausible (AHCL's
 * "meet on September 30, 2020" beside "year ended June 30, 2026" on a 2026-09-22 filing); 'ok' otherwise,
 * including when there is no date at all. A reporting period in the past ("year ended June 30, 2026" filed in
 * October, "quarter ended September 30, 2025" as last year's comparison) is never evidence that the document is
 * old; a period further ahead than max_days_after_filing is a misread.
 */
export function dateVerdict(texts: string[], filedOn: string, rules: Rules = DEFAULT_RULES): 'ok' | 'older_document' | 'date_unclear' {
  if (!validIso(filedOn)) return 'ok';
  const found = texts.flatMap(foundDates);
  const events = [...new Set(found.filter((d) => !d.period).map((d) => d.date))];
  const periods = [...new Set(found.filter((d) => d.period).map((d) => d.date))];
  if (!events.length && !periods.length) return 'ok';
  const before = rules.ai.date_sanity.max_days_before_filing;
  const sane = (d: string) => dateSane(d, filedOn, rules);
  if (events.length && events.every((d) => daysBetween(filedOn, d) < -before) && !periods.some(sane)) return 'older_document';
  const unclear = events.some((d) => !sane(d)) || periods.some((d) => !sane(d) && daysBetween(filedOn, d) > 0);
  return unclear ? 'date_unclear' : 'ok';
}

// ---------------------------------------------------------------------------
// This week
// ---------------------------------------------------------------------------

export type WeekEventKind = 'buy_by' | 'book_closure' | 'results' | 'board_meeting' | 'review_due' | 'payout';

export interface WeekEvent {
  date: string;
  kind: WeekEventKind;
  symbol: string;
  title: string; // "Last day to buy for Rs 2/share"
  detail: string | null;
  days: number; // from today; today = 0
  mine: boolean; // holding (true) vs watchlist
  source_id: string | null; // dividend / announcement / holding id
}

export interface WeekAheadInput {
  today: string;
  days?: number; // window length, default 7: today (0) up to and including today + days
  max?: number; // rows to return; the rest is counted in `more`
  held: string[];
  watched: string[];
  dividends: DividendEvent[];
  announcements: Announcement[];
  holdings: Holding[];
  cal: TradingCalendar;
  rules?: Rules;
}

const TITLES: Record<WeekEventKind, string> = {
  buy_by: 'Last day to buy', book_closure: 'Book closure starts', payout: 'Dividend payment',
  results: 'Results expected', board_meeting: 'Board meeting', review_due: 'Thesis review due',
};
const KIND_RANK: Record<WeekEventKind, number> = { buy_by: 0, book_closure: 1, payout: 2, results: 3, board_meeting: 4, review_due: 5 };
/** Figure labels worth a date: the spec's meeting/date/result plus the payment and book closure labels that feed 'payout' and 'book_closure'. */
const DATED_LABEL_RE = /meeting|date|result|pay|credit|closure/i;

const norm = (s: string) => s.trim().toUpperCase();
const rsPerShare = (dps: number) => `Rs ${Number(dps.toFixed(2))}/share`;

/** What a label or title is about, when it says so. */
const kindFromText = (s: string): WeekEventKind | null =>
  /book closure/i.test(s) ? 'book_closure'
    : /pay|credit|disburs/i.test(s) ? 'payout'
      : /meeting/i.test(s) ? 'board_meeting'
        : /result|account|financial/i.test(s) ? 'results' : null;
const announcementKind = (a: Announcement): WeekEventKind | null =>
  a.kind === 'results' ? 'results' : a.kind === 'board_meeting' ? 'board_meeting' : kindFromText(a.title);

/**
 * Dates in a title that stand for an event: not a reporting period ("quarter ended September 30, 2026"), not the
 * end of a range ("book closure from Oct 17 to Oct 22" is Oct 17), and when the notice moves an event
 * ("rescheduled from Oct 16 to Oct 20") the new date, not the old. "Postponed to Oct 20" and "adjourned till
 * Oct 20" are events.
 */
function eventDates(title: string): string[] {
  const dates = foundDates(title);
  const moved = MOVED_RE.test(title);
  const kept = dates.filter((d, i) => {
    if (d.period) return false;
    if (d.range_end) return moved && dates[i - 1].from; // the new date in "rescheduled from X to Y"
    return !(moved && d.from && dates[i + 1]?.range_end); // not the old date in "rescheduled from X to Y"
  });
  return [...new Set(kept.map((d) => d.date))];
}

/**
 * The event dates an announcement names, as "This week" reads them: first its AI figures (labels matching
 * meeting/date/result/pay/credit/closure whose value parses as a date; the kind from the label, else from the
 * notice), then its title when the title says what the date is for (eventDates). Dates that are not plausible for
 * the filing date (dateSane) are left out. In order of appearance; the same date may come twice.
 */
export function announcementDates(a: Announcement, rules: Rules = DEFAULT_RULES): { date: string; kind: WeekEventKind; detail: string }[] {
  const out: { date: string; kind: WeekEventKind; detail: string }[] = [];
  for (const f of a.ai_figures ?? []) {
    if (!DATED_LABEL_RE.test(f.label)) continue;
    const date = parseLooseDate(f.value);
    const kind = kindFromText(f.label) ?? announcementKind(a);
    if (date && kind && dateSane(date, a.published_at, rules)) out.push({ date, kind, detail: `${f.label}: ${f.value}` });
  }
  const kind = announcementKind(a);
  if (kind) for (const date of eventDates(a.title)) if (dateSane(date, a.published_at, rules)) out.push({ date, kind, detail: a.title });
  return out;
}

/**
 * The day book closure starts according to the notice itself (the earliest book-closure date announcementDates()
 * finds), else null. Expected dividends and "This week" use it when a dividend row has no book_closure_from yet.
 */
export function bookClosureDate(a: Announcement | undefined, rules: Rules = DEFAULT_RULES): string | null {
  if (!a) return null;
  const dates = announcementDates(a, rules).filter((d) => d.kind === 'book_closure').map((d) => d.date).sort();
  return dates[0] ?? null;
}

/**
 * Everything dated in the next `days` (default 7) days for the given symbols, soonest first, at most `max` rows
 * (the surplus is returned as `more`): last day to buy and book closure start from dividend events (a buy-by day
 * already gone is left out; the book closure row says so; a dividend without book_closure_from takes the date its
 * notice names, bookClosureDate()); results / board meeting / payment dates from
 * announcements' AI figures (labels matching meeting/date/result/pay/credit/closure whose value parses as a date)
 * and from titles that contain an event date; thesis review dates from holdings (`review_on`). Today counts as
 * 0 days and the window runs through today + `days` inclusive. One row per symbol, kind and date.
 */
export function weekAhead(o: WeekAheadInput): { events: WeekEvent[]; more: number } {
  const rules = o.rules ?? DEFAULT_RULES;
  const last = addDays(o.today, o.days ?? 7);
  const held = new Set(o.held.map(norm));
  const watched = new Set(o.watched.map(norm));
  const wanted = (s: string) => held.has(norm(s)) || watched.has(norm(s));
  const all: WeekEvent[] = [];
  const seen = new Set<string>();
  const push = (e: Omit<WeekEvent, 'days' | 'mine' | 'symbol'> & { symbol: string }) => {
    if (e.date < o.today || e.date > last) return;
    const symbol = norm(e.symbol);
    const key = `${symbol}|${e.kind}|${e.date}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push({ ...e, symbol, days: daysBetween(o.today, e.date), mine: held.has(symbol) });
  };

  // "today", "Sat", "Oct 22" as seen from o.today (PKT noon of that day)
  const now = new Date(o.today + 'T12:00:00+05:00');
  const on = (date: string) => day(date, now).replace(/^(Today|Tomorrow|Yesterday)$/, (w) => w.toLowerCase());
  const byId = new Map(o.announcements.map((a) => [a.id, a]));

  for (const d of o.dividends) {
    const from = validIso(d.book_closure_from) ? d.book_closure_from : bookClosureDate(byId.get(d.id), rules);
    if (!from || !wanted(d.symbol)) continue;
    const buyBy = buyByDate(from, o.cal, rules);
    const dps = d.dps != null ? rsPerShare(d.dps) : null;
    const note = d.verified ? '' : ' (unverified)';
    const closure = validIso(d.book_closure_to) ? `Book closure ${on(from)} to ${on(d.book_closure_to)}` : `Book closure starts ${on(from)}`;
    if (buyBy >= o.today) {
      push({ date: buyBy, kind: 'buy_by', symbol: d.symbol, title: dps ? `Last day to buy for ${dps}` : 'Last day to buy for the dividend', detail: closure + note, source_id: d.id });
    }
    push({
      date: from, kind: 'book_closure', symbol: d.symbol, title: dps ? `Book closure starts (${dps})` : TITLES.book_closure,
      detail: (buyBy >= o.today ? `Buy by ${on(buyBy)}` : `Last day to buy was ${on(buyBy)}`) + note, source_id: d.id,
    });
  }

  const anns = o.announcements.filter((a) => wanted(a.symbol)).sort((a, b) => b.published_at.localeCompare(a.published_at)); // newest notice wins a tie
  for (const a of anns) {
    for (const e of announcementDates(a, rules)) push({ ...e, symbol: a.symbol, title: TITLES[e.kind], source_id: a.id });
  }

  for (const h of o.holdings) {
    if (!validIso(h.review_on) || !wanted(h.symbol)) continue;
    push({ date: h.review_on, kind: 'review_due', symbol: h.symbol, title: TITLES.review_due, detail: h.thesis ?? h.note ?? null, source_id: h.id ?? null });
  }

  all.sort((a, b) => a.date.localeCompare(b.date) || Number(b.mine) - Number(a.mine) || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.symbol.localeCompare(b.symbol));
  const events = o.max == null ? all : all.slice(0, Math.max(0, o.max));
  return { events, more: all.length - events.length };
}
