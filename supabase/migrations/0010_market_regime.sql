-- Bull market ON/OFF and the State Bank policy rate. Public market data: everyone signed in reads, the worker writes.
-- Idempotent. Applied automatically by .github/workflows/migrate.yml.

-- ---- State Bank of Pakistan policy (target) rate decisions, from SBP's own history PDF and monetary policy page ----
create table if not exists public.policy_rates (
  decided_on   date primary key,
  policy_rate  numeric(6,2) not null check (policy_rate between 0 and 100),
  ceiling      numeric(6,2),
  floor        numeric(6,2),
  source       text not null,
  updated_at   timestamptz not null default now()
);
alter table public.policy_rates enable row level security;
drop policy if exists signed_in_read on public.policy_rates;
create policy signed_in_read on public.policy_rates for select to authenticated using (true);
revoke all on public.policy_rates from anon, authenticated;
grant select on public.policy_rates to authenticated;
grant all on public.policy_rates to service_role;

-- ---- one bull/bear reading per trading day ----------------------------------------------------------------------
create table if not exists public.market_regime (
  day                 date primary key,
  bull                boolean not null,
  close               numeric(12,2),
  ma                  numeric(12,2),
  change_1y_pct       numeric(8,2),
  drawdown_pct        numeric(8,2),
  earnings_yield_pct  numeric(8,2),
  policy_rate         numeric(6,2),
  reasons             jsonb not null default '[]'::jsonb,
  updated_at          timestamptz not null default now()
);
alter table public.market_regime enable row level security;
drop policy if exists signed_in_read on public.market_regime;
create policy signed_in_read on public.market_regime for select to authenticated using (true);
revoke all on public.market_regime from anon, authenticated;
grant select on public.market_regime to authenticated;
grant all on public.market_regime to service_role;
