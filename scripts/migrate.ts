/**
 * Apply supabase/migrations/*.sql in order, once each. Run by .github/workflows/migrate.yml.
 *   SUPABASE_DB_URL=postgresql://... npx tsx scripts/migrate.ts
 * Use the Session pooler connection string (IPv4); GitHub runners can't reach the IPv6-only direct host.
 * 0001 and 0002 were applied by hand in the SQL editor, so they are recorded as a baseline.
 */
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.log('SUPABASE_DB_URL not set; skipping migrations.');
  process.exit(0);
}

const dir = new URL('../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20_000 });

try {
  await client.connect();
  await client.query(`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await client.query('select name from public.schema_migrations')).rows.map((r) => r.name as string));

  if (!applied.size) {
    const { rows } = await client.query(`select to_regclass('public.holdings') is not null as has_schema,
      exists (select 1 from information_schema.columns where table_schema='public' and table_name='alerts_log' and column_name='batch_id') as has_0002`);
    const baseline = [rows[0].has_schema && '0001_schema.sql', rows[0].has_0002 && '0002_worker_columns.sql'].filter(Boolean) as string[];
    for (const b of baseline) {
      await client.query('insert into public.schema_migrations (name) values ($1) on conflict do nothing', [b]);
      applied.add(b);
      console.log(`baseline: ${b} (already applied by hand)`);
    }
  }

  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(new URL(f, dir), 'utf8');
    console.log(`applying ${f} ...`);
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public.schema_migrations (name) values ($1)', [f]);
      await client.query('commit');
      console.log(`applied ${f}`);
    } catch (e) {
      await client.query('rollback');
      throw new Error(`${f} failed: ${(e as Error).message}`);
    }
  }
  console.log('migrations up to date');
} finally {
  await client.end().catch(() => {});
}
