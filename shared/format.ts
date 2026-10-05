const nf0 = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Rs 56,279 (whole rupees). */
export const rs = (v: number | null | undefined) => (v == null ? 'no data' : `Rs ${nf0.format(Math.round(v))}`);
/** Rs 114.37 (share prices). */
export const rs2 = (v: number | null | undefined) => (v == null ? 'no data' : `Rs ${nf2.format(v)}`);
export const num = (v: number | null | undefined, digits = 2) =>
  v == null ? 'no data' : new Intl.NumberFormat('en-PK', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
export const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? 'no data' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
export const signedRs = (v: number | null | undefined) =>
  v == null ? 'no data' : `${v > 0 ? '+' : v < 0 ? '-' : ''}Rs ${nf0.format(Math.abs(Math.round(v)))}`;

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
