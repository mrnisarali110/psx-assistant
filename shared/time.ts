// Pakistan Standard Time is UTC+5 all year (no daylight saving).
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Wall-clock parts of `d` in PKT. */
export function pktParts(d: Date) {
  const p = new Date(d.getTime() + PKT_OFFSET_MS);
  return {
    date: p.toISOString().slice(0, 10), // YYYY-MM-DD
    weekday: p.getUTCDay(), // 0 = Sunday
    minutes: p.getUTCHours() * 60 + p.getUTCMinutes(),
  };
}

export const pktDate = (d: Date) => pktParts(d).date;

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000);
}

/** ISO week key like 2026-W41, used for weekly dedupe. */
export function isoWeek(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const hhmmToMinutes = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** True when `minutes` (PKT minutes since midnight) falls inside a start-end window that may wrap midnight. */
export function inWindow(minutes: number, start: string, end: string): boolean {
  const a = hhmmToMinutes(start);
  const b = hhmmToMinutes(end);
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

export function isMarketOpen(now: Date, hours: { mon_thu: string[][]; fri: string[][] }): boolean {
  const { weekday, minutes } = pktParts(now);
  const sessions = weekday >= 1 && weekday <= 4 ? hours.mon_thu : weekday === 5 ? hours.fri : [];
  return sessions.some(([s, e]) => inWindow(minutes, s, e));
}

/** Data is stale when the market is open and the quote is older than `staleMinutes`. */
export function isStale(asOf: string | null | undefined, now: Date, staleMinutes: number,
  hours: { mon_thu: string[][]; fri: string[][] }): boolean {
  if (!asOf) return true;
  if (!isMarketOpen(now, hours)) return false;
  return now.getTime() - Date.parse(asOf) > staleMinutes * 60000;
}
