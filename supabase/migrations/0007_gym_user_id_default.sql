-- ============================================================================
-- Migration 0007 — Restore `user_id DEFAULT auth.uid()` on the gym tables
--                   (routines, exercise_logs). Data-sync fix; see Known Issues #12.
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
--   The 2026-07-18 audit that produced 0006 (app_state) found the SAME root
--   cause on the two gym tables: migration 0003's
--       add column if not exists user_id ... default auth.uid()
--   NO-OP'd the DEFAULT because the column already existed, so only the backfill
--   UPDATE ran. Net effect since 0003:
--     • routines.user_id  and exercise_logs.user_id have NO working default.
--     • gym-cloud.js (toRoutineRow / toLogRow) never sends user_id.
--     • → a NEW-ROW insert lands user_id = NULL, and the CORRECT restrictive
--         policy  WITH CHECK (auth.uid() = user_id)  rejects it → 403.
--     • Existing-row upserts (ON CONFLICT client_id) still pass (user_id
--         unchanged), which is why the owner could edit but not create.
--   Unlike 0006 this was NEVER a security hole — the tables fail CLOSED (403),
--   isolation was always intact. This is a data-sync/stability fix: new routines
--   and new set-logs currently never reach the cloud (they queue in
--   localStorage `local_sync_queue`; offline-first masks it). After this runs,
--   those queued ops replay and self-heal.
--
-- WHAT THIS DOES (routines + exercise_logs ONLY — no other table, no policy,
-- no grant is touched; app_state=0006 and events=0004 already have the default)
--   • prints the BEFORE default + NULL-row count for both tables (audit trail);
--   • sets `default auth.uid()` on both user_id columns (the single fix);
--   • backfills any NULL user_id to the single owner, guarded (refuses if
--     ownership is ambiguous) — a no-op today (0 NULL rows), present for safety;
--   • verifies the default is now installed and no NULL rows remain, raising if
--     not. Read-only NOTICE of the existing policies (does not modify them —
--     they are already the correct auth.uid() = user_id owner policies).
--
-- SAFETY
--   Idempotent — re-running is a no-op on an already-fixed database. Preserves
--   all existing data (no DELETE; the only write is the guarded NULL backfill).
--   Does not weaken RLS: WITH CHECK still blocks any spoofed user_id. Run once
--   in: Supabase → SQL Editor.
-- ============================================================================

-- ---------- 0. BEFORE snapshot ----------------------------------------------
do $$
declare
  t text;
  def text;
  nulls int;
  pol record;
begin
  foreach t in array array['routines','exercise_logs'] loop
    select column_default into def
      from information_schema.columns
     where table_schema='public' and table_name=t and column_name='user_id';
    execute format('select count(*) from public.%I where user_id is null', t) into nulls;
    raise notice '[0007] BEFORE %.user_id: default=% | NULL rows=%', t, coalesce(def,'<none>'), nulls;
    for pol in select policyname, cmd, qual, with_check from pg_policies
               where schemaname='public' and tablename=t order by policyname loop
      raise notice '[0007]   policy %: cmd=% using=% check=%', pol.policyname, pol.cmd,
        coalesce(pol.qual,'<none>'), coalesce(pol.with_check,'<none>');
    end loop;
  end loop;
end $$;

-- ---------- 1. restore the missing default (THE fix) ------------------------
alter table public.routines      alter column user_id set default auth.uid();
alter table public.exercise_logs alter column user_id set default auth.uid();

-- ---------- 2. backfill NULL user_id → the single owner (guarded, no-op today)
do $$
declare
  t text;
  orphan int;
  owners int;
  owner uuid;
begin
  foreach t in array array['routines','exercise_logs'] loop
    execute format('select count(*) from public.%I where user_id is null', t) into orphan;
    if orphan = 0 then
      raise notice '[0007] backfill %: no NULL user_id rows', t;
    else
      execute format('select count(distinct user_id), max(user_id) from public.%I where user_id is not null', t)
        into owners, owner;
      if owners <> 1 then
        raise exception '[0007] %: % NULL rows but % distinct owners — resolve manually', t, orphan, owners;
      end if;
      execute format('update public.%I set user_id = %L where user_id is null', t, owner);
      raise notice '[0007] backfill %: attributed % row(s) to owner %', t, orphan, owner;
    end if;
  end loop;
end $$;

-- ---------- 3. AFTER verification (fails loudly if the default didn't take) --
do $$
declare
  t text;
  def text;
  nulls int;
begin
  foreach t in array array['routines','exercise_logs'] loop
    select column_default into def
      from information_schema.columns
     where table_schema='public' and table_name=t and column_name='user_id';
    execute format('select count(*) from public.%I where user_id is null', t) into nulls;
    if def is null or position('auth.uid()' in def) = 0 then
      raise exception '[0007] POST-CHECK FAILED: %.user_id default is % (expected auth.uid())', t, coalesce(def,'<none>');
    end if;
    if nulls <> 0 then
      raise exception '[0007] POST-CHECK FAILED: %.user_id still has % NULL row(s)', t, nulls;
    end if;
    raise notice '[0007] AFTER %.user_id: default=% | NULL rows=% ✓', t, def, nulls;
  end loop;
  raise notice '[0007] OK — gym inserts now self-attribute (default auth.uid()); RLS unchanged & restrictive.';
end $$;
