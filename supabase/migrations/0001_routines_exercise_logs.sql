-- ============================================================================
-- Migration 0001 — Normalized routines + exercise_logs for multi-device sync
-- ----------------------------------------------------------------------------
-- These tables COEXIST with the existing public.app_state blob sync. The blob
-- remains the cache/source for coach settings + logs; these tables add:
--   • routines      → cross-device routine sync (previously local-only)
--   • exercise_logs → a normalized, append-only log store that drives the
--                     PR badge and "recent 5" history on a fresh device.
--
-- The app is personal-use with NO auth, so it talks to Supabase with the
-- publishable (anon) key. The policies below allow anon full access — tighten
-- them later if you ever add a login flow.
--
-- `client_id` holds the app's own stable id (routine "r_…" id, or
-- "<exId>|<iso-timestamp>" for a logged set) so writes are idempotent: the same
-- routine/set upserts in place instead of duplicating on retries or backfill.
-- Run this whole script once in: Supabase → SQL Editor.
--
-- ⚠ REBUILD-FROM-SCRATCH WARNING (added 2026-07-21, Known Issues #14 / TD-2)
--   This file GRANTs anon full access and installs USING(true) "anon full
--   access" policies below. That was correct for the pre-auth era; it is WRONG
--   once auth exists. Migration 0003 (auth user scoping) revokes anon and
--   replaces these policies — but if you are ever rebuilding this database from
--   the migration files, running 0001 alone (or stopping before 0003) leaves
--   routines/exercise_logs open to anyone with the anon key. There is still no
--   migration ledger (Known Issues #7), so nothing enforces the order.
--   ALWAYS run 0001 → 0002 → 0003 → 0004 → 0005 → 0006 → 0007 → 0008 in full,
--   never 0001 in isolation. The live database already has 0003+ applied; this
--   warning only matters for a from-scratch rebuild.
-- ============================================================================

-- ---------- routines --------------------------------------------------------
create table if not exists public.routines (
  id          uuid primary key default gen_random_uuid(),
  client_id   text unique,                         -- app routine id ("r_…")
  name        text not null default 'Untitled routine',
  exercises   jsonb not null default '[]'::jsonb,  -- array of {exId,name,sets,…}
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- exercise_logs ---------------------------------------------------
create table if not exists public.exercise_logs (
  id            uuid primary key default gen_random_uuid(),
  client_id     text unique,                       -- "<exId>|<iso-timestamp>"
  exercise_name text not null,
  weight        numeric,
  reps          integer,
  timestamp     timestamptz not null default now(),
  metadata      jsonb not null default '{}'::jsonb, -- { exId, unit }
  created_at    timestamptz not null default now()
);

create index if not exists exercise_logs_exercise_name_idx
  on public.exercise_logs (exercise_name);
create index if not exists exercise_logs_timestamp_idx
  on public.exercise_logs (timestamp desc);

-- ---------- privileges + RLS (anon, no-auth personal use) --------------------
grant all on public.routines      to anon, authenticated;
grant all on public.exercise_logs to anon, authenticated;

alter table public.routines      enable row level security;
alter table public.exercise_logs enable row level security;

drop policy if exists "routines anon full access" on public.routines;
create policy "routines anon full access"
  on public.routines for all to anon, authenticated
  using (true) with check (true);

drop policy if exists "exercise_logs anon full access" on public.exercise_logs;
create policy "exercise_logs anon full access"
  on public.exercise_logs for all to anon, authenticated
  using (true) with check (true);

-- ---------- keep updated_at fresh on routine upserts ------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists routines_touch_updated_at on public.routines;
create trigger routines_touch_updated_at
  before update on public.routines
  for each row execute function public.touch_updated_at();
