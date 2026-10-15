-- Broker costs, tax status, sector cap, trim rules, thesis per holding, transaction charges,
-- dividends received, daily KSE-100 closes and daily portfolio values (benchmark + Performance screen).
-- Idempotent. Applied automatically by .github/workflows/migrate.yml.

-- ---- settings: your rules (continued) ----------------------------------------
alter table public.settings add column if not exists max_sector_pct numeric(5,2) not null default 30
  check (max_sector_pct > 0 and max_sector_pct <= 100);
alter table public.settings add column if not exists trim_pe_over_sector_pct numeric(5,2) not null default 50
  check (trim_pe_over_sector_pct >= 0 and trim_pe_over_sector_pct <= 500);
alter table public.settings add column if not exists trim_on_dividend_cut boolean not null default true;

-- ---- settings: broker & tax (every rate is a setting; defaults from shared/rules.json) ----
alter table public.settings add column if not exists broker text not null default 'JS Global' check (char_length(broker) <= 40);
alter table public.settings add column if not exists commission_pct numeric(6,4) not null default 0.15
  check (commission_pct >= 0 and commission_pct <= 5);
alter table public.settings add column if not exists min_commission_per_share numeric(8,4) not null default 0.03
  check (min_commission_per_share >= 0 and min_commission_per_share <= 100);
alter table public.settings add column if not exists sales_tax_pct numeric(5,2) not null default 15
  check (sales_tax_pct >= 0 and sales_tax_pct <= 100);
alter table public.settings add column if not exists tax_filer boolean not null default true;
alter table public.settings add column if not exists match_nccpl boolean not null default false;
alter table public.settings add column if not exists cgt_paid jsonb not null default '{}';            -- {"2026-27": 1800}
alter table public.settings add column if not exists loss_carry_forward jsonb not null default '{}';  -- {"2025-26": 6500}

-- ---- PSX's XD / XB / XR marker, kept apart from the symbol so one company is one row --------
alter table public.prices add column if not exists ex text check (ex is null or ex ~ '^(XD|XB|XR)+$');
alter table public.market_screen add column if not exists ex text check (ex is null or ex ~ '^(XD|XB|XR)+$');

-- ---- announcements: the AI's dates do not fit the filing date (a re-upload of an old notice, or a wrong date) ----
alter table public.announcements add column if not exists ai_date_note text
  check (ai_date_note is null or ai_date_note in ('older_document', 'date_unclear'));

-- ---- holdings: why I own it, when to re-check, a target price ----------------
alter table public.holdings add column if not exists thesis text check (char_length(thesis) <= 200);
alter table public.holdings add column if not exists review_on date;
alter table public.holdings add column if not exists target_price numeric(12,2) check (target_price is null or target_price > 0);

-- ---- transactions: real charges per side, CSV source, edits allowed ----------
alter table public.transactions add column if not exists charges numeric(12,2) check (charges is null or charges >= 0);
alter table public.transactions drop constraint if exists transactions_source_check;
alter table public.transactions add constraint transactions_source_check check (source in ('manual', 'import', 'csv'));
grant update on public.transactions to authenticated;

-- ---- dividends received (private): credited net of withholding tax -------------
create table if not exists public.dividend_receipts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol       text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  paid_on      date not null,
  shares       integer not null check (shares > 0),
  dps          numeric(10,4) not null check (dps > 0),
  gross        numeric(14,2) not null check (gross >= 0),
  wht_pct      numeric(5,2) not null check (wht_pct >= 0 and wht_pct <= 100),
  net          numeric(14,2) not null check (net >= 0),
  dividend_id  text,                                   -- the declared dividend it came from, when known
  note         text check (char_length(note) <= 200),
  created_at   timestamptz not null default now()
);
create index if not exists dividend_receipts_user_date on public.dividend_receipts (user_id, paid_on desc);
alter table public.dividend_receipts enable row level security;
drop policy if exists own_rows on public.dividend_receipts;
create policy own_rows on public.dividend_receipts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.dividend_receipts from anon, authenticated;
grant select, insert, update, delete on public.dividend_receipts to authenticated;
grant all on public.dividend_receipts to service_role;

-- ---- KSE-100 close per trading day (public, worker writes; backfilled from index_snapshots) ----
create table if not exists public.index_daily (
  day         date primary key,
  close       numeric(12,2) not null,
  updated_at  timestamptz not null default now()
);
alter table public.index_daily enable row level security;
drop policy if exists signed_in_read on public.index_daily;
create policy signed_in_read on public.index_daily for select to authenticated using (true);
revoke all on public.index_daily from anon, authenticated;
grant select on public.index_daily to authenticated;
grant all on public.index_daily to service_role;
insert into public.index_daily (day, close)
  select distinct on (d) d, kse100 from (
    select (ts at time zone 'Asia/Karachi')::date as d, ts, kse100 from public.index_snapshots
  ) s order by d, ts desc
on conflict (day) do nothing;

-- ---- one portfolio value per user per trading day (private, written by the night job) ----
create table if not exists public.portfolio_daily (
  user_id     uuid not null references auth.users (id) on delete cascade,
  day         date not null,
  value       numeric(14,2) not null,
  invested    numeric(14,2) not null,   -- cost of the holdings valued that day
  primary key (user_id, day)
);
alter table public.portfolio_daily enable row level security;
drop policy if exists own_rows on public.portfolio_daily;
create policy own_rows on public.portfolio_daily for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.portfolio_daily from anon, authenticated;
grant select on public.portfolio_daily to authenticated;
grant all on public.portfolio_daily to service_role;
