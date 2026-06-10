/* ============================================================
   gym-core.js — Progressive Overload Coach: core module.
   FIRST of the five Coach modules to load. Creates the single
   shared namespace (window.GymApp), holds the pure leaf helpers
   every other module reuses, and defines the bootstrap routine.
   Closures cannot span separate <script> files, so the Coach
   modules share live state through this ONE intentional global;
   everything else stays private inside each module's IIFE.
   Load order: core → storage → sync → ui → actions.
   Depends on the inline CONFIG object defined in gym.html.
   ============================================================ */
(function () {
  'use strict';

  // The one intentional global the Coach modules share.
  const G = window.GymApp = window.GymApp || {};

  // App title from the inline CONFIG (defined in gym.html).
  const titleEl = document.getElementById('appTitle');
  if (titleEl) titleEl.textContent = (typeof CONFIG !== 'undefined' && CONFIG.appTitle) || 'Progressive Overload Coach';

  // ============================================================
  // PURE LEAF HELPERS (no cross-module dependencies)
  // ============================================================
  const $ = (id) => document.getElementById(id);
  function unit() { return G.state.units; }
  function uid() { return 'ex_' + Date.now() + '_' + Math.floor(Math.random() * 9999); }
  function estimate1RM(w, r) { if (r < 2) return w; return w * (1 + r / 30); }
  // Dropsets are performed under accumulated fatigue at intentionally reduced
  // load, so they must NOT skew peak-strength tracking (1RM, PR, prescription,
  // trend). Returns only the "working" sets; falls back to the full list if an
  // exercise somehow has dropsets only, so peak panels never go blank. Volume
  // math deliberately ignores this filter — dropsets always count toward total.
  function workingSets(logs) {
    const w = (logs || []).filter(l => !l.is_dropset);
    return w.length ? w : (logs || []);
  }
  function roundToStep(v, s) { return Math.round(v / s) * s; }

  // ── Set rendering: single source of truth ────────────────────
  // Every place that prints a logged set (last-set chip, history rows, session
  // breakdown) routes through these two helpers so the value format and the
  // flag → marker mapping live in ONE spot. Adding a future per-set flag
  // (bodyweight badge, banded, paused…) means extending setMarkersHtml() once,
  // not hunting down three near-identical ternaries.
  function fmtSetValue(set, ex) {
    return (ex && ex.bw) ? (set.reps + ' reps') : (set.weight + unit() + ' × ' + set.reps);
  }
  // Inline marker tags prefixed to a set's value. Order = render order.
  function setMarkersHtml(set) {
    let html = '';
    if (set && set.is_dropset) html += '<span class="po-ds-tag">↳ DS</span>';
    return html;
  }
  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  // Reps box bounds — shared by the ui render seed and the actions handlers.
  const REP_MIN = 1, REP_MAX = 36;
  function clampReps(n) { return Math.max(REP_MIN, Math.min(REP_MAX, n)); }

  // ============================================================
  // BOOTSTRAP
  // Invoked once at the very end of gym-actions.js (the last Coach module to
  // load), so every G.* member is populated before the first render.
  // ============================================================
  G.boot = function () {
    G.state = G.loadState();
    // normalize() already scrubbed ghost-duplicate sets in memory on load; if
    // it dropped any, persist the cleaned state once so the purge is durable.
    if (G.state.__ghostsPurged) {
      console.info('[gym] Purged ' + G.state.__ghostsPurged + ' ghost-duplicate set(s).');
      delete G.state.__ghostsPurged;
      G.saveState();
    }
    // Manual re-run (e.g. after an old blob syncs in from another device):
    // call window.__gymPurgeGhosts() from the console.
    window.__gymPurgeGhosts = function () {
      const removed = G.dedupSessionSets(G.state);
      G.rebuildLogIndex();
      G.saveState();
      G.renderAll();
      return removed;
    };
    G.renderAll();
    G.photosRender();
  };

  // Expose leaf helpers + constants for the other modules.
  Object.assign(G, {
    $, unit, uid, estimate1RM, workingSets, roundToStep,
    fmtSetValue, setMarkersHtml, escape, clampReps, REP_MIN, REP_MAX
  });
})();
