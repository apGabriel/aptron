// =============================================================
// Persistent dashboard top bar + bottom tab bar.
// Drop this on any page with:
//     <script src="js/topbar.js" defer></script>
//     <script src="js/account.js" defer></script>   (optional, after topbar.js)
// It self-injects HTML + CSS, reads progress from localStorage,
// and renders the account/settings trigger, the water +1 button,
// a Smart Wardrobe shortcut in the top bar, and the Health/Main/Gym
// bottom tabs. Skips chrome inside iframes (so the water tracker can
// embed cleanly).
// The account trigger (#acctBtn) is inert markup on its own — js/account.js
// finds it by id and wires the click handler. account.js's IIFE runs eagerly
// (no DOMContentLoaded wait), so its <script> tag must come AFTER this one:
// deferred scripts execute in document order, and this file's DOM injection
// must complete before account.js looks for #acctBtn.
// =============================================================
(function () {
  'use strict';

  // Supabase access goes through the shared authed client (window.APP_SUPABASE,
  // created by js/auth/main.js) — see pushWaterMergedToSupabase below.

  // -------- CSS --------
  const css = `
.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; justify-content: flex-end; align-items: center;
  gap: 8px;
  padding: max(10px, env(safe-area-inset-top)) 14px 8px;
  background: #0a0a0b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.topbar-water-wrap { display: flex; align-items: stretch; }
.topbar-water-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 14px;
  background: rgba(125, 211, 252, 0.08);
  border: 1px solid rgba(125, 211, 252, 0.16);
  border-right: none;
  border-radius: 12px 0 0 12px;
  text-decoration: none; color: #FAFAFA;
  -webkit-tap-highlight-color: transparent;
}
.topbar-water-pill .topbar-pill-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #7DD3FC; flex-shrink: 0;
}
.topbar-water-pill.warn .topbar-pill-dot { background: #fbbf24; }
.topbar-water-pill.miss .topbar-pill-dot {
  background: #ff8a8a;
  animation: topbar-miss-pulse 1.6s ease-in-out infinite;
}
@keyframes topbar-miss-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
  50%      { box-shadow: 0 0 0 5px rgba(239, 68, 68, 0); }
}
.topbar-pill-count {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px; font-weight: 700; color: #FAFAFA;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.topbar-water-add {
  width: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(125, 211, 252, 0.16);
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.28), rgba(110, 231, 183, 0.28));
  color: #FFFFFF; font-family: inherit;
  font-weight: 700; line-height: 1;
  cursor: pointer; border-radius: 0 12px 12px 0;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, transform 0.10s;
}
.topbar-water-add svg {
  width: 20px; height: 20px;
  fill: none; stroke: currentColor; stroke-width: 1.75;
  stroke-linecap: round; stroke-linejoin: round;
}
.topbar-water-add:active { transform: scale(0.94); }
.topbar-water-add.flash {
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.7), rgba(110, 231, 183, 0.7));
}
.topbar-wardrobe-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 42px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px; text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.topbar-wardrobe-btn:hover { background: rgba(255, 255, 255, 0.08); }
.topbar-wardrobe-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; color: rgba(255, 255, 255, 0.85);
}
.topbar-wardrobe-icon svg {
  width: 20px; height: 20px;
  fill: none; stroke: currentColor; stroke-width: 1.75;
  stroke-linecap: round; stroke-linejoin: round;
}
/* Account & settings trigger (js/account.js wires #acctBtn on click; it's a
   no-op script until this button exists). --focus-ring is already defined
   per theme on every page (ADR-022 Fase 1 — page-local, protected, never
   accent-chained), so :focus-visible below picks up each page's own value
   for free. --accent is NOT page-local by design on gym/health/wardrobe
   (they use their own namespaced --apt-accent/--health-accent/--wr-accent
   instead, so a global accent can never leak into their brand identity) —
   but the account trigger/modal is suite-wide chrome, not page identity, and
   was always meant to track the dashboard's chosen theme everywhere (see
   account.js's own --acct-accent comment). The per-built-in-theme table
   below gives --accent a real value for these 3 pages so it does; Custom
   Theme already works cross-page without help, since js/theme.js sets
   --accent as an inline style on <html> directly, on every page. Bare
   fallback (#d2bc8a) only ever fires pre-first-paint or if this block is
   ever removed. margin-right:auto pushes the button to the opposite edge
   from the water/wardrobe group without touching the shared .topbar
   flex-end layout. */
.aios-acct {
  flex: none; width: 38px; height: 38px; padding: 0; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer;
  color: var(--accent, #d2bc8a); background: color-mix(in srgb, var(--accent, #d2bc8a) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, #d2bc8a) 28%, transparent);
  overflow: hidden; -webkit-tap-highlight-color: transparent;
  transition: border-color .15s ease, box-shadow .15s ease, transform .12s ease, background .15s ease;
}
.aios-acct:hover { border-color: color-mix(in srgb, var(--accent, #d2bc8a) 55%, transparent); background: color-mix(in srgb, var(--accent, #d2bc8a) 12%, transparent); transform: translateY(-1px); }
.aios-acct:active { transform: translateY(0) scale(0.96); }
.aios-acct:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus-ring, #d2bc8a) 30%, transparent); }
.aios-acct-inner { width: 100%; height: 100%; display: grid; place-items: center; }
.aios-acct-inner img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
.aios-acct-inner svg {
  width: 18px; height: 18px; fill: none; stroke: currentColor;
  stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
}
.aios-acct-inner .aios-acct-initials {
  font-size: 14px; font-weight: 700; letter-spacing: 0.02em; color: var(--accent, #d2bc8a);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
#topbar > .aios-acct { margin-right: auto; }
/* --accent per built-in theme, for the account trigger/modal only (see the
   comment above .aios-acct) — values copied from css/styles.css's own
   html[data-apt-theme="…"] blocks, the single source of truth for what each
   theme's accent actually is. Duplicated rather than shared because this
   project has no cross-page stylesheet (ADR-001/ADR-022 — no bundler, each
   page loads its own CSS). "dark" (the default) needs no rule: it matches
   the #d2bc8a fallback already on every var(--accent, #d2bc8a) above.
   custom-dark/custom-light need no rule either — js/theme.js sets --accent
   as an inline style directly for those, which already outranks this. */
html[data-apt-theme="obsidian"] { --accent: #c3ad7e; }
html[data-apt-theme="gold"]     { --accent: #e8d3a2; }
html[data-apt-theme="neon"]     { --accent: #00F0FF; }
html[data-apt-theme="emerald"]  { --accent: #52D1A2; }
html[data-apt-theme="light"]    { --accent: #956534; }
html[data-apt-theme="nordic"]   { --accent: #3B5BDB; }
.bottombar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: flex; justify-content: space-around; align-items: stretch;
  padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
  background: #0a0a0b;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.bottombar-tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; padding: 6px 0 4px; text-decoration: none;
  color: rgba(255, 255, 255, 0.45);
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
  -webkit-tap-highlight-color: transparent; transition: color 0.15s;
}
.bottombar-tab-icon {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; opacity: 0.6;
  transition: opacity 0.15s, transform 0.10s;
}
.bottombar-tab-icon svg {
  width: 24px; height: 24px;
  fill: none; stroke: currentColor; stroke-width: 1.75;
  stroke-linecap: round; stroke-linejoin: round;
}
.bottombar-tab.active { color: #FAFAFA; }
.bottombar-tab.active .bottombar-tab-icon { opacity: 1; }
.bottombar-tab:active .bottombar-tab-icon { transform: scale(0.92); }
body.has-bottombar {
  padding-bottom: calc(72px + env(safe-area-inset-bottom)) !important;
}
@media (max-width: 480px) {
  .topbar { padding-left: 10px; padding-right: 10px; gap: 6px; }
  .topbar-water-pill { padding: 8px 11px; gap: 6px; }
  .topbar-pill-count { font-size: 12px; }
  .topbar-water-add { width: 44px; }
  .topbar-water-add svg { width: 18px; height: 18px; }
  .topbar-wardrobe-btn { width: 44px; height: 44px; }
  .topbar-wardrobe-icon, .topbar-wardrobe-icon svg { width: 18px; height: 18px; }
  .bottombar-tab-icon, .bottombar-tab-icon svg { width: 22px; height: 22px; }
  .bottombar-tab { font-size: 10px; }
}
html, body { -webkit-text-size-adjust: 100%; }
@media (max-width: 768px) {
  html { touch-action: pan-y; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
}
/* ── Light themes (html[data-apt-theme] set by js/theme.js / js/account.js) ──
   Frosted-white chrome + dark ink. State variants (.warn/.miss dots, .active
   tab, :hover) are re-declared because the scoped base overrides outrank them. */
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar {
  background: rgba(255,255,255,0.85);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border-bottom-color: rgba(29,33,41,0.10);
}
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-water-pill {
  color: #1D2129;
  background: rgba(14,126,168,0.07); border-color: rgba(14,126,168,0.24);
}
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-pill-count { color: #1D2129; }
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-water-pill .topbar-pill-dot { background: #0E7EA8; }
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-water-pill.warn .topbar-pill-dot { background: #D97706; }
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-water-pill.miss .topbar-pill-dot { background: #DC2626; }
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-water-add {
  color: #0E7EA8; border-color: rgba(14,126,168,0.24);
}
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-wardrobe-btn {
  background: rgba(29,33,41,0.05); border-color: rgba(29,33,41,0.12);
}
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-wardrobe-btn:hover { background: rgba(29,33,41,0.09); }
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .topbar-wardrobe-icon { color: rgba(29,33,41,0.75); }
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .bottombar {
  background: rgba(255,255,255,0.88);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border-top-color: rgba(29,33,41,0.10);
}
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .bottombar-tab { color: rgba(29,33,41,0.64); }
html:is([data-apt-theme="light"], [data-apt-theme="nordic"], [data-apt-theme="custom-light"]) .bottombar-tab.active { color: #1D2129; }
.modal-bg, .modal, .po-modal-bg, .po-modal, .wt-overlay, .wt-viewer, .wr-modal-bg, .wr-modal, .acct-bg, .acct-modal {
  overscroll-behavior: contain;
}
body.topbar-modal-open { overflow: hidden; touch-action: none; }
@media (max-width: 480px) {
  .modal-bg, .po-modal-bg {
    padding: 0 !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .modal, .po-modal {
    width: 100% !important; max-width: 100% !important;
    max-height: 100vh !important; height: 100vh !important;
    border-radius: 0 !important;
    padding-top: max(20px, env(safe-area-inset-top)) !important;
    padding-bottom: max(28px, env(safe-area-inset-bottom)) !important;
    overflow-y: auto !important; overscroll-behavior: contain;
  }
}
`;

  // Minimalist line icons (Lucide paths, inlined — no CDN/build step). They draw
  // with `currentColor`, so the bottom-tab color rules theme them automatically.
  const ICON_HOME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const ICON_PILL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/></svg>';
  const ICON_DUMBBELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.4 14.4 9.6 9.6"/><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z"/><path d="m21.5 21.5-1.4-1.4"/><path d="M3.9 3.9 2.5 2.5"/><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z"/></svg>';
  const ICON_SHIRT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/></svg>';

  const topbarHtml = `
<header class="topbar" id="topbar" role="navigation" aria-label="Quick actions">
  <button class="aios-acct" id="acctBtn" type="button" aria-haspopup="dialog"
          aria-label="Account and settings">
    <span class="aios-acct-inner" id="acctAvatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
    </span>
  </button>
  <div class="topbar-water-wrap">
    <a href="health.html#water" class="topbar-water-pill" id="topbarWater" aria-label="Water progress">
      <span class="topbar-pill-dot"></span>
      <span class="topbar-pill-count" id="topbarWaterCount">0/0</span>
    </a>
    <button class="topbar-water-add" id="topbarWaterAdd" aria-label="Log one drink" type="button"><svg class="water-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8"/><path d="M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.789V2"/><path d="M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0"/></svg></button>
  </div>
  <a href="wardrobe.html" class="topbar-wardrobe-btn" id="topbarWardrobe" aria-label="Smart Wardrobe">
    <span class="topbar-wardrobe-icon">${ICON_SHIRT}</span>
  </a>
</header>`;

  // Tab order, left → right: Health, Main, Gym. (data-page="fitness" is an
  // internal routing key only, unrelated to the visible label — left as-is.)
  const bottombarHtml = `
<nav class="bottombar" id="bottombar" role="navigation" aria-label="Main tabs">
  <a href="health.html" class="bottombar-tab" data-page="health">
    <span class="bottombar-tab-icon">${ICON_PILL}</span><span>Health</span>
  </a>
  <a href="index.html" class="bottombar-tab" data-page="main">
    <span class="bottombar-tab-icon">${ICON_HOME}</span><span>Main</span>
  </a>
  <a href="gym.html" class="bottombar-tab" data-page="fitness">
    <span class="bottombar-tab-icon">${ICON_DUMBBELL}</span><span>Gym</span>
  </a>
</nav>`;

  function isEmbedded() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }
  function shouldShowChrome() { return !isEmbedded(); }
  function currentPageKey() {
    // Match the last path segment with or without the .html extension, so it
    // works under both raw files (/health.html) and clean URLs (/health).
    const seg = (window.location.pathname || '/').toLowerCase()
      .replace(/\/+$/, '').split('/').pop().replace(/\.html$/, '');
    if (seg === 'health') return 'health';
    if (seg === 'gym') return 'fitness';
    return 'main'; // '', 'index', or anything else
  }

  function injectStyleAndHTML() {
    if (!shouldShowChrome()) return;
    // Idempotent, per-element injection. A page may pre-declare the <header
    // id="topbar"> (e.g. index.html, to keep the markup in its own source) —
    // in that case we skip re-creating it but still inject the shared CSS and
    // the bottom tab bar, then wire everything by id. Previously this returned
    // early if either bar existed, which would have left such a page without
    // the bottombar/CSS.
    if (!document.getElementById('topbar-style')) {
      const style = document.createElement('style');
      style.id = 'topbar-style';
      style.textContent = css;
      document.head.appendChild(style);
    }
    if (!document.getElementById('topbar')) {
      const topWrap = document.createElement('div');
      topWrap.innerHTML = topbarHtml.trim();
      document.body.insertBefore(topWrap.firstChild, document.body.firstChild);
    }
    if (!document.getElementById('bottombar')) {
      const bottomWrap = document.createElement('div');
      bottomWrap.innerHTML = bottombarHtml.trim();
      document.body.appendChild(bottomWrap.firstChild);
    }
    const active = currentPageKey();
    document.querySelectorAll('.bottombar-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-page') === active);
    });
    document.body.classList.add('has-bottombar');
  }

  function calendarDateKey() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  // Volume of one display unit, in ml. The water app stores everything in ml
  // and shows progress strictly in bottles or glasses (raw ml was removed), so
  // the topbar mirrors that: any legacy 'ml'/'oz' unit reads as bottles.
  function unitVolMlFor(state) {
    return state.unit === 'glass' ? (state.glassMl || 250) : (state.bottleMl || 500);
  }
  // Shared serving icons — the EXACT minimalist line SVGs from js/health.js's
  // WATER_ICONS, so the + button, the bubble and the main panel all read as one
  // design. They draw with stroke:currentColor / stroke-width 1.75, so the add
  // button's white color themes them automatically (see .topbar-water-add svg).
  const WATER_ICONS = {
    glass:  '<svg class="water-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.116 4.104A1 1 0 0 1 6.11 3h11.78a1 1 0 0 1 .994 1.105L17.19 20.21A2 2 0 0 1 15.2 22H8.8a2 2 0 0 1-2-1.79z"/><path d="M6 12a5 5 0 0 1 6 0 5 5 0 0 0 6 0"/></svg>',
    bottle: '<svg class="water-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8"/><path d="M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.789V2"/><path d="M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0"/></svg>',
    custom: '<svg class="water-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 8 1.75 12.28a2 2 0 0 0 2 1.72h4.54a2 2 0 0 0 2-1.72L18 8"/><path d="M5 8h14"/><path d="M7 15a6.47 6.47 0 0 1 5 0 6.47 6.47 0 0 0 5 0"/></svg>'
  };
  // Which serving the + button logs right now — mirrors the water app's
  // inputMode. 'custom' only counts once the user has given it a size.
  function inputModeOf(state) {
    const m = state && state.inputMode;
    if (m === 'glass') return 'glass';
    if (m === 'custom' && (state.customMl || 0) > 0) return 'custom';
    return 'bottle';
  }
  function inputModeMlFor(state) {
    const m = inputModeOf(state);
    if (m === 'glass')  return state.glassMl  || 250;
    if (m === 'custom') return state.customMl || 500;
    return state.bottleMl || 500;
  }
  // Compact serving number for the small bubble: ≤1 decimal with a trailing
  // ".0" trimmed, so it stays tidy — bottles "1.6", glasses "8" / "8.5" / "12".
  function fmtUnit(n) {
    const r = Math.round((Number(n) || 0) * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }
  // Returns today's progress already CONVERTED into the active display unit
  // (bottles or glasses) — never raw ml. Both values are fractional so the
  // bubble matches the main panel exactly (e.g. 1.6 / 2.4).
  function getWaterProgress() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem('po_water_v1')); } catch (e) {}
    if (!state) return { unit: 'bottle', mode: 'bottle', done: 0, total: 0 };
    const todayKey = calendarDateKey();
    const doneMl = (state.logs || {})[todayKey] || 0;   // logs are absolute ml
    const p = state.profile || { weightKg: 75 };
    const wKg = state.weightUnit === 'lb' ? (p.weightKg || 0) / 2.20462 : (p.weightKg || 0);
    const base = wKg * 35;
    const exercise = (p.activityHrsPerWeek || 0) / 7 * 500;
    const caffeine = Math.max(0, (state.caffeineMgPerDay || 0) - 200) * 1.5;
    const subs = (state.substances || []).reduce((s, x) => {
      const dose = (x && x.dose != null ? x.dose : (x && x.defaultDose)) || 0;
      return s + Math.max(0, dose * ((x && x.mlPerUnit) || 0));
    }, 0);
    let adjust = 0;
    if (p.sex === 'm') adjust += 200;
    if ((p.age || 0) >= 50) adjust += 100;
    const totalMl = base + exercise + caffeine + subs + adjust;
    const unitVol = unitVolMlFor(state);
    const unit = state.unit === 'glass' ? 'glass' : 'bottle';
    // Divide the SAME stored ml by the unit volume → progress in the chosen unit.
    // `mode` is the INPUT serving (drives the + button icon); `unit` is the
    // display unit (drives the count) — they can differ.
    return { unit, mode: inputModeOf(state), done: doneMl / unitVol, total: totalMl / unitVol };
  }
  function classifyStatus(done, total) {
    if (total <= 0) return 'idle';
    if (done >= total) return 'good';
    if (done >= total * 0.5) return 'warn';
    const h = new Date().getHours();
    if (h >= 18 && done < total * 0.5) return 'miss';
    return 'warn';
  }
  function setPillStatus(pillEl, status) {
    pillEl.classList.remove('good', 'warn', 'miss');
    if (status === 'warn' || status === 'miss') pillEl.classList.add(status);
  }
  function render() {
    const waterEl = document.getElementById('topbarWater');
    if (!waterEl) return;
    const w = getWaterProgress();
    const countEl = document.getElementById('topbarWaterCount');
    // Mirror the main panel: "<done>/<target>" in the active unit, no ml.
    if (countEl) countEl.textContent = w.total > 0 ? (fmtUnit(w.done) + '/' + fmtUnit(w.total)) : '0/0';
    setPillStatus(waterEl, classifyStatus(w.done, w.total));
    // The + button wears the active serving's icon, so a one-tap log on any page
    // is unambiguous about what it's adding.
    const addBtn = document.getElementById('topbarWaterAdd');
    if (addBtn) {
      addBtn.innerHTML = WATER_ICONS[w.mode] || WATER_ICONS.bottle;
      addBtn.setAttribute('aria-label', 'Log one ' + (w.mode === 'custom' ? 'serving' : w.mode) + ' of water');
    }
  }

  function defaultWaterState() {
    return {
      v: 2, unit: 'bottle', inputMode: 'bottle', bottleMl: 500, glassMl: 250, customMl: 0, customLabel: 'Custom', weightUnit: 'kg',
      profile: { weightKg: 75, age: 25, sex: 'm', activityHrsPerWeek: 5 },
      caffeineMgPerDay: 200, substances: [], logs: {}
    };
  }
  // Keep topbar writes compatible with the water app's ml store. If we ever meet
  // a pre-v2 (count-based) blob, convert it the same way the app's normalize()
  // does, so the + button can't corrupt data by appending ml to a serving count.
  function ensureWaterV2(state) {
    if (state.v === 2) return;
    const bMl = state.bottleMl || 500;
    const out = {};
    for (const key in (state.logs || {})) {
      const n = Number(state.logs[key]) || 0;
      if (n > 0) out[key] = Math.round(n * bMl);
    }
    state.logs = out;
    if (state.profile && state.profile.sex === 'o') state.profile.sex = 'f';
    state.unit = state.unit === 'glass' ? 'glass' : 'bottle';
    state.v = 2;
  }
  async function pushWaterMergedToSupabase(localWater) {
    if (window.location.pathname.endsWith('/health.html') ||
        window.location.pathname.endsWith('health.html')) return;
    // Reuse the one authed client (js/auth/main.js). Null when signed out / local-only.
    const supa = window.APP_SUPABASE;
    if (!supa) return;
    try {
      const { data } = await supa
        .from('app_state').select('data').eq('key', 'health').maybeSingle();
      const current = (data && data.data) || {};
      const merged = Object.assign({}, current, { po_water_v1: localWater });
      await supa.from('app_state').upsert(
        { key: 'health', data: merged, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,key' }
      );
    } catch (e) {}
  }
  function addWater() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem('po_water_v1')); } catch (e) {}
    if (!state || typeof state !== 'object') state = defaultWaterState();
    ensureWaterV2(state);
    state.logs = state.logs || {};
    const k = calendarDateKey();
    // Add one serving's worth of ml (matching the app's input mode), NOT "+1",
    // since logs are absolute ml now. Handles bottle/glass/custom.
    const addMl = inputModeMlFor(state);
    state.logs[k] = Math.max(0, Math.round((state.logs[k] || 0) + addMl));
    try { localStorage.setItem('po_water_v1', JSON.stringify(state)); } catch (e) {}
    render();
    // Tell same-document listeners (the water panel) to reload, so it picks up
    // this add instead of overwriting it on its next action. Cross-frame docs
    // get this natively from the localStorage write above.
    try { window.dispatchEvent(new Event('storage')); } catch (e) {}
    const btn = document.getElementById('topbarWaterAdd');
    if (btn) { btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 220); }
    pushWaterMergedToSupabase(state);
  }

  function blockGesture(e) { e.preventDefault(); }
  function lockGestures() {
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });
    document.addEventListener('gestureend', blockGesture, { passive: false });
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });
  }
  function startModalLock() {
    const MODAL_SELECTORS = ['.modal-bg', '.po-modal-bg', '.wt-overlay', '.wt-viewer', '.wt-cam', '.wr-modal-bg', '.acct-bg'];
    function anyOpen() {
      for (const sel of MODAL_SELECTORS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.classList.contains('show') || el.classList.contains('is-open')) return true;
        }
      }
      return false;
    }
    function sync() { document.body.classList.toggle('topbar-modal-open', anyOpen()); }
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    sync();
  }

  function boot() {
    injectStyleAndHTML();
    const btn = document.getElementById('topbarWaterAdd');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); addWater(); });
    render();
    lockGestures();
    startModalLock();
    window.addEventListener('storage', render);
    // The water panel fires this on every local change (unit toggle, log, etc.)
    // so the bubble re-renders in the active unit instantly, same document.
    window.addEventListener('water:changed', render);
    window.addEventListener('focus', render);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
    setInterval(render, 30 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
