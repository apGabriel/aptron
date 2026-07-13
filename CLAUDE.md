# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Aptron is a personal dashboard suite: several self-contained single-page apps —
`index.html` (Goals + calendar), `gym.html` (Progressive Overload Coach),
`wardrobe.html` (Smart Wardrobe), `health.html` (daily health). Vanilla
JavaScript, **no framework and no build step**. Backed by Supabase for cloud
sync and a small Express proxy (`proxy/`) that fronts the Google Calendar API.

## Running locally

- Frontend: serve the repo root with a local static server (e.g. `npx serve .`
  or VS Code Live Server), then open the relevant `*.html`. Don't rely on
  `file://` — Supabase/CORS behave differently than a real origin.
- Proxy (only needed for the Goals calendar): `cd proxy && npm run dev`
  (auto-restart) or `npm start`. One-time Google OAuth setup: `npm run auth`,
  then paste the refresh token into `proxy/.env`.

## Architecture you need to know

- **No build, no bundler, no transpile.** Edit `.js`/`.html`/`.css` and reload.
  There is no CI or linter, so a syntax error ships silently — a `node --check`
  hook guards edited JS, but still load the page to confirm behavior.
- **Offline-first.** All data lives in `localStorage` first and syncs async to
  Supabase. UI must work before the network resolves.
- **Two intentional Supabase sync systems — do not collapse them:**
  1. `sync.js` mirrors `localStorage` ⇄ a per-app `app_state` JSONB blob
     (Goals, Wardrobe). Last-write-wins by `updated_at`; polls ~8s + realtime.
  2. `gym.js` uses normalized `routines` + `exercise_logs` tables
     (migration in `supabase/migrations/`). `gym.html` runs BOTH the app_state
     blob and the normalized tables on purpose.
- **Single-owner auth (Supabase Auth + RLS).** `js/auth/` (ES modules, entry
  `js/auth/main.js` via `<script type="module">`) gates every page
  with an email+password login and creates the ONE shared authenticated client,
  `window.APP_SUPABASE`. Tables are scoped to `auth.uid()` (RLS, migration
  `0003`); the anon key alone reads nothing. The publishable/anon key in
  `js/config.js` is still public, but it's only an entry point — the JWT is what
  grants access. The proxy holds the Google secrets server-side. See `AUTH.md`.
  - **Any new Supabase code MUST reuse `window.APP_SUPABASE`** (await
    `window.APP_AUTH_READY` first) — a second `createClient()` carries only the
    anon key and is denied by RLS.
  - **Any new calendar/proxy call MUST go through `authedFetch`** (js/index.js)
    or otherwise attach `Authorization: Bearer ${window.__appAccessToken}` — the
    proxy's `/api/*` middleware rejects requests without a valid session JWT.

## Big files

`gym.js` (~2500 lines), `js/wardrobe.js` (~1400), `js/index.js` (~1000).
Each feature is a self-contained IIFE communicating only via `window`/`CONFIG`.
`js/exercises-data.json` (~197 KB) is generated — edit the generator, not the JSON.

## Env vars

- Root `.env`: `SUPABASE_URL`, `SUPABASE_KEY`.
- `proxy/.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
  `GOOGLE_CALENDAR_ID`, `TIMEZONE`, `PORT`, plus `SUPABASE_URL` +
  `SUPABASE_ANON_KEY` (used to validate the login JWT on `/api`; without them
  `/api` fails closed). Both `.env` files are gitignored.

## Git workflow

All development goes to the `test` branch. Never touch `main` without an explicit
merge request. Frontend deploys to Vercel (auto from GitHub); proxy runs on
Render.com.
