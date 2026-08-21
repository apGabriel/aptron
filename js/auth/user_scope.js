// =============================================================
// User-boundary helper — the single place that knows which
// localStorage keys are Aptron-owned + user-scoped, and detects when
// the authenticated user on this browser has changed so that stale
// data from a previous account never rides into the new one's own
// sync/backfill pushes. See ADR-024 (supersedes/extends ADR-013).
//
// Root cause this exists for: sync.js / js/gym/gym-sync.js push
// whatever is in localStorage up to Supabase the first time a user's
// remote row is empty (a legitimate "seed the cloud from this device"
// path for a genuinely first-time device). Combined with logout never
// clearing localStorage, User B's first sync could durably write User
// A's stale local profile/theme/gym data into User B's OWN Supabase
// row. The fix is not to change that push logic — it's to guarantee
// local state actually belongs to the current uid before any sync
// consumer (which all `await window.APP_AUTH_READY`) ever runs.
//
// No DOM, no Supabase calls — pure localStorage logic so js/auth/main.js
// can call it synchronously before releasing APP_AUTH_READY.
// =============================================================

const LAST_UID_KEY = 'aptron_last_uid';

// Every Aptron-owned key that rides the localStorage -> Supabase sync
// path (the generic app_state blob, used by goals/profile/theme, gym
// coach state, wardrobe, health; plus the gym normalized-table local
// mirrors and their offline queue). One inventory, so a user-boundary
// clear and each page's `initCloudSync({ syncedKeys/syncedPrefixes })`
// declaration are drawn from the same list instead of drifting apart.
//
// Deliberately EXCLUDED:
//   - 'aptron-auth'              — owned by supabase-js itself; already
//                                   cleared by auth.signOut().
//   - 'aptron_pending_profile_v1'— short-lived, self-consuming (stashed
//                                   moments before the SAME new user's
//                                   own SIGNED_IN event promotes it —
//                                   see js/auth/register_service.js).
//                                   Clearing it here would race a brand
//                                   new signup's own just-entered name/
//                                   theme/avatar out from under it.
//   - LAST_UID_KEY itself        — the marker this module owns.
export const USER_SCOPED_KEYS = [
  'aptron_profile_v1',
  'quicknotes_v1',
  'po_coach_v1',
  'po_coach_workout_done',
  'po_coach_photos',
  'rb_routines_v1',
  'local_sync_queue',
  'stack:items', 'stack:version', 'stack:low',
  'po_water_v1', 'po_food_v1',
  // Shenlong's persistent per-user memory (js/index.js MEMORY_KEY) — never
  // synced to Supabase (local-only, so no sync-engine interaction/F1 risk),
  // but genuinely user-owned and must not survive a user-boundary crossing.
  'shenlong_memory_v1',
];
export const USER_SCOPED_PREFIXES = [
  'cal_done:', 'cal_manual:',
  'wardrobe:',
  'stack:taken:',
  'po_cloud_backfilled_v1:',   // per-uid backfill guards, see gym-cloud.js
];

function isUserScoped(k) {
  if (!k) return false;
  if (USER_SCOPED_KEYS.indexOf(k) !== -1) return true;
  for (let i = 0; i < USER_SCOPED_PREFIXES.length; i++) {
    if (k.indexOf(USER_SCOPED_PREFIXES[i]) === 0) return true;
  }
  return false;
}

// Pauses this page's sync engine(s) — sync.js (System 1, app_state blob:
// goals/health/wardrobe) and js/gym/gym-sync.js (System 2, po-coach) —
// around the removal loop below, so the clear itself can never be read as a
// real edit that needs pushing (ADR-024 F1). Both expose the same shape
// (window.__apt{,Gym}SyncPause/Resume), installed only if that page actually
// called initCloudSync / loaded gym-sync.js; no-op otherwise. Pause cancels
// any already-armed debounce timer (an edit made moments before the clear)
// AND reuses the existing suppressSync/pcSuppressSync flag each engine
// already uses for "this write isn't a real edit" (applyRemote()'s own
// purpose) — resumed immediately after, so normal writes elsewhere are
// completely unaffected.
function pauseSyncEngines() {
  try { if (typeof window.__aptSyncPause === 'function') window.__aptSyncPause(); } catch (e) {}
  try { if (typeof window.__aptGymSyncPause === 'function') window.__aptGymSyncPause(); } catch (e) {}
}
function resumeSyncEngines() {
  try { if (typeof window.__aptSyncResume === 'function') window.__aptSyncResume(); } catch (e) {}
  try { if (typeof window.__aptGymSyncResume === 'function') window.__aptGymSyncResume(); } catch (e) {}
}

// Removes every currently-present user-scoped key. Targeted, not
// localStorage.clear() — never touches the auth session, the pending-
// signup stash, or any non-Aptron key that might ever share this origin.
export function clearUserScopedState() {
  pauseSyncEngines();
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isUserScoped(k)) toRemove.push(k);
    }
    toRemove.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
  } catch (e) {
  } finally {
    resumeSyncEngines();
  }
}

// Reconciles the currently authenticated uid against the last uid known
// to have used this browser. Call once per session, BEFORE any sync
// consumer is allowed to run (js/auth/main.js gates APP_AUTH_READY on
// this). Returns true if a clear happened.
//
// First-ever run on a browser (no marker yet, e.g. right after this fix
// ships) deliberately does NOT clear — it grandfathers whatever's
// present in to the currently authenticated uid instead of discarding a
// real, legitimate cache on the one transition deploy. Every SUBSEQUENT
// uid change on this browser clears normally. A currently-contaminated
// browser's already-written Supabase rows are a separate, explicit data
// cleanup — this only stops FUTURE cross-user writes.
export function reconcileUserScope(uid) {
  if (!uid) return false;
  let last = null;
  try { last = localStorage.getItem(LAST_UID_KEY); } catch (e) {}
  if (last === null) {
    try { localStorage.setItem(LAST_UID_KEY, uid); } catch (e) {}
    return false;
  }
  if (last === uid) return false;
  clearUserScopedState();
  try { localStorage.setItem(LAST_UID_KEY, uid); } catch (e) {}
  return true;
}

// Called from window.appSignOut() BEFORE the Supabase signOut/reload
// boundary, so a killed tab isn't the only thing standing between
// logout and a clean slate (reconcileUserScope is the belt-and-
// suspenders for that case). Keeps LAST_UID_KEY itself — the next
// login's reconcile still needs it to tell "same user back" from
// "different user arrived" when logout never got a chance to run.
//
// Sets window.__aptLoggingOut = true FIRST, for the rest of this page's
// lifetime (ADR-024 F1) — unlike pauseSyncEngines()'s pause/resume above
// (which only brackets the synchronous removal loop), appSignOut() then
// calls supa.auth.signOut() and reload()s, and beforeunload/pagehide fire
// well after that loop has already resumed normal suppression state. Both
// sync engines' flushOnUnload()/pushNow() check this flag so neither can
// serialize the just-cleared (now empty) state during the reload. Never
// reset: appSignOut() always ends in location.reload(), so a fresh module
// instance — and a fresh, false, window.__aptLoggingOut — boots right after.
export function clearOnLogout() {
  window.__aptLoggingOut = true;
  clearUserScopedState();
}
