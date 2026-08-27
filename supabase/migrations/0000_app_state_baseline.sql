-- ============================================================================
-- Migration 0000 — Baseline: app_state table (pre-migration-history shape)
-- ----------------------------------------------------------------------------
-- app_state predates every migration file in this repo (dashboard-created
-- before this project adopted the migration-file convention) — no CREATE
-- TABLE for it has ever existed here (see Database.md §3). This closes that
-- gap so 0001-0010 can be replayed against a genuinely fresh database and
-- reach the exact schema production has today.
--
-- SHAPE: intentionally the PRE-0003 shape (key, data, updated_at only — no
-- user_id, no composite PK, no FK, no RLS, no policies), NOT today's live
-- shape. Reasoning (Architecture Review, 2026-08-23): 0003/0006/0009/0010
-- already know how to evolve app_state from this starting point — the same
-- pattern routines/exercise_logs already follow (0001 creates them pre-auth,
-- 0003 adds user_id). Baking in today's composite-PK shape directly would
-- make a fresh-install run of 0009 add a redundant UNIQUE(user_id,key)
-- constraint that 0010's own re-run-safety guard never cleans up (it returns
-- early, before reaching its cleanup step, when the PK is already composite)
-- — verified by reading both files' guard logic. Recreating the
-- pre-migration shape instead keeps every later migration doing real,
-- non-redundant work, on a fresh database exactly as it does against
-- production's actual history.
--
-- VERIFIED against the live database 2026-08-23 (read-only introspection —
-- list_tables + pg_constraint + pg_policies + information_schema grants;
-- zero DDL/DML executed): production's CURRENT app_state is
--   key text NOT NULL, data jsonb NOT NULL default '{}'::jsonb,
--   updated_at timestamptz NOT NULL default now(), user_id uuid NOT NULL
--   default auth.uid(), PRIMARY KEY (user_id, key) [constraint
--   app_state_user_key_pk], FOREIGN KEY (user_id) REFERENCES auth.users(id)
--   [constraint app_state_user_id_fkey, no ON DELETE CASCADE], RLS enabled
--   with exactly one policy "app_state owner" (auth.uid() = user_id).
-- That exactly matches applying 0003 -> 0006 -> 0009 -> 0010's documented
-- deltas to the shape this file creates, with no unexplained drift.
--
-- SAFETY: `create table if not exists` is a no-op on the live database (the
-- table already exists, already fully migrated). Idempotent. Run once in:
-- Supabase → SQL Editor.
-- ============================================================================

begin;

set local lock_timeout = '5s';

-- ── BEFORE snapshot ───────────────────────────────────────────────────────
do $$
begin
  raise notice '[0000] BEFORE: app_state exists = %',
    (select exists (select 1 from information_schema.tables
      where table_schema = 'public' and table_name = 'app_state'));
end $$;

-- ── the actual change (additive, guarded) ────────────────────────────────
create table if not exists public.app_state (
  key         text primary key,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ── AFTER verification ────────────────────────────────────────────────────
do $$
declare
  exists_now boolean;
begin
  select exists (select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'app_state')
    into exists_now;

  if not exists_now then
    raise exception '[0000] POST-CHECK FAILED: app_state does not exist after this migration';
  end if;

  raise notice '[0000] AFTER: app_state exists = %', exists_now;
  raise notice '[0000] OK — app_state now has a CREATE TABLE in the repo for the first time. No-op on the live database (table already existed, already migrated by 0003/0006/0009/0010).';
end $$;

commit;

-- ── POST-CHECK — run manually ──
-- select column_name, data_type, is_nullable, column_default
--  from information_schema.columns
--  where table_schema='public' and table_name='app_state'
--  order by ordinal_position;
-- → on the LIVE database, expect the FULLY MIGRATED shape (key, data,
--   updated_at, user_id, composite PK) — this file only guarantees app_state
--   EXISTS with at least the pre-migration columns; 0003/0006/0009/0010,
--   already applied in production, are what take it the rest of the way.
-- On a FRESH database running 0000 alone, expect exactly the three columns
-- declared above — key/data/updated_at, no user_id yet.
