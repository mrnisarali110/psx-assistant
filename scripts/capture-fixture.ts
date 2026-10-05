/**
 * Capture live PSX data for the seed symbols into shared/fixtures/seed-prices.json.
 * The rules tests and the app's demo mode use it. Run: npx tsx scripts/capture-fixture.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fetchSnapshot, toPrice } from '../worker/feed.ts';

const SYMBOLS = ['SYS', 'MEBL', 'UBL', 'DCR', 'EFERT', 'LUCK', 'FCCL', 'AVN', 'MARI', 'HUBC', 'FFC', 'OGDC', 'PPL'];

const snap = await fetchSnapshot(SYMBOLS);
if (snap.errors.length) console.warn('errors:', snap.errors);
const kse = snap.indices.KSE100;
const asOf = Object.values(snap.quotes).map((q) => q.as_of).filter(Boolean).sort().at(-1) ?? snap.fetched_at;
const out = {
  captured_at: snap.fetched_at,
  index: { ts: asOf, kse100: kse?.value, change: kse?.change, change_pct: kse?.change_pct },
  prices: Object.fromEntries(Object.values(snap.quotes).map((q) => [q.symbol, toPrice(q, snap.screener[q.symbol])])),
  announcements: Object.values(snap.quotes).flatMap((q) => q.announcements.slice(0, 3)),
};
mkdirSync('shared/fixtures', { recursive: true });
writeFileSync('shared/fixtures/seed-prices.json', JSON.stringify(out, null, 2));
for (const p of Object.values(out.prices)) {
  console.log(p.symbol.padEnd(6), String(p.price).padStart(8), String(p.change_pct).padStart(6), 'shariah=', p.is_shariah, 'dy=', p.dividend_yield_pct, p.sector);
}
console.log('KSE100', out.index);
