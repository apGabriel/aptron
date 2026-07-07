-- ============================================================================
-- Migration 0005 (MASTER) — calendar_connections: per-user Google token vault
-- ----------------------------------------------------------------------------
-- Consolidated end-state of 0005_calendar_connections.sql (unchanged by any
-- later migration — reproduced here so the calendar schema lives in exactly two
-- master files). Stores each linked user's Google refresh token so the proxy can
-- mint access tokens on their behalf and mirror events to their calendar.
--
-- SECURITY POSTURE — read before changing the policies:
--   • The refresh token is a long-lived secret. The BROWSER MUST NEVER READ IT.
--   • So this table has RLS ENABLED but ZERO policies: with RLS on and no policy,
--     `anon` and `authenticated` can select/insert NOTHING — every row is
--     invisible to the dashboard's user JWT. (The opposite of the events owner
--     policy, and intentional.)
--   • Only the proxy touches it, using the SERVICE ROLE key, which BYPASSES RLS.
--     Grants are to service_role only; anon/authenticated are revoked.
--   • refresh_token_enc is additionally encrypted at rest by the proxy
--     (AES-256-GCM, key = TOKEN_ENC_KEY, base64 iv|tag|ciphertext), so a raw
--     dump of this table is useless without the proxy's key too.
--
-- The UI never reads this table directly — it calls the proxy's
-- GET /api/calendar/status, which returns only non-secret metadata
-- (connected? / email / sync_enabled).
--
-- Run once in: Supabase → SQL Editor. Re-runnable (guarded).
-- ============================================================================

-- ---------- table -----------------------------------------------------------
create table if not exists public.calendar_connections (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  google_sub        text,                              -- stable Google account id
  google_email      text,                              -- for display / de-dupe
  refresh_token_enc text not null,                     -- AES-256-GCM, base64 (proxy-held key)
  scope             text,
  sync_enabled      boolean not null default false,    -- OFF until explicitly linked
  sync_token        text,                              -- Google incremental syncToken
  connected_at      timestamptz not null default now(),
  last_sync_at      timestamptz,
  updated_at        timestamptz not null default now()
);

-- ---------- privileges + RLS (service_role ONLY; no client access at all) ----
revoke all on public.calendar_connections from anon, authenticated;
grant  all on public.calendar_connections to   service_role;

-- RLS on with NO policy → anon/authenticated are denied every row. service_role
-- bypasses RLS, so the proxy still has full access. Do NOT add a permissive
-- policy here: it would expose refresh tokens to the browser's user JWT.
alter table public.calendar_connections enable row level security;

-- (Deliberately: no `create policy` statements on this table.)
