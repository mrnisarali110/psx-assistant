-- Blue-chip (BC) badge: the screener fields it needs, annual profit history, audit findings, the current BC state per
-- company and a history of every recheck (pass/fail per check, the actual values and the data source used).
-- Idempotent. Applied automatically by .github/workflows/migrate.yml.

-- ---- screener: index membership, PSX's 30-day average volume, market cap rank among all listed stocks ----
alter table public.market_screen add column if not exists listed_in text[];
alter table public.market_screen add column if not exists avg_volume_30d numeric(18,0);
alter table public.market_screen add column if not exists mcap_rank integer;

-- ---- profit after tax per financial year (public, worker writes) -----------------------------------------
create table if not exists public.company_annuals (
  symbol            text not null,
  year              integer not null check (year between 1990 and 2100),
  source            text not null check (source in ('psx_financials', 'filing')),
  profit_after_tax  numeric(20,0) not null,              -- rupees
  consolidated      boolean,                             -- null = the source does not say
  filing_id         text,
  updated_at        timestamptz not null default now(),
  primary key (symbol, year, source)
);
alter table public.company_annuals enable row level security;
drop policy if exists signed_in_read on public.company_annuals;
create policy signed_in_read on public.company_annuals for select to authenticated using (true);
revoke all on public.company_annuals from anon, authenticated;
grant select on public.company_annuals to authenticated;
grant all on public.company_annuals to service_role;

-- ---- auditor's opinion in annual reports (text search of the PDF, no AI) --------------------------------
create table if not exists public.company_audits (
  symbol      text not null,
  year        integer not null,
  qualified   boolean not null,
  filing_id   text not null,
  checked_at  timestamptz not null default now(),
  primary key (symbol, year)
);
alter table public.company_audits enable row level security;
drop policy if exists signed_in_read on public.company_audits;
create policy signed_in_read on public.company_audits for select to authenticated using (true);
revoke all on public.company_audits from anon, authenticated;
grant select on public.company_audits to authenticated;
grant all on public.company_audits to service_role;

-- ---- the current BC state per company (public, worker writes) -------------------------------------------
create table if not exists public.bluechip (
  symbol       text primary key,
  status       text not null check (status in ('bc', 'at_risk', 'not_bc', 'not_enough_data')),
  badge        boolean not null,
  fails        integer not null default 0,
  reason       text,
  checks       jsonb not null default '[]',   -- [{key, label, ok, detail, source}]
  checked_on   date not null,
  config_hash  text not null,
  lost_on      date                             -- when it last lost the badge (Home warns for a while)
);
alter table public.bluechip enable row level security;
drop policy if exists signed_in_read on public.bluechip;
create policy signed_in_read on public.bluechip for select to authenticated using (true);
revoke all on public.bluechip from anon, authenticated;
grant select on public.bluechip to authenticated;
grant all on public.bluechip to service_role;

-- ---- every recheck, kept for tracing a badge back to its numbers ----------------------------------------
create table if not exists public.bluechip_history (
  id          bigint generated always as identity primary key,
  symbol      text not null,
  checked_on  date not null,
  status      text not null,
  checks      jsonb not null,
  trigger     text not null                    -- weekly | filing | index_change | config | annual_season | first
);
create index if not exists bluechip_history_symbol on public.bluechip_history (symbol, checked_on desc);
alter table public.bluechip_history enable row level security;
drop policy if exists signed_in_read on public.bluechip_history;
create policy signed_in_read on public.bluechip_history for select to authenticated using (true);
revoke all on public.bluechip_history from anon, authenticated;
grant select on public.bluechip_history to authenticated;
grant all on public.bluechip_history to service_role;
