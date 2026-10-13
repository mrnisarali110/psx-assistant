/**
 * Capture live PSX data into shared/fixtures/seed-prices.json (tests + demo mode).
 *   npx tsx scripts/capture-fixture.ts               everything (tests assert Oct-5 values: update them too)
 *   npx tsx scripts/capture-fixture.ts --screen-only only the KSE-100 screen, keeps prices/index/announcements
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fetchSnapshot, toPrice, toScreenRows } from '../worker/feed.ts';

const FILE = 'shared/fixtures/seed-prices.json';
const SYMBOLS = ['SYS', 'MEBL', 'UBL', 'DCR', 'EFERT', 'LUCK', 'FCCL', 'AVN', 'MARI', 'HUBC', 'FFC', 'OGDC', 'PPL'];
const screenOnly = process.argv.includes('--screen-only');

const snap = await fetchSnapshot(screenOnly ? [] : SYMBOLS);
if (snap.errors.length) console.warn('errors:', snap.errors);
const old = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const screen = toScreenRows(snap.screener);
let out;
if (screenOnly) {
  out = { ...old, screen, screen_captured_at: snap.fetched_at };
} else {
  const kse = snap.indices.KSE100;
  const asOf = Object.values(snap.quotes).map((q) => q.as_of).filter(Boolean).sort().at(-1) ?? snap.fetched_at;
  out = {
    captured_at: snap.fetched_at,
    index: { ts: asOf, kse100: kse?.value, change: kse?.change, change_pct: kse?.change_pct },
    prices: Object.fromEntries(Object.values(snap.quotes).map((q) => [q.symbol, toPrice(q, snap.screener[q.symbol])])),
    announcements: Object.values(snap.quotes).flatMap((q) => q.announcements.slice(0, 3)),
    screen,
  };
}
mkdirSync('shared/fixtures', { recursive: true });
writeFileSync(FILE, JSON.stringify(out, null, 2));
console.log(`wrote ${FILE}: ${screen.length} screen rows${screenOnly ? ' (screen only)' : `, ${Object.keys(out.prices).length} prices`}`);
