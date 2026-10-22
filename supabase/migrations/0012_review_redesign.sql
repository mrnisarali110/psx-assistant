-- Owner review fixes and redesign (2026-10-23): per-stock daily closes (stock page, sparklines), intraday portfolio
-- values (1D chart), EPS with its basis from results filings (P/E on consolidated EPS), structured filing figures
-- (News cards), and two settings. Idempotent. Applied by .github/workflows/migrate.yml.

-- ---- one close per stock per trading day: public market data, the worker writes ------------------------------
create table if not exists public.price_daily (
  symbol      text not null,
  day         date not null,
  close       numeric(12,2) not null check (close > 0),
  change_pct  numeric(8,2),
  primary key (symbol, day)
);
create index if not exists price_daily_day on public.price_daily (day desc);
alter table public.price_daily enable row level security;
drop policy if exists signed_in_read on public.price_daily;
create policy signed_in_read on public.price_daily for select to authenticated using (true);
revoke all on public.price_daily from anon, authenticated;
grant select on public.price_daily to authenticated;
grant all on public.price_daily to service_role;

-- ---- portfolio value at each market check (private; the worker writes and keeps 10 days) ----------------------
create table if not exists public.portfolio_ticks (
  user_id     uuid not null references auth.users (id) on delete cascade,
  ts          timestamptz not null,
  value       numeric(14,2) not null,
  primary key (user_id, ts)
);
alter table public.portfolio_ticks enable row level security;
drop policy if exists own_rows on public.portfolio_ticks;
create policy own_rows on public.portfolio_ticks for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.portfolio_ticks from anon, authenticated;
grant select on public.portfolio_ticks to authenticated;
grant all on public.portfolio_ticks to service_role;

-- ---- EPS and its basis per results filing ------------------------------------------------------------------
alter table public.earnings add column if not exists eps numeric(12,4);
alter table public.earnings add column if not exists eps_basis text;
alter table public.earnings add column if not exists period_months smallint;
alter table public.earnings drop constraint if exists earnings_eps_basis_check;
alter table public.earnings add constraint earnings_eps_basis_check
  check (eps_basis is null or eps_basis in ('consolidated', 'unconsolidated', 'not_stated'));
alter table public.earnings drop constraint if exists earnings_period_months_check;
alter table public.earnings add constraint earnings_period_months_check
  check (period_months is null or period_months between 1 and 24);

-- ---- structured figures for the News card ------------------------------------------------------------------
alter table public.announcements add column if not exists ai_metrics jsonb;

-- ---- settings ------------------------------------------------------------------------------------------------
alter table public.settings add column if not exists inflation_pct numeric(5,2) not null default 10
  check (inflation_pct >= 0 and inflation_pct <= 50);
alter table public.settings add column if not exists onboarded boolean not null default false;
-- Existing accounts already set up their portfolio: do not show them the first-run setup.
update public.settings s set onboarded = true
  where onboarded = false and exists (select 1 from public.holdings h where h.user_id = s.user_id);
