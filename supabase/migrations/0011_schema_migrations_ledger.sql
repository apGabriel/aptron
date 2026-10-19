-- ============================================================================
-- Migration 0011 — Migration ledger: public._schema_migrations
-- ----------------------------------------------------------------------------
-- Minimal, hand-run-SQL-Editor-compatible tracking table recording which
-- migration files have actually been applied. Closes Technical Debt TD-4 /
-- Database.md §11 idea 3 / Known Issues #7.
--
-- ARCHITECTURE (Option B, explicitly approved 2026-08-23 — Architecture
-- Review gate): a small custom table, NOT Supabase CLI migration tracking.
-- No CLI, no config.toml, no project linking, no checksums, no dependency
-- graph, no schema-diff engine. Stays consistent with this project's
-- existing workflow — migrations are pasted and run by hand in the Supabase
-- SQL Editor; from this file onward, each one ends with one insert
-- recording itself.
--
-- SEMANTICS OF applied_at — read before querying this table:
--   A row's mere PRESENCE means the migration is verified/known to be part
--   of the applied history. applied_at being NULL does NOT mean "not
--   applied" — it means "applied, but the exact execution timestamp was
--   never documented anywhere and is not known." A non-NULL applied_at
--   means an exact, documented, verifiable date exists. Never treat a NULL
--   applied_at row as unapplied — its presence in this table already
--   asserts the opposite.
--
-- BACKFILL SCOPE — exactly the historical migrations that represent real
-- SQL actually run against the database:
--   0001, 0003, 0004, 0005            → applied_at NULL (no documented date
--                                        anywhere in this repo or Database.md)
--   0006, 0007, 0008                  → applied_at = the exact dates already
--                                        documented in Database.md §1
--                                        ("applied live + verified
--                                        2026-07-18"), copied verbatim, not
--                                        derived from git commit dates
--   0009, 0010                        → applied_at NULL. Read-only
--                                        introspection against production on
--                                        2026-08-23 found app_state's live
--                                        primary key is exactly
--                                        app_state_user_key_pk / PRIMARY KEY
--                                        (user_id, key) — the precise
--                                        constraint 0010's own SQL creates —
--                                        and that 0009's intermediate
--                                        app_state_user_key_uniq constraint
--                                        is absent, consistent with 0010
--                                        having dropped it after promotion.
--                                        That is strong evidence BOTH ran,
--                                        with no invented execution
--                                        timestamp — hence NULL, not a
--                                        fabricated date.
--   0002                              → EXCLUDED. Its own file states
--                                        "This file is documentation-only:
--                                        there is nothing to run." No SQL
--                                        was ever executed for it; a ledger
--                                        row would be semantically false.
--
-- 0001-0010 are themselves NOT modified to insert their own row — this file
-- backfills them from the outside. Only migrations from 0011 onward record
-- themselves directly, at their own end.
--
-- SAFETY: idempotent. Every insert is `on conflict (name) do nothing`, so
-- re-running this file is always safe and never duplicates or overwrites a
-- row. Run once in: Supabase → SQL Editor.
-- ============================================================================

begin;

set local lock_timeout = '5s';

-- ── BEFORE snapshot ───────────────────────────────────────────────────────
do $$
declare
  tbl_exists boolean;
  row_count  int := 0;
begin
  select exists (select 1 from information_schema.tables
    where table_schema = 'public' and table_name = '_schema_migrations')
    into tbl_exists;
  if tbl_exists then
    select count(*) into row_count from public._schema_migrations;
  end if;
  raise notice '[0011] BEFORE: _schema_migrations exists = % | row count = %', tbl_exists, row_count;
end $$;

-- ── the actual change (additive, guarded) ────────────────────────────────
create table if not exists public._schema_migrations (
  name        text primary key,
  applied_at  timestamptz null default now()
);

comment on table public._schema_migrations is
  'Migration ledger (Option B — custom SQL table, not Supabase CLI tracking). A row''s presence means the migration is verified/known-applied history; applied_at NULL means the exact execution date was never documented, not that the migration was skipped. Backfilled once by 0011 for 0001,0003-0010 (0002 excluded, documentation-only); every migration from 0011 onward inserts its own row.';

comment on column public._schema_migrations.applied_at is
  'NULL = applied, exact timestamp undocumented/unknown. Non-NULL = a real, documented application date. Never infer "not applied" from NULL — see the table comment.';

-- ── historical backfill: 0001-0010, excluding 0002 ───────────────────────
insert into public._schema_migrations (name, applied_at) values
  ('0001_routines_exercise_logs.sql',      null),
  ('0003_auth_user_scoping.sql',           null),
  ('0004_events_master.sql',               null),
  ('0005_calendar_connections_master.sql', null),
  ('0006_app_state_rls_fix.sql',           '2026-07-18'::timestamptz),
  ('0007_gym_user_id_default.sql',         '2026-07-18'::timestamptz),
  ('0008_progress_photos_private.sql',     '2026-07-18'::timestamptz),
  ('0009_app_state_add_composite_unique.sql',   null),
  ('0010_app_state_promote_composite_key.sql',  null)
on conflict (name) do nothing;

-- ── register 0011 itself — separate statement, own real applied_at (now),
--    not folded into the historical backfill above and not depending on
--    any future migration to register it ─────────────────────────────────
insert into public._schema_migrations (name, applied_at)
values ('0011_schema_migrations_ledger.sql', now())
on conflict (name) do nothing;

-- ── AFTER verification ────────────────────────────────────────────────────
do $$
declare
  expected_names text[] := array[
    '0001_routines_exercise_logs.sql',
    '0003_auth_user_scoping.sql',
    '0004_events_master.sql',
    '0005_calendar_connections_master.sql',
    '0006_app_state_rls_fix.sql',
    '0007_gym_user_id_default.sql',
    '0008_progress_photos_private.sql',
    '0009_app_state_add_composite_unique.sql',
    '0010_app_state_promote_composite_key.sql',
    '0011_schema_migrations_ledger.sql'
  ];
  n            int;
  missing      text;
  has_0002     boolean;
begin
  select count(*) into n from public._schema_migrations where name = any(expected_names);
  if n <> array_length(expected_names, 1) then
    select string_agg(x, ', ') into missing
      from unnest(expected_names) x
      where x not in (select name from public._schema_migrations);
    raise exception '[0011] POST-CHECK FAILED: expected % rows, found % — missing: %',
      array_length(expected_names, 1), n, coalesce(missing, '(none missing, unexpected extra rows?)');
  end if;

  select exists (select 1 from public._schema_migrations
    where name like '0002%') into has_0002;
  if has_0002 then
    raise exception '[0011] POST-CHECK FAILED: a 0002 row exists — 0002 is documentation-only and must never be in this ledger';
  end if;

  raise notice '[0011] OK — ledger created, % rows present (0001,0003-0010 backfilled, 0011 self-registered). 0002 correctly absent. Dates: 0006/0007/0008 dated per Database.md §1; all others NULL (applied, exact date undocumented) except 0011 itself (now()).', n;
end $$;

commit;

-- ── POST-CHECK — run manually ──
-- select name, applied_at from public._schema_migrations order by name;
-- → expect exactly 10 rows: 0001,0003,0004,0005,0006,0007,0008,0009,0010,0011
--   (0002 absent). applied_at NULL for 0001/0003/0004/0005/0009/0010,
--   '2026-07-18' for 0006/0007/0008, and a real timestamp (this run's time)
--   for 0011.
