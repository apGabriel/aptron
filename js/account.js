// =============================================================================
// ACCOUNT & SETTINGS — Aptron-account panel (distinct from per-integration UI).
//
// Self-contained IIFE (no framework/build step, see CLAUDE.md). Wires the
// avatar trigger in the header (#acctBtn) and lazily builds a modal offering:
//   • profile picture (client-downscaled to 160px, stored locally + synced via
//     the goals app_state blob — no Storage bucket, no JWT bloat)
//   • display name  → localStorage + best-effort Supabase user_metadata
//   • email         → read-only, from the current session
//   • password      → supa.auth.updateUser({ password })
//   • Log out       → window.appSignOut()  (Supabase signOut + reload to gate)
//
// Profile picture + name persist in localStorage key `aptron_profile_v1`, which
// index.html registers as a synced prefix, so they ride the existing offline-
// first sync. Password/logout hide in local-only mode (no window.APP_SUPABASE).
// All dynamic values are written via textContent / .value — the injected markup
// is static, so nothing user-supplied is ever parsed as HTML.
// =============================================================================
(function () {
  'use strict';
  const btn = document.getElementById('acctBtn');
  if (!btn) return;                          // only present on index.html

  const PKEY = 'aptron_profile_v1';
  const AVATAR_PX = 160;                     // stored avatar edge (cover-cropped)
  const supa = window.APP_SUPABASE || null;  // null in local-only mode
  let currentEmail = '';
  let lastFocused = null;
  let modal = null;                          // built lazily on first open

  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';

  // ── profile store ───────────────────────────────────────────────────────────
  function loadProfile() {
    try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch (e) { return {}; }
  }
  function saveProfile(p) {
    try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) {}
    // Nudge the sync layer (sync.js mirrors this prefix into app_state).
    try { window.dispatchEvent(new Event('storage')); } catch (e) {}
  }

  function initialsFrom(name, email) {
    const src = (name || '').trim() || (email || '');
    if (!src) return '';
    const parts = src.replace(/@.*/, '').split(/[\s._+-]+/).filter(Boolean);
    const a = parts[0] ? parts[0][0] : '';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b || a).toUpperCase().slice(0, 2);
  }

  // Render the header trigger: photo → initials → gear.
  function renderTrigger() {
    const av = document.getElementById('acctAvatar');
    if (!av) return;
    const p = loadProfile();
    if (p.avatar) {
      av.innerHTML = '';
      const img = document.createElement('img');
      img.src = p.avatar; img.alt = '';
      av.appendChild(img);
      return;
    }
    const ini = initialsFrom(p.name, currentEmail);
    if (ini) {
      av.innerHTML = '';
      const s = document.createElement('span');
      s.className = 'aios-acct-initials';
      s.textContent = ini;
      av.appendChild(s);
      return;
    }
    av.innerHTML = GEAR_SVG;
  }

  // ── image downscale (cover-crop to a square, JPEG) ───────────────────────────
  function downscale(file, size, cb) {
    if (!file || !/^image\//.test(file.type)) { cb(null); return; }
    const reader = new FileReader();
    reader.onload = function () {
      const img = new Image();
      img.onload = function () {
        try {
          const c = document.createElement('canvas');
          c.width = size; c.height = size;
          const ctx = c.getContext('2d');
          const s = Math.min(img.width, img.height);
          const sx = (img.width - s) / 2, sy = (img.height - s) / 2;
          ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
          cb(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { cb(null); }
      };
      img.onerror = function () { cb(null); };
      img.src = reader.result;
    };
    reader.onerror = function () { cb(null); };
    reader.readAsDataURL(file);
  }

  // ── styles ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('acct-styles')) return;
    const s = document.createElement('style');
    s.id = 'acct-styles';
    s.textContent = `
.acct-bg {
  position: fixed; inset: 0; z-index: 99990;
  display: flex; align-items: center; justify-content: center;
  padding: max(20px, env(safe-area-inset-top)) 18px 20px;
  background: rgba(9,9,10,0.62);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  opacity: 0; pointer-events: none; transition: opacity .22s ease;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.acct-bg.is-open { opacity: 1; pointer-events: auto; }

.acct-modal {
  position: relative; width: 100%; max-width: 420px;
  max-height: min(92vh, 720px); overflow-y: auto;
  display: flex; flex-direction: column; gap: 18px;
  padding: 24px 22px 22px;
  background: linear-gradient(180deg, rgba(58,56,52,0.94) 0%, rgba(33,32,30,0.96) 100%);
  border: 1px solid rgba(210,188,138,0.18); border-radius: 20px;
  box-shadow: 0 24px 70px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.05);
  transform: translateY(10px) scale(0.985); transition: transform .28s cubic-bezier(0.22,1,0.36,1);
}
.acct-bg.is-open .acct-modal { transform: translateY(0) scale(1); }

.acct-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.acct-title {
  margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.01em;
  background: linear-gradient(180deg, #fff 0%, #d2bc8a 150%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.acct-x {
  flex: none; width: 32px; height: 32px; border-radius: 9px; cursor: pointer;
  display: grid; place-items: center; color: rgba(255,255,255,0.6);
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  transition: color .15s, border-color .15s, background .15s;
}
.acct-x:hover { color: #fff; border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); }
.acct-x svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }

.acct-sec { display: flex; flex-direction: column; gap: 11px; }
.acct-sec + .acct-sec { padding-top: 17px; border-top: 1px solid rgba(255,255,255,0.07); }
.acct-eyebrow {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(255,255,255,0.38);
}

.acct-avrow { display: flex; align-items: center; gap: 15px; }
.acct-avbig {
  flex: none; width: 68px; height: 68px; border-radius: 50%; overflow: hidden;
  display: grid; place-items: center; color: #d2bc8a;
  background: radial-gradient(circle at 50% 34%, rgba(230,207,156,0.16), transparent 70%),
              linear-gradient(180deg, rgba(230,207,156,0.10), rgba(149,101,52,0.05));
  box-shadow: 0 0 0 1px rgba(210,188,138,0.5) inset;
}
.acct-avbig img { width: 100%; height: 100%; object-fit: cover; display: block; }
.acct-avbig .aios-acct-initials { font-size: 22px; font-weight: 700; color: #d2bc8a; }
.acct-avbig svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.acct-avbtns { display: flex; flex-direction: column; gap: 7px; align-items: flex-start; }

.acct-field { display: flex; flex-direction: column; gap: 6px; }
.acct-label { font-size: 12px; color: rgba(255,255,255,0.5); font-weight: 550; }
.acct-input {
  width: 100%; box-sizing: border-box; padding: 11px 13px; font-size: 14.5px; font-family: inherit;
  color: #fff; background: rgba(0,0,0,0.26);
  border: 1px solid rgba(210,188,138,0.16); border-radius: 11px; outline: none; -webkit-appearance: none;
  transition: border-color .18s, box-shadow .18s, background .18s;
}
.acct-input::placeholder { color: rgba(255,255,255,0.32); }
.acct-input:focus { border-color: rgba(210,188,138,0.5); background: rgba(0,0,0,0.32); box-shadow: 0 0 0 3px rgba(210,188,138,0.12); }
.acct-input[readonly] { color: rgba(255,255,255,0.55); background: rgba(0,0,0,0.16); cursor: default; }
.acct-input:-webkit-autofill { -webkit-text-fill-color: #fff; -webkit-box-shadow: 0 0 0 40px #2a2926 inset; caret-color: #fff; }

.acct-btn {
  padding: 11px 15px; font-size: 13.5px; font-weight: 700; font-family: inherit;
  color: #1a1408; cursor: pointer; border: none; border-radius: 11px; white-space: nowrap;
  background: linear-gradient(180deg, #e6cf9c 0%, #d2bc8a 48%, #b8a06e 100%);
  box-shadow: 0 1px 0 rgba(255,255,255,0.35) inset, 0 6px 16px rgba(149,101,52,0.28);
  -webkit-tap-highlight-color: transparent;
  transition: transform .14s, filter .14s, opacity .14s;
}
.acct-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.05); }
.acct-btn:active:not(:disabled) { transform: translateY(0) scale(0.985); }
.acct-btn:disabled { opacity: 0.6; cursor: default; }
.acct-btn.small { padding: 8px 12px; font-size: 12.5px; }
.acct-btn.ghost {
  color: rgba(255,255,255,0.72); background: transparent;
  border: 1px solid rgba(255,255,255,0.14); box-shadow: none;
}
.acct-btn.ghost:hover:not(:disabled) { color: #fff; border-color: rgba(255,255,255,0.28); filter: none; }
.acct-btn.danger {
  color: #f0b3aa; background: transparent; border: 1px solid rgba(233,139,127,0.35); box-shadow: none;
}
.acct-btn.danger:hover:not(:disabled) { color: #fff; background: rgba(233,139,127,0.14); border-color: rgba(233,139,127,0.6); filter: none; }

.acct-row2 { display: flex; gap: 10px; align-items: flex-end; }
.acct-row2 .acct-field { flex: 1 1 auto; }
.acct-msg { font-size: 12px; min-height: 15px; margin: -2px 0 0; line-height: 1.35; }
.acct-msg.ok { color: #6fcf97; }
.acct-msg.err { color: #e98b7f; }
.acct-hint { font-size: 11px; color: rgba(255,255,255,0.32); line-height: 1.4; margin: 0; }
.acct-foot { display: flex; justify-content: flex-end; }

/* ── mobile: bottom drawer ───────────────────────────────────────────────── */
@media (max-width: 560px) {
  .acct-bg { align-items: flex-end; padding: 0; }
  .acct-modal {
    max-width: none; max-height: 90vh; border-radius: 20px 20px 0 0;
    padding-bottom: max(22px, env(safe-area-inset-bottom));
    transform: translateY(100%);
  }
  .acct-bg.is-open .acct-modal { transform: translateY(0); }
  .acct-avrow { gap: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  .acct-bg, .acct-modal { transition: opacity .15s ease !important; transform: none !important; }
}`;
    document.head.appendChild(s);
  }

  // ── modal build (once) ──────────────────────────────────────────────────────
  function build() {
    if (modal) return modal;
    injectStyles();
    const authControls = supa ? '' : ' hidden';
    const bg = document.createElement('div');
    bg.className = 'acct-bg';
    bg.setAttribute('role', 'dialog');
    bg.setAttribute('aria-modal', 'true');
    bg.setAttribute('aria-label', 'Account and settings');
    bg.innerHTML = `
<div class="acct-modal" role="document">
  <div class="acct-head">
    <h2 class="acct-title">Account</h2>
    <button class="acct-x" id="acctClose" type="button" aria-label="Close">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  </div>

  <div class="acct-sec">
    <span class="acct-eyebrow">Profile</span>
    <div class="acct-avrow">
      <span class="acct-avbig" id="acctAvBig" aria-hidden="true"></span>
      <div class="acct-avbtns">
        <button class="acct-btn small" id="acctPhotoBtn" type="button">Change photo</button>
        <button class="acct-btn ghost small" id="acctPhotoRemove" type="button">Remove</button>
      </div>
      <input type="file" id="acctFile" accept="image/*" hidden>
    </div>
    <div class="acct-field">
      <label class="acct-label" for="acctName">Display name</label>
      <input class="acct-input" id="acctName" type="text" maxlength="60" placeholder="Your name"
             autocomplete="name" spellcheck="false">
    </div>
    <div class="acct-field">
      <label class="acct-label" for="acctEmail">Email</label>
      <input class="acct-input" id="acctEmail" type="email" readonly tabindex="-1">
    </div>
    <p class="acct-msg" id="acctProfMsg" role="status" aria-live="polite"></p>
    <div class="acct-foot">
      <button class="acct-btn" id="acctSaveProfile" type="button">Save profile</button>
    </div>
  </div>

  <div class="acct-sec"${authControls}>
    <span class="acct-eyebrow">Password</span>
    <div class="acct-field">
      <label class="acct-label" for="acctNewPass">New password</label>
      <input class="acct-input" id="acctNewPass" type="password" maxlength="100"
             placeholder="At least 8 characters" autocomplete="new-password">
    </div>
    <div class="acct-field">
      <label class="acct-label" for="acctConfirmPass">Confirm new password</label>
      <input class="acct-input" id="acctConfirmPass" type="password" maxlength="100"
             autocomplete="new-password">
    </div>
    <p class="acct-msg" id="acctPassMsg" role="status" aria-live="polite"></p>
    <div class="acct-foot">
      <button class="acct-btn" id="acctUpdatePass" type="button">Update password</button>
    </div>
  </div>

  <div class="acct-sec"${authControls}>
    <span class="acct-eyebrow">Session</span>
    <p class="acct-hint">Signing out clears your session on this device and returns you to the login screen.</p>
    <button class="acct-btn danger" id="acctLogout" type="button">Log out</button>
  </div>
</div>`;
    document.body.appendChild(bg);
    modal = bg;
    wire(bg);
    return bg;
  }

  // ── modal wiring ────────────────────────────────────────────────────────────
  function wire(bg) {
    const nameEl = bg.querySelector('#acctName');
    const emailEl = bg.querySelector('#acctEmail');
    const avBig = bg.querySelector('#acctAvBig');
    const fileEl = bg.querySelector('#acctFile');
    const profMsg = bg.querySelector('#acctProfMsg');
    const passMsg = bg.querySelector('#acctPassMsg');
    const newPass = bg.querySelector('#acctNewPass');
    const confPass = bg.querySelector('#acctConfirmPass');

    function setMsg(el, text, kind) { el.textContent = text || ''; el.className = 'acct-msg' + (kind ? ' ' + kind : ''); }
    function friendly(e) {
      const raw = (e && (e.message || e.error_description)) || '';
      const m = raw.toLowerCase();
      if (m.indexOf('should be different') !== -1) return 'That’s already your password.';
      if (m.indexOf('weak') !== -1 || m.indexOf('at least') !== -1) return 'Password is too weak — try a longer one.';
      if (m.indexOf('network') !== -1 || m.indexOf('fetch') !== -1) return 'Network error — check your connection.';
      return raw ? raw.slice(0, 140) : 'Something went wrong — try again.';
    }

    // Render the big preview from the current profile.
    function renderBig() {
      const p = loadProfile();
      if (p.avatar) { avBig.innerHTML = ''; const img = document.createElement('img'); img.src = p.avatar; img.alt = ''; avBig.appendChild(img); return; }
      const ini = initialsFrom(nameEl.value, currentEmail);
      if (ini) { avBig.innerHTML = ''; const sp = document.createElement('span'); sp.className = 'aios-acct-initials'; sp.textContent = ini; avBig.appendChild(sp); return; }
      avBig.innerHTML = GEAR_SVG;
    }
    bg._renderBig = renderBig;

    bg.querySelector('#acctPhotoBtn').addEventListener('click', () => fileEl.click());
    fileEl.addEventListener('change', () => {
      const f = fileEl.files && fileEl.files[0];
      fileEl.value = '';                       // allow re-picking the same file
      if (!f) return;
      if (f.size > 12 * 1024 * 1024) { setMsg(profMsg, 'That image is too large (max 12 MB).', 'err'); return; }
      setMsg(profMsg, 'Processing photo…', '');
      downscale(f, AVATAR_PX, (dataUrl) => {
        if (!dataUrl) { setMsg(profMsg, 'Couldn’t read that image — try another.', 'err'); return; }
        const p = loadProfile(); p.avatar = dataUrl; saveProfile(p);
        renderBig(); renderTrigger();
        setMsg(profMsg, 'Photo updated.', 'ok');
      });
    });
    bg.querySelector('#acctPhotoRemove').addEventListener('click', () => {
      const p = loadProfile();
      if (!p.avatar) { setMsg(profMsg, 'No photo to remove.', ''); return; }
      delete p.avatar; saveProfile(p);
      renderBig(); renderTrigger();
      setMsg(profMsg, 'Photo removed.', 'ok');
    });

    bg.querySelector('#acctSaveProfile').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      const name = (nameEl.value || '').trim().slice(0, 60);
      const p = loadProfile(); p.name = name; saveProfile(p);
      renderTrigger(); renderBig();
      setMsg(profMsg, 'Saved.', 'ok');
      if (supa) {
        b.disabled = true;
        try { await supa.auth.updateUser({ data: { display_name: name } }); }
        catch (e2) { /* local save already succeeded; metadata is best-effort */ }
        b.disabled = false;
      }
    });

    if (supa) {
      bg.querySelector('#acctUpdatePass').addEventListener('click', async (e) => {
        const b = e.currentTarget;
        const np = newPass.value || '', cp = confPass.value || '';
        if (np.length < 8) { setMsg(passMsg, 'Use at least 8 characters.', 'err'); return; }
        if (np !== cp) { setMsg(passMsg, 'Passwords don’t match.', 'err'); return; }
        b.disabled = true; setMsg(passMsg, 'Updating…', '');
        try {
          const { error } = await supa.auth.updateUser({ password: np });
          if (error) throw error;
          newPass.value = ''; confPass.value = '';
          setMsg(passMsg, 'Password updated.', 'ok');
        } catch (e2) { setMsg(passMsg, friendly(e2), 'err'); }
        b.disabled = false;
      });
      bg.querySelector('#acctLogout').addEventListener('click', () => {
        if (typeof window.appSignOut === 'function') window.appSignOut();
        else location.reload();
      });
    }

    // keep initials preview live as the name is typed (pre-save)
    nameEl.addEventListener('input', () => { if (!loadProfile().avatar) renderBig(); });

    // close affordances
    bg.querySelector('#acctClose').addEventListener('click', close);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    bg._populate = function () {
      const p = loadProfile();
      nameEl.value = p.name || '';
      emailEl.value = currentEmail || (supa ? '—' : 'Local mode');
      setMsg(profMsg, '', ''); setMsg(passMsg, '', '');
      if (newPass) newPass.value = ''; if (confPass) confPass.value = '';
      renderBig();
    };
  }

  // ── open / close ────────────────────────────────────────────────────────────
  function onKey(e) { if (e.key === 'Escape') close(); }
  function open() {
    const bg = build();
    bg._populate();
    lastFocused = document.activeElement;
    // reveal on next frame so the CSS transition runs from the hidden state
    requestAnimationFrame(() => bg.classList.add('is-open'));
    try { document.body.style.overflow = 'hidden'; } catch (e) {}
    document.addEventListener('keydown', onKey);
    const first = bg.querySelector('#acctName');
    if (first) setTimeout(() => first.focus(), 60);
  }
  function close() {
    if (!modal) return;
    modal.classList.remove('is-open');
    document.removeEventListener('keydown', onKey);
    try { document.body.style.overflow = ''; } catch (e) {}
    if (lastFocused && lastFocused.focus) { try { lastFocused.focus(); } catch (e) {} }
    else btn.focus();
  }

  btn.addEventListener('click', open);

  // ── boot: learn the account email, then paint the trigger ────────────────────
  renderTrigger();                             // immediate paint (photo/initials/gear)
  (async function () {
    if (!supa) return;
    try {
      await (window.APP_AUTH_READY || Promise.resolve());
      const { data } = await supa.auth.getUser();
      const u = data && data.user;
      if (u) {
        currentEmail = u.email || '';
        // Adopt a Supabase-stored display name only if we have none locally.
        const p = loadProfile();
        const metaName = u.user_metadata && u.user_metadata.display_name;
        if (!p.name && metaName) { p.name = metaName; saveProfile(p); }
        renderTrigger();
        if (modal && modal.classList.contains('is-open')) modal._populate();
      }
    } catch (e) {}
  })();

  // Re-render the trigger when a sync applies a profile change from another device.
  window.addEventListener('storage', function (e) {
    if (!e || !e.key || e.key === PKEY) renderTrigger();
  });

  window.AptAccount = { open, close, renderTrigger };
})();
