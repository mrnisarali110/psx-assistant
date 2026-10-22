import { describe, expect, it } from 'vitest';
import { latestAsOf, marketLine } from './Freshness.tsx';
import { tradingCalendar } from '../../shared/calendar.ts';
import { DEFAULT_RULES } from '../../shared/types.ts';

// PKT = UTC+5. Hours from rules.json: Mon-Thu 09:15-15:50 (close 15:30), Fri 09:00-12:00 and 14:15-16:50 (close 16:30).
const at = (pkt: string) => new Date(`${pkt}+05:00`);
const cal = { holidays: new Set<string>() };
const hours = DEFAULT_RULES.market_hours_pkt;

describe('marketLine', () => {
  it('open on a Thursday morning, with the regular close', () => {
    expect(marketLine(at('2026-10-22T11:00:00'), hours, cal)).toEqual({ open: true, text: 'Market open · closes 3:30 PM' });
  });
  it('Friday break reads "reopens today"', () => {
    expect(marketLine(at('2026-10-23T13:00:00'), hours, cal)).toEqual({ open: false, text: 'Market reopens today 2:15 PM' });
  });
  it('before the bell reads "opens today"', () => {
    expect(marketLine(at('2026-10-22T08:00:00'), hours, cal).text).toBe('Market opens today 9:15 AM');
  });
  it('Thursday evening opens tomorrow (Friday) at 9:00', () => {
    expect(marketLine(at('2026-10-22T20:00:00'), hours, cal).text).toBe('Market opens tomorrow 9:00 AM');
  });
  it('Friday night skips the weekend to Monday', () => {
    expect(marketLine(at('2026-10-23T21:00:00'), hours, cal).text).toBe('Market opens Mon 9:15 AM');
  });
  it('skips a holiday', () => {
    const hol = { holidays: new Set(['2026-10-26']) };
    expect(marketLine(at('2026-10-23T21:00:00'), hours, hol).text).toBe('Market opens Tue 9:15 AM');
  });
  it('a holiday is closed even inside trading hours', () => {
    expect(marketLine(at('2026-10-22T11:00:00'), hours, { holidays: new Set(['2026-10-22']) }).open).toBe(false);
  });
  it('works with the rules calendar', () => {
    expect(typeof marketLine(at('2026-10-22T11:00:00'), hours, tradingCalendar()).text).toBe('string');
  });
});

describe('latestAsOf', () => {
  it('takes the newest price, else the index time, else null', () => {
    const p = (as_of: string | null) => ({ price: 1, as_of }) as never;
    expect(latestAsOf({ prices: { A: p('2026-10-22T10:00:00Z'), B: p('2026-10-23T10:00:00Z') }, index: null })).toBe('2026-10-23T10:00:00Z');
    expect(latestAsOf({ prices: {}, index: { ts: '2026-10-21T10:00:00Z' } as never })).toBe('2026-10-21T10:00:00Z');
    expect(latestAsOf({ prices: {}, index: null })).toBeNull();
  });
});
