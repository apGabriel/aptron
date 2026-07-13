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

const CFG_URL = (window.APP_CONFIG || {}).SUPABASE_URL || '';
const CFG_KEY = (window.APP_CONFIG || {}).SUPABASE_KEY || '';

// po-water.html runs inside an iframe on health.html. It shares this origin's
// localStorage, so it sees the same persisted session — but the PARENT owns
// the visible login gate. Embedded frames never draw their own overlay.
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
  const supa = window.supabase.createClient(CFG_URL, CFG_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'aptron-auth' },
  });
  window.APP_SUPABASE = supa;

  let readyResolved = false;
  function markReady(session) {
    // Promote any pending signup profile into aptron_profile_v1 before
    // resolving APP_AUTH_READY, so sync.js's first push already carries it.
    if (session) promotePendingProfile();
    window.__appAccessToken = session ? session.access_token : null;
    if (!readyResolved) { readyResolved = true; resolveReady(); }
  }

  window.appSignOut = function () {
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
        const res = await register(supa, { email, password, fullName, username, avatar: raw.avatar });
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
