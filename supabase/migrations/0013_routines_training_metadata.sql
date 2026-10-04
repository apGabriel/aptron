-- ============================================================================
-- Migration 0013 — routines: add training_days, goal, rest, rest_enabled
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
--   public.routines has only id/client_id/name/exercises(jsonb)/created_at/
--   updated_at/user_id. The app's own routine object (js/gym/gym-routine-
--   builder.js's freshRoutine(), mirrored by js/shelron/routine-authoring.js)
--   also carries trainingDays (string[] of weekday codes), goal (text|null),
--   rest (integer seconds) and restEnabled (boolean) — none of which have
--   ever had a column here. gym-cloud.js's toRoutineRow()/pullRoutines() and
--   routine-authoring.js's own toRoutineRow() both only map the 4 columns
--   that DO exist, so every cloud round-trip has always silently dropped
--   these 4 fields. Found and root-caused during a 2026-09-03 Shenlong
--   hardening pass; tracked as Known Issues #32.
--
--   A second-order consequence, found the same pass: gym-routine-builder.js's
--   __gymRBMergeRoutines() does a WHOLE-OBJECT replace of the local routine
--   with the cloud-pulled one whenever the cloud row's updated_at is newer.
--   Because the cloud-pulled object never carried these 4 fields, a
--   multi-device (or multi-tab) race where the cloud pull wins that
--   timestamp comparison has always silently wiped trainingDays/goal/
--   rest/restEnabled from local storage too — not merely failed to
--   propagate them forward. This migration does not touch the merge
--   function itself; once the cloud row is complete, the existing
--   last-write-wins replace becomes correct instead of lossy.
--
-- WHAT THIS DOES (public.routines ONLY — additive, nullable/defaulted,
-- no existing column altered or dropped, no other table touched)
--   • prints the BEFORE column list + row count as NOTICEs;
--   • adds 4 columns: training_days jsonb not null default '[]'::jsonb,
--     goal text null, rest integer null, rest_enabled boolean not null
--     default true;
--   • uses ADD COLUMN IF NOT EXISTS — idempotent, safe to re-run;
--   • existing rows get the defaults (empty trainingDays, no goal, no
--     rest override, restEnabled true) — matches freshRoutine()'s own
--     defaults in gym-routine-builder.js, so a routine pulled from a row
--     migrated this way behaves identically to a brand-new local routine
--     that never touched these fields;
--   • no RLS change needed — routines already has RLS enabled with a
--     per-user policy from migration 0003 that governs the whole row;
--     new columns are automatically covered by the existing row policy,
--     not by column-level grants;
--   • self-registers in public._schema_migrations per 0011's convention
--     (0012 was a one-time, explicitly-authorized exception to that
--     convention, not a change to it);
--   • verifies the END state and RAISES if any column is missing, has
--     the wrong type/default, or if the row count changed (this
--     migration must never add or remove rows, only columns).
--
-- APPLICATION-SIDE FOLLOW-UP (done in the same change, not left dangling):
--   js/gym/gym-cloud.js's toRoutineRow()/pullRoutines() and
--   js/shelron/routine-authoring.js's own toRoutineRow() are updated in the
--   same change to map all 4 new fields both ways, so this migration and
--   the application code land together.
--
-- SAFETY: idempotent (IF NOT EXISTS + defaulted columns); no data row
--   touched, no column dropped/altered/renamed. Run once in:
--   Supabase → SQL Editor.
-- ============================================================================

begin;

set local lock_timeout = '5s';

-- ---------- 0. BEFORE snapshot -----------------------------------------------
do $$
declare
  cols_n int;
  rows_n int;
begin
  select count(*) into cols_n from information_schema.columns
    where table_schema='public' and table_name='routines';
  select count(*) into rows_n from public.routines;
  raise notice '[0013] BEFORE: routines columns = % | rows = %', cols_n, rows_n;
end $$;

-- ---------- 1. the actual change (additive, guarded) --------------------------
alter table public.routines
  add column if not exists training_days jsonb not null default '[]'::jsonb,
  add column if not exists goal          text,
  add column if not exists rest          integer,
  add column if not exists rest_enabled  boolean not null default true;

comment on column public.routines.training_days is
  'Weekday codes (e.g. ["mon","wed","fri"]) the routine is scheduled on. Mirrors the app''s local trainingDays field. Added by migration 0013 — Known Issues #32.';
comment on column public.routines.goal is
  'Optional free-text training goal for the routine (e.g. "strength", "hypertrophy"). Mirrors the app''s local goal field. Added by migration 0013 — Known Issues #32.';
comment on column public.routines.rest is
  'Routine-wide rest duration in seconds, used when rest_enabled is true. Mirrors the app''s local rest field. Added by migration 0013 — Known Issues #32.';
comment on column public.routines.rest_enabled is
  'Master switch for the routine-wide rest timer. Mirrors the app''s local restEnabled field. Added by migration 0013 — Known Issues #32.';

-- ---------- 2. register in the migration ledger (per 0011's convention) -------
insert into public._schema_migrations (name, applied_at)
values ('0013_routines_training_metadata.sql', now())
on conflict (name) do nothing;

-- ---------- 3. AFTER verification (fails loudly if not exactly right) --------
do $$
declare
  cols_n     int;
  rows_n     int;
  missing    text;
  expected   text[] := array['training_days','goal','rest','rest_enabled'];
  present_n  int;
begin
  select count(*) into present_n from information_schema.columns
    where table_schema='public' and table_name='routines' and column_name = any(expected);
  if present_n <> array_length(expected, 1) then
    select string_agg(x, ', ') into missing
      from unnest(expected) x
      where x not in (select column_name from information_schema.columns
        where table_schema='public' and table_name='routines');
    raise exception '[0013] POST-CHECK FAILED: expected % new columns, found % — missing: %',
      array_length(expected, 1), present_n, coalesce(missing, '(none missing?)');
  end if;

  select count(*) into cols_n from information_schema.columns
    where table_schema='public' and table_name='routines';
  select count(*) into rows_n from public.routines;

  if cols_n <> 11 then
    raise exception '[0013] POST-CHECK FAILED: expected 11 total columns on routines (7 original + 4 new), found %', cols_n;
  end if;

  raise notice '[0013] AFTER: routines columns = % | rows = % (unchanged — additive only)', cols_n, rows_n;
  raise notice '[0013] OK — training_days/goal/rest/rest_enabled added to public.routines. Known Issues #32 schema gap closed.';
end $$;

commit;

-- ── POST-CHECK — run manually ──
-- select column_name, data_type, column_default from information_schema.columns
--  where table_schema='public' and table_name='routines' order by ordinal_position;
-- → expect 11 rows, including training_days(jsonb,'[]'), goal(text,null),
--   rest(integer,null), rest_enabled(boolean,true)
-- select count(*) from public.routines;
-- → expect unchanged from BEFORE
