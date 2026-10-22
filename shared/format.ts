const nf0 = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rs 56,279 (whole rupees). */
export const rs = (v: number | null | undefined) => (v == null ? 'no data' : `Rs ${nf0.format(Math.round(v))}`);
/** Rs 114.37 (share prices). */
export const rs2 = (v: number | null | undefined) => (v == null ? 'no data' : `Rs ${nf2.format(v)}`);
/** Rs 1.2M / Rs 85K for tight spots like chart labels. */
export const rsShort = (v: number | null | undefined) => {
  if (v == null) return 'no data';
  const a = Math.abs(v);
  const s = a >= 1e7 ? `${(a / 1e6).toFixed(0)}M` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(0)}K` : nf0.format(Math.round(a));
  return `${v < 0 ? '-' : ''}Rs ${s}`;
};
export const num = (v: number | null | undefined, digits = 2) =>
  v == null ? 'no data' : new Intl.NumberFormat('en-PK', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
export const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? 'no data' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
export const signedRs = (v: number | null | undefined) =>
  v == null ? 'no data' : `${v > 0 ? '+' : v < 0 ? '-' : ''}Rs ${nf0.format(Math.abs(Math.round(v)))}`;

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** PSX sector names read nicely: "COMMERCIAL BANKS" → "Commercial Banks", acronyms kept. */
export function sectorLabel(s: string): string {
  return titleCase(s).replace(/\b(Reit|Etf|Nbfc|Ppl|Psx)\b/g, (m) => m.toUpperCase());
}

/** "Oct 5, 3:49 PM" in PKT. */
export function asOfLabel(iso: string | null | undefined): string {
  if (!iso) return 'no data';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

export function dateLabel(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(isoDate + 'T00:00:00Z'));
}

/** "2h ago", "yesterday", "Oct 3". */
export function ago(iso: string, now = new Date()): string {
  const mins = Math.round((now.getTime() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  if (mins < 48 * 60) return 'yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', month: 'short', day: 'numeric' }).format(new Date(iso));
}

// ---- One date language for the whole app (owner review 2026-10-23). All in PKT. ----

const PKT = 'Asia/Karachi';
const fmtMonthDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const fmtMonthDayYear = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const fmtWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: PKT, hour: 'numeric', minute: '2-digit' });
const pktDay = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
const utcNoon = (isoDate: string) => new Date(isoDate.slice(0, 10) + 'T12:00:00Z');
/** A timestamp or a YYYY-MM-DD date → its PKT calendar date. */
const toPktDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : pktDay(new Date(iso)));
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/**
 * "Today", "Yesterday", "Tomorrow", a weekday within 6 days either side ("Thu"), "Oct 5" this year, "Oct 5, 2025"
 * otherwise. Accepts a YYYY-MM-DD date or a timestamp (read in PKT).
 */
export function day(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'no date';
  const d = toPktDate(iso);
  const today = pktDay(now);
  const diff = dayDiff(today, d);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  if (Math.abs(diff) <= 6) return fmtWeekday.format(utcNoon(d));
  return d.slice(0, 4) === today.slice(0, 4) ? fmtMonthDay.format(utcNoon(d)) : fmtMonthDayYear.format(utcNoon(d));
}

/** "3:49 PM" in PKT. */
export function time(iso: string | null | undefined): string {
  return iso ? fmtTime.format(new Date(iso)) : 'no time';
}

/** "Today 3:49 PM", "Thu 3:49 PM", "Oct 5 3:49 PM". */
export function dayTime(iso: string | null | undefined, now = new Date()): string {
  return iso ? `${day(iso, now)} ${time(iso)}` : 'no data';
}

/**
 * The word for a price's day change: "Today" only while the price is from today's session (PKT, Mon-Fri);
 * otherwise "Last session (Thu)". At 00:41 on Friday a Thursday close reads "Last session (Thu)".
 */
export function sessionLabel(asOfIso: string | null | undefined, now = new Date()): string {
  if (!asOfIso) return 'Last session';
  const d = toPktDate(asOfIso);
  const weekday = new Date(now.getTime() + 5 * 3600_000).getUTCDay();
  if (d === pktDay(now) && weekday >= 1 && weekday <= 5) return 'Today';
  return `Last session (${fmtWeekday.format(utcNoon(d))})`;
}

/** Greeting by PKT hour: morning 05-12, afternoon 12-17, evening otherwise (00:41 is evening, not morning). */
export function greeting(now = new Date()): string {
  const h = new Date(now.getTime() + 5 * 3600_000).getUTCHours();
  return h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : 'Good evening';
}
