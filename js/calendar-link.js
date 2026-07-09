// =============================================================================
// GOOGLE CALENDAR LINKING — per-user OAuth connect UI + Shenlong celebration.
//
// The vanilla-JS counterpart to the "connect calendar" React component. No
// framework/build step (see CLAUDE.md); this is a self-contained IIFE that:
//   1. renders a "Start Calendar Synchronization" button into #calLinkMount and
//      opens the Google OAuth popup via GET /api/oauth/google/start;
//   2. listens for the popup's window.postMessage({source:'aptron-oauth',ok});
//   3. polls GET /api/calendar/status for connection state / email / token
//      health (?verify=1 confirms the stored refresh token still works);
//   4. plays the Shenlong "wish granted" overlay the moment a link succeeds.
//
// Talks to the proxy same-origin (relative /api/*), same convention as
// js/index.js. Every /api call carries the login JWT (window.__appAccessToken).
// =============================================================================
(function () {
  'use strict';
  const mount = document.getElementById('calLinkMount');
  if (!mount) return;                       // only present on index.html

  const API = '';                           // same-origin proxy (Vercel rewrite in prod)
  const POLL_MS = 45 * 1000;                // cheap status refresh cadence
  let state = null;                         // last status payload
  let polling = 0;

  // ── authed fetch (mirror of index.js: await session, attach bearer) ─────────
  async function authedFetch(url, opts) {
    await (window.APP_AUTH_READY || Promise.resolve());
    opts = opts || {};
    const headers = Object.assign({}, opts.headers);
    let token = window.__appAccessToken;
    if (!token && window.APP_SUPABASE) {
      try { const { data } = await window.APP_SUPABASE.auth.getSession(); token = data && data.session && data.session.access_token; }
      catch (e) {}
    }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, Object.assign({}, opts, { headers }));
  }

  // ── styles (Shenlong gold-on-slate, matching js/auth.js) ────────────────────
  function injectStyles() {
    if (document.getElementById('callink-styles')) return;
    const s = document.createElement('style');
    s.id = 'callink-styles';
    s.textContent = `
.callink {
  display: flex; align-items: center; gap: 12px;
  margin: 2px 0 12px; padding: 12px 14px;
  border: 1px solid rgba(210,188,138,0.16); border-radius: 14px;
  background: linear-gradient(180deg, rgba(58,56,52,0.55), rgba(37,36,34,0.55));
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.callink[hidden] { display: none; }
.callink-emblem {
  flex: 0 0 auto; width: 28px; height: 28px; color: #d2bc8a;
  background: currentColor;
  -webkit-mask: url("img/shenlong.png") center / contain no-repeat;
          mask: url("img/shenlong.png") center / contain no-repeat;
  opacity: 0.85;
}
.callink-body { flex: 1 1 auto; min-width: 0; }
.callink-title { font-size: 13px; font-weight: 600; color: #efe7d3; letter-spacing: 0.01em; }
.callink-sub { font-size: 12px; color: rgba(255,255,255,0.5); margin-top: 1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.callink-sub .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  margin-right: 5px; vertical-align: 1px; background: rgba(255,255,255,0.35); }
.callink-sub.is-ok    .dot { background: #6fcf97; box-shadow: 0 0 6px rgba(111,207,151,0.6); }
.callink-sub.is-warn  .dot { background: #e6b25a; box-shadow: 0 0 6px rgba(230,178,90,0.6); }
.callink-sub.is-error .dot { background: #e98b7f; }
.callink-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.callink-btn {
  padding: 9px 14px; font-size: 13px; font-weight: 700; font-family: inherit;
  color: #1a1408; cursor: pointer; border: none; border-radius: 11px; white-space: nowrap;
  background: linear-gradient(180deg, #e6cf9c 0%, #d2bc8a 48%, #b8a06e 100%);
  box-shadow: 0 1px 0 rgba(255,255,255,0.35) inset, 0 6px 16px rgba(149,101,52,0.28);
  transition: transform .14s, box-shadow .14s, filter .14s, opacity .14s;
}
.callink-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.05); }
.callink-btn:active:not(:disabled) { transform: translateY(0) scale(0.985); }
.callink-btn:disabled { opacity: 0.6; cursor: default; }
.callink-link {
  background: none; border: none; padding: 4px 2px; font-family: inherit; font-size: 12px;
  color: rgba(210,188,138,0.85); cursor: pointer; text-decoration: underline; text-underline-offset: 2px;
}
.callink-link:hover { color: #e6cf9c; }
.callink-link.is-danger { color: rgba(233,139,127,0.9); }
.callink-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: rgba(255,255,255,0.55); cursor: pointer; }
.callink-toggle input { accent-color: #d2bc8a; }

/* ── Shenlong "wish granted" overlay ─────────────────────────────────────── */
.shenlong-wish {
  position: fixed; inset: 0; z-index: 100001;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; text-align: center; pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
  background: radial-gradient(ellipse 60% 50% at 50% 45%, rgba(149,101,52,0.42) 0%, rgba(13,13,14,0.86) 60%, rgba(13,13,14,0.94) 100%);
  opacity: 0; animation: swFade 2.7s ease forwards;
}
.shenlong-wish .sw-dragon {
  width: 168px; height: 168px; color: #f0d79c; background: currentColor;
  -webkit-mask: url("img/shenlong.png") center / contain no-repeat;
          mask: url("img/shenlong.png") center / contain no-repeat;
  filter: drop-shadow(0 0 22px rgba(240,215,156,0.65));
  transform: translateY(24px) scale(0.82); opacity: 0;
  animation: swRise 2.7s cubic-bezier(0.22,1,0.36,1) forwards;
}
.shenlong-wish .sw-title {
  font-size: 26px; font-weight: 800; letter-spacing: -0.01em;
  background: linear-gradient(180deg, #fff, #e6cf9c 130%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  transform: translateY(10px); opacity: 0; animation: swText 2.7s ease forwards; animation-delay: 0.25s;
}
.shenlong-wish .sw-sub {
  font-size: 14px; color: rgba(255,255,255,0.62);
  transform: translateY(10px); opacity: 0; animation: swText 2.7s ease forwards; animation-delay: 0.4s;
}
@keyframes swFade { 0%{opacity:0} 12%{opacity:1} 82%{opacity:1} 100%{opacity:0} }
@keyframes swRise {
  0%{transform:translateY(24px) scale(0.82); opacity:0}
  16%{opacity:1} 45%{transform:translateY(0) scale(1); opacity:1}
  82%{transform:translateY(-2px) scale(1); opacity:1} 100%{transform:translateY(-10px) scale(0.98); opacity:0}
}
@keyframes swText { 0%{transform:translateY(10px); opacity:0} 20%{opacity:1} 82%{opacity:1} 100%{opacity:0; transform:translateY(-4px)} }
@media (prefers-reduced-motion: reduce) {
  .shenlong-wish, .shenlong-wish * { animation-duration: 1.1s !important; animation-timing-function: ease !important; }
  .shenlong-wish .sw-dragon { animation: swFade 1.1s ease forwards; transform: none; }
}`;
    document.head.appendChild(s);
  }

  // ── the celebration overlay (one-shot; auto-removes) ────────────────────────
  let wishTimer = 0;
  function celebrate(email) {
    injectStyles();
    const prev = document.querySelector('.shenlong-wish');
    if (prev) prev.remove();
    const el = document.createElement('div');
    el.className = 'shenlong-wish';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="sw-dragon" aria-hidden="true"></div>' +
      '<div class="sw-title">Your wish is granted</div>' +
      '<div class="sw-sub"></div>';
    el.querySelector('.sw-sub').textContent =
      email ? ('Calendar synchronized · ' + email) : 'Calendar synchronization begins';
    document.body.appendChild(el);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    clearTimeout(wishTimer);
    wishTimer = setTimeout(() => { el.remove(); }, reduce ? 1200 : 2700);
  }

  // ── render the connect UI for the current status ────────────────────────────
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function render() {
    injectStyles();
    // configured:false → the proxy has no linking secrets; hide entirely.
    if (!state || state.configured === false) { mount.innerHTML = ''; return; }

    const connected = !!state.connected;
    let subCls = '', subHtml;
    if (!connected) {
      subHtml = 'Not linked — sync your Google Calendar';
    } else {
      const health = state.verified === true ? 'is-ok'
        : state.verified === false ? 'is-error' : '';
      subCls = health;
      const healthTxt = state.verified === true ? 'healthy'
        : state.verified === false ? 'reconnect needed' : (state.sync_enabled ? 'sync on' : 'sync paused');
      subHtml = '<span class="dot"></span>' + esc(state.email || 'Linked') + ' · ' + healthTxt;
    }

    let actions;
    if (!connected) {
      actions = '<button class="callink-btn" data-act="connect">Start Calendar Synchronization</button>';
    } else {
      actions =
        '<label class="callink-toggle" title="Mirror events to Google"><input type="checkbox" data-act="toggle"' +
          (state.sync_enabled ? ' checked' : '') + '>Sync</label>' +
        '<button class="callink-link" data-act="syncnow">Sync now</button>' +
        '<button class="callink-link" data-act="recheck">Recheck</button>' +
        '<button class="callink-link is-danger" data-act="disconnect">Disconnect</button>';
    }

    mount.innerHTML =
      '<div class="callink">' +
        '<span class="callink-emblem" aria-hidden="true"></span>' +
        '<div class="callink-body">' +
          '<div class="callink-title">Google Calendar</div>' +
          '<div class="callink-sub ' + subCls + '">' + subHtml + '</div>' +
        '</div>' +
        '<div class="callink-actions">' + actions + '</div>' +
      '</div>';
  }

  function setSub(text, cls) {
    const sub = mount.querySelector('.callink-sub');
    if (sub) { sub.textContent = text; sub.className = 'callink-sub ' + (cls || ''); }
  }

  // ── status polling ──────────────────────────────────────────────────────────
  async function refresh(opts) {
    opts = opts || {};
    try {
      const res = await authedFetch(API + '/api/calendar/status' + (opts.verify ? '?verify=1' : ''),
        { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const next = await res.json();
      // Preserve a known-good `verified` across cheap (non-verify) polls so the
      // health dot doesn't flicker back to unknown between rechecks.
      if (!opts.verify && state && typeof state.verified === 'boolean' && next.connected)
        next.verified = state.verified;
      state = next;
      render();
    } catch (e) {
      // Network/proxy hiccup: keep the last good UI, just note it if we have one.
      if (state && state.connected) setSub('Status unavailable — retrying…', 'is-warn');
    }
  }

  function startPolling() {
    if (polling) return;
    polling = setInterval(() => refresh(), POLL_MS);
  }

  // ── OAuth popup flow ────────────────────────────────────────────────────────
  function connect() {
    // Open the popup SYNCHRONOUSLY (inside the click) so blockers don't kill it,
    // then navigate it once the authed /start call returns the consent URL.
    const popup = window.open('about:blank', 'aptron-gcal',
      'width=520,height=660,menubar=no,toolbar=no,location=no,status=no');
    setSub('Opening Google…', '');
    authedFetch(API + '/api/oauth/google/start', { signal: AbortSignal.timeout(9000) })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(({ url }) => {
        if (!url) throw new Error('no url');
        if (popup && !popup.closed) popup.location.href = url;
        else setSub('Popup blocked — allow popups and retry', 'is-warn');
      })
      .catch(() => {
        if (popup && !popup.closed) popup.close();
        setSub('Couldn’t start linking — try again', 'is-error');
      });
  }

  async function toggleSync(enabled) {
    try {
      const res = await authedFetch(API + '/api/calendar/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const { sync_enabled } = await res.json();
      if (state) state.sync_enabled = !!sync_enabled;
      render();
    } catch (e) { refresh(); }         // reconcile with the server on failure
  }

  async function syncNow() {
    setSub('Syncing with Google…', '');
    try {
      const res = await authedFetch(API + '/api/calendar/sync/trigger', { method: 'POST', signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await res.json().catch(() => ({}));
      // Show freshly pulled Google events, then re-read status/health.
      try { if (window.AptCal && window.AptCal.reload) window.AptCal.reload(); } catch (e) {}
      await refresh({ verify: true });
    } catch (e) { setSub('Sync failed — try again', 'is-error'); }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect Google Calendar? Sync will stop and the stored token is revoked.')) return;
    setSub('Disconnecting…', '');
    try {
      const res = await authedFetch(API + '/api/calendar/disconnect', { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state = Object.assign({}, state, { connected: false, email: null, sync_enabled: false, verified: undefined });
      render();
      // The server drops the mirrored rows on disconnect; reload so the calendar
      // clears immediately instead of showing stale events until the next fetch.
      try { if (window.AptCal && window.AptCal.reload) window.AptCal.reload(); } catch (e) {}
    } catch (e) { setSub('Couldn’t disconnect — try again', 'is-error'); }
  }

  // ── events ──────────────────────────────────────────────────────────────────
  mount.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'connect') connect();
    else if (act === 'syncnow') syncNow();
    else if (act === 'recheck') { setSub('Checking token…', ''); refresh({ verify: true }); }
    else if (act === 'disconnect') disconnect();
  });
  mount.addEventListener('change', (e) => {
    const t = e.target.closest('[data-act="toggle"]');
    if (t) toggleSync(t.checked);
  });

  // The popup's callback page posts back {source:'aptron-oauth', ok, message}.
  // We key off the source tag rather than e.origin because in local dev the proxy
  // origin differs from the dashboard's. This message only drives the cosmetic
  // celebration + a status refresh; the AUTHORITATIVE state comes from the authed
  // /api/calendar/status call below, so a spoofed message can't grant anything.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'aptron-oauth') return;
    if (d.ok) {
      // Drive the first mirror from the client: the serverless OAuth callback
      // can't run a reliable background sync (its instance is frozen once the
      // popup response is sent). An AWAITED trigger pulls Google → events table
      // in a real request, sets last_sync_at, then reloads the calendar (syncNow
      // handles the reload + status refresh on success).
      refresh({ verify: true }).then(() => { celebrate(state && state.email); syncNow(); });
    } else {
      setSub(d.message || 'Linking failed — try again', 'is-error');
    }
  });

  // ── boot ────────────────────────────────────────────────────────────────────
  refresh({ verify: true }).then(startPolling);

  // Exposed for debugging / manual QA (e.g. AptCalLink.celebrate()).
  window.AptCalLink = { refresh, connect, celebrate, get status() { return state; } };
})();
