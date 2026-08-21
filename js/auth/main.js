// =============================================================
// Auth orchestrator — single authenticated Supabase client, the
// session lifecycle, and the wiring between the gate UI
// (./auth_ui.js) and the sign-in / registration services
// (./login_service.js, ./register_service.js).
//
// Loaded as <script type="module"> on every page: supabase-js CDN →
// js/config.js → THIS FILE → sync.js / gym-*.js / index.js /
// topbar.js. Module scripts are defer-equivalent and keep document
// order with classic defer scripts, so the contract below exists
// before any consumer runs. Everything that talks to Supabase must
// reuse window.APP_SUPABASE (created here) so the user's JWT rides
// along; a second createClient() would fall back to the bare anon
// key and get denied by RLS.
//
// Contract for consumers — these four globals are the DELIBERATE
// public API (the no-bundler suite's classic scripts can't import);
// everything else now lives in module scope:
//   • window.APP_SUPABASE   — the one authed client (may be null in
//                             local-only mode: no supabase / no config).
//   • window.APP_AUTH_READY — Promise that resolves ONLY once a valid
//                             session exists. Sync modules must `await` it
//                             before their first query so nothing runs (or
//                             leaks an empty-state write) while signed out.
//   • window.__appAccessToken — current JWT string (or null). For the
//                             keepalive unload fetches that can't await.
//   • window.appSignOut()   — sign out + reload (drops back to the gate).
// =============================================================
import { createGateController } from './auth_ui.js';
import {
  normalizeEmail, normalizePassword, validateLogin, signIn,
} from './login_service.js';
import {
  AVATAR_PRESETS, normalizeFullName, normalizeUsername,
  validateRegistration, register, promotePendingProfile,
} from './register_service.js';
import { createAppSupabaseClient } from './supabase_client.js';
import { reconcileUserScope, clearOnLogout } from './user_scope.js';

const CFG_URL = (window.APP_CONFIG || {}).SUPABASE_URL || '';
const CFG_KEY = (window.APP_CONFIG || {}).SUPABASE_KEY || '';

// A page embedded in an iframe on this origin shares localStorage, so it
// sees the same persisted session — but the PARENT owns the visible login
// gate. Embedded frames never draw their own overlay.
const embedded = (function () {
  try { return window.self !== window.top; } catch (e) { return true; }
})();

let resolveReady;
window.APP_AUTH_READY = new Promise((r) => { resolveReady = r; });
window.__appAccessToken = null;

// Local-only fallback: no supabase lib or no config → can't gate. Resolve so
// the app still boots against localStorage (matches the pre-auth behavior of
// the sync modules, which no-op without a client).
if (!window.supabase || !CFG_URL || !CFG_KEY ||
    CFG_URL.indexOf('PASTE-') === 0 || CFG_KEY.indexOf('PASTE-') === 0) {
  resolveReady();
} else {
  boot();
}

function boot() {
  const supa = createAppSupabaseClient();
  window.APP_SUPABASE = supa;

  let readyResolved = false;
  function markReady(session) {
    if (session) {
      // Discard any previous user's local Aptron state BEFORE resolving
      // APP_AUTH_READY — sync.js / gym-sync.js / gym-cloud.js all await
      // that promise, so this guarantees they never see (and never push
      // upstream) data left behind by a different account on this
      // browser. Must run before promotePendingProfile(): a brand-new
      // signup's own just-stashed pending profile is excluded from the
      // clear for exactly this reason (see user_scope.js).
      const uid = session.user && session.user.id;
      reconcileUserScope(uid);
      // Promote any pending signup profile into aptron_profile_v1 before
      // resolving APP_AUTH_READY, so sync.js's first push already carries it.
      promotePendingProfile();
    }
    window.__appAccessToken = session ? session.access_token : null;
    if (!readyResolved) { readyResolved = true; resolveReady(); }
  }

  window.appSignOut = function () {
    // Clear Aptron-owned local state BEFORE the Supabase session actually
    // drops, so nothing from this account can be mistaken for "this
    // browser's data" if the next sign-in's reconcile is ever skipped
    // (e.g. a killed tab never reaching this handler at all).
    try { clearOnLogout(); } catch (e) {}
    try { supa.auth.signOut().finally(() => location.reload()); }
    catch (e) { location.reload(); }
  };

  // ── Gate + submit routing ──────────────────────────────────────────────────
  // Submission throttle: every attempt that reaches the network arms a 3s
  // cooldown; the button stays disabled until BOTH the request has settled
  // and the cooldown has elapsed, so hammering the button (or Enter) can't
  // fan requests out. Local validation failures skip the cooldown — they
  // fire no request.
  let busy = false;
  let cooldownUntil = 0;
  function endAttempt() {
    setTimeout(() => {
      busy = false;
      ui.setIdle();
    }, Math.max(0, cooldownUntil - Date.now()));
  }

  const ui = createGateController({
    avatarPresets: AVATAR_PRESETS,
    onSubmit: handleSubmit,
  });

  // GoTrue redirects a failed confirmation/magic link back here as a URL
  // hash (#error=...&error_code=otp_expired&...), never as a JS exception —
  // read it once on boot, scrub it from the URL, and surface it on the gate
  // instead of silently showing a plain sign-in form with no explanation.
  let authHashError = consumeAuthHashError();
  function consumeAuthHashError() {
    const hash = location.hash || '';
    if (hash.indexOf('error=') === -1) return null;
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const code = params.get('error_code');
    history.replaceState(null, '', location.pathname + location.search);
    if (code === 'otp_expired')
      return 'That confirmation link expired or was already used. Sign up again to get a new one.';
    return 'That link is invalid or has expired. Please try again.';
  }

  async function handleSubmit(raw, mode) {
    if (busy || Date.now() < cooldownUntil) return;
    ui.setNote('');
    const signup = mode === 'signup';
    const email = normalizeEmail(raw.email);
    const password = normalizePassword(raw.password);
    const fullName = normalizeFullName(raw.fullName);
    const username = normalizeUsername(raw.username);

    const errors = signup
      ? validateRegistration({ fullName, username, email, password })
      : validateLogin({ email, password });
    if (errors.length) { ui.showErrors(errors); return; }

    busy = true;
    cooldownUntil = Date.now() + 3000;
    ui.setBusy(signup ? 'Creating account…' : 'Signing in…');
    try {
      if (signup) {
        const res = await register(supa, {
          email, password, fullName, username, avatar: raw.avatar,
          redirectTo: window.location.origin,
        });
        if (!res.ok) ui.setNote(res.message);
        else if (res.needsConfirmation)
          ui.showSigninNotice('Check your email to confirm registration.');
        // With auto-confirm a session arrives → onAuthStateChange dismisses.
      } else {
        const res = await signIn(supa, { email, password });
        if (!res.ok) ui.setNote(res.message);
        // On success, onAuthStateChange(SIGNED_IN) fades the gate out + resolves.
      }
    } catch (e2) {
      ui.setNote((signup ? 'Sign-up' : 'Sign-in') + ' failed. Check your connection.');
    }
    endAttempt();
  }

  function showGate() {
    if (embedded) return;              // parent frame owns the gate
    ui.show();
    if (authHashError) { ui.setNote(authHashError); authHashError = null; }
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────
  supa.auth.onAuthStateChange((event, session) => {
    if (session) { ui.dismiss(); markReady(session); return; }
    window.__appAccessToken = null;
    // Session ended AFTER we were logged in (expiry / manual sign-out): the
    // page is showing user data, so reload straight to the gate. On the very
    // first no-session event we just present the gate instead of reloading.
    if (readyResolved) location.reload();
    else showGate();
  });

  // Belt-and-suspenders: resolve the initial state even if the listener above
  // is slow to fire (it normally emits INITIAL_SESSION on subscribe).
  supa.auth.getSession().then(({ data }) => {
    if (data && data.session) { ui.hide(); markReady(data.session); }
    else if (!embedded) showGate();
  }).catch(() => { if (!embedded) showGate(); });
}
