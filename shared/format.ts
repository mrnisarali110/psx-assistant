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
