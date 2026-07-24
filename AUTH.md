# Auth (feature/auth)

Turns the previously no-auth personal dashboard into a single-owner, logged-in
app. Nothing is readable without your login: the Supabase tables are locked to
`auth.uid()` by RLS, and the calendar/Gemini proxy rejects any request without a
valid session JWT.

## What changed (code)

- `js/auth/` (ES modules; `main.js` is the `type="module"` entry) — one shared
  authenticated Supabase client (`window.APP_SUPABASE`), a blocking
  email+password login gate, `APP_AUTH_READY` (resolves only once a session
  exists), `window.__appAccessToken`, and `window.appSignOut()`. Split:
  `main.js` (client + session lifecycle + submit routing), `auth_ui.js`
  (gate DOM/animations only), `login_service.js` / `register_service.js`
  (sign-in / sign-up logic, validations, `aptron_pending_profile_v1` engine).
- All sync paths (`sync.js`, `js/topbar.js`, `js/gym/gym-sync.js`,
  `js/gym/gym-cloud.js`) now reuse that one client and wait for the gate. The two
  keepalive unload `fetch`es send the user JWT instead of the anon key.
- `js/index.js` / `js/health.js` attach the JWT to every proxy call.
- `proxy/server.js` — validates the JWT on every `/api/*` route; `/health` stays open.
- `supabase/migrations/0003_auth_user_scoping.sql` — the DB migration (**you run it**).

---

## Setup — do this once, in order

### 1. Supabase dashboard
- **Authentication → Providers → Email**: enable.
- **Authentication → Users → Add user**: create your account (email + password,
  "Auto Confirm").
- Optional but recommended — **Providers → Email → disable "Allow new users to
  sign up"** so nobody else can register.

### 2. Run the migration
Open `supabase/migrations/0003_auth_user_scoping.sql` and follow its header:
1. `select id, email from auth.users;` → copy your uuid.
2. Paste it into the one marked `owner uuid := '…'` line.
3. Run the whole file in **Supabase → SQL Editor**.

It backfills every existing row to you, revokes anon, and switches to per-user
RLS. It's re-runnable and refuses to finish if any row is left unattributed.

### 3. Proxy env (local `proxy/.env` **and** Render)
Add:
```
SUPABASE_URL=https://vcuqcjtzdjtonvaqolzm.supabase.co
SUPABASE_ANON_KEY=sb_publishable_JEudB5hgyn38SkUiO6oWhw_9Qrtr36b
```
Restart the proxy (locally: `pm2 restart gcal-proxy`; Render redeploys on push).
Until these are set the proxy answers `503` on `/api` — by design (fails closed).

### 4. Frontend
No new env — `js/config.js` already holds the public URL + anon key. Just deploy
the branch. (Vercel needs nothing added.)

### 5. Progress photos (only if you use gym photos)
The `progress-photos` Storage bucket has its own policies. If uploads start
failing after login, add an `authenticated` insert/select policy on that bucket
(Storage → Policies) — the table migration doesn't touch Storage.

---

## Test plan — verify locally

Serve the repo root (`npx serve .`) and run the proxy locally with the env from
step 3. "Signed out" below means: open the login gate and **do not** log in (or
run `appSignOut()` in the console first).

### (a) Without login, nothing is accessible
1. **UI** — load `index.html` / `gym.html` / `wardrobe.html` / `health.html`
   signed out: each shows only the login card; no goals, sessions, wardrobe, or
   water data renders behind it. (Verified: the gate is `position:fixed`,
   `z-index:100000`, full-viewport, and locks body scroll.)
2. **Data (RLS)** — in the signed-out page's devtools console:
   ```js
   await window.APP_SUPABASE.from('app_state').select('key')      // → { data: [], … }
   await window.APP_SUPABASE.from('routines').select('client_id') // → { data: [], … }
   ```
   Both come back **empty** (anon is revoked; no session → no rows). To prove the
   lock-down is what changed, run the same two lines **before** the migration —
   they return your rows.
3. **Proxy** — no token is rejected:
   ```bash
   curl -s -w '\n%{http_code}\n' http://localhost:3001/api/events            # → 401
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/health     # → 200
   ```
   (Already confirmed against a throwaway instance: `/api/*` → 401, `/health` → 200.)

### (b) With your login, you see your data
1. Enter your email + password in the gate → it drops.
2. Goals/calendar, gym routines + logs, wardrobe, and water all load as before.
3. Console: `(await window.APP_SUPABASE.auth.getUser()).data.user.id` → your uuid,
   and `await window.APP_SUPABASE.from('app_state').select('key')` now returns rows.

### (c) Sync still works
1. Log in on two tabs (or two browsers) on the same page.
2. Edit in tab A (add a goal / log a set / +1 water).
3. Tab B reflects it within ~5s (realtime, or the fallback poll). Confirm the row
   in Supabase (**Table editor → app_state / exercise_logs**) shows the update and
   carries your `user_id`.
4. Calendar round-trip: create/rename/delete an event in Goals — it hits the proxy
   with your JWT and succeeds; signed out, the same action shows "proxy offline".

---

## Rollback
Everything is on `feature/auth` and unpushed. To revert the DB, re-open the anon
policies from `0001` and drop the `owner` policies / `user_id` columns. Code-side,
just don't merge the branch.

## Troubleshooting — the schedule shows an error after login

The calendar widget now names the exact failure instead of a blanket "proxy
offline". Match the message to the fix:

| In-app message | Proxy status | Cause | Fix |
|---|---|---|---|
| "Proxy is missing its Supabase keys…" | 503 | `SUPABASE_URL`/`SUPABASE_ANON_KEY` not set on the proxy | Add both to the proxy env (local `proxy/.env` **and** Render) and redeploy/restart |
| "Your login wasn't accepted by the proxy…" | 401 | No/expired/invalid JWT reached the proxy | Sign out and back in; confirm the frontend is sending `Authorization: Bearer …` |
| "Proxy can't reach the auth server…" | 502 | Proxy is up but can't reach Supabase to verify the token | Check the proxy's network / `SUPABASE_URL` value |
| "Google session expired — re-authenticate" | 5xx (`invalid_grant`) | Google refresh token stale | Re-run the Google OAuth (`npm run auth`) and update `GOOGLE_REFRESH_TOKEN` |
| "Proxy offline — run `npm start`…" | (no HTTP status) | Request never completed: proxy down, network, or timeout | Start/redeploy the proxy |

The proxy also logs its auth state on boot: `[auth] enabled — validating JWTs
against …/auth/v1/user`, or a multi-line `[auth] DISABLED — missing …` block.

## Follow-ups (not done here)
- The `progress-photos` Storage bucket may need an `authenticated` policy if gym
  photo uploads fail after login (Storage policies are separate from the table RLS).
