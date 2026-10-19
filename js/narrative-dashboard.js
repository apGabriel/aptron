// =============================================================================
// NARRATIVE DASHBOARD — Goal 4.1 (Narrative Dashboard Refinement), feature-
// flagged behind html.narrative-on (set synchronously by the inline script in
// index.html's <head>, before first paint). Entirely inert when the flag is
// off — every line below returns immediately, touching no DOM the classic
// dashboard uses.
//
// Refinement over the Goal 4 prototype: the goal is not "a nicer dashboard,"
// it's dissolving the FEELING of a dashboard — no section labels, no pill
// row of chips, one primary action instead of up to three, and a story that
// is genuinely one written paragraph (server-synthesized from up to 3
// pre-ranked facts) instead of client-side string concatenation. Still zero
// new reasoning: the ranking is the same ADR-019 selectTopSignals(), and the
// one addition (an optional "trained yesterday" fact) is appended to the
// SAME pre-verified-facts contract the model already can't exceed.
// =============================================================================
'use strict';

(function () {
  if (!document.documentElement.classList.contains('narrative-on')) return;

  var storyEl = document.getElementById('narrStory');
  var actionsEl = document.getElementById('narrActions');
  var momentsEl = document.getElementById('narrMoments');
  if (!storyEl || !actionsEl || !momentsEl) return;

  // ── Looking for something specific? — reveal toggles for the classic
  // surfaces. Nothing here is deleted; each classic section still exists
  // exactly as before, just display:none by default under html.narrative-on
  // (see css/narrative.css) until explicitly revealed. ─────────────────────
  function syncGridVisibility() {
    var grid = document.getElementById('classicGrid');
    var cal = document.getElementById('classicCal');
    var chat = document.querySelector('.aios-chat');
    if (!grid) return;
    var anyShown = (cal && cal.classList.contains('narr-show')) || (chat && chat.classList.contains('narr-show'));
    grid.classList.toggle('narr-show', anyShown);
  }
  function reveal(key) {
    if (key === 'notes') {
      var notes = document.getElementById('classicNotes');
      if (!notes) return;
      var showingNotes = notes.classList.toggle('narr-show');
      if (showingNotes) notes.scrollIntoView({ block: 'start' });
      return;
    }
    var el = key === 'cal' ? document.getElementById('classicCal') : document.querySelector('.aios-chat');
    if (!el) return;
    var showing = el.classList.toggle('narr-show');
    syncGridVisibility();
    if (showing) el.scrollIntoView({ block: 'start' });
  }
  document.querySelectorAll('.narr-else-link[data-reveal]').forEach(function (btn) {
    btn.addEventListener('click', function () { reveal(btn.getAttribute('data-reveal')); });
  });
  var settingsBtn = document.getElementById('narrSettingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', function () {
      var acct = document.getElementById('acctBtn');
      if (acct) acct.click();
    });
  }

  // ── Meal streak (reuses the shared js/streak-engine.js, same pattern as
  // health.js's own renderMealStreak()). ───────────────────────────────────
  function computeMealStreak() {
    var food;
    try { food = JSON.parse(localStorage.getItem('po_food_v1') || 'null'); } catch (e) { food = null; }
    if (!food || typeof food !== 'object' || !window.StreakEngine || typeof activeFoodDayKey !== 'function') return null;
    var hitDays = {};
    Object.keys(food).forEach(function (k) {
      if (Array.isArray(food[k]) && food[k].length > 0) hitDays[k] = true;
    });
    var result = window.StreakEngine.compute(hitDays, activeFoodDayKey());
    return result.current > 0 ? result.current : null;
  }

  function nextMeeting(events, now) {
    var upcoming = (events || [])
      .filter(function (e) { return !e.allDay && new Date(e.end) > now; })
      .sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    return upcoming.length ? upcoming[0] : null;
  }
  function fmtClockLocal(d) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ── Moments — only genuinely additive facts the story doesn't already
  // carry: what's coming later today, and a positive habit signal. No
  // calendar-openness or "trained N days ago" chip here anymore — those are
  // now woven into the story paragraph itself (see run()), so repeating them
  // here would just be the same fact said twice in two different voices. ──
  function buildMoments(data) {
    var moments = [];
    var next = nextMeeting(data.events, data.now);
    if (next) moments.push({ label: 'Later today', value: next.title + ' at ' + fmtClockLocal(new Date(next.start)) });
    var streak = computeMealStreak();
    if (streak) moments.push({ label: 'Meal streak', value: streak + (streak === 1 ? ' day' : ' days') });
    return moments;
  }

  // ── One primary action, never a row of buttons. If more than one is
  // justified, only the highest-priority one is shown — a second button
  // competing for attention is exactly the "toolbar" feeling Goal 4.1 asks
  // to remove; a lower-priority justified action simply isn't shown this
  // visit rather than crowding the one that matters most. ─────────────────
  function primaryAction(data) {
    if (data.gym && data.gym.workoutInProgress) return { label: 'Continue Workout', kind: 'link', href: 'gym.html' };
    if (data.calSigs.length) return { label: 'Open today’s calendar', kind: 'reveal', target: 'cal' };
    if (data.healthSigs.some(function (s) { return s.key === 'low_water'; })) return { label: 'Log water', kind: 'link', href: 'health.html#water' };
    if (data.healthSigs.some(function (s) { return s.key === 'no_meals'; })) return { label: 'Log lunch', kind: 'link', href: 'health.html' };
    if (data.gymRecent && (data.gymRecent.daysAgo === 0 || data.gymRecent.daysAgo === 1)) return { label: 'Review yesterday', kind: 'link', href: 'gym.html' };
    return null;
  }

  function render(data, storyText) {
    storyEl.textContent = storyText;

    actionsEl.innerHTML = '';
    var action = primaryAction(data);
    if (action) {
      var el = document.createElement(action.kind === 'link' ? 'a' : 'button');
      el.className = 'narr-action';
      el.textContent = action.label;
      if (action.kind === 'link') { el.href = action.href; }
      else { el.type = 'button'; el.addEventListener('click', function () { reveal(action.target); }); }
      actionsEl.appendChild(el);
    }

    momentsEl.innerHTML = '';
    buildMoments(data).forEach(function (m) {
      var wrap = document.createElement('div');
      wrap.className = 'narr-moment';
      var label = document.createElement('p');
      label.className = 'narr-moment-label';
      label.textContent = m.label;
      var value = document.createElement('p');
      value.className = 'narr-moment-value';
      value.textContent = m.value;
      wrap.appendChild(label);
      wrap.appendChild(value);
      momentsEl.appendChild(wrap);
    });
  }

  async function run() {
    // SHENLONG P2 (2026-09-10): same fix as js/index.js's greet() — this
    // function's own 6500ms safety-net (below) used to call straight into
    // todayGymSummary()/todayHealthSummary()/recentGymSession() with no
    // auth-readiness check, so a slow auth check on a browser still holding
    // a previous account's data could latch a stale-account story into
    // storyEl with no later re-render (see `started` guard below). Same
    // defensive `|| Promise.resolve()` AptCal.getClient() already uses, so
    // this still resolves immediately in local-only mode.
    await (window.APP_AUTH_READY || Promise.resolve());
    if (typeof window.__synthesizeBrief !== 'function' || !window.AptCal) {
      storyEl.textContent = 'Your day is still loading.';
      return;
    }
    var now = new Date();
    var events = window.AptCal.getEvents();
    var health = typeof todayHealthSummary === 'function' ? todayHealthSummary() : null;
    var gym = typeof todayGymSummary === 'function' ? todayGymSummary() : null;
    var gymRecent = typeof recentGymSession === 'function' ? recentGymSession() : null;

    var greeting = typeof window.__aiosGreeting === 'function' ? window.__aiosGreeting() : 'Hello';

    if (gym && gym.workoutInProgress) {
      var sessionText = 'You have an open ' + (gym.pinnedRoutineName || 'workout') + ' session'
        + (gym.setsLoggedInOpenSession ? ' — ' + gym.setsLoggedInOpenSession + ' set' + (gym.setsLoggedInOpenSession === 1 ? '' : 's') + ' logged' : '')
        + '. Resume when ready.';
      render({ now: now, events: events, health: health, gym: gym, gymRecent: gymRecent, calSigs: [], healthSigs: [] }, greeting + '. ' + sessionText);
      return;
    }

    var calSigs = computeCalendarSignals(events, now);
    var healthSigs = computeHealthSignals(health, now.getHours()).concat(computeGymSignals(gymRecent));
    var selected = selectTopSignals(calSigs, healthSigs);

    // The one addition beyond the classic ADR-019 ranking: a "trained
    // yesterday" fact, appended only if it isn't already the body-fact
    // selectTopSignals picked (avoids handing the model the same fact twice
    // under two different domain tags). Still capped — 2 from the ranking
    // plus at most 1 more, never more than 3 total, matching the proxy's
    // own cap.
    var narrativeSignals = selected.slice();
    if (gymRecent && gymRecent.daysAgo === 1) {
      var alreadyHasIt = selected.some(function (s) { return s.key === 'trained_yesterday'; });
      if (!alreadyHasIt) narrativeSignals.push({ tier: 3, domain: 'gym', key: 'trained_yesterday', fact: 'Trained "' + gymRecent.label + '" yesterday.' });
    }

    var data = { now: now, events: events, health: health, gym: gym, gymRecent: gymRecent, calSigs: calSigs, healthSigs: healthSigs };

    var briefText;
    try { briefText = await window.__synthesizeBrief(narrativeSignals, events.length > 0); }
    catch (e) { briefText = 'Your day is ready when you are.'; }

    // The greeting stays deterministic and is always prepended here — never
    // delegated to the model (see the proxy's "do NOT open with a greeting"
    // instruction). A greeting is a function of the clock, not something
    // worth a model call, or a risk of a duplicated "Good morning" if the
    // model ever ignored that instruction.
    var story = (greeting + '. ' + briefText).replace(/\s+/g, ' ').trim();
    render(data, story);
  }

  // Same readiness pattern greet() already uses in js/index.js — fires once
  // the calendar's first load resolves, with an identical safety-net timeout
  // so a slow/offline calendar never leaves the story stuck on "Reading your
  // day…" indefinitely.
  var started = false;
  function start() { if (started) return; started = true; run(); }
  window.addEventListener('apt:calendar-loaded', start, { once: true });
  setTimeout(start, 6500); // slightly after greet()'s own 6000ms so window.AptCal is guaranteed present
})();
