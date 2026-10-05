-- Follow-up to 0001. Paste into Supabase SQL Editor and Run. Safe to run more than once.

-- Shariah status from PSX (member of the KMI All Share index). Null when PSX does not list it.
alter table public.prices add column if not exists is_shariah boolean;

-- Alerts sent together in one notification share a batch_id, so the "3 notifications a day"
-- limit counts notifications, not individual alerts. Null for alerts that were not pushed.
alter table public.alerts_log add column if not exists batch_id uuid;
create index if not exists alerts_log_user_batch on public.alerts_log (user_id, batch_id);

select 'migration 0002 applied' as result;
