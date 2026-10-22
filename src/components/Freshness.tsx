/**
 * The slim line under the top bar on every screen: how fresh the prices are and when the market opens or closes.
 * "Data as of Thu 3:49 PM · Market opens Mon 9:15 AM", or "Data as of Today 11:02 AM · Market open · closes 3:30 PM".
 */
import type { AppData } from '../lib/data.ts';
import { tradingCalendar, isTradingDay, type TradingCalendar } from '../../shared/calendar.ts';
import { day, dayTime, time } from '../../shared/format.ts';
import { addDays, hhmmToMinutes, isStale, pktParts } from '../../shared/time.ts';
import { DEFAULT_RULES, type Rules } from '../../shared/types.ts';

/** The newest price time across your stocks, else the index's. */
export function latestAsOf(data: Pick<AppData, 'prices' | 'index'>): string | null {
  const times = Object.values(data.prices).map((p) => p.as_of).filter(Boolean) as string[];
  return times.sort().at(-1) ?? data.index?.ts ?? null;
}

type Hours = Rules['market_hours_pkt'];
const weekdayOf = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay();
const sessionsOn = (d: string, hours: Hours, cal: TradingCalendar) => {
  if (!isTradingDay(d, cal)) return [];
  const wd = weekdayOf(d);
  return wd >= 1 && wd <= 4 ? hours.mon_thu : wd === 5 ? hours.fri : [];
};
/** "9:15 AM" for a PKT wall-clock time on a date. */
const at = (d: string, hhmm: string) => time(`${d}T${hhmm}:00+05:00`);

/**
 * Whether the market is open now (PSX hours from rules.json, holidays from the calendar) and the words for it:
 * "Market open · closes 3:30 PM", "Market reopens today 2:15 PM" (Friday break), "Market opens tomorrow 9:15 AM",
 * "Market opens Mon 9:15 AM".
 */
export function marketLine(now: Date, hours: Hours = DEFAULT_RULES.market_hours_pkt, cal: TradingCalendar = tradingCalendar()): { open: boolean; text: string } {
  const { date, minutes } = pktParts(now);
  const today = sessionsOn(date, hours, cal);
  if (today.some(([s, e]) => minutes >= hhmmToMinutes(s) && minutes < hhmmToMinutes(e))) {
    const close = weekdayOf(date) === 5 ? hours.close_fri : hours.close_mon_thu;
    return { open: true, text: minutes < hhmmToMinutes(close) ? `Market open · closes ${at(date, close)}` : 'Market open · closing session' };
  }
  const later = today.find(([s]) => hhmmToMinutes(s) > minutes);
  if (later) {
    const reopen = today.some(([s]) => hhmmToMinutes(s) <= minutes);
    return { open: false, text: `Market ${reopen ? 'reopens' : 'opens'} today ${at(date, later[0])}` };
  }
  for (let i = 1; i <= 14; i++) {
    const d = addDays(date, i);
    const first = sessionsOn(d, hours, cal)[0];
    if (!first) continue;
    const word = day(d, now);
    return { open: false, text: `Market opens ${word === 'Tomorrow' ? 'tomorrow' : word} ${at(d, first[0])}` };
  }
  return { open: false, text: 'Market closed' };
}

export function Freshness({ data, now = new Date(), className = '' }: { data: AppData; now?: Date; className?: string }) {
  const asOf = latestAsOf(data);
  const hours = DEFAULT_RULES.market_hours_pkt;
  const m = marketLine(now, hours, tradingCalendar(DEFAULT_RULES, data.indexDaily));
  const stale = isStale(asOf, now, DEFAULT_RULES.data.stale_minutes, hours);
  return (
    <p className={`flex flex-wrap items-center gap-x-1.5 text-12 text-muted ${className}`} aria-live="polite">
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.open ? 'bg-info' : 'bg-muted/60'}`} />
      <span className={stale ? 'font-semibold text-caution' : ''}>
        {asOf ? `${stale ? 'May be out of date: data as of ' : 'Data as of '}${dayTime(asOf, now)}` : 'No prices yet'}
      </span>
      <span aria-hidden="true">·</span>
      <span>{m.text}</span>
    </p>
  );
}
