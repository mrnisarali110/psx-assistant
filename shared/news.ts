/** News helpers shared by the night digest and the News screen. */
import type { Announcement } from './types.ts';
import { addDays } from './time.ts';

/** One filing per symbol and title (PSX often posts the same notice twice). */
export function dedupeFilings<T extends Pick<Announcement, 'symbol' | 'title'>>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = `${a.symbol}|${a.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Group items under "Today", "Yesterday" or a date label, newest group first. */
export function groupByDay<T>(items: T[], dayOf: (t: T) => string, today: string): { label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const it of items) groups.set(dayOf(it), [...(groups.get(dayOf(it)) ?? []), it]);
  const label = (d: string) => (d === today ? 'Today' : d === addDays(today, -1) ? 'Yesterday'
    : new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d + 'T00:00:00Z')));
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, list]) => ({ label: label(d), items: list }));
}

/** PSX titles are often ALL CAPS; show them in headline case (names stay readable), keeping the ticker as is. */
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
export function tidyTitle(title: string, symbol: string): string {
  const letters = title.replace(/[^A-Za-z]/g, '');
  if (!letters || letters.replace(/[^A-Z]/g, '').length / letters.length < 0.8) return title;
  return title.toLowerCase().split(/(\s+)/).map((w, i) => {
    if (w.replace(/[^a-z0-9]/g, '').toUpperCase() === symbol) return w.toUpperCase();
    if (i > 0 && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}
