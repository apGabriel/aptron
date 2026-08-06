-- Rollback for 0009_app_state_add_composite_unique.sql
--
-- The forward migration is purely additive, so this rollback is purely
-- subtractive — zero data risk in either direction. Safe to run at any
-- time UNLESS 0010 has already promoted this constraint to the primary
-- key, in which case roll back 0010 first.

begin;

set local lock_timeout = '5s';

do $$
declare
  promoted boolean;
begin
  select exists (
    select 1 from pg_constraint
     where conrelid = 'public.app_state'::regclass
       and contype = 'p'
       and conname = 'app_state_user_key_pk'
  ) into promoted;

  if promoted then
    raise exception '[0009-rollback] ABORT: app_state_user_key_pk already exists as the primary key — 0010 has run. Roll back 0010_app_state_promote_composite_key.sql first, then this file.';
  end if;

  alter table public.app_state drop constraint if exists app_state_user_key_uniq;

  raise notice '[0009-rollback] OK — app_state_user_key_uniq removed. app_state back to PRIMARY KEY (key) only, no other constraint.';
end $$;

commit;

-- ── VERIFICATION — run manually ──
-- select conname, contype from pg_constraint
--  where conrelid = 'public.app_state'::regclass and contype in ('p','u');
-- → expect exactly one row: p | app_state_pkey (or whatever it's named) | PRIMARY KEY (key)
