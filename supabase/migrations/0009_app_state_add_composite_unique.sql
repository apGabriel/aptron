-- Migration 0009 — app_state: add (user_id, key) as a UNIQUE constraint
-- Step 1 of 2 for KNOWN ISSUE #39 (app_state's primary key is `key` alone,
-- global across every user). This step is purely additive.
--
-- REDESIGNED 2026-08-06 for a zero-write-failure deployment (owner
-- direction: optimize for continuous compatibility over minimizing an
-- incompatibility window). Full sequence:
--
--   1. THIS FILE — add UNIQUE(user_id, key) alongside the untouched
--      existing PRIMARY KEY (key). Nothing is dropped; old application
--      code is completely unaffected.
--   2. Deploy the application code change (sync.js / js/gym/gym-sync.js /
--      js/topbar.js — onConflict:'key' -> onConflict:'user_id,key';
--      already written, same commit as this file). No further code
--      change is needed for this redesign: PostgREST's on_conflict target
--      matches ANY unique constraint on those columns, not specifically
--      the primary key, so the new code already works correctly the
--      moment this migration lands — even before step 4 runs. Old code
--      (onConflict:'key') keeps resolving against the untouched legacy
--      PK. Both versions are simultaneously correct against this schema.
--   3. Verify production (see the operational checklist in the PR/review).
--   4. Run 0010_app_state_promote_composite_key.sql — promotes this
--      unique constraint to the real primary key and drops the legacy
--      PK(key). THIS is the step that actually closes #39: two different
--      users still cannot both hold a row for the same key until 0010
--      runs. Steps 1-3 only make the transition safe; they do not fix the
--      underlying collision bug by themselves. Do not leave the sequence
--      stalled here.
--
-- SAFETY: additive only, no existing constraint touched, no data at risk.
-- Re-runnable — skips cleanly if the constraint already exists.

begin;

set local lock_timeout = '5s';

do $$
declare
  already_exists boolean;
  dupes int;
begin
  select exists (
    select 1 from pg_constraint
     where conrelid = 'public.app_state'::regclass
       and conname = 'app_state_user_key_uniq'
  ) into already_exists;

  if already_exists then
    raise notice '[0009] app_state_user_key_uniq already exists — nothing to do.';
    return;
  end if;

  -- Guard: no existing (user_id, key) duplicates would violate the new
  -- constraint. Expected zero (this project is single-user today,
  -- live-verified 2026-08-06: 4 rows, 1 distinct user_id).
  select count(*) into dupes
    from ( select user_id, key from public.app_state group by user_id, key having count(*) > 1 ) d;
  if dupes > 0 then
    raise exception '[0009] ABORT: % (user_id, key) pair(s) already duplicated — resolve manually before re-running', dupes;
  end if;

  alter table public.app_state
    add constraint app_state_user_key_uniq unique (user_id, key);

  raise notice '[0009] OK — app_state now has UNIQUE (user_id, key) alongside the existing PRIMARY KEY (key). Both old and new application code work against this schema; run 0010 after the code deploy is verified to actually close #39.';
end $$;

commit;

-- ── POST-CHECK — run manually after commit ──
-- select conname, contype, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.app_state'::regclass and contype in ('p','u')
--  order by contype;
-- → expect two rows: p | PRIMARY KEY (key)  and  u | UNIQUE (user_id, key)
