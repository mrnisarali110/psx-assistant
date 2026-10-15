-- Hard caps (Trim above them) on top of the soft caps (no new money), loss-quarter rules, and quarterly profit
-- read from results filings. Idempotent. Applied automatically by .github/workflows/migrate.yml.

alter table public.settings add column if not exists hard_stock_cap_pct numeric(5,2) not null default 30
  check (hard_stock_cap_pct > 0 and hard_stock_cap_pct <= 100);
alter table public.settings add column if not exists hard_sector_cap_pct numeric(5,2) not null default 40
  check (hard_sector_cap_pct > 0 and hard_sector_cap_pct <= 100);
alter table public.settings add column if not exists review_after_loss_quarters integer not null default 2
  check (review_after_loss_quarters >= 0 and review_after_loss_quarters <= 12);
alter table public.settings add column if not exists sell_after_loss_quarters integer not null default 4
  check (sell_after_loss_quarters >= 0 and sell_after_loss_quarters <= 12);

-- ---- one row per results filing: profit after tax of the latest quarter (public, worker writes) ----
create table if not exists public.earnings (
  id                text primary key,           -- the announcement id
  symbol            text not null,
  period_end        date not null,              -- last day of the quarter
  profit_after_tax  numeric(18,0) not null,     -- rupees for that quarter; negative = loss
  verified          boolean not null default false,
  pdf_url           text,
  created_at        timestamptz not null default now()
);
create index if not exists earnings_symbol_period on public.earnings (symbol, period_end desc);
alter table public.earnings enable row level security;
drop policy if exists signed_in_read on public.earnings;
create policy signed_in_read on public.earnings for select to authenticated using (true);
revoke all on public.earnings from anon, authenticated;
grant select on public.earnings to authenticated;
grant all on public.earnings to service_role;
