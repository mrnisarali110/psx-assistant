-- Mobile redesign: transactions, last-buy price, dividends, Discover picks, richer AI insights.
-- Idempotent. Applied automatically by .github/workflows/migrate.yml.

-- ---- last buy price per holding ("x% below your last buy") -----------------
alter table public.holdings add column if not exists last_buy_price numeric(12,2) check (last_buy_price is null or last_buy_price > 0);
alter table public.holdings add column if not exists last_buy_on date;

-- ---- buys and sells (private) ----------------------------------------------
create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol       text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  side         text not null check (side in ('buy', 'sell')),
  shares       integer not null check (shares > 0),
  price        numeric(12,2) not null check (price > 0),
  amount       numeric(14,2) not null check (amount > 0),
  executed_on  date not null default ((now() at time zone 'Asia/Karachi')::date),
  source       text not null default 'manual' check (source in ('manual', 'import')),
  created_at   timestamptz not null default now()
);
create index if not exists transactions_user_date on public.transactions (user_id, executed_on desc);
alter table public.transactions enable row level security;
drop policy if exists own_rows on public.transactions;
create policy own_rows on public.transactions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.transactions from anon, authenticated;
grant select, insert, delete on public.transactions to authenticated;
grant all on public.transactions to service_role;

-- ---- cash dividends read from PSX announcements (public, worker writes) ----
create table if not exists public.dividends (
  id                 text primary key,          -- the announcement id
  symbol             text not null,
  announced_on       date not null,
  dps                numeric(10,2),             -- rupees per share
  dividend_type      text check (dividend_type in ('interim', 'final', 'special')),
  book_closure_from  date,
  book_closure_to    date,
  verified           boolean not null default false,
  pdf_url            text,
  created_at         timestamptz not null default now()
);
create index if not exists dividends_symbol_date on public.dividends (symbol, announced_on desc);
create index if not exists dividends_book_closure on public.dividends (book_closure_from);
alter table public.dividends enable row level security;
drop policy if exists signed_in_read on public.dividends;
create policy signed_in_read on public.dividends for select to authenticated using (true);
revoke all on public.dividends from anon, authenticated;
grant select on public.dividends to authenticated;
grant all on public.dividends to service_role;

-- ---- Discover: nightly AI picks (public, worker writes) --------------------
create table if not exists public.ai_picks (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('undervalued', 'dividend')),
  created_at  timestamptz not null default now(),
  model       text,
  items       jsonb not null default '[]'           -- [{symbol, why, frequency?}]
);
create index if not exists ai_picks_kind_created on public.ai_picks (kind, created_at desc);
alter table public.ai_picks enable row level security;
drop policy if exists signed_in_read on public.ai_picks;
create policy signed_in_read on public.ai_picks for select to authenticated using (true);
revoke all on public.ai_picks from anon, authenticated;
grant select on public.ai_picks to authenticated;
grant all on public.ai_picks to service_role;

-- ---- richer AI insight + 1-year change on the screen ------------------------
alter table public.ai_insights add column if not exists stance text check (stance in ('buy', 'hold', 'wait'));
alter table public.ai_insights add column if not exists holding_calls jsonb not null default '[]';
alter table public.ai_insights add column if not exists rebalance text;
alter table public.ai_insights add column if not exists cash_note text;
alter table public.market_screen add column if not exists change_1y_pct numeric(8,2);
