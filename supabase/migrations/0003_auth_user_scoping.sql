-- ============================================================================
-- Migration 0003 — Auth: scope every table to the logged-in user (auth.uid())
-- ----------------------------------------------------------------------------
-- Reverses the original "personal-use, no auth" posture (see 0001). Until now
-- the publishable (anon) key had full read/write on app_state, routines and
-- exercise_logs. After this migration:
--   • every row carries user_id (uuid → auth.users)
--   • anon has NO access; only an authenticated user sees/edits their own rows
--   • existing rows are backfilled to YOU (the single owner)
--
-- HOW TO RUN — read carefully, this is a do-it-yourself migration:
--
--   STEP 0 (dashboard, once): Authentication → Providers → Email = ON.
--           Authentication → Users → "Add user" → create YOUR account
--           (email + password). Optional: Providers → disable "Allow new
--           users to sign up" so nobody else can register.
--
--   STEP 1: Find your user id — run this alone in the SQL editor, copy the uuid:
--             select id, email from auth.users;
--
--   STEP 2: Paste that uuid into the ONE marked spot in section 2 below
--           (replace 00000000-…-000000000000), then run this WHOLE file in:
--           Supabase → SQL Editor.
--
-- Runs in the Supabase web SQL editor (plain SQL, no psql meta-commands).
-- Re-runnable: every statement is guarded, so running it twice is safe. It does
-- NOT touch Google/proxy config.
-- ============================================================================

-- ---------- 1. add user_id columns ------------------------------------------
-- Default auth.uid() so future inserts self-attribute to the caller and pass
-- the RLS check without the client having to send user_id explicitly.
alter table public.app_state     add column if not exists user_id uuid references auth.users(id) default auth.uid();
alter table public.routines      add column if not exists user_id uuid references auth.users(id) default auth.uid();
alter table public.exercise_logs add column if not exists user_id uuid references auth.users(id) default auth.uid();

-- ---------- 2. backfill existing rows to the owner --------------------------
do $$
declare
  -- ⬇⬇⬇  PASTE YOUR auth.users.id HERE (from STEP 1)  ⬇⬇⬇
  owner uuid := '00000000-0000-0000-0000-000000000000';
  -- ⬆⬆⬆  ............................................  ⬆⬆⬆
begin
  update public.app_state     set user_id = owner where user_id is null;
  update public.routines      set user_id = owner where user_id is null;
  update public.exercise_logs set user_id = owner where user_id is null;

  -- Safety: refuse to finish if anything is still unattributed (it would become
  -- invisible once RLS tightens). If this raises, fix the uuid above and re-run.
  if exists (select 1 from public.app_state     where user_id is null)
  or exists (select 1 from public.routines      where user_id is null)
  or exists (select 1 from public.exercise_logs where user_id is null) then
    raise exception 'Unattributed rows remain — set owner to a real auth.users.id and re-run';
  end if;
end $$;

-- ---------- 3. lock RLS to the authenticated owner --------------------------
-- Revoke the blanket anon grants from 0001, then grant only to authenticated.
-- RLS below narrows that to each user's own rows.
revoke all on public.app_state     from anon;
revoke all on public.routines      from anon;
revoke all on public.exercise_logs from anon;
grant  all on public.app_state     to authenticated;
grant  all on public.routines      to authenticated;
grant  all on public.exercise_logs to authenticated;

alter table public.app_state     enable row level security;
alter table public.routines      enable row level security;
alter table public.exercise_logs enable row level security;

-- Drop the wide-open anon policies from 0001 (and any prior app_state policy).
drop policy if exists "routines anon full access"     on public.routines;
drop policy if exists "exercise_logs anon full access" on public.exercise_logs;
drop policy if exists "app_state anon full access"     on public.app_state;

-- Per-user policies: a row is visible/editable only by its owner.
drop policy if exists "app_state owner" on public.app_state;
create policy "app_state owner" on public.app_state
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "routines owner" on public.routines;
create policy "routines owner" on public.routines
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "exercise_logs owner" on public.exercise_logs;
create policy "exercise_logs owner" on public.exercise_logs
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- 4. (optional) make user_id NOT NULL going forward ---------------
-- Uncomment after a clean run if you want the DB to hard-guarantee attribution.
-- alter table public.app_state     alter column user_id set not null;
-- alter table public.routines      alter column user_id set not null;
-- alter table public.exercise_logs alter column user_id set not null;
