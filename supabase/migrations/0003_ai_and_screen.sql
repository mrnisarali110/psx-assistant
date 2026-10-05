-- AI layer, KSE-100 opportunity screen, migration tracking. Idempotent (safe to re-run).
-- Applied automatically by .github/workflows/migrate.yml when the SUPABASE_DB_URL secret is set.

-- ---- AI reading of PSX announcements (public, written by the worker) -------
alter table public.announcements add column if not exists ai_summary text;
alter table public.announcements add column if not exists ai_figures jsonb;          -- [{label, value, verified}]
alter table public.announcements add column if not exists ai_verified boolean;       -- every number found in the PDF text
alter table public.announcements add column if not exists ai_checked_at timestamptz;

-- ---- "AI Assistant suggests": one row per user per run (private) ----------
create table if not exists public.ai_insights (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  job          text not null,
  headline     text not null,
  suggestions  jsonb not null default '[]',  -- [{action, symbol, text, why, confidence}]
  plan_note    text,
  risks        text,
  model        text,
  dropped      int not null default 0         -- suggestions removed by the guardrails
);
create index if not exists ai_insights_user_created on public.ai_insights (user_id, created_at desc);
alter table public.ai_insights enable row level security;
drop policy if exists own_rows on public.ai_insights;
create policy own_rows on public.ai_insights for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.ai_insights from anon, authenticated;
grant select on public.ai_insights to authenticated;
grant all on public.ai_insights to service_role;

-- ---- KSE-100 screen for opportunities (public, written by the worker) ------
create table if not exists public.market_screen (
  symbol              text primary key,
  sector              text,
  price               numeric(12,2),
  change_pct          numeric(7,2),
  pe                  numeric(9,2),
  dividend_yield_pct  numeric(7,2),
  market_cap          numeric(20,0),
  is_shariah          boolean,
  updated_at          timestamptz not null default now()
);
alter table public.market_screen enable row level security;
drop policy if exists signed_in_read on public.market_screen;
create policy signed_in_read on public.market_screen for select to authenticated using (true);
revoke all on public.market_screen from anon, authenticated;
grant select on public.market_screen to authenticated;
grant all on public.market_screen to service_role;

-- ---- AI on/off per user. Portfolio numbers go to Google Gemini (free tier), so new users opt in;
--      accounts that exist when this runs (the owner) start with it on.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'settings' and column_name = 'ai_enabled') then
    alter table public.settings add column ai_enabled boolean not null default false;
    update public.settings set ai_enabled = true;
  end if;
end $$;

-- ---- migration bookkeeping (no access for app users) -----------------------
create table if not exists public.schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;
