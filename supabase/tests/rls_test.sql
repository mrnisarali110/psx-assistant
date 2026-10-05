-- Phase 2 "done when" test: a second user cannot read the first user's holdings.
-- Paste into Supabase SQL Editor and Run AFTER 0001_schema.sql.
-- Creates two throwaway users, acts as each one, then deletes them. Leaves nothing behind.
-- Expected output: one row "RLS test passed ...". Any leak shows as an error "RLS TEST FAILED: ...".

do $$
declare
  a     uuid := gen_random_uuid();
  b     uuid := gen_random_uuid();
  n     int;
  fails text[] := '{}';
begin
  insert into auth.users (id, email, aud, role) values
    (a, 'rls-test-a-' || a || '@example.invalid', 'authenticated', 'authenticated'),
    (b, 'rls-test-b-' || b || '@example.invalid', 'authenticated', 'authenticated');

  select count(*) into n from public.settings where user_id in (a, b);
  if n <> 2 then fails := fails || 'signup trigger did not create settings rows'; end if;

  -- ---- user A writes some private data ---------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.holdings (symbol, shares, avg_cost, status) values ('SYS', 10, 100, 'core');
  insert into public.watchlist (symbol) values ('MARI');
  insert into public.recommendations (amount_pkr, payload) values (50000, '[]');
  reset role;

  -- ---- user B tries to see / change A's data ---------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.holdings;        if n <> 0 then fails := fails || format('B sees %s holdings of A', n); end if;
  select count(*) into n from public.watchlist;       if n <> 0 then fails := fails || 'B sees A''s watchlist'; end if;
  select count(*) into n from public.recommendations; if n <> 0 then fails := fails || 'B sees A''s recommendations'; end if;
  select count(*) into n from public.settings;        if n <> 1 then fails := fails || format('B sees %s settings rows', n); end if;
  select count(*) into n from public.profiles;        if n <> 1 then fails := fails || format('B sees %s profiles', n); end if;

  update public.holdings set shares = 999 where user_id = a;
  get diagnostics n = row_count; if n <> 0 then fails := fails || 'B updated A''s holding'; end if;
  delete from public.holdings where user_id = a;
  get diagnostics n = row_count; if n <> 0 then fails := fails || 'B deleted A''s holding'; end if;
  update public.settings set monthly_budget_pkr = 1 where user_id = a;
  get diagnostics n = row_count; if n <> 0 then fails := fails || 'B changed A''s settings'; end if;

  begin
    insert into public.holdings (user_id, symbol, shares, avg_cost) values (a, 'UBL', 1, 1);
    fails := fails || 'B inserted a holding into A''s portfolio';
  exception when insufficient_privilege then null; end;

  begin
    update public.profiles set telegram_chat_id = 12345 where id = b;
    fails := fails || 'user can set their own telegram_chat_id (should be worker-only)';
  exception when insufficient_privilege then null; end;

  begin
    insert into public.prices (symbol, price) values ('FAKE', 1);
    fails := fails || 'signed-in user can write prices';
  exception when insufficient_privilege then null; end;

  begin
    insert into public.alerts_log (user_id, kind, message, dedupe_key) values (b, 'x', 'x', 'x');
    fails := fails || 'signed-in user can write alerts_log';
  exception when insufficient_privilege then null; end;

  select count(*) into n from public.prices;  -- must be allowed (public table), no error
  reset role;

  -- ---- not signed in ----------------------------------------------------
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin
    select count(*) into n from public.holdings;
    fails := fails || 'anonymous visitor can query holdings';
  exception when insufficient_privilege then null; end;
  begin
    select count(*) into n from public.prices;
    fails := fails || 'anonymous visitor can query prices';
  exception when insufficient_privilege then null; end;
  reset role;

  -- ---- A still sees exactly their own data, unchanged ------------------
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.holdings where shares = 10;
  if n <> 1 then fails := fails || 'A lost or saw changed holdings'; end if;
  reset role;

  delete from auth.users where id in (a, b);  -- cascades to all their rows

  if array_length(fails, 1) > 0 then
    raise exception 'RLS TEST FAILED: %', array_to_string(fails, '; ');
  end if;
end $$;

select 'RLS test passed: user B cannot read or change user A''s data, users cannot write market data, anonymous visitors see nothing' as result;
