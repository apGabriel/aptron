-- Migration 0010 — app_state: promote (user_id, key) to the primary key,
-- drop the legacy key-only primary key. Step 2 of 2 for KNOWN ISSUE #39.
--
-- THIS is the step that actually closes #39 — before it runs, two
-- different users still cannot both hold a row for the same key (the
-- legacy PRIMARY KEY (key) is still in force). Run only after:
--   - 0009_app_state_add_composite_unique.sql has been applied, AND
--   - the paired application code (onConflict:'user_id,key' in sync.js /
--     js/gym/gym-sync.js / js/topbar.js) has been deployed AND verified
--     in production.
--
-- A table cannot have two PRIMARY KEY constraints at once, so "promote
-- the composite constraint" and "remove the legacy key-only primary key"
-- are necessarily one atomic operation in Postgres, not two separately
-- runnable steps — this file does both together, inside one transaction.
--
-- RESIDUAL RISK (irreducible without adding a forced-reload mechanism,
-- which this repo doesn't have and isn't worth building for a
-- single-owner app): a browser tab left open since BEFORE the code
-- deploy, never refreshed, is still running onConflict:'key' and will
-- start failing writes the moment this commits — safely (caught, no
-- data loss) and self-healing (retries on the next local change), but
-- failing nonetheless until that tab is refreshed. Refresh any long-lived
-- open tabs before running this file.
--
-- Deliberately does NOT use `ADD CONSTRAINT ... PRIMARY KEY USING INDEX`
-- to re-attach 0009's existing unique index — that reuse pattern exists
-- to avoid an index rebuild on large tables, and introduces constraint-
-- ownership subtleties that aren't worth it for a 4-row table. This
-- drops and recreates instead: slower in the abstract, free in practice
-- here, and unambiguous.
--
-- Re-runnable: skips cleanly if the composite key is already the primary key.

begin;

set local lock_timeout = '5s';

do $$
declare
  npk        int;
  pkcols     text;
  uniq_exists boolean;
  nulls      int;
  fkrefs     int;
begin
  -- ── pre-check: current primary key shape ──────────────────────────────
  select count(*) into npk
    from pg_constraint
   where conrelid = 'public.app_state'::regclass and contype = 'p';
  select string_agg(a.attname, ',' order by a.attname)
    into pkcols
    from pg_constraint c
    join unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.app_state'::regclass and c.contype = 'p';
  raise notice '[0010] BEFORE: % primary key constraint(s) on app_state, columns = %', npk, coalesce(pkcols, '(none)');

  -- Already migrated (re-run safety).
  if pkcols = 'key,user_id' or pkcols = 'user_id,key' then
    raise notice '[0010] app_state already has a composite (user_id, key) primary key — nothing to do.';
    return;
  end if;

  -- Guard: only proceed from the exact shape this migration assumes.
  if npk > 0 and pkcols is distinct from 'key' then
    raise exception '[0010] ABORT: existing primary key on app_state is (%) — expected (key) alone. Schema has drifted from what this migration assumes; do not proceed without reviewing.', pkcols;
  end if;

  -- Guard: 0009's unique constraint must already exist — this migration
  -- assumes the code deploy already happened against it.
  select exists (
    select 1 from pg_constraint
     where conrelid = 'public.app_state'::regclass and conname = 'app_state_user_key_uniq'
  ) into uniq_exists;
  if not uniq_exists then
    raise exception '[0010] ABORT: app_state_user_key_uniq does not exist — run 0009_app_state_add_composite_unique.sql (and deploy + verify the application code) first.';
  end if;

  -- Guard: user_id must be non-null on every row (composite PK requires it).
  select count(*) into nulls from public.app_state where user_id is null;
  if nulls > 0 then
    raise exception '[0010] ABORT: % row(s) with a null user_id — back-fill (see 0003''s pattern) before re-running', nulls;
  end if;

  -- Guard: no foreign key anywhere in the schema may reference this PK.
  select count(*) into fkrefs
    from pg_constraint
   where contype = 'f' and confrelid = 'public.app_state'::regclass;
  if fkrefs > 0 then
    raise exception '[0010] ABORT: % foreign key(s) reference app_state — inspect before proceeding, this migration does not handle that case', fkrefs;
  end if;

  raise notice '[0010] All guards passed — proceeding.';

  -- ── the actual change ────────────────────────────────────────────────
  alter table public.app_state alter column user_id set not null;

  execute format('alter table public.app_state drop constraint %I', (
    select conname from pg_constraint
     where conrelid = 'public.app_state'::regclass and contype = 'p' limit 1
  ));

  alter table public.app_state
    add constraint app_state_user_key_pk primary key (user_id, key);

  -- The separate UNIQUE constraint from 0009 is now redundant (the new PK
  -- enforces the identical invariant) — drop it so exactly one constraint
  -- documents this, not two overlapping ones.
  alter table public.app_state drop constraint if exists app_state_user_key_uniq;

  raise notice '[0010] OK — app_state now has PRIMARY KEY (user_id, key). Known Issue #39 is closed: global cross-user collisions on this table are no longer possible.';
end $$;

commit;

-- ── POST-CHECK — run manually after commit ──
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.app_state'::regclass and contype = 'p';
-- → expect: app_state_user_key_pk | PRIMARY KEY (user_id, key)
