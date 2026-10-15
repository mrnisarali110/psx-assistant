-- "Buy more" is your rule: this far below your last buy, and only when the P/E is at or under its sector's.
-- Idempotent. Applied automatically by .github/workflows/migrate.yml.
alter table public.settings add column if not exists buy_more_below_pct numeric(5,2) not null default 5
  check (buy_more_below_pct > 0 and buy_more_below_pct < 100);
