-- Rollback for 0010_app_state_promote_composite_key.sql
--
-- Restores the exact intermediate state 0010 started from: PRIMARY KEY
-- (key) alone, PLUS the separate UNIQUE (user_id, key) constraint (so
-- application code stays working — it targets the unique constraint by
-- column name, not by whether that constraint happens to be the PK).
--
-- Does NOT revert application code — if the code deploy from step 2 of
-- the sequence is still live, it keeps working after this rollback,
-- because the UNIQUE (user_id, key) constraint this file recreates is
-- exactly what it targets. No code revert is required to pair with this
-- file, unlike a rollback that removed the constraint entirely.

begin;

set local lock_timeout = '5s';

do $$
declare
  pkcols text;
  pkname text;
  dupes  int;
  fkrefs int;
begin
  select string_agg(a.attname, ',' order by a.attname), max(c.conname)
    into pkcols, pkname
    from pg_constraint c
    join unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.app_state'::regclass and c.contype = 'p';

  -- Already rolled back (re-run safety).
  if pkcols = 'key' then
    raise notice '[0010-rollback] app_state already has a single-column (key) primary key — nothing to do.';
    return;
  end if;

  -- Guard: only proceed from the exact shape 0010 produces.
  if pkcols is distinct from 'key,user_id' and pkcols is distinct from 'user_id,key' then
    raise exception '[0010-rollback] ABORT: existing primary key on app_state is (%) — expected the composite (user_id, key) from 0010. Schema has drifted; do not proceed without reviewing.', coalesce(pkcols, '(none)');
  end if;

  -- Guard: no foreign key may reference this PK before it's dropped.
  select count(*) into fkrefs
    from pg_constraint
   where contype = 'f' and confrelid = 'public.app_state'::regclass;
  if fkrefs > 0 then
    raise exception '[0010-rollback] ABORT: % foreign key(s) reference app_state — inspect before proceeding', fkrefs;
  end if;

  -- Guard: collapsing back to a single-column key on `key` alone would
  -- silently make one of any duplicate keys unreachable — abort instead.
  select count(*) into dupes
    from ( select key from public.app_state group by key having count(*) > 1 ) d;
  if dupes > 0 then
    raise exception '[0010-rollback] ABORT: % duplicate key value(s) exist across users — collapsing to a global-unique key would hide data, not just a constraint. Do not proceed without resolving these rows manually first.', dupes;
  end if;

  execute format('alter table public.app_state drop constraint %I', pkname);
  alter table public.app_state add constraint app_state_pkey primary key (key);
  alter table public.app_state alter column user_id drop not null;

  -- Restore 0009's constraint too, so application code (which may still
  -- be running the onConflict:'user_id,key' version) keeps working.
  alter table public.app_state
    add constraint app_state_user_key_uniq unique (user_id, key);

  raise notice '[0010-rollback] OK — app_state back to PRIMARY KEY (key) + UNIQUE (user_id, key), the pre-0010 state.';
end $$;

commit;

-- ── VERIFICATION — run manually ──
-- select conname, contype, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.app_state'::regclass and contype in ('p','u')
--  order by contype;
-- → expect: p | app_state_pkey | PRIMARY KEY (key)
--           u | app_state_user_key_uniq | UNIQUE (user_id, key)
