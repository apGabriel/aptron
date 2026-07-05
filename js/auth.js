// =============================================================
// Shared auth gate + single authenticated Supabase client.
//
// Load order (defer) on every page: supabase-js CDN → js/config.js →
// THIS FILE → sync.js / gym-*.js / index.js / topbar.js. Everything that
// talks to Supabase must reuse window.APP_SUPABASE (created here) so the
// user's JWT rides along; a second createClient() would fall back to the
// bare anon key and get denied by RLS.
//
// Contract for consumers:
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
(function () {
  'use strict';
  const URL = (window.APP_CONFIG || {}).SUPABASE_URL || '';
  const KEY = (window.APP_CONFIG || {}).SUPABASE_KEY || '';

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
  if (!window.supabase || !URL || !KEY ||
      URL.indexOf('PASTE-') === 0 || KEY.indexOf('PASTE-') === 0) {
    resolveReady();
    return;
  }

  const supa = window.supabase.createClient(URL, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'aptron-auth' },
  });
  window.APP_SUPABASE = supa;

  let readyResolved = false;
  function markReady(session) {
    window.__appAccessToken = session ? session.access_token : null;
    if (!readyResolved) { readyResolved = true; resolveReady(); }
  }

  window.appSignOut = function () {
    try { supa.auth.signOut().finally(() => location.reload()); }
    catch (e) { location.reload(); }
  };

  // ── Login overlay ──────────────────────────────────────────────────────────
  let gateEl = null;
  function buildGate() {
    if (gateEl) return gateEl;
    const style = document.createElement('style');
    style.textContent = `
.auth-gate {
  position: fixed; inset: 0; z-index: 100000;
  display: flex; align-items: center; justify-content: center;
  padding: max(20px, env(safe-area-inset-top)) 20px;
  background: #0a0a0b;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.auth-card {
  width: 100%; max-width: 360px;
  display: flex; flex-direction: column; gap: 14px;
  padding: 28px 24px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 16px;
}
.auth-title { color: #FAFAFA; font-size: 18px; font-weight: 700; margin: 0; }
.auth-sub { color: rgba(255,255,255,0.5); font-size: 13px; margin: -6px 0 4px; }
.auth-input {
  width: 100%; box-sizing: border-box;
  padding: 12px 14px; font-size: 15px; font-family: inherit;
  color: #FAFAFA; background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.10); border-radius: 12px;
  -webkit-appearance: none; outline: none;
}
.auth-input:focus { border-color: rgba(125,211,252,0.5); }
.auth-btn {
  padding: 12px 14px; font-size: 15px; font-weight: 700; font-family: inherit;
  color: #05121f; cursor: pointer; border: none; border-radius: 12px;
  background: linear-gradient(180deg, #7DD3FC, #6EE7B7);
  -webkit-tap-highlight-color: transparent;
}
.auth-btn:disabled { opacity: 0.6; cursor: default; }
.auth-err { color: #ff8a8a; font-size: 13px; min-height: 16px; margin: 0; }
`;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'auth-gate';
    wrap.innerHTML = `
<form class="auth-card" id="authForm" autocomplete="on">
  <h1 class="auth-title">Aptron</h1>
  <p class="auth-sub">Sign in to continue.</p>
  <input class="auth-input" id="authEmail" type="email" name="email"
         placeholder="Email" autocomplete="username" required>
  <input class="auth-input" id="authPass" type="password" name="password"
         placeholder="Password" autocomplete="current-password" required>
  <p class="auth-err" id="authErr" role="alert"></p>
  <button class="auth-btn" id="authBtn" type="submit">Sign in</button>
</form>`;
    gateEl = wrap;

    const form = wrap.querySelector('#authForm');
    const btn = wrap.querySelector('#authBtn');
    const err = wrap.querySelector('#authErr');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true; btn.textContent = 'Signing in…';
      const email = wrap.querySelector('#authEmail').value.trim();
      const password = wrap.querySelector('#authPass').value;
      try {
        const { error } = await supa.auth.signInWithPassword({ email, password });
        if (error) {
          err.textContent = error.message || 'Sign-in failed.';
          btn.disabled = false; btn.textContent = 'Sign in';
        }
        // On success, onAuthStateChange(SIGNED_IN) hides the gate + resolves.
      } catch (e2) {
        err.textContent = 'Sign-in failed. Check your connection.';
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });
    return wrap;
  }

  function showGate() {
    if (embedded) return;              // parent frame owns the gate
    const el = buildGate();
    if (!el.isConnected) (document.body || document.documentElement).appendChild(el);
    try { document.body && (document.body.style.overflow = 'hidden'); } catch (e) {}
    const email = el.querySelector('#authEmail');
    if (email && !email.value) setTimeout(() => email.focus(), 30);
  }
  function hideGate() {
    if (gateEl && gateEl.isConnected) gateEl.remove();
    try { document.body && (document.body.style.overflow = ''); } catch (e) {}
  }

  // ── Session lifecycle ────────────────────────────────────────────────────
  supa.auth.onAuthStateChange((event, session) => {
    if (session) { hideGate(); markReady(session); return; }
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
    if (data && data.session) { hideGate(); markReady(data.session); }
    else if (!embedded) showGate();
  }).catch(() => { if (!embedded) showGate(); });
})();
