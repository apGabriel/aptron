// =============================================================
// Auth gate UI — DOM only. Builds the overlay lazily, handles the
// sign-in ⇄ sign-up layout shift inside the one card (seamless
// transition, same session-memory'd form), the live initials
// avatar preview, feedback chips + invalid rings, and the
// show/hide/dismiss animations. All validation and every network
// call live in the services; this module reports raw field values
// to the orchestrator via onSubmit and renders whatever it's told.
//
// XSS posture (unchanged): the only innerHTML writes are static
// string literals; every user-influenced write goes through
// textContent.
// =============================================================

const GATE_CSS = `
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

.auth-input.is-invalid {
  border-color: rgba(233,139,127,0.60);
  box-shadow: 0 0 0 3px rgba(233,139,127,0.10);
}

.auth-field { display: flex; flex-direction: column; gap: 6px; }
.auth-label {
  font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em;
  color: rgba(255,255,255,0.55);
}
.auth-label i { font-style: normal; font-weight: 400; color: rgba(255,255,255,0.32); }

/* Sign-up-only rows: hidden while signing in so the sign-in card stays the
   minimal two-field layout; revealed (with the gate's fade) in signup mode. */
.auth-su { display: none; }
.auth-card.is-signup .auth-su { display: flex; animation: authGateIn 0.3s ease; }
span.auth-label.auth-su, label.auth-label.auth-su { display: none; }
.auth-card.is-signup label.auth-label.auth-su,
.auth-card.is-signup span.auth-label.auth-su { display: block; }

.auth-avatars { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.auth-av {
  width: 46px; height: 46px; border-radius: 50%; padding: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; background: rgba(0,0,0,0.28);
  border: 2px solid rgba(210,188,138,0.16);
  color: #d2bc8a; font: 700 15px/1 inherit; letter-spacing: 0.02em;
  -webkit-tap-highlight-color: transparent;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
.auth-av:hover { transform: translateY(-1px); border-color: rgba(210,188,138,0.40); }
.auth-av.is-active {
  border-color: #d2bc8a;
  box-shadow: 0 0 0 3px rgba(210,188,138,0.18), 0 0 14px rgba(210,188,138,0.22);
}
.auth-av img { width: 100%; height: 100%; display: block; object-fit: cover; }

.auth-err {
  min-height: 16px; margin: 0;
  display: flex; flex-wrap: wrap; gap: 6px; justify-content: center;
}
.auth-chip {
  font-size: 11.5px; line-height: 1.3; padding: 4px 11px; border-radius: 999px;
  color: #e98b7f; background: rgba(233,139,127,0.10);
  border: 1px solid rgba(233,139,127,0.28);
}
.auth-err.is-ok .auth-chip {
  color: #d2bc8a; background: rgba(210,188,138,0.10);
  border-color: rgba(210,188,138,0.30);
}
.auth-err.is-shake { animation: authErrShake 0.4s ease; }
@keyframes authErrShake {
  0%,100% { transform: translateX(0); }
  20% { transform: translateX(-5px); } 40% { transform: translateX(5px); }
  60% { transform: translateX(-3px); } 80% { transform: translateX(3px); }
}

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

// Static markup only — no interpolation, so nothing user-supplied is ever
// parsed as HTML here.
const GATE_HTML = `
<form class="auth-card" id="authForm" autocomplete="on" novalidate>
  <div class="auth-orb" aria-hidden="true"><span class="auth-emblem"></span></div>
  <h1 class="auth-title">Aptron</h1>
  <p class="auth-sub">Summon your dashboard — sign in to continue.</p>
  <div class="auth-su auth-field">
    <label class="auth-label" for="authName">Full name</label>
    <input class="auth-input" id="authName" type="text" name="name" placeholder="Your name"
           autocomplete="name" spellcheck="false" maxlength="60">
  </div>
  <div class="auth-su auth-field">
    <label class="auth-label" for="authUser">Username <i>&mdash; optional</i></label>
    <input class="auth-input" id="authUser" type="text" name="username" placeholder="username"
           autocomplete="nickname" spellcheck="false" autocapitalize="off" autocorrect="off" maxlength="24">
  </div>
  <div class="auth-field">
    <label class="auth-label auth-su" for="authEmail">Email</label>
    <input class="auth-input" id="authEmail" type="email" name="email" placeholder="Email"
           autocomplete="username" inputmode="email" spellcheck="false"
           autocapitalize="off" autocorrect="off" maxlength="100" required>
  </div>
  <div class="auth-field">
    <label class="auth-label auth-su" for="authPass">Password</label>
    <input class="auth-input" id="authPass" type="password" name="password" placeholder="Password"
           autocomplete="current-password" maxlength="100" required>
  </div>
  <div class="auth-su auth-field">
    <span class="auth-label" id="authAvLabel">Avatar</span>
    <div class="auth-avatars" id="authAvatars" role="radiogroup" aria-labelledby="authAvLabel"></div>
  </div>
  <p class="auth-err" id="authErr" role="alert" aria-live="polite"></p>
  <button class="auth-btn" id="authBtn" type="submit"><span class="auth-btn-label" id="authBtnLabel">Sign in</span></button>
  <p class="auth-toggle"><button type="button" id="authToggle"></button></p>
</form>`;

// Orchestrator-facing controller. `avatarPresets` = data-URI list from
// register_service; `onSubmit(rawValues, mode)` receives untouched field
// values — normalization/validation belong to the services.
export function createGateController({ avatarPresets, onSubmit }) {
  let root = null;
  let refs = null;
  let mode = 'signin';
  let chosenAvatar = null;   // null → no p.avatar → account.js paints initials

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Styled to the Shenlong ecosystem (css/styles.css): deep-slate glass card,
  // gold (#d2bc8a / #956534) accents + gradient, the shenlong.png emblem orb,
  // and matching focus glow. Fades in on render, fades out on success.
  function build() {
    if (root) return;
    const style = document.createElement('style');
    style.textContent = GATE_CSS;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'auth-gate';
    wrap.innerHTML = GATE_HTML;
    root = wrap;

    refs = {
      form: wrap.querySelector('#authForm'),
      btn: wrap.querySelector('#authBtn'),
      btnLabel: wrap.querySelector('#authBtnLabel'),
      err: wrap.querySelector('#authErr'),
      sub: wrap.querySelector('.auth-sub'),
      toggle: wrap.querySelector('#authToggle'),
      avWrap: wrap.querySelector('#authAvatars'),
      // field elements keyed by the service validators' `field` names
      name: wrap.querySelector('#authName'),
      username: wrap.querySelector('#authUser'),
      email: wrap.querySelector('#authEmail'),
      password: wrap.querySelector('#authPass'),
    };

    // A field's invalid ring clears the moment the user edits it.
    refs.form.addEventListener('input', (e) => {
      const el = e.target;
      if (el && el.classList) el.classList.remove('is-invalid');
    });

    // ── Avatar picker: "initials" (live from the name field) + presets ──────
    const iniBtn = document.createElement('button');
    iniBtn.type = 'button';
    iniBtn.className = 'auth-av is-active';
    iniBtn.setAttribute('aria-label', 'Use my initials');
    iniBtn.title = 'Your initials';
    refs.avWrap.appendChild(iniBtn);
    function paintInitials() {
      const src = (refs.name.value || '').trim();
      const parts = src.split(/\s+/).filter(Boolean);
      iniBtn.textContent = parts.length
        ? parts.slice(0, 2).map((w) => w[0]).join('').toUpperCase()
        : '∙';
    }
    paintInitials();
    refs.name.addEventListener('input', paintInitials);
    (avatarPresets || []).forEach((uri, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'auth-av';
      b.setAttribute('aria-label', 'Avatar ' + (i + 1));
      const img = document.createElement('img');
      img.src = uri; img.alt = '';
      b.appendChild(img);
      b.addEventListener('click', () => {
        chosenAvatar = uri;
        refs.avWrap.querySelectorAll('.auth-av').forEach((x) => x.classList.toggle('is-active', x === b));
      });
      refs.avWrap.appendChild(b);
    });
    iniBtn.addEventListener('click', () => {
      chosenAvatar = null;
      refs.avWrap.querySelectorAll('.auth-av').forEach((x) => x.classList.toggle('is-active', x === iniBtn));
    });

    refs.toggle.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
    setMode('signin');

    refs.form.addEventListener('submit', (e) => {
      e.preventDefault();
      onSubmit({
        email: refs.email.value,
        password: refs.password.value,
        fullName: refs.name.value,
        username: refs.username.value,
        avatar: chosenAvatar,
      }, mode);
    });
  }

  // Feedback chips: one pill per issue, all via textContent (never markup).
  function setChips(list, ok) {
    const err = refs.err;
    err.classList.remove('is-shake', 'is-ok');
    err.textContent = '';
    refs.form.querySelectorAll('.auth-input.is-invalid')
        .forEach((el) => el.classList.remove('is-invalid'));
    (list || []).forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'auth-chip';
      chip.textContent = t;
      err.appendChild(chip);
    });
    if (!list || !list.length) return;
    if (ok) { err.classList.add('is-ok'); return; }
    void err.offsetWidth;  // restart the shake even when the message repeats
    err.classList.add('is-shake');
  }
  function setNote(text, ok) { setChips(text ? [text] : [], ok); }

  // [{ field, message }] from the services → chips + rings on the offenders
  // (setChips resets every ring, so mark them after it runs).
  function showErrors(errors) {
    setChips(errors.map((e) => e.message));
    errors.forEach((e) => {
      const el = refs[e.field];
      if (el && el.classList) el.classList.add('is-invalid');
    });
  }

  function swapBtnLabel(text) {
    if (refs.btnLabel.textContent === text) return;
    if (reduceMotion()) { refs.btnLabel.textContent = text; return; }
    refs.btnLabel.classList.add('is-swapping');
    setTimeout(() => {
      refs.btnLabel.textContent = text;
      refs.btnLabel.classList.remove('is-swapping');
    }, 160);
  }

  // ── Dual mode: sign in ⇄ sign up (one card, layout shift only) ────────────
  function idleLabel() { return mode === 'signup' ? 'Create Account' : 'Sign in'; }
  function setMode(next) {
    mode = next;
    const signup = mode === 'signup';
    refs.form.classList.toggle('is-signup', signup);
    refs.sub.textContent = signup ? 'Create your account to get started.'
                                  : 'Summon your dashboard — sign in to continue.';
    refs.password.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    if (signup && refs.form.isConnected) setTimeout(() => refs.name.focus(), 30);
    // Static strings only — nothing user-supplied ever lands in this innerHTML.
    refs.toggle.innerHTML = signup ? 'Already have an account? <b>Sign in</b>'
                                   : 'Don&rsquo;t have an account? <b>Sign up</b>';
    if (!refs.btn.disabled) swapBtnLabel(idleLabel());
    setNote('');
  }

  function setBusy(label) {
    refs.btn.disabled = true;
    swapBtnLabel(label);
  }
  function setIdle() {
    refs.btn.disabled = false;
    swapBtnLabel(idleLabel());
  }
  // Post-signup, confirmation-pending: drop back to sign-in with an ok note.
  function showSigninNotice(msg) {
    refs.password.value = '';
    setMode('signin');
    swapBtnLabel(idleLabel()); // setMode skips this while the button is disabled
    setNote(msg, true);
  }

  function show() {
    build();
    root.classList.remove('is-leaving');
    if (!root.isConnected) (document.body || document.documentElement).appendChild(root);
    try { document.body && (document.body.style.overflow = 'hidden'); } catch (e) {}
    if (refs.email && !refs.email.value) setTimeout(() => refs.email.focus(), 30);
  }
  function hide() {
    if (root && root.isConnected) root.remove();
    if (root) root.classList.remove('is-leaving');
    try { document.body && (document.body.style.overflow = ''); } catch (e) {}
  }
  // Fade the gate out (revealing the dashboard) before removing it. Safe to
  // call when the gate was never shown (already-authed load) — it no-ops.
  function dismiss() {
    if (!root || !root.isConnected) { hide(); return; }
    root.classList.add('is-leaving');
    setTimeout(hide, reduceMotion() ? 200 : 460);
  }

  return { show, hide, dismiss, setNote, showErrors, setBusy, setIdle, showSigninNotice };
}
