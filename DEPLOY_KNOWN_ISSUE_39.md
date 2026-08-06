# Deployment Runbook — Known Issue #39: `app_state` per-user primary key

Operational checklist for deploying the fix for Known Issue #39. Follow it
top to bottom. It assumes no prior context beyond read access to this repo
and the Supabase project dashboard (SQL Editor).

Code + migrations for this fix are already committed on branch `test`,
commit `748388b`. This runbook covers taking that commit to production:
running the SQL against the live database and deploying the app.

---

## 1. Purpose of the migration

`public.app_state` stores every module's synced state (Goals, Wardrobe,
Health, and the gym Progressive Overload Coach) as one JSONB row per
`key` (`'goals'`, `'wardrobe'`, `'health'`, `'po-coach'`). Its primary key
is `key` alone — **globally unique across every user**, not scoped per
user. `user_id` and row-level security were added in a later migration
(0006), but nothing ever fixed the underlying key.

The practical failure: two different users' devices both writing a row
for `key = 'goals'` collide on that global uniqueness constraint. Postgres
evaluates the constraint **before** RLS visibility applies, so this isn't
a permissions problem RLS can paper over — it's a schema defect. Today
this project has exactly one real user, so the bug is latent, not yet
triggered. It becomes live the moment a second person signs up.

This deployment makes the primary key `(user_id, key)` instead of `key`
alone, so uniqueness is scoped per user. It is split into two SQL steps
specifically so that no window exists where deployed application code is
incompatible with the live database schema — see §4.

---

## 2. Preconditions

Confirm all of the following before starting. Do not proceed if any fail.

- [ ] You have SQL Editor access to the production Supabase project.
- [ ] You have the ability to deploy this repo's `main` branch to
      production (Vercel).
- [ ] The repo is on (or you can check out) commit `748388b` or later on
      branch `test`, which contains:
      - `supabase/migrations/0009_app_state_add_composite_unique.sql`
      - `supabase/migrations/0009_app_state_add_composite_unique.rollback.sql`
      - `supabase/migrations/0010_app_state_promote_composite_key.sql`
      - `supabase/migrations/0010_app_state_promote_composite_key.rollback.sql`
      - Application code changes in `sync.js`, `js/gym/gym-sync.js`,
        `js/topbar.js` (each upserts to `app_state` with
        `onConflict: 'user_id,key'` instead of `'key'`).
- [ ] Run this query in the SQL Editor and confirm the primary key is
      still `key` alone (if it already shows `(user_id, key)`, this
      migration has already been applied — stop and investigate before
      re-running anything):
      ```sql
      select conname, pg_get_constraintdef(oid)
        from pg_constraint
       where conrelid = 'public.app_state'::regclass and contype = 'p';
      ```
- [ ] Run this query and confirm the row count is small (at the time this
      runbook was written: 4 rows, 1 distinct `user_id`). If the table
      has grown to many users, re-read §5's guard descriptions — the
      migration will still run correctly, but the blast radius of any
      guard failure is larger and warrants more caution:
      ```sql
      select count(*) as rows, count(distinct user_id) as distinct_users
        from public.app_state;
      ```
- [ ] Any browser tabs you have open with this app loaded are refreshed
      or closed after the application deploy in §4 step 2, and again
      before running the migration in §4 step 4. A stale tab still
      running old JavaScript will fail its background syncs (safely,
      silently) until refreshed — see §6's residual-risk note.

---

## 3. Required backup

The table is small enough to back up trivially by hand — do this even if
your Supabase plan also has automatic backups, since it costs one minute.

1. In the SQL Editor, run:
   ```sql
   select * from public.app_state order by user_id, key;
   ```
2. Export the result (SQL Editor → results pane → download as CSV, or
   copy the JSON output) and save it somewhere outside the database
   (local file, password manager note, etc.), timestamped.
3. Separately, confirm your Supabase project's automatic backup / point
   in time recovery status: Supabase Dashboard → Project Settings →
   Database → Backups. Note what recovery window is available. This
   runbook does not require PITR to be enabled, but you should know
   whether it is before touching production schema.

Do not proceed past this section without a saved export from step 2.

---

## 4. Deployment order

This is the sequence in full; §5–§6 give the detail for each numbered step.

1. Run migration **0009** (additive — adds a `UNIQUE(user_id, key)`
   constraint; the existing primary key is untouched).
2. Commit is already in place — deploy the application (`main` branch,
   via Vercel) so the live app uses `onConflict: 'user_id,key'`.
3. Validate production (§6).
4. Run migration **0010** (promotes the composite constraint to the
   primary key and drops the legacy one — this is the step that actually
   fixes the bug).
5. Run 0010's post-check and confirm the final schema (§9).

Do not run 0010 before deploying and validating the application. Doing so
defeats the entire purpose of the two-step design — 0010 is safe to defer
indefinitely, but only 0009 by itself is not a fix, and running 0010 while
old code is still live will cause writes from that old code to fail (see
§6's residual-risk note, and §8 if this happens anyway).

---

## 5. SQL migration execution steps

### Step A — run 0009

1. Open `supabase/migrations/0009_app_state_add_composite_unique.sql` in
   this repo and copy its full contents.
2. Paste into the Supabase SQL Editor and run it.
3. Read the `NOTICE` output. Expect:
   ```
   NOTICE: [0009] OK — app_state now has UNIQUE (user_id, key) alongside the existing PRIMARY KEY (key). ...
   ```
   If instead you see an `EXCEPTION` (the statement fails and nothing is
   changed — this migration only ever fully applies or fully rolls back,
   never partially), read the error message; it names the exact problem
   (duplicate `(user_id, key)` pairs is the only realistic cause at this
   table's current size) and stop here.
4. Run the post-check named at the bottom of the file:
   ```sql
   select conname, contype, pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.app_state'::regclass and contype in ('p','u')
    order by contype;
   ```
   Expect two rows: `p | PRIMARY KEY (key)` and
   `u | UNIQUE (user_id, key)`.

### Step B — deploy the application

Deploy this repo's `main` branch (containing the `onConflict` changes) to
Vercel through your normal process. Confirm the deploy is live before
continuing.

### Step C — run 0010 (only after §6 validation passes)

1. Open `supabase/migrations/0010_app_state_promote_composite_key.sql`
   and copy its full contents.
2. Paste into the SQL Editor and run it.
3. Read the `NOTICE` output. Expect:
   ```
   NOTICE: [0010] OK — app_state now has PRIMARY KEY (user_id, key). Known Issue #39 is closed: ...
   ```
   An `EXCEPTION` here means nothing was changed. The error message will
   say exactly which guard failed (schema drift, missing prerequisite
   from 0009, a null `user_id` row, an unexpected foreign key, or a lock
   timeout from a stuck client session) — resolve that specific cause
   before retrying; do not work around a guard failure by editing the
   migration file.
4. Run 0010's post-check (also see §9):
   ```sql
   select conname, pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.app_state'::regclass and contype = 'p';
   ```
   Expect exactly one row: `app_state_user_key_pk | PRIMARY KEY (user_id, key)`.

---

## 6. Post-deployment validation

Run this **after Step B (app deploy) and before Step C (0010)** — this is
the gate that decides whether it's safe to proceed to 0010.

1. **Schema check** (from Step A.4 above) — composite unique constraint
   exists alongside the untouched legacy primary key.
2. **Signed-in read check** — in the browser console on the deployed
   site, signed in as the real user:
   ```js
   await window.APP_SUPABASE.from('app_state').select('key')
   ```
   Expect your 4 keys returned, no error.
3. **Live write check** — perform a real action that writes to
   `app_state` (e.g. log a glass of water on the Health page, or add a
   note in Goals). Confirm:
   - No error in the browser console.
   - In the Supabase Table Editor, the corresponding row's `updated_at`
     column has advanced to the current time.
4. **Network check** — in browser devtools Network tab, find the
   `app_state` upsert request triggered by step 3. Confirm it returns
   `200`/`201`, not `400`/`409` with a Postgres `42P10` error body ("no
   unique or exclusion constraint matching the ON CONFLICT specification").
5. **Optional, recommended** — since the entire purpose of this migration
   is multi-user correctness, and there is currently no second real user
   to test against: sign up a throwaway second account, sign in with it,
   perform one write, and confirm in the Table Editor that its row does
   not collide with or alter the original owner's rows. Delete the
   throwaway account afterward.

Only proceed to Step C (0010) once every check above passes. If any
check fails, do not run 0010 — see §8.

---

## 7. Rollback procedure

Each migration step has its own rollback file. Roll back in reverse order
— never roll back 0009 while 0010 is still applied (0009's rollback file
detects and refuses this automatically).

**If 0010 needs to be rolled back** (composite key promoted, but
something is wrong):
1. Open `supabase/migrations/0010_app_state_promote_composite_key.rollback.sql`
   and run it in the SQL Editor.
2. Expect `NOTICE: [0010-rollback] OK — app_state back to PRIMARY KEY (key) + UNIQUE (user_id, key), the pre-0010 state.`
3. Run its verification query (in the file's footer) and confirm both
   constraints are back: `PRIMARY KEY (key)` and `UNIQUE (user_id, key)`.
4. No application code revert is required for this rollback specifically
   — the deployed code targets `onConflict: 'user_id,key'`, and the
   restored `UNIQUE (user_id, key)` constraint still satisfies that.

**If 0009 also needs to be rolled back** (returning fully to the
pre-deployment schema):
1. First revert the application code (`sync.js`, `js/gym/gym-sync.js`,
   `js/topbar.js` — `onConflict` back to `'key'`) and redeploy. Do this
   before the SQL rollback below, or every upsert will target a
   constraint that no longer exists.
2. Open `supabase/migrations/0009_app_state_add_composite_unique.rollback.sql`
   and run it.
3. Expect `NOTICE: [0009-rollback] OK — app_state_user_key_uniq removed. app_state back to PRIMARY KEY (key) only, no other constraint.`
4. Confirm via the query in that file's footer: exactly one constraint,
   `PRIMARY KEY (key)`.

---

## 8. Recovery steps if validation fails

**If §6 validation fails after Step B (app deployed, 0010 not yet run):**
- The database still has the legacy `PRIMARY KEY (key)` untouched. No
  data-affecting change has happened yet from 0010's perspective.
- Diagnose using the browser console error and the Network tab response
  body — the failure is almost certainly either (a) a stale browser
  cache still serving pre-deploy JavaScript (hard-refresh and retry), or
  (b) the Vercel deploy didn't actually complete/promote (check the
  Vercel dashboard for deploy status).
- If the application code itself is wrong, revert the Vercel deployment
  to the prior version. §5 Step A (0009) does not need to be rolled back
  in this case — it's additive and harmless to leave in place while you
  fix and redeploy the code.
- Do not run 0010 until validation passes cleanly.

**If something goes wrong during or after Step C (0010 already run):**
- Follow §7's "If 0010 needs to be rolled back" procedure immediately.
- After rolling back, re-diagnose using the same signals as above
  (console errors, Network tab, Vercel deploy status) before attempting
  0010 again.
- If data looks wrong in `app_state` (unexpected rows, a value that
  doesn't match what a user actually entered), stop and compare against
  the backup export taken in §3 before making further changes.

**If a migration's own guard raised an exception (nothing changed):**
- This is the expected, safe failure mode — the transaction rolled back
  automatically, so the schema is exactly as it was before you ran the
  file. Read the exception message (it names the specific guard that
  failed and why), resolve the underlying cause, and re-run the same
  file. Do not proceed to the next step in the sequence.

---

## 9. Expected final schema

After both migrations have been run successfully and validated:

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.app_state'::regclass and contype = 'p';
```

should return exactly one row:

| conname | definition |
|---|---|
| `app_state_user_key_pk` | `PRIMARY KEY (user_id, key)` |

Additional facts true of the final state:
- `user_id` is `NOT NULL` (a composite primary key enforces this on every
  constituent column).
- The intermediate `app_state_user_key_uniq` constraint from 0009 no
  longer exists as a separate object — 0010 drops it once the composite
  primary key supersedes it, so exactly one constraint documents this
  invariant, not two overlapping ones.
- No other table structure changes: column set, RLS policy
  (`"app_state owner"`, `auth.uid() = user_id`), and grants are all
  unchanged by this migration.
- Two different users can now each hold a row with the same `key` value
  without colliding — Known Issue #39 is closed.
