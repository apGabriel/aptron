// =============================================================================
// ACCOUNT & SETTINGS — Aptron-account dashboard (sidebar nav + content panes).
//
// Self-contained IIFE (no framework/build step, see CLAUDE.md). Wires the
// avatar trigger in the header (#acctBtn) and lazily builds a two-column modal:
//   • Sidebar nav (desktop) / pill tabs (mobile): Profile · Security ·
//     Preferences · Cloud & Data Sync, plus an isolated Log out.
//   • Content panes with premium UX: avatar upload, verified-member badge,
//     live password-strength meter, functional theme cards, and a real
//     cloud/sync status widget.
//
// DATA MANAGEMENT (unchanged from the prior version):
//   • profile photo — client-downscaled to 160px, base64 in localStorage
//     (`aptron_profile_v1`, a synced prefix) so it rides the offline-first sync.
//   • display name  — localStorage + best-effort Supabase user_metadata.
//   • password      — supa.auth.updateUser({ password }).
//   • Log out       — window.appSignOut().
//   Password/logout hide in local-only mode (no window.APP_SUPABASE). Dynamic
//   values are written via textContent / .value; injected markup is static.
// =============================================================================
(function () {
  'use strict';
  const btn = document.getElementById('acctBtn');
  if (!btn) return;                          // only present on index.html

  const PKEY = 'aptron_profile_v1';
  const AVATAR_PX = 160;                     // stored avatar edge (cover-cropped)
  const SYNC_PREFIXES = ['cal_done:', 'cal_manual:', 'quicknotes_v1', 'aptron_profile_v1'];
  const STORAGE_BUDGET = 512 * 1024;         // soft budget for the synced blob (bytes)
  const THEMES = [
    { id: 'dark',     name: 'Aptron Dark',   hint: 'The signature slate + gold.',   sw: ['#101010', '#3e3e3e', '#d2bc8a'] },
    { id: 'obsidian', name: 'Pure Obsidian', hint: 'Near-black, muted accents.',    sw: ['#050506', '#1c1c1e', '#c3ad7e'] },
    { id: 'gold',     name: 'Shenlong Gold', hint: 'Brighter aura, richer gold.',   sw: ['#121011', '#3e3a33', '#e8d3a2'] },
  ];

  const supa = window.APP_SUPABASE || null;  // null in local-only mode
  let currentEmail = '';
  let emailVerified = null;                  // true/false/null(unknown)
  let lastFocused = null;
  let modal = null;                          // built lazily on first open
  let activePane = 'profile';

  // ── icons ───────────────────────────────────────────────────────────────────
  const ICON = {
    gear:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    user:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    lock:  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13.5" cy="6.5" r="2.3"/><circle cx="17.5" cy="10.5" r="2.3"/><circle cx="8.5" cy="7.5" r="2.3"/><circle cx="6.5" cy="12.5" r="2.3"/><path d="M12 22a10 10 0 1 1 0-20 8 8 0 0 1 8 8 4 4 0 0 1-4 4h-1.8a2 2 0 0 0-1.5 3.3A1.9 1.9 0 0 1 12 22z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 1 0-1.6-8.7A6 6 0 1 0 5.9 15"/><path d="M7 19h10.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    x:     '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    logout:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
    refresh:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  };

  // ── profile store ───────────────────────────────────────────────────────────
  function loadProfile() {
    try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch (e) { return {}; }
  }
  function saveProfile(p) {
    try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) {}
    try { window.dispatchEvent(new Event('storage')); } catch (e) {}  // nudge sync.js
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
      av.innerHTML = ''; const img = document.createElement('img');
      img.src = p.avatar; img.alt = ''; av.appendChild(img); return;
    }
    const ini = initialsFrom(p.name, currentEmail);
    if (ini) {
      av.innerHTML = ''; const s = document.createElement('span');
      s.className = 'aios-acct-initials'; s.textContent = ini; av.appendChild(s); return;
    }
    av.innerHTML = ICON.gear;
  }

  // ── theme ─────────────────────────────────────────────────────────────────
  function applyTheme(t) {
    const el = document.documentElement;
    if (!t || t === 'dark') el.removeAttribute('data-apt-theme');
    else el.setAttribute('data-apt-theme', t);
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

  // ── password strength (length + character variety) ───────────────────────────
  function pwStrength(pw) {
    if (!pw) return { score: 0, label: '' };
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    s = Math.min(s, 4);
    return { score: s, label: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][s] };
  }

  // ── real sync/storage signals for the Cloud pane ─────────────────────────────
  function syncedBytes() {
    let items = 0, bytes = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        let hit = false;
        for (let j = 0; j < SYNC_PREFIXES.length; j++) { if (k.indexOf(SYNC_PREFIXES[j]) === 0) { hit = true; break; } }
        if (!hit) continue;
        const v = localStorage.getItem(k) || '';
        items++; bytes += (k.length + v.length) * 2;      // ~UTF-16 bytes
      }
    } catch (e) {}
    return { items: items, bytes: bytes };
  }
  function ago(ts) {
    if (!ts) return 'not yet this session';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }
  function fmtKB(b) { return b < 1024 ? b + ' B' : (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB'; }

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
  /* Gold accent, sourced from the page's --accent token so it tracks the theme
     the user picks in the Preferences pane. #d2bc8a fallback = the historic gold,
     so appearance is unchanged if --accent is ever absent. */
  --acct-accent: var(--accent, #d2bc8a);
  --acct-line: color-mix(in srgb, var(--acct-accent) 18%, transparent);
  --acct-line-soft: color-mix(in srgb, var(--acct-accent) 14%, transparent);
  --acct-bar: color-mix(in srgb, var(--acct-accent) 48%, transparent);
  position: relative; width: 100%; max-width: 860px; height: min(88vh, 600px);
  display: flex; overflow: hidden;
  background: linear-gradient(180deg, rgba(62,62,62,0.88) 0%, rgba(33,32,30,0.94) 100%);
  border: 1px solid var(--acct-line); border-radius: 20px;
  backdrop-filter: blur(26px) saturate(1.2); -webkit-backdrop-filter: blur(26px) saturate(1.2);
  box-shadow: 0 24px 70px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.05);
  transform: translateY(10px) scale(0.985); transition: transform .28s cubic-bezier(0.22,1,0.36,1);
}
.acct-bg.is-open .acct-modal { transform: translateY(0) scale(1); }

/* ── sidebar ──────────────────────────────────────────────────────────────── */
.acct-nav {
  flex: none; width: 212px; display: flex; flex-direction: column; gap: 4px;
  padding: 20px 14px; background: rgba(0,0,0,0.16);
  border-right: 1px solid var(--acct-line-soft);
}
.acct-brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 14px; }
.acct-brand-av {
  width: 34px; height: 34px; border-radius: 50%; flex: none; overflow: hidden;
  display: grid; place-items: center; color: #d2bc8a;
  background: radial-gradient(circle at 50% 34%, rgba(230,207,156,0.18), transparent 70%);
  box-shadow: 0 0 0 1px rgba(210,188,138,0.45) inset;
}
.acct-brand-av img { width: 100%; height: 100%; object-fit: cover; }
.acct-brand-av svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.acct-brand-av .aios-acct-initials { font-size: 13px; font-weight: 700; color: #d2bc8a; }
.acct-brand-name { min-width: 0; }
.acct-brand-name b { display: block; font-size: 13px; font-weight: 650; color: #efe7d3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acct-brand-name span { font-size: 11px; color: rgba(255,255,255,0.4); }

.acct-navlist { display: flex; flex-direction: column; gap: 3px; }
.acct-navitem {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  padding: 9px 10px; border-radius: 10px; cursor: pointer;
  font-family: inherit; font-size: 13px; font-weight: 550; color: rgba(255,255,255,0.62);
  background: transparent; border: 1px solid transparent;
  transition: background .15s, color .15s, border-color .15s;
}
.acct-navitem svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.acct-navitem:hover { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.85); }
.acct-navitem.is-active {
  color: #efe7d3; background: linear-gradient(180deg, rgba(210,188,138,0.16), rgba(210,188,138,0.06));
  border-color: rgba(210,188,138,0.32);
}
.acct-navitem.is-active svg { color: #e6cf9c; }
.acct-navfoot { margin-top: auto; padding-top: 12px; }
.acct-logout {
  display: flex; align-items: center; gap: 9px; width: 100%; justify-content: center;
  padding: 9px 10px; border-radius: 10px; cursor: pointer; font-family: inherit;
  font-size: 12.5px; font-weight: 600; color: #f0b3aa;
  background: transparent; border: 1px solid rgba(233,139,127,0.32);
  transition: background .15s, color .15s, border-color .15s;
}
.acct-logout svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.acct-logout:hover { color: #fff; background: rgba(233,139,127,0.14); border-color: rgba(233,139,127,0.6); }
.acct-logout.mobile-only { display: none; }     /* desktop: sidebar owns logout (overridden on mobile below) */

/* ── content pane ─────────────────────────────────────────────────────────── */
.acct-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.acct-panehead {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 18px 20px 14px; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.acct-panehead h2 {
  margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -0.01em;
  background: linear-gradient(180deg, #fff 0%, #d2bc8a 165%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
}
.acct-x {
  flex: none; width: 32px; height: 32px; border-radius: 9px; cursor: pointer; display: grid; place-items: center;
  color: rgba(255,255,255,0.6); background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  transition: color .15s, border-color .15s, background .15s;
}
.acct-x:hover { color: #fff; border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); }
.acct-x svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }

.acct-scroll {
  flex: 1 1 auto; overflow-y: auto; padding: 20px;
  scrollbar-width: thin; scrollbar-color: transparent transparent;
  transition: scrollbar-color .2s;
}
.acct-scroll:hover, .acct-scroll:focus-within { scrollbar-color: var(--acct-bar) transparent; }
.acct-scroll::-webkit-scrollbar { width: 9px; }
.acct-scroll::-webkit-scrollbar-track { background: transparent; }
.acct-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 9px; border: 3px solid transparent; background-clip: padding-box; }
.acct-scroll:hover::-webkit-scrollbar-thumb, .acct-scroll:focus-within::-webkit-scrollbar-thumb { background: var(--acct-bar); background-clip: padding-box; }

.acct-pane { display: none; flex-direction: column; gap: 18px; }
.acct-pane.is-active { display: flex; }

.acct-eyebrow {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.38);
}
.acct-field { display: flex; flex-direction: column; gap: 6px; }
.acct-label { font-size: 12px; color: rgba(255,255,255,0.5); font-weight: 550; }
.acct-input {
  width: 100%; box-sizing: border-box; padding: 11px 13px; font-size: 14.5px; font-family: inherit;
  color: #fff; background: rgba(0,0,0,0.26); border: 1px solid rgba(210,188,138,0.16);
  border-radius: 11px; outline: none; -webkit-appearance: none; transition: border-color .18s, box-shadow .18s, background .18s;
}
.acct-input::placeholder { color: rgba(255,255,255,0.32); }
.acct-input:focus { border-color: rgba(210,188,138,0.5); background: rgba(0,0,0,0.32); box-shadow: 0 0 0 3px rgba(210,188,138,0.12); }
.acct-input[readonly] { color: rgba(255,255,255,0.55); background: rgba(0,0,0,0.16); cursor: default; }
.acct-input:-webkit-autofill { -webkit-text-fill-color: #fff; -webkit-box-shadow: 0 0 0 40px #2a2926 inset; caret-color: #fff; }

.acct-btn {
  padding: 11px 15px; font-size: 13.5px; font-weight: 700; font-family: inherit; color: #1a1408; cursor: pointer;
  border: none; border-radius: 11px; white-space: nowrap; display: inline-flex; align-items: center; gap: 7px;
  background: linear-gradient(180deg, #e6cf9c 0%, #d2bc8a 48%, #b8a06e 100%);
  box-shadow: 0 1px 0 rgba(255,255,255,0.35) inset, 0 6px 16px rgba(149,101,52,0.28);
  -webkit-tap-highlight-color: transparent; transition: transform .14s, filter .14s, opacity .14s;
}
.acct-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.acct-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.05); }
.acct-btn:active:not(:disabled) { transform: translateY(0) scale(0.985); }
.acct-btn:disabled { opacity: 0.6; cursor: default; }
.acct-btn.small { padding: 8px 12px; font-size: 12.5px; }
.acct-btn.ghost { color: rgba(255,255,255,0.72); background: transparent; border: 1px solid rgba(255,255,255,0.14); box-shadow: none; }
.acct-btn.ghost:hover:not(:disabled) { color: #fff; border-color: rgba(255,255,255,0.28); filter: none; }

.acct-msg { font-size: 12px; min-height: 15px; margin: 0; line-height: 1.35; }
.acct-msg.ok { color: #6fcf97; }
.acct-msg.err { color: #e98b7f; }
.acct-hint { font-size: 11.5px; color: rgba(255,255,255,0.34); line-height: 1.45; margin: 0; }
.acct-foot { display: flex; justify-content: flex-end; }

/* profile */
.acct-avrow { display: flex; align-items: center; gap: 16px; }
.acct-avbig {
  flex: none; width: 72px; height: 72px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; color: #d2bc8a;
  background: radial-gradient(circle at 50% 34%, rgba(230,207,156,0.16), transparent 70%), linear-gradient(180deg, rgba(230,207,156,0.10), rgba(149,101,52,0.05));
  box-shadow: 0 0 0 1px rgba(210,188,138,0.5) inset;
}
.acct-avbig img { width: 100%; height: 100%; object-fit: cover; display: block; }
.acct-avbig .aios-acct-initials { font-size: 24px; font-weight: 700; color: #d2bc8a; }
.acct-avbig svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.acct-avbtns { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.acct-badge {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600;
  padding: 3px 9px 3px 7px; border-radius: 999px; white-space: nowrap;
}
.acct-badge svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.acct-badge.ok { color: #7fdca4; background: rgba(111,207,151,0.12); border: 1px solid rgba(111,207,151,0.3); }
.acct-badge.warn { color: #e6b25a; background: rgba(230,178,90,0.12); border: 1px solid rgba(230,178,90,0.32); }
.acct-badge.muted { color: rgba(255,255,255,0.5); background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); }
.acct-emailrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.acct-emailrow .acct-input { flex: 1 1 200px; }

/* strength meter */
.acct-meter { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.acct-meter-bars { display: flex; gap: 4px; flex: 1 1 auto; }
.acct-meter-seg { height: 5px; flex: 1 1 0; border-radius: 99px; background: rgba(255,255,255,0.09); transition: background .2s; }
.acct-meter-label { font-size: 11.5px; font-weight: 600; min-width: 58px; text-align: right; color: rgba(255,255,255,0.4); }
.acct-meter[data-score="1"] .acct-meter-seg.on { background: #e05545; }
.acct-meter[data-score="2"] .acct-meter-seg.on { background: #e6b25a; }
.acct-meter[data-score="3"] .acct-meter-seg.on { background: #d2bc8a; }
.acct-meter[data-score="4"] .acct-meter-seg.on { background: #6fcf97; }
.acct-meter[data-score="1"] .acct-meter-label { color: #e05545; }
.acct-meter[data-score="2"] .acct-meter-label { color: #e6b25a; }
.acct-meter[data-score="3"] .acct-meter-label { color: #d2bc8a; }
.acct-meter[data-score="4"] .acct-meter-label { color: #6fcf97; }

/* theme cards */
.acct-themegrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.acct-themecard {
  display: flex; flex-direction: column; gap: 10px; padding: 12px; cursor: pointer; text-align: left;
  border-radius: 13px; border: 1.5px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03);
  font-family: inherit; transition: border-color .15s, transform .12s, background .15s;
}
.acct-themecard:hover { transform: translateY(-2px); background: rgba(255,255,255,0.055); border-color: rgba(210,188,138,0.3); }
.acct-themecard.is-active { border-color: rgba(210,188,138,0.7); background: rgba(210,188,138,0.08); box-shadow: 0 0 20px rgba(149,101,52,0.14); }
.acct-swatch { height: 40px; border-radius: 9px; display: flex; overflow: hidden; box-shadow: 0 0 0 1px rgba(0,0,0,0.3) inset; }
.acct-swatch span { flex: 1 1 0; }
.acct-themename { font-size: 12.5px; font-weight: 650; color: #efe7d3; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.acct-themename .tick { width: 15px; height: 15px; opacity: 0; color: #e6cf9c; }
.acct-themecard.is-active .tick { opacity: 1; }
.acct-themename .tick svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.acct-themehint { font-size: 10.5px; color: rgba(255,255,255,0.36); line-height: 1.35; }

/* cloud pane */
.acct-cloudcard {
  padding: 16px; border-radius: 14px; border: 1px solid rgba(210,188,138,0.16);
  background: radial-gradient(90% 130% at 6% -20%, rgba(149,101,52,0.16) 0%, transparent 46%), rgba(0,0,0,0.18);
  display: flex; flex-direction: column; gap: 14px;
}
.acct-cloudtop { display: flex; align-items: center; gap: 12px; }
.acct-cloudicon {
  width: 40px; height: 40px; border-radius: 11px; flex: none; display: grid; place-items: center; color: #e6cf9c;
  background: linear-gradient(180deg, rgba(230,207,156,0.14), rgba(149,101,52,0.05)); box-shadow: 0 0 0 1px rgba(210,188,138,0.4) inset;
}
.acct-cloudicon svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.acct-cloudhead b { display: block; font-size: 13.5px; font-weight: 650; color: #efe7d3; }
.acct-cloudhead span { font-size: 11.5px; color: rgba(255,255,255,0.45); }
.acct-usage { display: flex; flex-direction: column; gap: 6px; }
.acct-usage-top { display: flex; justify-content: space-between; font-size: 11.5px; color: rgba(255,255,255,0.5); }
.acct-usage-track { height: 6px; border-radius: 99px; background: rgba(255,255,255,0.08); overflow: hidden; }
.acct-usage-fill { height: 100%; border-radius: 99px; background: linear-gradient(90deg, #956534, #d2bc8a); box-shadow: 0 0 8px rgba(210,188,138,0.4); transition: width .4s ease; }
.acct-statgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.acct-stat { display: flex; align-items: center; gap: 9px; padding: 10px 11px; border-radius: 11px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); }
.acct-stat .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: rgba(255,255,255,0.35); }
.acct-stat .dot.ok { background: #6fcf97; box-shadow: 0 0 7px rgba(111,207,151,0.7); }
.acct-stat .dot.warn { background: #e6b25a; box-shadow: 0 0 7px rgba(230,178,90,0.7); }
.acct-stat .dot.off { background: #e98b7f; }
.acct-stat-txt { min-width: 0; }
.acct-stat-txt b { display: block; font-size: 12.5px; color: #efe7d3; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acct-stat-txt span { font-size: 10.5px; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.05em; font-family: ui-monospace, Menlo, monospace; }

/* ── mobile: bottom drawer + pill tabs ───────────────────────────────────── */
@media (max-width: 600px) {
  .acct-bg { align-items: flex-end; padding: 0; }
  .acct-modal {
    max-width: none; width: 100%; height: auto; max-height: 92vh; flex-direction: column;
    border-radius: 20px 20px 0 0; transform: translateY(100%);
  }
  .acct-bg.is-open .acct-modal { transform: translateY(0); }
  .acct-nav {
    width: auto; flex-direction: row; gap: 8px; overflow-x: auto; padding: 12px 14px;
    border-right: none; border-bottom: 1px solid var(--acct-line-soft);
    scrollbar-width: none;
  }
  .acct-nav::-webkit-scrollbar { display: none; }
  .acct-brand { display: none; }
  .acct-navlist { flex-direction: row; gap: 8px; }
  .acct-navitem { white-space: nowrap; padding: 8px 13px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.1); }
  .acct-navitem span { display: inline; }
  .acct-navfoot { display: none; }             /* logout moves into the Profile pane on mobile */
  .acct-logout.mobile-only { display: flex; margin-top: 4px; }
  .acct-main { min-height: 0; }
  .acct-scroll { padding: 18px 16px calc(20px + env(safe-area-inset-bottom)); }
  .acct-themegrid { grid-template-columns: 1fr; }
  .acct-statgrid { grid-template-columns: 1fr; }
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
    const auth = supa ? '' : ' hidden';
    const bg = document.createElement('div');
    bg.className = 'acct-bg';
    bg.setAttribute('role', 'dialog');
    bg.setAttribute('aria-modal', 'true');
    bg.setAttribute('aria-label', 'Account and settings');
    bg.innerHTML = `
<div class="acct-modal" role="document">
  <aside class="acct-nav">
    <div class="acct-brand">
      <span class="acct-brand-av" id="acctNavAv" aria-hidden="true"></span>
      <span class="acct-brand-name"><b id="acctNavName">Your account</b><span id="acctNavSub">Aptron</span></span>
    </div>
    <div class="acct-navlist" role="tablist" aria-label="Settings sections">
      <button class="acct-navitem is-active" data-pane="profile"  role="tab" type="button">${ICON.user}<span>Profile &amp; Account</span></button>
      <button class="acct-navitem" data-pane="security" role="tab" type="button"${auth}>${ICON.lock}<span>Security &amp; Password</span></button>
      <button class="acct-navitem" data-pane="prefs"    role="tab" type="button">${ICON.theme}<span>Preferences &amp; Theme</span></button>
      <button class="acct-navitem" data-pane="cloud"    role="tab" type="button">${ICON.cloud}<span>Cloud &amp; Data Sync</span></button>
    </div>
    <div class="acct-navfoot"${auth}>
      <button class="acct-logout" id="acctLogout" type="button">${ICON.logout}Log out</button>
    </div>
  </aside>

  <div class="acct-main">
    <div class="acct-panehead">
      <h2 id="acctPaneTitle">Profile &amp; Account</h2>
      <button class="acct-x" id="acctClose" type="button" aria-label="Close">${ICON.x}</button>
    </div>
    <div class="acct-scroll">

      <section class="acct-pane is-active" data-pane="profile" role="tabpanel">
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
          <input class="acct-input" id="acctName" type="text" maxlength="60" placeholder="Your name" autocomplete="name" spellcheck="false">
        </div>
        <div class="acct-field">
          <label class="acct-label" for="acctEmail">Email</label>
          <div class="acct-emailrow">
            <input class="acct-input" id="acctEmail" type="email" readonly tabindex="-1">
            <span class="acct-badge muted" id="acctVerBadge"></span>
          </div>
        </div>
        <p class="acct-msg" id="acctProfMsg" role="status" aria-live="polite"></p>
        <div class="acct-foot"><button class="acct-btn" id="acctSaveProfile" type="button">Save profile</button></div>
        <button class="acct-logout mobile-only" id="acctLogoutM" type="button"${auth}>${ICON.logout}Log out</button>
      </section>

      <section class="acct-pane" data-pane="security" role="tabpanel"${auth}>
        <div class="acct-field">
          <label class="acct-label" for="acctNewPass">New password</label>
          <input class="acct-input" id="acctNewPass" type="password" maxlength="100" placeholder="At least 8 characters" autocomplete="new-password">
          <div class="acct-meter" id="acctMeter" data-score="0" aria-hidden="true">
            <div class="acct-meter-bars"><span class="acct-meter-seg"></span><span class="acct-meter-seg"></span><span class="acct-meter-seg"></span><span class="acct-meter-seg"></span></div>
            <span class="acct-meter-label" id="acctMeterLabel"></span>
          </div>
        </div>
        <div class="acct-field">
          <label class="acct-label" for="acctConfirmPass">Confirm new password</label>
          <input class="acct-input" id="acctConfirmPass" type="password" maxlength="100" autocomplete="new-password">
        </div>
        <p class="acct-hint">Choose something you don’t use elsewhere. You’ll stay signed in on this device after changing it.</p>
        <p class="acct-msg" id="acctPassMsg" role="status" aria-live="polite"></p>
        <div class="acct-foot"><button class="acct-btn" id="acctUpdatePass" type="button">Update password</button></div>
      </section>

      <section class="acct-pane" data-pane="prefs" role="tabpanel">
        <span class="acct-eyebrow">Appearance</span>
        <div class="acct-themegrid" id="acctThemeGrid"></div>
        <p class="acct-hint">Applies instantly on your dashboard and is saved to your synced profile.</p>
      </section>

      <section class="acct-pane" data-pane="cloud" role="tabpanel">
        <div class="acct-cloudcard">
          <div class="acct-cloudtop">
            <span class="acct-cloudicon" aria-hidden="true">${ICON.cloud}</span>
            <div class="acct-cloudhead"><b id="acctCloudTitle">Checking…</b><span id="acctCloudSub"></span></div>
          </div>
          <div class="acct-usage">
            <div class="acct-usage-top"><span>Synced data</span><span id="acctUsageTxt"></span></div>
            <div class="acct-usage-track"><div class="acct-usage-fill" id="acctUsageFill" style="width:0%"></div></div>
          </div>
          <div class="acct-statgrid">
            <div class="acct-stat"><span class="dot" id="acctDotNet"></span><div class="acct-stat-txt"><b id="acctNet">—</b><span>Network</span></div></div>
            <div class="acct-stat"><span class="dot" id="acctDotSync"></span><div class="acct-stat-txt"><b id="acctLastSync">—</b><span>Last sync</span></div></div>
          </div>
        </div>
        <div class="acct-foot"><button class="acct-btn" id="acctSyncNow" type="button">${ICON.refresh}Sync now</button></div>
      </section>

    </div>
  </div>
</div>`;
    document.body.appendChild(bg);
    modal = bg;
    wire(bg);
    return bg;
  }

  // ── modal wiring ────────────────────────────────────────────────────────────
  function wire(bg) {
    const q = (sel) => bg.querySelector(sel);
    const nameEl = q('#acctName');
    const emailEl = q('#acctEmail');
    const verBadge = q('#acctVerBadge');
    const avBig = q('#acctAvBig');
    const navAv = q('#acctNavAv');
    const navName = q('#acctNavName');
    const navSub = q('#acctNavSub');
    const fileEl = q('#acctFile');
    const profMsg = q('#acctProfMsg');
    const passMsg = q('#acctPassMsg');
    const newPass = q('#acctNewPass');
    const confPass = q('#acctConfirmPass');
    const meter = q('#acctMeter');
    const meterLabel = q('#acctMeterLabel');

    function setMsg(el, text, kind) { el.textContent = text || ''; el.className = 'acct-msg' + (kind ? ' ' + kind : ''); }
    function friendly(e) {
      const raw = (e && (e.message || e.error_description)) || '';
      const m = raw.toLowerCase();
      if (m.indexOf('should be different') !== -1) return 'That’s already your password.';
      if (m.indexOf('weak') !== -1) return 'Password is too weak — try a longer one.';
      if (m.indexOf('network') !== -1 || m.indexOf('fetch') !== -1) return 'Network error — check your connection.';
      return raw ? raw.slice(0, 140) : 'Something went wrong — try again.';
    }

    // avatar into any target (big preview or nav mini)
    function paintAvatar(target, size) {
      const p = loadProfile();
      if (p.avatar) { target.innerHTML = ''; const img = document.createElement('img'); img.src = p.avatar; img.alt = ''; target.appendChild(img); return; }
      const ini = initialsFrom(nameEl.value || p.name, currentEmail);
      if (ini) { target.innerHTML = ''; const sp = document.createElement('span'); sp.className = 'aios-acct-initials'; sp.textContent = ini; target.appendChild(sp); return; }
      target.innerHTML = ICON.gear;
    }
    function paintAll() { paintAvatar(avBig); paintAvatar(navAv); renderTrigger(); }
    bg._paintAll = paintAll;

    q('#acctPhotoBtn').addEventListener('click', () => fileEl.click());
    fileEl.addEventListener('change', () => {
      const f = fileEl.files && fileEl.files[0];
      fileEl.value = '';
      if (!f) return;
      if (f.size > 12 * 1024 * 1024) { setMsg(profMsg, 'That image is too large (max 12 MB).', 'err'); return; }
      setMsg(profMsg, 'Processing photo…', '');
      downscale(f, AVATAR_PX, (dataUrl) => {
        if (!dataUrl) { setMsg(profMsg, 'Couldn’t read that image — try another.', 'err'); return; }
        const p = loadProfile(); p.avatar = dataUrl; saveProfile(p);
        paintAll(); setMsg(profMsg, 'Photo updated.', 'ok');
      });
    });
    q('#acctPhotoRemove').addEventListener('click', () => {
      const p = loadProfile();
      if (!p.avatar) { setMsg(profMsg, 'No photo to remove.', ''); return; }
      delete p.avatar; saveProfile(p);
      paintAll(); setMsg(profMsg, 'Photo removed.', 'ok');
    });

    q('#acctSaveProfile').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      const name = (nameEl.value || '').trim().slice(0, 60);
      const p = loadProfile(); p.name = name; saveProfile(p);
      paintAll();
      navName.textContent = name || 'Your account';
      setMsg(profMsg, 'Saved.', 'ok');
      if (supa) {
        b.disabled = true;
        try { await supa.auth.updateUser({ data: { display_name: name } }); } catch (e2) {}
        b.disabled = false;
      }
    });
    nameEl.addEventListener('input', () => { if (!loadProfile().avatar) { paintAvatar(avBig); paintAvatar(navAv); } });

    // strength meter
    function refreshMeter() {
      const { score, label } = pwStrength(newPass.value || '');
      meter.setAttribute('data-score', String(score));
      const segs = meter.querySelectorAll('.acct-meter-seg');
      segs.forEach((seg, i) => seg.classList.toggle('on', i < score));
      meterLabel.textContent = newPass.value ? label : '';
    }
    if (newPass) newPass.addEventListener('input', refreshMeter);
    bg._refreshMeter = refreshMeter;

    if (supa) {
      q('#acctUpdatePass').addEventListener('click', async (e) => {
        const b = e.currentTarget;
        const np = newPass.value || '', cp = confPass.value || '';
        if (np.length < 8) { setMsg(passMsg, 'Use at least 8 characters.', 'err'); return; }
        if (np !== cp) { setMsg(passMsg, 'Passwords don’t match.', 'err'); return; }
        b.disabled = true; setMsg(passMsg, 'Updating…', '');
        try {
          const { error } = await supa.auth.updateUser({ password: np });
          if (error) throw error;
          newPass.value = ''; confPass.value = ''; refreshMeter();
          setMsg(passMsg, 'Password updated.', 'ok');
        } catch (e2) { setMsg(passMsg, friendly(e2), 'err'); }
        b.disabled = false;
      });
      const doLogout = () => { if (typeof window.appSignOut === 'function') window.appSignOut(); else location.reload(); };
      q('#acctLogout').addEventListener('click', doLogout);
      const lm = q('#acctLogoutM'); if (lm) lm.addEventListener('click', doLogout);
    }

    // theme cards
    const grid = q('#acctThemeGrid');
    grid.innerHTML = THEMES.map((t) =>
      '<button class="acct-themecard" data-theme="' + t.id + '" type="button">' +
        '<span class="acct-swatch" aria-hidden="true">' + t.sw.map((c) => '<span style="background:' + c + '"></span>').join('') + '</span>' +
        '<span class="acct-themename">' + t.name + '<span class="tick">' + ICON.check + '</span></span>' +
        '<span class="acct-themehint">' + t.hint + '</span>' +
      '</button>'
    ).join('');
    function markTheme(id) {
      grid.querySelectorAll('.acct-themecard').forEach((c) => c.classList.toggle('is-active', c.getAttribute('data-theme') === id));
    }
    bg._markTheme = markTheme;
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('[data-theme]'); if (!card) return;
      const id = card.getAttribute('data-theme');
      const p = loadProfile(); p.theme = id; saveProfile(p);
      applyTheme(id); markTheme(id);
    });

    // nav switching
    bg.querySelectorAll('.acct-navitem').forEach((it) => {
      it.addEventListener('click', () => showPane(it.getAttribute('data-pane')));
    });

    // cloud pane (real signals)
    q('#acctSyncNow').addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        if (typeof window.cloudSyncFlush === 'function') await window.cloudSyncFlush();
        if (typeof window.cloudSyncPull === 'function') await window.cloudSyncPull();
        window.__aptSync = { at: Date.now(), kind: 'manual', cloud: !!supa };
      } catch (e2) {}
      updateCloud(); b.disabled = false;
    });
    function updateCloud() {
      const online = navigator.onLine;
      const su = syncedBytes();
      const pct = Math.min(100, Math.round((su.bytes / STORAGE_BUDGET) * 100));
      q('#acctCloudTitle').textContent = supa ? (online ? 'All data safe in the cloud' : 'Saved locally — will sync when online')
                                              : 'Local-only mode';
      q('#acctCloudSub').textContent = supa ? 'Supabase · end-to-end account sync' : 'No cloud configured on this build';
      q('#acctUsageTxt').textContent = su.items + ' items · ' + fmtKB(su.bytes) + ' / ' + fmtKB(STORAGE_BUDGET);
      q('#acctUsageFill').style.width = Math.max(3, pct) + '%';
      const net = q('#acctNet'), dotNet = q('#acctDotNet');
      net.textContent = online ? 'Online' : 'Offline';
      dotNet.className = 'dot ' + (online ? 'ok' : 'off');
      const last = q('#acctLastSync'), dotSync = q('#acctDotSync');
      const sync = window.__aptSync;
      if (!supa) { last.textContent = 'Local only'; dotSync.className = 'dot warn'; }
      else { last.textContent = ago(sync && sync.at); dotSync.className = 'dot ' + (sync && (Date.now() - sync.at) < 120000 ? 'ok' : 'warn'); }
    }
    bg._updateCloud = updateCloud;
    window.addEventListener('apt-sync', () => { if (modal && modal.classList.contains('is-open') && activePane === 'cloud') updateCloud(); });
    const onNet = () => { if (modal && modal.classList.contains('is-open')) updateCloud(); };
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onNet);

    // close affordances
    q('#acctClose').addEventListener('click', close);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });

    bg._populate = function () {
      const p = loadProfile();
      nameEl.value = p.name || '';
      emailEl.value = currentEmail || (supa ? '—' : 'Local mode');
      navName.textContent = p.name || currentEmail || 'Your account';
      navSub.textContent = supa ? 'Aptron account' : 'Local mode';
      // verified badge — from the REAL email_confirmed_at (honest, not decorative)
      if (!supa) { verBadge.className = 'acct-badge muted'; verBadge.textContent = 'Local'; }
      else if (emailVerified === true) { verBadge.className = 'acct-badge ok'; verBadge.innerHTML = ICON.check + 'Verified Member'; }
      else if (emailVerified === false) { verBadge.className = 'acct-badge warn'; verBadge.textContent = 'Unverified'; }
      else { verBadge.className = 'acct-badge muted'; verBadge.textContent = 'Member'; }
      setMsg(profMsg, '', ''); setMsg(passMsg, '', '');
      if (newPass) { newPass.value = ''; confPass.value = ''; refreshMeter(); }
      paintAvatar(avBig); paintAvatar(navAv);
      markTheme(loadProfile().theme || 'dark');
      updateCloud();
      showPane('profile');
    };
  }

  function showPane(name) {
    if (!modal) return;
    activePane = name || 'profile';
    modal.querySelectorAll('.acct-navitem').forEach((it) => {
      const on = it.getAttribute('data-pane') === activePane;
      it.classList.toggle('is-active', on);
      it.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    let title = 'Account';
    modal.querySelectorAll('.acct-pane').forEach((pane) => {
      const on = pane.getAttribute('data-pane') === activePane;
      pane.classList.toggle('is-active', on);
      if (on) {
        const item = modal.querySelector('.acct-navitem[data-pane="' + activePane + '"] span');
        if (item) title = item.textContent;
      }
    });
    const t = modal.querySelector('#acctPaneTitle'); if (t) t.textContent = title;
    if (activePane === 'cloud' && modal._updateCloud) modal._updateCloud();
    const sc = modal.querySelector('.acct-scroll'); if (sc) sc.scrollTop = 0;
  }

  // ── open / close ────────────────────────────────────────────────────────────
  function onKey(e) { if (e.key === 'Escape') close(); }
  function open() {
    const bg = build();
    bg._populate();
    lastFocused = document.activeElement;
    requestAnimationFrame(() => bg.classList.add('is-open'));
    try { document.body.style.overflow = 'hidden'; } catch (e) {}
    document.addEventListener('keydown', onKey);
    const first = bg.querySelector('.acct-navitem.is-active');
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

  // ── boot ──────────────────────────────────────────────────────────────────
  applyTheme(loadProfile().theme || 'dark');   // apply saved theme immediately
  renderTrigger();
  (async function () {
    if (!supa) return;
    try {
      await (window.APP_AUTH_READY || Promise.resolve());
      const { data } = await supa.auth.getUser();
      const u = data && data.user;
      if (u) {
        currentEmail = u.email || '';
        emailVerified = !!(u.email_confirmed_at || u.confirmed_at);
        const p = loadProfile();
        const metaName = u.user_metadata && u.user_metadata.display_name;
        if (!p.name && metaName) { p.name = metaName; saveProfile(p); }
        renderTrigger();
        if (modal && modal.classList.contains('is-open')) modal._populate();
      }
    } catch (e) {}
  })();

  // Re-apply theme + repaint the trigger when a sync applies a remote profile.
  window.addEventListener('storage', function (e) {
    if (!e || !e.key || e.key === PKEY) { applyTheme(loadProfile().theme || 'dark'); renderTrigger(); }
  });

  window.AptAccount = { open, close, renderTrigger, showPane: function (p) { if (modal) showPane(p); } };
})();
