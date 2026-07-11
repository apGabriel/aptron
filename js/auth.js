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
    // Styled to the Shenlong ecosystem (css/styles.css): deep-slate glass card,
    // gold (#d2bc8a / #956534) accents + gradient, the shenlong.png emblem orb,
    // and matching focus glow. Fades in on render, fades out on success.
    style.textContent = `
.auth-gate {
  position: fixed; inset: 0; z-index: 100000;
  display: flex; align-items: center; justify-content: center;
  padding: max(20px, env(safe-area-inset-top)) 20px;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
  background:
    radial-gradient(ellipse 70% 55% at 50% 6%, rgba(149,101,52,0.30) 0%, transparent 62%),
    radial-gradient(ellipse 55% 45% at 12% 100%, rgba(210,188,138,0.10) 0%, transparent 65%),
    #0d0d0e;
  opacity: 0;
  animation: authGateIn 0.5s ease forwards;
}
.auth-gate.is-leaving { animation: authGateOut 0.45s ease forwards; }
@keyframes authGateIn  { from { opacity: 0; } to { opacity: 1; } }
@keyframes authGateOut { from { opacity: 1; } to { opacity: 0; } }

.auth-card {
  position: relative;
  width: 100%; max-width: 372px;
  display: flex; flex-direction: column; gap: 15px;
  padding: 34px 26px 28px;
  background: linear-gradient(180deg, rgba(58,56,52,0.90) 0%, rgba(37,36,34,0.93) 100%);
  border: 1px solid rgba(210,188,138,0.16);
  border-radius: 20px;
  backdrop-filter: blur(26px) saturate(1.2);
  -webkit-backdrop-filter: blur(26px) saturate(1.2);
  box-shadow: 0 24px 70px rgba(0,0,0,0.62), 0 0 40px rgba(210,188,138,0.06),
              inset 0 1px 0 rgba(255,255,255,0.05);
  transform: translateY(8px) scale(0.985);
  animation: authCardIn 0.55s cubic-bezier(0.22,1,0.36,1) forwards;
}
@keyframes authCardIn { to { transform: translateY(0) scale(1); } }
.auth-gate.is-leaving .auth-card {
  transition: transform 0.4s ease, opacity 0.4s ease;
  transform: translateY(-6px) scale(0.97); opacity: 0;
}

.auth-orb {
  width: 56px; height: 56px; border-radius: 50%;
  align-self: center;
  display: flex; align-items: center; justify-content: center;
  color: #d2bc8a;
  background: radial-gradient(circle at 35% 30%, rgba(210,188,138,0.38), rgba(149,101,52,0.16));
  animation: authOrbPulse 3.6s ease-in-out infinite;
}
.auth-orb .auth-emblem {
  width: 46px; height: 46px; background: currentColor;
  -webkit-mask: url("img/shenlong.png") center / contain no-repeat;
          mask: url("img/shenlong.png") center / contain no-repeat;
}
@keyframes authOrbPulse {
  0%,100% { box-shadow: 0 0 14px rgba(210,188,138,0.18); }
  50%     { box-shadow: 0 0 28px rgba(210,188,138,0.44); }
}

.auth-title {
  align-self: center; margin: 0;
  font-size: 24px; font-weight: 700; letter-spacing: -0.02em;
  background: linear-gradient(180deg, #FFFFFF 0%, #d2bc8a 140%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.auth-sub {
  align-self: center; margin: -9px 0 6px;
  color: rgba(255,255,255,0.48); font-size: 12.5px; letter-spacing: 0.01em;
}

.auth-input {
  width: 100%; box-sizing: border-box;
  padding: 13px 15px; font-size: 15px; font-family: inherit;
  color: #FFFFFF; background: rgba(0,0,0,0.28);
  border: 1px solid rgba(210,188,138,0.16); border-radius: 13px;
  -webkit-appearance: none; outline: none;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
}
.auth-input::placeholder { color: rgba(255,255,255,0.34); }
.auth-input:focus {
  border-color: rgba(210,188,138,0.55);
  background: rgba(0,0,0,0.34);
  box-shadow: 0 0 0 3px rgba(210,188,138,0.12), 0 0 18px rgba(210,188,138,0.16);
}
.auth-input:-webkit-autofill {
  -webkit-text-fill-color: #fff;
  -webkit-box-shadow: 0 0 0 40px #2a2926 inset;
  caret-color: #fff;
}

.auth-btn {
  margin-top: 4px;
  padding: 13px 14px; font-size: 15px; font-weight: 700; font-family: inherit;
  color: #1a1408; cursor: pointer; border: none; border-radius: 13px;
  background: linear-gradient(180deg, #e6cf9c 0%, #d2bc8a 48%, #b8a06e 100%);
  box-shadow: 0 1px 0 rgba(255,255,255,0.35) inset, 0 8px 22px rgba(149,101,52,0.32);
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease, opacity 0.14s ease;
}
.auth-btn:hover:not(:disabled) {
  transform: translateY(-1px); filter: brightness(1.05);
  box-shadow: 0 1px 0 rgba(255,255,255,0.45) inset, 0 10px 26px rgba(149,101,52,0.42);
}
.auth-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.985); filter: brightness(0.97);
  box-shadow: 0 1px 0 rgba(255,255,255,0.30) inset, 0 5px 14px rgba(149,101,52,0.30);
}
.auth-btn:disabled { opacity: 0.62; cursor: default; }

.auth-err {
  color: #e98b7f; font-size: 12.5px; min-height: 16px; margin: 0;
  text-align: center; line-height: 1.35;
}
.auth-err.is-shake { animation: authErrShake 0.4s ease; }
@keyframes authErrShake {
  0%,100% { transform: translateX(0); }
  20% { transform: translateX(-5px); } 40% { transform: translateX(5px); }
  60% { transform: translateX(-3px); } 80% { transform: translateX(3px); }
}
.auth-err.is-ok { color: #d2bc8a; }

.auth-btn .auth-btn-label {
  display: inline-block;
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.auth-btn .auth-btn-label.is-swapping { opacity: 0; transform: translateY(3px); }

.auth-toggle {
  margin: 2px 0 0; text-align: center;
  font-size: 12.5px; color: rgba(255,255,255,0.42);
}
.auth-toggle button {
  background: none; border: none; padding: 0; margin: 0;
  font: inherit; color: inherit; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.auth-toggle button b {
  color: #d2bc8a; font-weight: 600;
  transition: color 0.15s ease;
}
.auth-toggle button:hover b { color: #e6cf9c; text-decoration: underline; text-underline-offset: 3px; }

@media (max-width: 400px) {
  .auth-card { padding: 30px 20px 24px; border-radius: 18px; }
  .auth-title { font-size: 22px; }
}
@media (prefers-reduced-motion: reduce) {
  .auth-gate, .auth-card, .auth-orb, .auth-err {
    animation: none !important; opacity: 1 !important; transform: none !important;
  }
  .auth-gate.is-leaving { opacity: 0; transition: opacity 0.2s; }
  .auth-btn .auth-btn-label { transition: none; }
}
`;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'auth-gate';
    // Static markup only — no interpolation, so nothing user-supplied is ever
    // parsed as HTML here.
    wrap.innerHTML = `
<form class="auth-card" id="authForm" autocomplete="on" novalidate>
  <div class="auth-orb" aria-hidden="true"><span class="auth-emblem"></span></div>
  <h1 class="auth-title">Aptron</h1>
  <p class="auth-sub">Summon your dashboard — sign in to continue.</p>
  <input class="auth-input" id="authEmail" type="email" name="email" placeholder="Email"
         autocomplete="username" inputmode="email" spellcheck="false"
         autocapitalize="off" autocorrect="off" maxlength="100" required>
  <input class="auth-input" id="authPass" type="password" name="password" placeholder="Password"
         autocomplete="current-password" maxlength="100" required>
  <p class="auth-err" id="authErr" role="alert" aria-live="polite"></p>
  <button class="auth-btn" id="authBtn" type="submit"><span class="auth-btn-label" id="authBtnLabel">Sign in</span></button>
  <p class="auth-toggle"><button type="button" id="authToggle"></button></p>
</form>`;
    gateEl = wrap;

    // ── Client-side hardening (defense-in-depth) ─────────────────────────────
    const MAX_LEN  = 100;                          // cap both fields
    // Strict shape check that also rejects <>"'\` and backslash, so nothing
    // that could ever read as markup or a quote-breaker survives — even though
    // every DOM write below goes through textContent (never innerHTML), which
    // is the actual escaping boundary.
    const EMAIL_RE = /^[^\s@<>"'`\\]+@[^\s@<>"'`\\]+\.[^\s@<>"'`\\]+$/;
    // Sign-up password policy — each rule checked separately so the inline
    // error names exactly what's missing. "Special" = any non-alphanumeric,
    // deliberately broader than a fixed symbol list so -, _, ~ etc. count.
    const PW_RULES = [
      { re: /.{8,}/,        label: '8+ characters' },
      { re: /[a-z]/,        label: 'a lowercase letter' },
      { re: /[A-Z]/,        label: 'an uppercase letter' },
      { re: /[0-9]/,        label: 'a number' },
      { re: /[^A-Za-z0-9]/, label: 'a special character' },
    ];
    // Anti-enumeration: every non-network auth failure collapses to ONE generic
    // string per mode. Raw GoTrue text is never echoed — "Email not confirmed"
    // or "User already registered" would confirm the account exists.
    function friendlyAuthError(error, signup) {
      const raw = (error && (error.message || error.error_description)) || '';
      const m = raw.toLowerCase();
      if (m.indexOf('rate limit') !== -1 || m.indexOf('too many') !== -1)
        return 'Too many attempts. Wait a moment and try again.';
      if (m.indexOf('failed to fetch') !== -1 || m.indexOf('network') !== -1)
        return 'Network error. Check your connection.';
      return signup ? 'Could not create the account. Please try again.'
                    : 'Invalid login credentials.';
    }

    const form = wrap.querySelector('#authForm');
    const btn = wrap.querySelector('#authBtn');
    const btnLabel = wrap.querySelector('#authBtnLabel');
    const err = wrap.querySelector('#authErr');
    const sub = wrap.querySelector('.auth-sub');
    const passEl = wrap.querySelector('#authPass');
    const toggle = wrap.querySelector('#authToggle');
    const reduceMotion = () =>
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function setNote(text, ok) {
      err.classList.remove('is-shake', 'is-ok');
      err.textContent = text;
      if (!text) return;
      if (ok) { err.classList.add('is-ok'); return; }
      void err.offsetWidth;  // restart the shake even when the message repeats
      err.classList.add('is-shake');
    }
    function swapBtnLabel(text) {
      if (btnLabel.textContent === text) return;
      if (reduceMotion()) { btnLabel.textContent = text; return; }
      btnLabel.classList.add('is-swapping');
      setTimeout(() => {
        btnLabel.textContent = text;
        btnLabel.classList.remove('is-swapping');
      }, 160);
    }

    // ── Dual mode: sign in ⇄ sign up ─────────────────────────────────────────
    let mode = 'signin';
    function idleLabel() { return mode === 'signup' ? 'Create Account' : 'Sign in'; }
    function setMode(next) {
      mode = next;
      const signup = mode === 'signup';
      sub.textContent = signup ? 'Create your account to get started.'
                               : 'Summon your dashboard — sign in to continue.';
      passEl.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
      // Static strings only — nothing user-supplied ever lands in this innerHTML.
      toggle.innerHTML = signup ? 'Already have an account? <b>Sign in</b>'
                                : 'Don&rsquo;t have an account? <b>Sign up</b>';
      if (!btn.disabled) swapBtnLabel(idleLabel());
      setNote('');
    }
    toggle.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
    setMode('signin');

    // ── Submission throttle ──────────────────────────────────────────────────
    // Every attempt that reaches the network arms a 3s cooldown; the button
    // stays disabled until BOTH the request has settled and the cooldown has
    // elapsed, so hammering the button (or Enter) can't fan requests out.
    // Local validation failures skip the cooldown — they fire no request.
    let busy = false;
    let cooldownUntil = 0;
    function endAttempt() {
      setTimeout(() => {
        busy = false;
        btn.disabled = false;
        swapBtnLabel(idleLabel());
      }, Math.max(0, cooldownUntil - Date.now()));
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy || Date.now() < cooldownUntil) return;
      setNote('');
      // Trim + length-cap the email; validate its shape before any network call.
      const email = (wrap.querySelector('#authEmail').value || '').trim().slice(0, MAX_LEN);
      // Passwords are length-capped but NOT trimmed — leading/trailing chars can
      // be significant, so trimming would silently alter a valid secret.
      const password = (passEl.value || '').slice(0, MAX_LEN);
      if (!EMAIL_RE.test(email)) { setNote('Enter a valid email address.'); return; }
      if (!password) { setNote('Enter your password.'); return; }
      const signup = mode === 'signup';
      if (signup) {
        const missing = PW_RULES.filter((r) => !r.re.test(password)).map((r) => r.label);
        if (missing.length) { setNote('Password needs ' + missing.join(', ') + '.'); return; }
      }

      busy = true;
      cooldownUntil = Date.now() + 3000;
      btn.disabled = true;
      swapBtnLabel(signup ? 'Creating account…' : 'Signing in…');
      try {
        if (signup) {
          const { data, error } = await supa.auth.signUp({ email, password });
          if (error) {
            setNote(friendlyAuthError(error, true));
          } else if (!data || !data.session) {
            // Email confirmation is on → no session yet. Supabase obfuscates
            // already-registered emails on signUp, so this notice is safe to
            // show unconditionally (no enumeration signal).
            passEl.value = '';
            setMode('signin');
            swapBtnLabel(idleLabel()); // setMode skips this while disabled
            setNote('Check your email to confirm registration.', true);
          }
          // With auto-confirm a session arrives → onAuthStateChange dismisses.
        } else {
          const { error } = await supa.auth.signInWithPassword({ email, password });
          if (error) setNote(friendlyAuthError(error, false));
          // On success, onAuthStateChange(SIGNED_IN) fades the gate out + resolves.
        }
      } catch (e2) {
        setNote((signup ? 'Sign-up' : 'Sign-in') + ' failed. Check your connection.');
      }
      endAttempt();
    });
    return wrap;
  }

  function showGate() {
    if (embedded) return;              // parent frame owns the gate
    const el = buildGate();
    el.classList.remove('is-leaving');
    if (!el.isConnected) (document.body || document.documentElement).appendChild(el);
    try { document.body && (document.body.style.overflow = 'hidden'); } catch (e) {}
    const email = el.querySelector('#authEmail');
    if (email && !email.value) setTimeout(() => email.focus(), 30);
  }
  function hideGate() {
    if (gateEl && gateEl.isConnected) gateEl.remove();
    if (gateEl) gateEl.classList.remove('is-leaving');
    try { document.body && (document.body.style.overflow = ''); } catch (e) {}
  }
  // Fade the gate out (revealing the dashboard) before removing it. Safe to call
  // when the gate was never shown (e.g. an already-authed load) — it just no-ops.
  function dismissGate() {
    if (!gateEl || !gateEl.isConnected) { hideGate(); return; }
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gateEl.classList.add('is-leaving');
    setTimeout(hideGate, reduce ? 200 : 460);
  }

  // ── Session lifecycle ────────────────────────────────────────────────────
  supa.auth.onAuthStateChange((event, session) => {
    if (session) { dismissGate(); markReady(session); return; }
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
