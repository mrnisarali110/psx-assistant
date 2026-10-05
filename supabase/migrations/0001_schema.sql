-- PSX Personal Investing Assistant: schema, row-level security, signup trigger, seed function.
-- Paste into Supabase Dashboard > SQL Editor > New query, then Run. Safe to run once on an empty project.
--
-- Access model
--   private tables : a signed-in user reads/writes only rows where user_id = auth.uid()
--   public tables  : readable by any signed-in user, written only by the worker (service role)
--   anon (not signed in) : no access to anything

-- ===========================================================================
-- Helpers
-- ===========================================================================
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ===========================================================================
-- Private tables
-- ===========================================================================
create table public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  display_name      text check (char_length(display_name) <= 80),
  telegram_chat_id  bigint,           -- set only by the worker after a verified link code
  created_at        timestamptz not null default now()
);

create table public.settings (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  monthly_budget_pkr     numeric(12,0) not null default 50000  check (monthly_budget_pkr >= 0),
  crash_fund_pkr         numeric(12,0) not null default 50000  check (crash_fund_pkr >= 0),
  crash_trigger_kse      numeric(12,2) not null default 155000 check (crash_trigger_kse > 0),
  max_position_pct       numeric(5,2)  not null default 25     check (max_position_pct > 0 and max_position_pct <= 100),
  drop_alert_pct         numeric(5,2)  not null default 10     check (drop_alert_pct > 0 and drop_alert_pct < 100),
  tranche_split          jsonb not null default
    '[{"pct":40,"after_days":0},{"pct":40,"after_days":14},{"pct":20,"after_days":25}]',
  quiet_hours            jsonb not null default '{"start":"23:00","end":"07:00"}',
  shariah_only           boolean not null default false,
  notifications_enabled  boolean not null default true,
  updated_at             timestamptz not null default now()
);

create table public.holdings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol      text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  shares      integer not null check (shares > 0),
  avg_cost    numeric(12,2) not null check (avg_cost >= 0),
  status      text not null default 'core' check (status in ('core', 'hold_no_add', 'review')),
  sector      text,
  is_shariah  boolean not null default false,
  note        text check (char_length(note) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, symbol)
);

create table public.watchlist (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol      text not null check (symbol ~ '^[A-Z0-9]{1,12}$'),
  note        text check (char_length(note) <= 200),
  created_at  timestamptz not null default now(),
  unique (user_id, symbol)
);

create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  unique (user_id, endpoint)
);

-- One-time code the user sends to the Telegram bot to link their chat.
-- The user can only create one (code and expiry are generated here); the worker consumes it.
create table public.telegram_link_codes (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  code        text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  expires_at  timestamptz not null default now() + interval '15 minutes'
);

create table public.alerts_log (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        text not null,
  symbol      text,
  message     text not null,
  channel     text check (channel in ('push', 'telegram', 'both', 'none')),
  sent_at     timestamptz not null default now(),
  dedupe_key  text not null,
  unique (user_id, dedupe_key)
);
create index alerts_log_user_sent on public.alerts_log (user_id, sent_at desc);

create table public.recommendations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at          timestamptz not null default now(),
  amount_pkr          numeric(12,0) not null check (amount_pkr >= 0),
  payload             jsonb not null,
  outcome_checked_at  timestamptz
);
create index recommendations_user_created on public.recommendations (user_id, created_at desc);

create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();
create trigger holdings_touch before update on public.holdings
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- Public market tables (worker writes, signed-in users read)
-- ===========================================================================
create table public.prices (
  symbol              text primary key,
  name                text,
  sector              text,
  price               numeric(12,2),
  change              numeric(12,2),
  change_pct          numeric(7,2),
  volume              bigint,
  ldcp                numeric(12,2),
  high_52w            numeric(12,2),
  low_52w             numeric(12,2),
  dividend_yield_pct  numeric(7,2),
  pe                  numeric(9,2),
  as_of               timestamptz,          -- time PSX reports for the quote
  updated_at          timestamptz not null default now()  -- time the worker wrote it
);

create table public.index_snapshots (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null unique,
  kse100      numeric(12,2) not null,
  change      numeric(12,2),
  change_pct  numeric(7,2)
);
create index index_snapshots_ts on public.index_snapshots (ts desc);

create table public.announcements (
  id             text primary key,          -- 'psx-doc-<id>' from the PDF link, else a hash
  symbol         text not null,
  title          text not null,
  kind           text not null check (kind in ('dividend', 'results', 'board_meeting', 'other')),
  published_at   date not null,
  pdf_url        text,
  first_seen_at  timestamptz not null default now()
);
create index announcements_symbol_published on public.announcements (symbol, published_at desc);

-- Heartbeat: one row per worker run. Also keeps the free project from pausing.
create table public.worker_runs (
  id           bigint generated always as identity primary key,
  job          text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  errors       jsonb not null default '[]'
);
create index worker_runs_started on public.worker_runs (started_at desc);

-- ===========================================================================
-- Privileges: start from nothing, grant exactly what each role needs
-- ===========================================================================
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;

grant select, update (display_name)                  on public.profiles           to authenticated;
grant select, update                                 on public.settings           to authenticated;
grant select, insert, update, delete                 on public.holdings           to authenticated;
grant select, insert, update, delete                 on public.watchlist          to authenticated;
grant select, insert, delete                         on public.push_subscriptions to authenticated;
grant select, insert (user_id), delete               on public.telegram_link_codes to authenticated;
grant select                                         on public.alerts_log         to authenticated;
grant select, insert, delete                         on public.recommendations    to authenticated;
grant select on public.prices, public.index_snapshots, public.announcements, public.worker_runs to authenticated;

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ===========================================================================
-- Row-level security
-- ===========================================================================
alter table public.profiles            enable row level security;
alter table public.settings            enable row level security;
alter table public.holdings            enable row level security;
alter table public.watchlist           enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.alerts_log          enable row level security;
alter table public.recommendations     enable row level security;
alter table public.prices              enable row level security;
alter table public.index_snapshots     enable row level security;
alter table public.announcements       enable row level security;
alter table public.worker_runs         enable row level security;

create policy own_profile on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy own_rows on public.settings            for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.holdings            for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.watchlist           for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.push_subscriptions  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.telegram_link_codes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.alerts_log          for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.recommendations     for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy signed_in_read on public.prices          for select to authenticated using (true);
create policy signed_in_read on public.index_snapshots for select to authenticated using (true);
create policy signed_in_read on public.announcements   for select to authenticated using (true);
create policy signed_in_read on public.worker_runs     for select to authenticated using (true);

-- ===========================================================================
-- New user -> profile + default settings
-- ===========================================================================
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
    values (new.id, split_part(coalesce(new.email, ''), '@', 1))
    on conflict (id) do nothing;
  insert into public.settings (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- Seed the owner's portfolio (section 9). Callable only from the SQL editor.
--   select public.seed_owner_portfolio('you@example.com');
-- Shares and average cost from JS InvestPro screenshots, early October 2026.
-- ===========================================================================
create or replace function public.seed_owner_portfolio(p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then
    raise exception 'No account with email %. Create it first (Authentication > Users > Add user).', p_email;
  end if;

  insert into public.holdings (user_id, symbol, shares, avg_cost, sector, is_shariah, status, note) values
    (uid, 'SYS',   118, 130.45, 'Technology', true,  'core',        'Earnings growing, near the cap, so add small'),
    (uid, 'MEBL',   20, 583.06, 'Banks',      true,  'core',        'Quality bank, below cost'),
    (uid, 'UBL',    16, 442.93, 'Banks',      false, 'core',        'Dividend payer, below cost'),
    (uid, 'DCR',   170,  38.07, 'REIT',       true,  'core',        'Only holding in profit'),
    (uid, 'EFERT',  50, 212.68, 'Fertilizer', true,  'hold_no_add', 'Large position, already the biggest loser'),
    (uid, 'LUCK',   10, 458.39, 'Cement',     true,  'hold_no_add', 'Waiting for rate cuts'),
    (uid, 'FCCL',   45,  52.30, 'Cement',     true,  'hold_no_add', 'Waiting for rate cuts'),
    (uid, 'AVN',   100,  29.31, 'Technology', true,  'review',      'Weak earnings, re-check after its Oct 30 results')
  on conflict (user_id, symbol) do update set
    shares = excluded.shares, avg_cost = excluded.avg_cost, sector = excluded.sector,
    is_shariah = excluded.is_shariah, status = excluded.status, note = excluded.note;

  insert into public.watchlist (user_id, symbol, note) values
    (uid, 'MARI', 'Suggested candidate'), (uid, 'HUBC', 'Suggested candidate'),
    (uid, 'FFC',  'Suggested candidate'), (uid, 'OGDC', 'Suggested candidate'),
    (uid, 'PPL',  'Suggested candidate')
  on conflict (user_id, symbol) do nothing;

  insert into public.settings (user_id) values (uid) on conflict (user_id) do nothing;
  update public.settings set
    monthly_budget_pkr = 50000, crash_fund_pkr = 50000, crash_trigger_kse = 155000,
    max_position_pct = 25, drop_alert_pct = 10, shariah_only = false,
    tranche_split = '[{"pct":40,"after_days":0},{"pct":40,"after_days":14},{"pct":20,"after_days":25}]'
  where user_id = uid;

  return 'Seeded 8 holdings, 5 watchlist names and settings for ' || p_email;
end $$;
revoke execute on function public.seed_owner_portfolio(text) from public, anon, authenticated;
