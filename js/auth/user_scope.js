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

// Removes every currently-present user-scoped key. Targeted, not
// localStorage.clear() — never touches the auth session, the pending-
// signup stash, or any non-Aptron key that might ever share this origin.
export function clearUserScopedState() {
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isUserScoped(k)) toRemove.push(k);
    }
    toRemove.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
  } catch (e) {}
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
export function clearOnLogout() {
  clearUserScopedState();
}
