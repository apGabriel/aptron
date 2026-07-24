-- ============================================================================
-- Migration 0006 — Fix app_state RLS: enforce per-user isolation + restore the
--                   user_id default. Security fix; see ADR-013.
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
--   A 2026-07-18 live audit proved that public.app_state was NOT per-user
--   isolated, while routines / exercise_logs / events all were. A freshly
--   created, unrelated authenticated user could SELECT and UPDATE the owner's
--   rows, upsert over them (on_conflict=key), and INSERT rows with a FORGED
--   user_id. Two independent defects caused it:
--
--     1. app_state had no EFFECTIVE per-user policy — either RLS was disabled,
--        or a legacy dashboard-created permissive policy (USING true) dominated
--        the intended owner policy. (app_state predates the repo migrations and
--        has no CREATE TABLE here, so 0003's `drop policy "app_state anon full
--        access"` never matched its real policy name.)
--     2. user_id had NO default. 0003's `add column if not exists user_id …
--        default auth.uid()` no-op'd the default because the column already
--        existed; only the backfill UPDATE ran. New inserts land user_id = NULL,
--        and sync.js / the keepalive upsert never send user_id explicitly — so
--        the intended `with check (auth.uid() = user_id)` had nothing to pass on.
--
-- WHAT THIS DOES (app_state ONLY — no other table is touched)
--   • prints the BEFORE state (RLS flag + every existing policy) as NOTICEs, so
--     the exact pre-fix root cause is captured in the SQL editor's Messages pane;
--   • guarantees the user_id column + FK, then sets `default auth.uid()`;
--   • backfills any NULL user_id to the single existing owner (guarded: refuses
--     to proceed if ownership is ambiguous, so it can never mis-attribute data);
--   • revokes anon, grants authenticated (idempotent; matches the sibling tables);
--   • DROPS EVERY existing policy on app_state by enumeration (name-agnostic —
--     this is what removes the unknown legacy permissive policy for certain);
--   • enables RLS and creates exactly ONE policy: the authenticated owner policy;
--   • verifies the END state and RAISES if anything is still wrong.
--
-- SAFETY
--   Idempotent — re-running is a no-op on an already-fixed database. It preserves
--   all existing owner data (no DELETE, no data rewrite beyond NULL backfill).
--   The service role (proxy vault) has BYPASSRLS and does not use app_state, so
--   it is unaffected. Run once in: Supabase → SQL Editor.
-- ============================================================================

-- ---------- 0. BEFORE snapshot (captured for ADR-013 / the audit trail) ------
do $$
declare
  rls_on boolean;
  pol    record;
  npol   int := 0;
begin
  select c.relrowsecurity into rls_on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'app_state';

  raise notice '[0006] BEFORE: app_state RLS enabled = %', coalesce(rls_on::text, '(table missing)');
  for pol in
    select policyname, cmd, roles, qual, with_check
      from pg_policies where schemaname = 'public' and tablename = 'app_state'
      order by policyname
  loop
    npol := npol + 1;
    raise notice '[0006] BEFORE policy #% : name=% cmd=% roles=% using=% check=%',
      npol, pol.policyname, pol.cmd, pol.roles, coalesce(pol.qual,'<none>'), coalesce(pol.with_check,'<none>');
  end loop;
  raise notice '[0006] BEFORE: % existing policy(ies) on app_state', npol;
end $$;

-- ---------- 1. column + FK guarantee (no-op if already correct) --------------
alter table public.app_state
  add column if not exists user_id uuid references auth.users(id);

-- ---------- 2. restore the missing default (THE key defect) ------------------
alter table public.app_state
  alter column user_id set default auth.uid();

-- ---------- 3. backfill NULL user_id → the single owner (guarded) ------------
-- Attributes any orphan rows created while the default was missing. Refuses to
-- run if ownership is ambiguous, so it can never assign a row to the wrong user.
do $$
declare
  owners int;
  owner  uuid;
  orphan int;
begin
  select count(*) into orphan from public.app_state where user_id is null;
  if orphan = 0 then
    raise notice '[0006] backfill: no NULL user_id rows — nothing to attribute';
  else
    select count(distinct user_id), max(user_id) into owners, owner
      from public.app_state where user_id is not null;
    if owners <> 1 then
      raise exception '[0006] % NULL-user_id rows but % distinct owners — resolve ownership manually before re-running', orphan, owners;
    end if;
    update public.app_state set user_id = owner where user_id is null;
    raise notice '[0006] backfill: attributed % orphan row(s) to owner %', orphan, owner;
  end if;
end $$;

-- ---------- 4. privileges (idempotent; mirrors routines/events) --------------
revoke all on public.app_state from anon;
grant  all on public.app_state to authenticated;

-- ---------- 5. drop EVERY existing policy (name-agnostic) --------------------
-- This is what deterministically removes the unknown legacy permissive policy,
-- whatever it was named, so the only surviving policy is the owner policy below.
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies
             where schemaname = 'public' and tablename = 'app_state'
  loop
    execute format('drop policy if exists %I on public.app_state', pol.policyname);
    raise notice '[0006] dropped policy %', pol.policyname;
  end loop;
end $$;

-- ---------- 6. enable RLS + the single correct policy ------------------------
alter table public.app_state enable row level security;

create policy "app_state owner" on public.app_state
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- 7. AFTER verification (fails loudly if not fully fixed) ----------
do $$
declare
  rls_on  boolean;
  npol    int;
  polname text;
  polqual text;
  polchk  text;
  orphan  int;
begin
  select c.relrowsecurity into rls_on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'app_state';
  select count(*) into npol from pg_policies where schemaname='public' and tablename='app_state';
  select policyname, qual, with_check into polname, polqual, polchk
    from pg_policies where schemaname='public' and tablename='app_state' limit 1;
  select count(*) into orphan from public.app_state where user_id is null;

  if not coalesce(rls_on,false) then raise exception '[0006] POST-CHECK FAILED: RLS not enabled on app_state'; end if;
  if npol <> 1 then raise exception '[0006] POST-CHECK FAILED: expected exactly 1 policy, found %', npol; end if;
  if orphan <> 0 then raise exception '[0006] POST-CHECK FAILED: % NULL-user_id rows remain', orphan; end if;

  raise notice '[0006] AFTER: RLS enabled = % | policies = % | policy "%": using=% check=% | NULL user_id rows = %',
    rls_on, npol, polname, polqual, polchk, orphan;
  raise notice '[0006] OK — app_state is now per-user isolated (auth.uid() = user_id) with default auth.uid().';
end $$;
