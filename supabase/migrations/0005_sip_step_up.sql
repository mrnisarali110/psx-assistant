-- Yearly step-up of the monthly investment (SIP), used by the wealth projection on Home.
-- Idempotent. Applied automatically by .github/workflows/migrate.yml.
alter table public.settings add column if not exists sip_step_up_pct numeric(5,2) not null default 0
  check (sip_step_up_pct >= 0 and sip_step_up_pct <= 100);
