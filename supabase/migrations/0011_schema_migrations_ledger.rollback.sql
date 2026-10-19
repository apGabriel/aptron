-- Rollback for 0011_schema_migrations_ledger.sql
--
-- 0011 is purely additive (one new table, no changes to any existing table,
-- no RLS, no policy, no data touched outside the new table itself), so this
-- rollback is purely subtractive — unlike app_state (0000's territory),
-- dropping this table has zero application-data consequence: nothing in
-- js/**/*.js or proxy/*.js reads or writes public._schema_migrations; it is
-- pure operator bookkeeping.
--
-- GUARD (consistent with 0009/0010's convention of refusing to proceed if
-- the live state is richer than what this rollback was designed to remove):
-- if more rows exist than the 10 this file's forward migration created
-- (0001,0003-0011), some later real migration has already registered
-- itself here for real — dropping the table would destroy that genuine
-- tracking history, not just undo 0011's own backfill. Abort in that case.

begin;

set local lock_timeout = '5s';

do $$
declare
  n int;
  expected_max int := 10;  -- 0001,0003,0004,0005,0006,0007,0008,0009,0010,0011
begin
  if not exists (select 1 from information_schema.tables
    where table_schema = 'public' and table_name = '_schema_migrations') then
    raise notice '[0011-rollback] _schema_migrations does not exist — nothing to do.';
    return;
  end if;

  select count(*) into n from public._schema_migrations;
  if n > expected_max then
    raise exception '[0011-rollback] ABORT: % rows exist, more than the % this migration backfilled — a later migration has likely registered itself for real. Dropping the table would destroy that history. Inspect public._schema_migrations manually before proceeding.', n, expected_max;
  end if;

  drop table public._schema_migrations;

  raise notice '[0011-rollback] OK — public._schema_migrations removed (% row(s) were present, all accounted for by 0011''s own backfill/self-registration).', n;
end $$;

commit;

-- ── VERIFICATION — run manually ──
-- select exists (select 1 from information_schema.tables
--   where table_schema='public' and table_name='_schema_migrations');
-- → expect false
