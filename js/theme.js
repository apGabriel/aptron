// =============================================================================
// Shared theme applier — promotes the dashboard theme switch to every page.
//
// Reads the theme picked in Account → Preferences (index.html, js/account.js)
// from the synced profile blob and stamps <html data-apt-theme="…"> so each
// page's stylesheet can restyle its surfaces. Loaded SYNCHRONOUSLY in <head>
// (no defer) so the attribute lands before first paint — no dark flash.
//
// 'dark' (the default) removes the attribute, matching account.js applyTheme.
// The storage listener keeps long-lived tabs in step when the theme changes
// in another tab (or when account.js nudges same-document listeners).
// =============================================================================
(function () {
  'use strict';
  function apply() {
    var t = null;
    try { t = (JSON.parse(localStorage.getItem('aptron_profile_v1')) || {}).theme; } catch (e) {}
    var el = document.documentElement;
    if (!t || t === 'dark') el.removeAttribute('data-apt-theme');
    else el.setAttribute('data-apt-theme', t);
  }
  apply();
  window.addEventListener('storage', apply);
})();
