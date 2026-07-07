-- ============================================================================
-- Migration 0004 (MASTER) — Per-user calendar events (Supabase-native)
-- ----------------------------------------------------------------------------
-- Consolidated end-state of the original 0004_events.sql + 0006 (the unique
-- constraint). Supabase is the source of truth for the day's blocks; every user
-- gets their own isolated calendar via RLS (auth.uid()), like app_state/routines
-- after 0003. Google Calendar is an OPTIONAL per-user mirror (see the proxy +
-- 0005_calendar_connections_master); google_event_id/sync_state are the only
-- mirror-facing columns here.
--
-- NOTE: this file is idempotent — safe to re-run on the LIVE database (every
-- statement is a no-op there) and safe as a from-scratch rebuild on a fresh
-- project. It does NOT re-apply itself to prod automatically; these are
-- run-by-hand SQL-editor migrations with no schema_migrations ledger.
--
-- Design notes:
--   • starts_at / ends_at are timestamptz (absolute instants). Timed blocks are
--     stored as the real UTC instant and rendered in the viewer's local zone.
--     All-day blocks are stored at 00:00:00Z of their calendar date with
--     all_day = true; the client reads the date back off the UTC parts.
--   • tz records the IANA zone the block was authored in — informational for
--     now; rendering uses the absolute instant.
--   • deleted_at is a SOFT delete (NULL = live). The assistant's restore/undo
--     clears it (same id), and it maps onto Google's cancelled-event tombstones.
--   • sync_state (local | pending | synced | error): the mirror's dirty flag.
--     Local writes leave it 'local'; the proxy sets 'synced' after mirroring.
--
-- RLS mirrors 0003: anon gets nothing; an authenticated user sees/edits only
-- their own rows. user_id defaults to auth.uid() so inserts self-attribute.
--
-- Run once in: Supabase → SQL Editor. Re-runnable (guarded).
-- ============================================================================

-- ---------- table -----------------------------------------------------------
create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title           text not null,
  starts_at       timestamptz,
  ends_at         timestamptz,
  all_day         boolean not null default false,
  tz              text,                              -- IANA zone the block was authored in
  notes           text not null default '',
  location        text not null default '',
  google_event_id text,                              -- set once mirrored to Google; null otherwise
  sync_state      text not null default 'local',     -- local | pending | synced | error
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz                        -- soft delete (NULL = live)
);

-- ---------- indexes ---------------------------------------------------------
-- Day/month range scans are always per-user and ordered by start.
create index if not exists events_user_start_idx
  on public.events (user_id, starts_at);
-- Live-row scans skip tombstones cheaply.
create index if not exists events_user_live_idx
  on public.events (user_id, starts_at) where deleted_at is null;

-- ---------- unique dedupe key (was a partial index in the original 0004; the
-- mirror's PostgREST upsert ON CONFLICT (user_id, google_event_id) needs a real
-- CONSTRAINT to infer as arbiter). Plain UNIQUE keeps NULLs distinct, so the
-- many local-only rows (google_event_id IS NULL) are unconstrained; only
-- non-null Google ids are deduped, one per user. -----------------------------
drop index if exists public.events_user_google_id_uidx;   -- retire the old partial index if present
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'events_user_google_uk') then
    alter table public.events
      add constraint events_user_google_uk unique (user_id, google_event_id);
  end if;
end $$;

-- ---------- privileges + RLS (authenticated owner only, per 0003) -----------
revoke all on public.events from anon;
grant  all on public.events to authenticated;

alter table public.events enable row level security;

drop policy if exists "events owner" on public.events;
create policy "events owner" on public.events
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
