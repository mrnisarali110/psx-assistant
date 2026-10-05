/** Print the seed plan: npx tsx scripts/show-plan.ts [amount] */
import { allocate, planToText } from '../shared/allocate.ts';
import { SEED_HOLDINGS, SEED_PRICES, SEED_SETTINGS, SEED_WATCHLIST } from '../shared/fixtures/seed.ts';

const plan = allocate({
  amount: Number(process.argv[2] ?? 50000), holdings: SEED_HOLDINGS, watchlist: SEED_WATCHLIST,
  prices: SEED_PRICES, settings: SEED_SETTINGS, today: '2026-10-06',
});
console.log(planToText(plan));
console.log('\nweights after:', Object.fromEntries(Object.entries(plan.weights_after).map(([k, v]) => [k, v.toFixed(1)])));
console.log('skipped:', plan.skipped);
