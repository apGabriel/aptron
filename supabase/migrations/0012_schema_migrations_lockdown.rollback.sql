-- Rollback for 0012_schema_migrations_lockdown.sql
--
-- Restores the exact pre-0012 state: RLS disabled, and anon/authenticated
-- privileges restored to precisely what was freshly verified live in
-- production immediately before 0012 was authorized (2026-08-27, read-only
-- introspection against information_schema.role_table_grants): both anon
-- and authenticated held the full table-privilege set — SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER (7 privilege types each).
-- That is exactly the set `GRANT ALL ON TABLE` produces, so this rollback
-- restores it via that one alias rather than listing privileges by hand —
-- not a guess, the literal freshly-observed grant list.
--
-- No policy is dropped (0012 created none). No ledger row is touched in
-- either direction. This rollback exists for migration symmetry and
-- controlled recovery — running it deliberately re-opens Known Issues #49;
-- it should only ever be run as a reviewed, intentional action, never
-- routinely.

begin;

set local lock_timeout = '5s';

-- ---------- 0. BEFORE (i.e., current post-0012) snapshot ---------------------
do $$
declare
  rls_on  boolean;
  npol    int;
  anon_n  int;
  authn_n int;
begin
  select c.relrowsecurity into rls_on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = '_schema_migrations';
  select count(*) into npol from pg_policies
    where schemaname='public' and tablename='_schema_migrations';
  select count(*) into anon_n from information_schema.role_table_grants
    where table_schema='public' and table_name='_schema_migrations' and grantee='anon';
  select count(*) into authn_n from information_schema.role_table_grants
    where table_schema='public' and table_name='_schema_migrations' and grantee='authenticated';

  raise notice '[0012-rollback] BEFORE: RLS enabled = % | policies = % | anon privileges = % | authenticated privileges = %',
    coalesce(rls_on::text,'(table missing)'), npol, anon_n, authn_n;
end $$;

-- ---------- 1. restore privileges (exact pre-0012 set, not a guess) ----------
grant all on public._schema_migrations to anon, authenticated;

-- ---------- 2. disable RLS ----------------------------------------------------
alter table public._schema_migrations disable row level security;

-- ---------- 3. AFTER verification ---------------------------------------------
do $$
declare
  rls_on  boolean;
  npol    int;
  anon_n  int;
  authn_n int;
  rows_n  int;
begin
  select c.relrowsecurity into rls_on
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = '_schema_migrations';
  select count(*) into npol from pg_policies
    where schemaname='public' and tablename='_schema_migrations';
  select count(*) into anon_n from information_schema.role_table_grants
    where table_schema='public' and table_name='_schema_migrations' and grantee='anon';
  select count(*) into authn_n from information_schema.role_table_grants
    where table_schema='public' and table_name='_schema_migrations' and grantee='authenticated';
  select count(*) into rows_n from public._schema_migrations;

  if coalesce(rls_on,true) then
    raise exception '[0012-rollback] POST-CHECK FAILED: RLS still enabled on _schema_migrations';
  end if;
  if anon_n <> 7 then
    raise exception '[0012-rollback] POST-CHECK FAILED: expected anon to hold exactly 7 privileges (the full ALL set, matching the freshly-verified pre-0012 grant), found %', anon_n;
  end if;
  if authn_n <> 7 then
    raise exception '[0012-rollback] POST-CHECK FAILED: expected authenticated to hold exactly 7 privileges (the full ALL set, matching the freshly-verified pre-0012 grant), found %', authn_n;
  end if;
  if rows_n <> 10 then
    raise exception '[0012-rollback] POST-CHECK FAILED: expected 10 ledger rows (unchanged), found %', rows_n;
  end if;

  raise notice '[0012-rollback] AFTER: RLS enabled = % | policies = % | anon privileges = % | authenticated privileges = % | rows = %',
    rls_on, npol, anon_n, authn_n, rows_n;
  raise notice '[0012-rollback] OK — public._schema_migrations restored to its exact pre-0012 state. This re-opens Known Issues #49 — do not run outside a reviewed, intentional recovery.';
end $$;

commit;

-- ── VERIFICATION — run manually ──
-- select relrowsecurity from pg_class where relname = '_schema_migrations';
-- → expect false
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='_schema_migrations' and grantee in ('anon','authenticated')
--  order by grantee, privilege_type;
-- → expect 7 rows each: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
