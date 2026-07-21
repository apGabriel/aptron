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

  // ── styles (Shenlong gold-on-slate, matching js/auth/main.js) ───────────────
  function injectStyles() {
    if (document.getElementById('callink-styles')) return;
    const s = document.createElement('style');
    s.id = 'callink-styles';
    s.textContent = `
.callink {
  position: relative; overflow: hidden;
  margin: 2px 0 12px; padding: 16px 18px;
  border: 1px solid rgba(210,188,138,0.20); border-radius: 15px;
  background:
    radial-gradient(90% 130% at 6% -20%, rgba(149,101,52,0.22) 0%, transparent 46%),
    linear-gradient(180deg, rgba(58,56,52,0.60), rgba(31,30,28,0.62));
  box-shadow: 0 8px 26px rgba(0,0,0,0.35);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
  transition: border-color .18s ease, box-shadow .18s ease;
}
.callink[hidden] { display: none; }
.callink:hover {
  border-color: rgba(210,188,138,0.42);
  box-shadow: 0 10px 30px rgba(0,0,0,0.40), 0 0 24px rgba(149,101,52,0.14);
}
/* faint gold hairline along the top edge */
.callink::before {
  content: ""; position: absolute; top: 0; left: 14px; right: 14px; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(230,207,156,0.55), transparent);
}

.callink-top { display: flex; align-items: center; gap: 14px; }

/* Gold-ringed Shenlong medallion */
.callink-medallion {
  flex: 0 0 auto; position: relative; width: 46px; height: 46px; border-radius: 50%;
  display: grid; place-items: center;
  background:
    radial-gradient(circle at 50% 34%, rgba(230,207,156,0.16), transparent 70%),
    linear-gradient(180deg, rgba(230,207,156,0.10), rgba(149,101,52,0.05));
  box-shadow: 0 0 0 1px rgba(210,188,138,0.55) inset, 0 0 18px rgba(149,101,52,0.30);
  transition: box-shadow .18s ease;
}
/* A gold calendar glyph — NOT the Shenlong mark. Signals an external calendar
   integration and keeps it visually distinct from the native assistant orb,
   which carries the dragon. Inline SVG so it stays crisp at any viewport. */
.callink-medallion svg {
  width: 25px; height: 25px; display: block; color: #e6cf9c;
  fill: none; stroke: currentColor; stroke-width: 1.7;
  stroke-linecap: round; stroke-linejoin: round;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
}
.callink-medallion svg .fillday { fill: currentColor; stroke: none; }
/* amber-tinted medallion when the connection needs attention */
.callink.is-warn .callink-medallion {
  box-shadow: 0 0 0 1px rgba(230,178,90,0.55) inset, 0 0 18px rgba(230,178,90,0.28);
}
.callink.is-warn .callink-medallion svg { color: #f0cf8f; }

.callink-body { flex: 1 1 auto; min-width: 0; }
.callink-titlerow { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.callink-title { font-size: 14.5px; font-weight: 650; color: #efe7d3; letter-spacing: 0.01em; }

/* Non-interactive pill stating permanence — replaces the old sync checkbox. */
.callink-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  color: #e6cf9c; padding: 3px 9px 3px 8px; border-radius: 999px;
  border: 1px solid rgba(210,188,138,0.38);
  background: linear-gradient(180deg, rgba(210,188,138,0.16), rgba(210,188,138,0.06));
}
.callink-pill .swap { font-size: 11px; line-height: 1; }

.callink-sub {
  display: flex; align-items: center; gap: 7px; font-size: 12.5px;
  color: rgba(255,255,255,0.55); margin-top: 5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.callink-sub .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: rgba(255,255,255,0.35); }
.callink-sub.is-ok    .dot { background: #6fcf97; box-shadow: 0 0 7px rgba(111,207,151,0.7); }
.callink-sub.is-warn  .dot { background: #e6b25a; box-shadow: 0 0 7px rgba(230,178,90,0.7); }
.callink-sub.is-error .dot { background: #e98b7f; }
.callink-sub .sep { color: rgba(255,255,255,0.30); }
.callink-sub .state { font-weight: 550; }
.callink-sub.is-ok   .state { color: #6fcf97; }
.callink-sub.is-warn .state { color: #e6b25a; }

/* gold hairline divider */
.callink-rule {
  height: 1px; margin: 14px 0 12px;
  background: linear-gradient(90deg, transparent, rgba(210,188,138,0.22) 20%, rgba(210,188,138,0.22) 80%, transparent);
}

.callink-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.callink-caption { font-size: 12px; line-height: 1.45; color: rgba(255,255,255,0.38); max-width: 300px; margin: 0; }
.callink-caption b { color: rgba(255,255,255,0.6); font-weight: 600; }
.callink.is-warn .callink-caption b { color: #e6b25a; }

.callink-actions { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; }
.callink-link {
  display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
  font-family: inherit; font-size: 12px; font-weight: 550; color: #d2bc8a; cursor: pointer;
  padding: 7px 11px; border-radius: 9px; border: 1px solid rgba(210,188,138,0.22);
  background: rgba(210,188,138,0.04);
  transition: background .15s, border-color .15s, color .15s, transform .12s;
}
.callink-link svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.callink-link:hover { background: rgba(210,188,138,0.10); border-color: rgba(210,188,138,0.45); color: #e6cf9c; transform: translateY(-1px); }
.callink-link.ghost { color: rgba(255,255,255,0.55); border-color: rgba(255,255,255,0.08); background: transparent; }
.callink-link.ghost:hover { color: #e98b7f; border-color: rgba(233,139,127,0.40); background: rgba(233,139,127,0.06); }

/* prominent reconnect CTA shown when the stored token is dead/expired */
.callink-link.is-reconnect {
  color: #1a1408; font-weight: 700; border: none;
  background: linear-gradient(180deg, #f0cf8f 0%, #e6b25a 55%, #cf9838 100%);
  box-shadow: 0 1px 0 rgba(255,255,255,0.30) inset, 0 4px 12px rgba(207,152,56,0.30);
}
.callink-link.is-reconnect:hover { color: #1a1408; filter: brightness(1.05); transform: translateY(-1px); }

/* primary connect CTA (not-linked state) */
.callink-cta {
  flex: none; padding: 10px 16px; font-size: 13px; font-weight: 700; font-family: inherit;
  color: #1a1408; cursor: pointer; border: none; border-radius: 11px; white-space: nowrap;
  background: linear-gradient(180deg, #e6cf9c 0%, #d2bc8a 48%, #b8a06e 100%);
  box-shadow: 0 1px 0 rgba(255,255,255,0.35) inset, 0 6px 16px rgba(149,101,52,0.28);
  transition: transform .14s, filter .14s;
}
.callink-cta:hover { transform: translateY(-1px); filter: brightness(1.05); }
.callink-cta:active { transform: translateY(0) scale(0.985); }

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

  // The medallion glyph — a clean gold calendar (rounded body, binder tabs,
  // header rule, one filled "event" day). Replaces the Shenlong mask so this
  // integration reads distinctly from the assistant's dragon orb.
  const ICON_GCAL =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="3" y="5" width="18" height="16" rx="2.5"/>' +
      '<path d="M3 9.5h18"/>' +
      '<path d="M8 2.5v4"/><path d="M16 2.5v4"/>' +
      '<rect class="fillday" x="6.8" y="12.4" width="3.4" height="3.4" rx="0.9"/>' +
    '</svg>';

  // Inline stroke icons (match the calendar refresh / external-link marks).
  const ICON_REFRESH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  const ICON_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/></svg>';

  function render() {
    injectStyles();
    // configured:false → the proxy has no linking secrets; hide entirely.
    if (!state || state.configured === false) { mount.innerHTML = ''; return; }

    // ── not linked: single-row card with the primary connect CTA ─────────────
    if (!state.connected) {
      mount.innerHTML =
        '<div class="callink">' +
          '<div class="callink-top">' +
            '<span class="callink-medallion" aria-hidden="true">' + ICON_GCAL + '</span>' +
            '<div class="callink-body">' +
              '<div class="callink-title">Google Calendar</div>' +
              '<div class="callink-sub">Not linked — sync your Google Calendar</div>' +
            '</div>' +
            '<button class="callink-cta" data-act="connect">Start Calendar Synchronization</button>' +
          '</div>' +
        '</div>';
      return;
    }

    // ── linked: premium two-row card. Sync is permanent & two-way; there is no
    //    opt-out. The only conditional chrome is the health state: a dead/expired
    //    refresh token (verified === false) flips the dot amber and swaps the
    //    "Refresh events" action for a prominent "Reconnect Account" CTA. ───────
    const needsReconnect = state.verified === false;
    const healthCls = needsReconnect ? 'is-warn' : 'is-ok';
    const stateTxt = needsReconnect ? 'Reconnect needed' : 'Connected';
    const caption = needsReconnect
      ? 'Your Google connection <b>expired</b>. Reconnect to resume two-way sync — your existing blocks are safe.'
      : 'Blocks you create here appear in Google — and Google events appear here — <b>automatically, both ways</b>. Nothing to switch on.';
    const primaryAction = needsReconnect
      ? '<button class="callink-link is-reconnect" data-act="connect">Reconnect Account</button>'
      : '<button class="callink-link" data-act="syncnow">' + ICON_REFRESH + 'Refresh events</button>';

    mount.innerHTML =
      '<div class="callink ' + healthCls + '">' +
        '<div class="callink-top">' +
          '<span class="callink-medallion" aria-hidden="true">' + ICON_GCAL + '</span>' +
          '<div class="callink-body">' +
            '<div class="callink-titlerow">' +
              '<span class="callink-title">Google Calendar</span>' +
              '<span class="callink-pill" title="Sync runs automatically in both directions and can’t be turned off"><span class="swap">⇄</span> Two-way · Always on</span>' +
            '</div>' +
            '<div class="callink-sub ' + healthCls + '">' +
              '<span class="dot" aria-hidden="true"></span>' +
              '<span class="email">' + esc(state.email || 'Linked') + '</span>' +
              '<span class="sep">·</span>' +
              '<span class="state">' + stateTxt + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="callink-rule" aria-hidden="true"></div>' +
        '<div class="callink-foot">' +
          '<p class="callink-caption">' + caption + '</p>' +
          '<div class="callink-actions">' +
            primaryAction +
            '<a class="callink-link" data-act="open" href="https://calendar.google.com/" target="_blank" rel="noopener">' + ICON_OPEN + 'Open in Google Calendar</a>' +
            '<button class="callink-link ghost" data-act="disconnect">Disconnect</button>' +
          '</div>' +
        '</div>' +
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
      state = Object.assign({}, state, { connected: false, email: null, verified: undefined });
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
    // 'open' is a real <a href> → let the browser handle navigation.
    if (act === 'connect') connect();          // also drives Reconnect Account
    else if (act === 'syncnow') syncNow();      // "Refresh events"
    else if (act === 'disconnect') disconnect();
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
