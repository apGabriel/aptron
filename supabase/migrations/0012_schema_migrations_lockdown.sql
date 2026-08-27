-- ============================================================================
-- Migration 0012 — Lock down public._schema_migrations: enable RLS, revoke
--                   anon/authenticated privileges. Security fix; see Known
--                   Issues #49.
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
--   0011 created public._schema_migrations without ever enabling RLS or
--   revoking the default anon/authenticated grants Supabase applies to new
--   public-schema tables. A documentation reconciliation pass (2026-08-26)
--   found this live in production: relrowsecurity = false, and anon /
--   authenticated both held the full table-privilege set (SELECT, INSERT,
--   UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER). The anon key is public
--   by design (js/config.js), so anyone holding it could read, forge, or
--   TRUNCATE the migration ledger. No user data is at risk (the table holds
--   only migration filenames + timestamps), but the ledger's own integrity
--   as an audit trail was unprotected — the same anon-over-grant pattern
--   that caused the app_state incident (0006 / ADR-013), now recurring on
--   the very table built to prevent this class of drift.
--
-- WHAT THIS DOES (public._schema_migrations ONLY — no other table, no Auth
-- configuration, no other grant or policy is touched)
--   • prints the BEFORE state (RLS flag, policy count, anon/authenticated
--     privilege counts, row count) as NOTICEs, for the audit trail;
--   • enables RLS on the table — WITHOUT FORCE ROW LEVEL SECURITY (no
--     migration in this project has ever used FORCE; the table owner and
--     service_role, which has BYPASSRLS, are unaffected either way);
--   • adds NO policy — this table has no per-user concept (it's operator
--     bookkeeping, not user data), so "RLS enabled + zero policies" is the
--     same deny-all-by-default posture calendar_connections already uses
--     (ADR-006), not a new security model;
--   • revokes anon and authenticated's privileges entirely — service_role
--     and postgres are untouched (service_role has BYPASSRLS and is how
--     future migrations self-register; a repo-wide grep confirms nothing
--     in js/**/*.js or proxy/*.js reads or writes this table);
--   • verifies the END state and RAISES if RLS isn't enabled, if any policy
--     exists, if anon/authenticated retain any privilege, or if the row
--     count / column count drifted from what this file expects.
--
-- DELIBERATE DEVIATION FROM 0011's OWN STATED CONVENTION
--   0011's header says "every migration from 0011 onward inserts its own
--   row" into the ledger. This file does NOT do that — by explicit owner
--   instruction (2026-08-27 authorization), the existing 10 ledger rows
--   must remain exactly unchanged, and no INSERT/UPDATE/DELETE/TRUNCATE
--   against ledger data is authorized as part of this security fix. This is
--   a scoped, explicit exception for this one migration, not a change to
--   the convention itself — a future migration should resume
--   self-registering unless told otherwise.
--
-- SAFETY: both statements below are naturally idempotent in Postgres —
--   ENABLE ROW LEVEL SECURITY on an already-RLS-enabled table, and REVOKE of
--   a privilege a role doesn't hold, are both no-ops, not errors. No data
--   row is touched; no column is added, dropped, or altered. Run once in:
--   Supabase → SQL Editor.
-- ============================================================================

begin;

set local lock_timeout = '5s';

-- ---------- 0. BEFORE snapshot -----------------------------------------------
do $$
declare
  rls_on  boolean;
  npol    int;
  anon_n  int;
  authn_n int;
  rows_n  int;
  cols_n  int;
begin
  select c.relrowsecurity into rls_on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = '_schema_migrations';

  select count(*) into npol from pg_policies
    where schemaname = 'public' and tablename = '_schema_migrations';

  select count(*) into anon_n from information_schema.role_table_grants
    where table_schema='public' and table_name='_schema_migrations' and grantee='anon';
  select count(*) into authn_n from information_schema.role_table_grants
    where table_schema='public' and table_name='_schema_migrations' and grantee='authenticated';

  select count(*) into rows_n from public._schema_migrations;
  select count(*) into cols_n from information_schema.columns
    where table_schema='public' and table_name='_schema_migrations';

  raise notice '[0012] BEFORE: RLS enabled = % | policies = % | anon privileges = % | authenticated privileges = % | rows = % | columns = %',
    coalesce(rls_on::text,'(table missing)'), npol, anon_n, authn_n, rows_n, cols_n;
end $$;

-- ---------- 1. enable RLS (no FORCE — matches every other table in this project) ----
alter table public._schema_migrations enable row level security;

-- ---------- 2. revoke anon/authenticated only (service_role, postgres untouched) ----
revoke all on public._schema_migrations from anon, authenticated;

-- ---------- 3. AFTER verification (fails loudly if not exactly right) --------
do $$
declare
  rls_on  boolean;
  npol    int;
  anon_n  int;
  authn_n int;
  rows_n  int;
  cols_n  int;
begin
  select c.relrowsecurity into rls_on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = '_schema_migrations';

  select count(*) into npol from pg_policies
    where schemaname = 'public' and tablename = '_schema_migrations';

  select count(*) into anon_n from information_schema.role_table_grants
    where table_schema='public' and table_name='_schema_migrations' and grantee='anon';
  select count(*) into authn_n from information_schema.role_table_grants
    where table_schema='public' and table_name='_schema_migrations' and grantee='authenticated';

  select count(*) into rows_n from public._schema_migrations;
  select count(*) into cols_n from information_schema.columns
    where table_schema='public' and table_name='_schema_migrations';

  if not coalesce(rls_on,false) then
    raise exception '[0012] POST-CHECK FAILED: RLS not enabled on _schema_migrations';
  end if;
  if npol <> 0 then
    raise exception '[0012] POST-CHECK FAILED: expected 0 policies (deny-all by default, like calendar_connections), found %', npol;
  end if;
  if anon_n <> 0 then
    raise exception '[0012] POST-CHECK FAILED: anon still holds % privilege(s) on _schema_migrations', anon_n;
  end if;
  if authn_n <> 0 then
    raise exception '[0012] POST-CHECK FAILED: authenticated still holds % privilege(s) on _schema_migrations', authn_n;
  end if;
  if rows_n <> 10 then
    raise exception '[0012] POST-CHECK FAILED: expected 10 ledger rows (unchanged — this migration inserts nothing, by explicit scope), found %', rows_n;
  end if;
  if cols_n <> 2 then
    raise exception '[0012] POST-CHECK FAILED: expected 2 columns (name, applied_at — unchanged), found %', cols_n;
  end if;

  raise notice '[0012] AFTER: RLS enabled = % | policies = % | anon privileges = % | authenticated privileges = % | rows = % | columns = %',
    rls_on, npol, anon_n, authn_n, rows_n, cols_n;
  raise notice '[0012] OK — public._schema_migrations is now RLS-enabled, zero-policy, anon/authenticated fully revoked. service_role/postgres access unaffected (service_role has BYPASSRLS). Ledger data/schema unchanged.';
end $$;

commit;

-- ── POST-CHECK — run manually ──
-- select relrowsecurity from pg_class where relname = '_schema_migrations';
-- → expect true
-- select count(*) from pg_policies where schemaname='public' and tablename='_schema_migrations';
-- → expect 0
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='_schema_migrations' and grantee in ('anon','authenticated');
-- → expect 0 rows
-- select count(*) from public._schema_migrations;
-- → expect 10 (unchanged)
