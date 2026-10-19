-- ============================================================================
-- Rollback for Migration 0013 — routines: add training_days, goal, rest,
--                                rest_enabled
-- ----------------------------------------------------------------------------
-- Drops the 4 columns added by 0013 and removes 0013's own ledger row.
-- DESTRUCTIVE: any training_days/goal/rest/rest_enabled data written since
-- 0013 was applied is permanently lost. Only run this if the application-side
-- change (gym-cloud.js / routine-authoring.js mapping) is also being reverted
-- in the same rollback — otherwise the app will keep sending these fields to
-- Supabase on every routine upsert with no column to receive them, and
-- pulling routines back down will silently lose them again (the original
-- Known Issues #32 gap, reopened on purpose).
-- ============================================================================

begin;

set local lock_timeout = '5s';

do $$
declare cols_n int; rows_n int;
begin
  select count(*) into cols_n from information_schema.columns
    where table_schema='public' and table_name='routines';
  select count(*) into rows_n from public.routines;
  raise notice '[0013 rollback] BEFORE: routines columns = % | rows = %', cols_n, rows_n;
end $$;

alter table public.routines
  drop column if exists training_days,
  drop column if exists goal,
  drop column if exists rest,
  drop column if exists rest_enabled;

delete from public._schema_migrations where name = '0013_routines_training_metadata.sql';

do $$
declare cols_n int; rows_n int;
begin
  select count(*) into cols_n from information_schema.columns
    where table_schema='public' and table_name='routines';
  select count(*) into rows_n from public.routines;
  if cols_n <> 7 then
    raise exception '[0013 rollback] POST-CHECK FAILED: expected 7 columns after rollback, found %', cols_n;
  end if;
  raise notice '[0013 rollback] AFTER: routines columns = % | rows = %', cols_n, rows_n;
  raise notice '[0013 rollback] OK — training_days/goal/rest/rest_enabled dropped, ledger row removed.';
end $$;

commit;

-- ── POST-CHECK — run manually ──
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='routines' order by ordinal_position;
-- → expect exactly 7 columns (id, client_id, name, exercises, created_at,
--   updated_at, user_id) — training_days/goal/rest/rest_enabled absent
-- select count(*) from public.routines;
-- → expect unchanged
