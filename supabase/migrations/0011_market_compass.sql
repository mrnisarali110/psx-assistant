-- Market Compass: dated macro facts (T-bill and PIB yields, CPI, FX reserves, PKR/USD, KIBOR, KSE-100 1-year change)
-- read from SBP / PBS / PSX documents, and the compass reading stored next to each day's bull/bear reading.
-- Public market data: everyone signed in reads, the worker writes. Idempotent. Applied by .github/workflows/migrate.yml.

-- ---- one value per series per date, with the document it came from ------------------------------------------
create table if not exists public.macro_readings (
  series      text not null,
  as_of       date not null,
  value       numeric(14,4) not null,
  source      text not null,
  updated_at  timestamptz not null default now(),
  primary key (series, as_of)
);
alter table public.macro_readings enable row level security;
drop policy if exists signed_in_read on public.macro_readings;
create policy signed_in_read on public.macro_readings for select to authenticated using (true);
revoke all on public.macro_readings from anon, authenticated;
grant select on public.macro_readings to authenticated;
grant all on public.macro_readings to service_role;

-- ---- the compass reading on each trading day -------------------------------------------------------------------
alter table public.market_regime add column if not exists trend text;
alter table public.market_regime add column if not exists pe numeric(8,2);
alter table public.market_regime add column if not exists dividend_yield_pct numeric(8,2);
alter table public.market_regime add column if not exists value_state text;
alter table public.market_regime add column if not exists action text;
alter table public.market_regime add column if not exists compass jsonb;

alter table public.market_regime drop constraint if exists market_regime_trend_check;
alter table public.market_regime add constraint market_regime_trend_check check (trend in ('up','sideways','down'));
alter table public.market_regime drop constraint if exists market_regime_value_state_check;
alter table public.market_regime add constraint market_regime_value_state_check check (value_state in ('cheap','fair','expensive'));
