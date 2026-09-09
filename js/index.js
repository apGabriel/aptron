// =============================================================================
// Calendar-first AI dashboard.
//   • Supabase (public.events, RLS-scoped to the logged-in user) is the source
//     of truth for the day's blocks — no proxy in the hot path. The engine below
//     exposes a small window.AptCal API so the assistant can read + mutate it.
//   • The Assistant is HYBRID: a synchronous local intent parser handles the
//     common tactical commands instantly/offline (and is fully previewable);
//     anything it can't match is forwarded to the Gemini proxy route
//     (/api/gemini/assistant) for free-form understanding when deployed.
//   • A tiny synced Quick-Notes inbox replaces the old to-do lists.
// No framework, no build step.
// =============================================================================
'use strict';

// ── Shared date helpers ──────────────────────────────────────────────────────
function padZ(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + padZ(d.getMonth() + 1) + '-' + padZ(d.getDate());
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Cross-module context readers (pre-Shelron stopgap, see Shelron.md § v0.2) ─
// Top-level (not nested in any IIFE) so BOTH the calendar block's summarize()
// and the assistant's askGemini() can call them — index.html never loads
// js/health.js/gym/*.js/wardrobe.js (separate static pages), so localStorage
// is the only channel into their state, read-only. A field left null means
// "no data available"; callers must say so, never guess (Shenlong Intelligence
// pass, 2026-08-03).
function activeFoodDayKey() {
  const now = new Date();
  if (now.getHours() < 6) now.setDate(now.getDate() - 1);
  return now.getFullYear() + '-' + padZ(now.getMonth() + 1) + '-' + padZ(now.getDate());
}
function todayHealthSummary() {
  let waterMlToday = null, mealsLoggedToday = null;
  try {
    const w = JSON.parse(localStorage.getItem('po_water_v1') || 'null');
    if (w && w.logs) waterMlToday = Number(w.logs[todayStr()]) || 0;
  } catch (e) {}
  try {
    const f = JSON.parse(localStorage.getItem('po_food_v1') || 'null');
    if (f) mealsLoggedToday = (f[activeFoodDayKey()] || []).length;
  } catch (e) {}
  if (waterMlToday === null && mealsLoggedToday === null) return null;
  return { waterMlToday, mealsLoggedToday };
}
function todayGymSummary() {
  let coach;
  try { coach = JSON.parse(localStorage.getItem('po_coach_v1') || 'null'); } catch (e) { coach = null; }
  if (!coach) return null;
  let routines = [];
  try { routines = JSON.parse(localStorage.getItem('rb_routines_v1') || '[]'); } catch (e) {}
  const pinned = Array.isArray(routines) ? routines.find(r => r.id === coach.filterRoutine) : null;
  const openSession = Array.isArray(coach.sessions) ? coach.sessions.find(s => !s.endedAt) : null;
  return {
    pinnedRoutineName: pinned ? pinned.name : null,
    pinnedRoutineExerciseCount: pinned ? (pinned.exercises || []).length : null,
    workoutInProgress: !!openSession,
    setsLoggedInOpenSession: openSession ? (openSession.sets || []).length : 0,
  };
}
// Known Issue #53's companion finding: a direct "what workout do I have
// today?" question used to be answered entirely by the Calendar summarizer
// (which only knows about `events`), even when a real routine was scheduled
// for today. Mirrors js/gym/gym-storage.js's own todaysScheduledRoutine() —
// same WEEKDAY_CODES/trainingDays match — rather than inventing a second
// selection algorithm; duplicated (not called) because index.html never
// loads the Gym module suite (window.GymApp doesn't exist here). Read-only.
function todaysScheduledRoutineName() {
  let routines = [];
  try { routines = JSON.parse(localStorage.getItem('rb_routines_v1') || '[]'); } catch (e) {}
  if (!Array.isArray(routines) || !routines.length) return null;
  const WEEKDAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const code = WEEKDAY_CODES[new Date().getDay()];
  const scheduled = routines.find(r => Array.isArray(r.trainingDays) && r.trainingDays.includes(code));
  return scheduled ? scheduled.name : null;
}
// ── Scoped local memory (Shenlong Intelligence pass, 2026-08-03) ─────────────
// Durable, user-scoped facts/preferences — deliberately NOT a vector store or
// new database table (per [[Shelron]]'s engine-by-engine order, the real
// Memory Engine is still future work). A capped, deduped localStorage list;
// writes only ever go through rememberFact() (below), which the model can
// request via the `remember_fact` intent but never writes directly — "AI
// proposes, deterministic code disposes" applies here exactly like every
// other intent. Distinguishes persistent facts (this) from session-only
// chat history (never persisted at all, lives only in the DOM chat log) and
// temporary context (calendar/gym/health/wardrobe snapshots, re-read fresh
// every request, never stored here).
const MEMORY_KEY = 'shenlong_memory_v1';
const MEMORY_MAX = 15;
const MEMORY_FACT_MAX_LEN = 140;
function readMemory() {
  try {
    const arr = JSON.parse(localStorage.getItem(MEMORY_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeMemory(arr) {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(arr)); } catch (e) {}
}
// Deterministic validation: trim/cap length, skip near-duplicates (case-
// insensitive substring match either direction), evict oldest past MEMORY_MAX.
// Returns the stored fact string, or null if rejected (empty/duplicate).
function rememberFact(text) {
  const clean = String(text || '').trim().slice(0, MEMORY_FACT_MAX_LEN);
  if (!clean) return null;
  const facts = readMemory();
  const norm = clean.toLowerCase();
  // Exact match only (not substring containment) — substring matching was
  // tried and rejected: "fact number 1" is a substring of "fact number 10"
  // through "fact number 19", so it false-positived every one of them as a
  // "duplicate" of the first. Found by the Shenlong Intelligence pass test
  // suite (2026-08-03). Near-duplicate detection is inherently fuzzy; exact
  // match is the boring, predictable choice — a truly repeated fact is
  // common, a coincidental shared prefix is not worth the false-positive risk.
  const isDup = facts.some((f) => String(f.text || '').toLowerCase() === norm);
  if (isDup) return null;
  facts.push({ text: clean, savedAt: Date.now() });
  while (facts.length > MEMORY_MAX) facts.shift(); // evict oldest
  writeMemory(facts);
  return clean;
}
function memoryFactTexts() { return readMemory().map((f) => f.text); }

// ── Deterministic intent-domain classification ───────────────────────────────
// Step 1 of the reasoning pipeline (Shenlong Intelligence pass, 2026-08-03):
// classify BEFORE gathering context, so context gathering (step 2) can be
// selective instead of dumping every domain into every prompt. Pure keyword
// matching — deterministic and instantly testable, no model call. Returns one
// of 'calendar' | 'gym' | 'health' | 'wardrobe' | 'knowledge' | 'general' |
// 'multi' | 'unknown'. 'knowledge' is defined for schema completeness (the
// brief's category list) but has no real data source yet — no Knowledge
// module exists (see [[Roadmap]] "Ideas") — so it never actually matches
// today; left in so classification doesn't silently need a rewrite when that
// module lands.
// Deliberately NOT included here: bare "today"/"tomorrow"/"tonight"/
// "weekend"/"this week" — they're generic time modifiers used across every
// domain ("my workout today", "water today", "outfit today"), not calendar-
// specific signals. Including them originally caused "what's my workout
// routine today" to misclassify as 'multi' (gym + calendar both "matching")
// instead of 'gym' — found by the Shenlong Intelligence pass test suite
// (2026-08-03) and removed.
const DOMAIN_KEYWORDS = {
  calendar: /\b(calendar|schedule|event|meeting|appointment|block|reschedule|agenda|free time|busy|plan(s|ned)?)\b/i,
  gym: /\b(gym|workout|work out|train(ed|ing)?|exercise|routine|reps?|sets?|squat|bench|deadlift|cardio|lift(ing)?|\bpr\b|personal record)\b/i,
  health: /\b(water|hydrat|meal|food|eat(en|ing)?|calorie|macro|protein|carbs?|fats?|stack|supplement|nutrition)\b/i,
  // "top"/"tops" deliberately excluded — collides with this app's own gym
  // terminology ("log today's top set"), which would misclassify a gym
  // question as 'multi'. Caught during design, before it ever shipped.
  wardrobe: /\b(outfit|wear|wearing|clothes|clothing|wardrobe|closet|dress(ed)?|jackets?|shirts?|pants|shoes?|sweaters?|coats?|bottoms?|outerwear|footwear|accessor(?:y|ies))\b/i,
};
const GENERAL_PATTERN = /\b(what should i do|what('?s| is) (on|up|going on)|how('?s| is) my day|good morning|good afternoon|good evening|\bhi\b|\bhey\b|hello|free hour|catch me up|summary|recap)\b/i;
function classifyIntentDomain(message) {
  const t = String(message || '');
  const matched = Object.keys(DOMAIN_KEYWORDS).filter((d) => DOMAIN_KEYWORDS[d].test(t));
  if (matched.length >= 2) return 'multi';
  if (matched.length === 1) return matched[0];
  if (GENERAL_PATTERN.test(t)) return 'general';
  return 'unknown';
}

// ── Deterministic proactive nudge (Shenlong Intelligence pass, 2026-08-03) ───
// Zero LLM calls, zero background jobs/timers — this only ever runs inside
// summarize() (below), i.e. only when the user already asked "what's on
// today"/greeted, never unprompted. Reuses the exact same gym/health readers
// askGemini() uses; no new data, no invented judgment. At most ONE nudge,
// picked by priority, and only when the underlying fact is unambiguously
// true — "never interrupt, never spam, only high-value insights."
function proactiveNudge() {
  const gym = todayGymSummary();
  if (gym && gym.workoutInProgress) {
    return 'You have an open ' + (gym.pinnedRoutineName || 'workout') + ' session'
      + (gym.setsLoggedInOpenSession ? ' — ' + gym.setsLoggedInOpenSession + ' set' + (gym.setsLoggedInOpenSession === 1 ? '' : 's') + ' logged' : '')
      + '. Resume when ready.';
  }
  const hour = new Date().getHours();
  if (hour < 14) return null; // too early in the day for a "nothing logged yet" nudge to be useful, not just true
  const health = todayHealthSummary();
  if (health && health.waterMlToday === 0) return "You haven't logged any water today.";
  if (health && health.mealsLoggedToday === 0) return "No meals logged today yet.";
  return null;
}

// ── Unified Daily Brief (Product Constitution / Unified Intelligence Strategy,
// implemented 2026-08-04) — deterministic signal gathering + ranking. This is
// the reasoning layer in front of the proactive greeting: it decides WHICH
// facts are worth mentioning today and in what priority, before any model
// call happens. "AI proposes, deterministic code disposes" applies here in
// its purest form yet — the model never sees raw module state, only the
// short list of facts this code already selected; it may only phrase them,
// never add to them. See generateDailyBrief() below (assistant IIFE) for the
// orchestration and js/../proxy/server.js's `mode: 'daily_brief'` branch for
// the synthesis prompt.
function fmtClock(d) { return padZ(d.getHours()) + ':' + padZ(d.getMinutes()); }
function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

// Most recent COMPLETED gym session (any day, not just today) — reads the
// same `po_coach_v1.sessions` array todayGymSummary() reads, just the
// endedAt/label fields that reader doesn't need. `label` is the routine name
// captured at log time (gym-storage.js's currentSessionLabel()), so no
// separate routine lookup/join is required.
function recentGymSession() {
  let coach;
  try { coach = JSON.parse(localStorage.getItem('po_coach_v1') || 'null'); } catch (e) { coach = null; }
  if (!coach || !Array.isArray(coach.sessions)) return null;
  const ended = coach.sessions.filter((s) => s.endedAt).sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt));
  if (!ended.length) return null;
  const last = ended[0];
  const daysAgo = Math.round((dateOnly(new Date()) - dateOnly(new Date(last.endedAt))) / 86400000);
  return { label: last.label || 'a workout', daysAgo };
}

// Priority tier 1 ("urgent calendar conflicts") — pure deterministic math
// over today's events (window.AptCal.getEvents()). No new table, no new API:
// this is free/busy arithmetic, the kind of thing that has a right answer
// and must never be left to a model (Product Constitution, Part II/III).
// At most one conflict fact and one busy-day fact are ever produced (the
// caller picks one calendar fact overall — see selectTopSignals) — this
// function may return more than one candidate so the caller has a choice.
function computeCalendarSignals(events, now) {
  const sigs = [];
  const timed = (events || []).filter((e) => !e.allDay)
    .map((e) => ({ title: e.title, s: new Date(e.start), e: new Date(e.end) }))
    .sort((a, b) => a.s - b.s);
  // Deliberately no early return for an empty `timed` — a fully open day must
  // still reach the free-block check below (an empty calendar IS a free
  // block), otherwise the "empty afternoon, good day to batch errands" case
  // could never fire. The conflict loop and busy-day check below are already
  // no-ops on 0-1 events, so nothing needs to guard against that separately.
  for (let i = 1; i < timed.length; i++) {
    if (timed[i].s < timed[i - 1].e) {
      sigs.push({
        tier: 1, domain: 'calendar', key: 'conflict',
        fact: '"' + timed[i - 1].title + '" (' + fmtClock(timed[i - 1].s) + '–' + fmtClock(timed[i - 1].e) +
          ') overlaps "' + timed[i].title + '" (' + fmtClock(timed[i].s) + '–' + fmtClock(timed[i].e) + ').',
      });
      break; // one conflict fact is enough — the brief states one conclusion, not a list
    }
  }

  const totalMin = timed.reduce((sum, ev) => sum + (ev.e - ev.s) / 60000, 0);
  if (timed.length >= 5 || totalMin >= 300) {
    sigs.push({
      tier: 1, domain: 'calendar', key: 'busy',
      fact: timed.length + ' blocks scheduled today, about ' + (Math.round(totalMin / 6) / 10) + 'h total.',
    });
  }

  // Largest free gap between now and a 22:00 cutoff — deliberately not
  // suggesting anything start later than that (protects the evening/rest,
  // Product Constitution Law III/Part III "silence vs helpfulness").
  const windowEnd = new Date(now); windowEnd.setHours(22, 0, 0, 0);
  if (now < windowEnd) {
    let cursor = new Date(now);
    let bestStart = null, bestEnd = null, bestMs = 0;
    timed.filter((ev) => ev.e > now).forEach((ev) => {
      const capped = ev.s < windowEnd ? ev.s : windowEnd;
      if (capped > cursor) {
        const gapMs = capped - cursor;
        if (gapMs > bestMs) { bestMs = gapMs; bestStart = cursor; bestEnd = capped; }
      }
      if (ev.e > cursor) cursor = ev.e;
    });
    if (windowEnd > cursor) {
      const gapMs = windowEnd - cursor;
      if (gapMs > bestMs) { bestMs = gapMs; bestStart = cursor; bestEnd = windowEnd; }
    }
    if (bestMs >= 120 * 60000) {
      const openEnded = bestEnd.getTime() === windowEnd.getTime();
      sigs.push({
        tier: 1, domain: 'calendar', key: 'free_block',
        fact: openEnded
          ? 'Free from ' + fmtClock(bestStart) + ' onward.'
          : 'Free from ' + fmtClock(bestStart) + ' to ' + fmtClock(bestEnd) + '.',
      });
    }
  }
  return sigs;
}

// Priority tiers 2 ("health conditions affecting today") and 4 ("meal
// consistency"). Aptron has no illness/symptom tracking and no sleep
// tracking today (Health's real surfaces are hydration + the food diary,
// see [[Health]]) — "health conditions" is deliberately interpreted as
// today's hydration/nutrition state, not fabricated, per ADR-017's grounding
// rule. Gated to hour >= 14 so a normal morning with nothing logged yet
// doesn't read as a problem (same guard proactiveNudge() already uses).
function computeHealthSignals(health, hour) {
  const sigs = [];
  if (!health) return sigs; // not fetched / nothing logged anywhere — say nothing, never invent
  if (hour >= 14 && health.waterMlToday != null && health.waterMlToday < 500) {
    sigs.push({ tier: 2, domain: 'health', key: 'low_water', fact: 'Only ' + health.waterMlToday + 'ml of water logged today.' });
  }
  if (hour >= 14 && health.mealsLoggedToday === 0) {
    sigs.push({ tier: 4, domain: 'meal', key: 'no_meals', fact: 'No meals logged yet today.' });
  }
  return sigs;
}

// Priority tier 3 ("workout recovery"). No plateau/deload flag is exposed to
// Shenlong yet (that's the prescription engine's own internal state,
// [[Roadmap]] "Gym analytics") — this stays to what's already readable today:
// how recently the user trained and what they trained.
function computeGymSignals(recent) {
  if (!recent || recent.daysAgo == null || recent.daysAgo < 0) return [];
  if (recent.daysAgo === 0) return [{ tier: 3, domain: 'gym', key: 'trained_today', fact: 'Already trained "' + recent.label + '" today.' }];
  if (recent.daysAgo === 1) return [{ tier: 3, domain: 'gym', key: 'trained_yesterday', fact: 'Trained "' + recent.label + '" yesterday.' }];
  if (recent.daysAgo <= 3) return [{ tier: 3, domain: 'gym', key: 'trained_recently', fact: 'Last trained "' + recent.label + '" ' + recent.daysAgo + ' days ago.' }];
  return [];
}

// One calendar fact + one body fact, max — "one conclusion, not three
// summaries." Combining exactly one signal from each side is what lets the
// brief connect domains ("free after 18:00" + "trained Push yesterday")
// instead of just picking the two loudest facts regardless of where they
// came from. Priority order within each side follows the brief exactly:
// calendar conflicts > busy day > free block; health > gym recovery > meals.
function selectTopSignals(calSigs, bodySigs) {
  function pick(pool, order) {
    for (const key of order) { const f = pool.find((s) => s.key === key); if (f) return f; }
    return null;
  }
  const calPick = pick(calSigs, ['conflict', 'busy', 'free_block']);
  const bodyPick = pick(bodySigs, ['low_water', 'trained_yesterday', 'trained_today', 'trained_recently', 'no_meals']);
  return [calPick, bodyPick].filter(Boolean);
}

// Fully deterministic phrasing, used when there's nothing to say, and as the
// offline-first fallback when the model is unreachable/slow/misconfigured —
// the greeting must never be blank or stuck (Offline First invariant). Never
// calls a model; always ends with a concrete suggestion per spec.
function deterministicBriefFallback(selected, hasEvents) {
  if (!selected.length) {
    return hasEvents
      ? "Today looks steady — no conflicts, nothing urgent flagged. You're clear to focus on what matters most."
      : 'Nothing on the calendar today — an open day. Good time to catch up on training, errands, or rest.';
  }
  const suggestion = {
    conflict: " I'd resolve that clash before the day gets away from you.",
    busy: " Keep today's plan tight — not the day to add anything extra.",
    free_block: ' Worth protecting that window for whatever matters most today.',
    low_water: ' Worth catching up before the day gets busier.',
    no_meals: ' Worth fitting in a real meal soon.',
    trained_yesterday: ' Good day to prioritize recovery or train something different.',
    trained_today: ' Recovery matters more than volume for the rest of today.',
    trained_recently: " You're due for your next session when it fits.",
  }[selected[0].key] || '';
  return selected.map((s) => s.fact).join(' ') + suggestion;
}

// Item counts only — deliberately no outfit/weather-suitability judgment.
// Wardrobe's own seasonality vector needs live weather, which is still a
// scaffolded placeholder ([[Roadmap]] "Wardrobe weather input") — Shenlong
// must not fabricate an opinion a real weather feed would be needed for.
function todayWardrobeSummary() {
  let items;
  try { items = JSON.parse(localStorage.getItem('wardrobe:items') || 'null'); } catch (e) { items = null; }
  if (!Array.isArray(items)) return null;
  const byCategory = {};
  items.forEach((it) => {
    const cat = (it && it.category) || 'other';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  });
  let savedOutfitCount = 0;
  try {
    const saved = JSON.parse(localStorage.getItem('wardrobe:saved_outfits') || 'null');
    if (Array.isArray(saved)) savedOutfitCount = saved.length;
  } catch (e) {}
  return { totalItems: items.length, byCategory, savedOutfitCount };
}

// =============================================================================
// DAY HEADER — greeting + slim awake-day progress (ambient, replaces the ring).
// =============================================================================
(function () {
  const WAKE = 6.5, SLEEP = 24;
  const hello = document.getElementById('aiosHello');
  const dateEl = document.getElementById('aiosDate');
  const fill = document.getElementById('aiosDayFill');
  const label = document.getElementById('aiosDayLabel');
  if (!hello) return;

  function fmtDateLabel() {
    const d = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
  }
  function greeting(h) {
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }
  function update() {
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    hello.textContent = greeting(now.getHours());
    dateEl.textContent = fmtDateLabel();
    let pct, txt;
    if (h < WAKE) { pct = 0; txt = 'before wake-up'; }
    else if (h >= SLEEP) { pct = 100; txt = 'past bedtime'; }
    else {
      pct = (h - WAKE) / (SLEEP - WAKE) * 100;
      const left = SLEEP - h;
      txt = Math.floor(left) + 'h ' + Math.round((left % 1) * 60) + 'm awake left';
    }
    fill.style.width = pct.toFixed(1) + '%';
    label.textContent = Math.round(pct) + '% of day · ' + txt;
  }
  update();
  setInterval(update, 60 * 1000);
  // Greeting word can change as the day rolls; expose the current one for the bot.
  window.__aiosGreeting = () => greeting(new Date().getHours());
})();

// =============================================================================
// QUICK NOTES — minimalist synced inbox (key 'quicknotes_v1', in syncedPrefixes).
// =============================================================================
window.QuickNotes = (function () {
  const KEY = 'quicknotes_v1';
  const listEl = document.getElementById('notesList');
  const countEl = document.getElementById('notesCount');
  const form = document.getElementById('notesForm');
  const input = document.getElementById('notesInput');

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function persist(arr) {
    localStorage.setItem(KEY, JSON.stringify(arr));
    if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    render();
  }
  function add(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const arr = load(); arr.unshift({ text: t, ts: Date.now() }); persist(arr);
    return true;
  }
  function del(ts) { persist(load().filter(n => n.ts !== ts)); }

  function render() {
    if (!listEl) return;
    const arr = load();
    if (countEl) countEl.textContent = arr.length ? arr.length + (arr.length === 1 ? ' note' : ' notes') : '';
    listEl.innerHTML = arr.map(n =>
      '<li class="aios-note" data-ts="' + n.ts + '">'
      + '<span class="aios-note-dot"></span>'
      + '<span class="aios-note-text">' + esc(n.text) + '</span>'
      + '<button class="aios-note-del" data-del="' + n.ts + '" aria-label="Delete note" title="Delete">×</button>'
      + '</li>').join('');
  }

  if (form) {
    form.addEventListener('submit', e => { e.preventDefault(); if (add(input.value)) input.value = ''; });
  }
  if (listEl) {
    listEl.addEventListener('click', e => {
      const b = e.target.closest('[data-del]');
      if (b) del(Number(b.dataset.del));
    });
  }
  window.addEventListener('notes-changed', render);
  window.addEventListener('storage', render);
  render();
  return { add, render };
})();

// =============================================================================
// CALENDAR ENGINE — Supabase-backed fetch/render/inline-edit, plus a
// window.AptCal API so the assistant can read + mutate the schedule.
// =============================================================================
(function () {
  let currentEvents = [];

  // Calendar data lives in Supabase (public.events), scoped to the logged-in
  // user by RLS — no proxy in the hot path. getClient() awaits APP_AUTH_READY so
  // no query fires before the session is confirmed (RLS would reject it anyway),
  // then hands back the ONE shared authed client. It's null only in local-only
  // mode (no supabase lib / no config), which callers surface as "unavailable".
  async function getClient() {
    await (window.APP_AUTH_READY || Promise.resolve());
    return window.APP_SUPABASE || null;
  }

  const EVENT_COLS = 'id,title,starts_at,ends_at,all_day,tz,notes,location,google_event_id,deleted_at';
  function tzName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }
  // A Supabase row → the in-memory event shape the render/edit/assistant code
  // already speaks (identical to the old proxy formatEvent output, so nothing
  // downstream changes). Timed blocks pass the absolute instant straight through
  // (new Date() renders it in local time); all-day blocks collapse to the UTC
  // calendar date, exactly as Google's ev.start.date used to.
  function rowToEvent(row) {
    const allDay = !!row.all_day;
    const dateOf = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : null);
    return {
      id:       row.id,
      title:    row.title || '(no title)',
      start:    allDay ? dateOf(row.starts_at) : row.starts_at,
      end:      allDay ? dateOf(row.ends_at)   : row.ends_at,
      allDay,
      notes:    row.notes || '',
      location: row.location || '',
      google_event_id: row.google_event_id || null,
    };
  }
  // UTC day-boundary helpers for range queries. We over-fetch by ±1 day and then
  // bucket by each event's LOCAL day (eventDateKey), so the schedule list and the
  // grid dots always agree no matter the viewer's UTC offset.
  function addDaysStr(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
  }
  function dayStartUTC(dateStr) { return dateStr + 'T00:00:00.000Z'; }
  function dayEndUTC(dateStr)   { return dateStr + 'T23:59:59.999Z'; }
  // Fetch live (non-tombstoned) events whose start falls in [gteIso, lteIso].
  // Returns null in local-only mode so callers can show "not configured".
  async function fetchWindow(gteIso, lteIso) {
    const supa = await getClient();
    if (!supa) return null;
    const { data, error } = await supa
      .from('events')
      .select(EVENT_COLS)
      .is('deleted_at', null)
      .gte('starts_at', gteIso)
      .lte('starts_at', lteIso)
      .order('starts_at', { ascending: true });
    if (error) throw Object.assign(new Error(error.message || 'query failed'), { supabase: error });
    return (data || []).map(rowToEvent);
  }

  // Turn a calendar failure into a short, debuggable message. With Supabase as
  // the store the failure modes collapse to two: no client (local-only / not
  // configured) vs a query or network error. The old proxy/Google-auth branches
  // no longer apply — the login gate (js/auth/main.js) already guarantees a session.
  function calShowError(offlineEl, countEl, err) {
    if (err && err.notConfigured) {
      offlineEl.textContent = '⚠ Cloud sync isn’t configured — calendar unavailable.';
      countEl.textContent = 'not configured';
    } else {
      offlineEl.textContent = '⚠ Couldn’t reach your calendar — check your connection.';
      countEl.textContent = 'offline';
    }
  }

  // ── multi-day state ──────────────────────────────────────────────────────
  //   selectedDate — the day the schedule list + completion state reflect.
  //   viewY/viewM   — the month the grid is showing (may differ from selected).
  //   eventsByDate  — keyed cache "YYYY-MM-DD" → [events]; Supabase stays the
  //                   source of truth, this just lets the grid show dots and
  //                   switch days instantly. One range fetch fills a whole month.
  let selectedDate = todayStr();
  const now0 = new Date();
  let viewY = now0.getFullYear(), viewM = now0.getMonth();
  const eventsByDate = Object.create(null);

  // ── volatile undo memory ─────────────────────────────────────────────────
  // The last block dropped via the assistant, snapshotted *before* deletion so
  // a regret/correction ("recover the walk", "undo", "my mistake") can re-create
  // it verbatim. One slot, cleared once consumed. Stores the raw stored title so
  // restore round-trips through the same sentence-case display path.
  let lastDeletedEvent = null;

  function ymd(y, m, d) { return y + '-' + padZ(m + 1) + '-' + padZ(d); }
  function partsOf(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return { y, m: m - 1, d }; }
  function dateObj(dateStr) { const p = partsOf(dateStr); return new Date(p.y, p.m, p.d); }
  // A local Date on the selected day at h:m — so the assistant/create paths
  // schedule onto whatever day is in view, not always today.
  function dtOnSelected(h, m, dateStr) { const p = partsOf(dateStr || selectedDate); return new Date(p.y, p.m, p.d, h, m, 0, 0); }
  // The local calendar day an event belongs to (handles all-day + timed).
  function eventDateKey(ev) {
    const s = ev.start || '';
    if (ev.allDay) return s.slice(0, 10);
    const d = new Date(s);
    return ymd(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // ── formatting ──────────────────────────────────────────────────────────
  function fmtRange(startIso, endIso) {
    const s = new Date(startIso), e = new Date(endIso);
    function fmt(d, showAmpm) {
      let h = d.getHours() % 12 || 12;
      const m = d.getMinutes();
      return h + (m ? ':' + padZ(m) : '') + (showAmpm ? ' ' + (d.getHours() >= 12 ? 'PM' : 'AM') : '');
    }
    const sAmpm = s.getHours() >= 12 ? 'PM' : 'AM';
    const eAmpm = e.getHours() >= 12 ? 'PM' : 'AM';
    return fmt(s, sAmpm !== eAmpm) + ' – ' + fmt(e, true);
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    let h = d.getHours() % 12 || 12;
    const m = d.getMinutes();
    return h + (m ? ':' + padZ(m) : '') + ' ' + (d.getHours() >= 12 ? 'PM' : 'AM');
  }
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDateLabel(d) {
    d = d || new Date();
    return DAY_NAMES[d.getDay()] + ', ' + MONTH_ABBR[d.getMonth()] + ' ' + d.getDate();
  }
  function eventClass(ev) {
    if (ev.allDay) return '';
    const now = new Date(), start = new Date(ev.start), end = new Date(ev.end);
    if (end < now) return 'is-past';
    if (start <= now) return 'is-now';
    return '';
  }
  function toLocalISO(dt) {
    const p = n => String(n).padStart(2, '0');
    const off = -dt.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) +
      'T' + p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':00' +
      sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60);
  }

  // ── completion state (the events table has no "done" flag) ────────────────
  // Known Issue #22: these keys were derived from the shared selectedDate with
  // no way to target a different day — a mutating action resolving an event
  // for day X could still record its done-state under whatever day Y
  // selectedDate happened to be at the moment it ran, if a concurrent command
  // changed it in between. Every function here now takes an optional dateStr,
  // defaulting to selectedDate so every existing caller is unaffected.
  function doneKey(dateStr) { return 'cal_done:' + (dateStr || selectedDate); }
  function manualKey(dateStr) { return 'cal_manual:' + (dateStr || selectedDate); }
  function getDoneSet(dateStr) {
    try { return new Set(JSON.parse(localStorage.getItem(doneKey(dateStr))) || []); } catch (e) { return new Set(); }
  }
  function setDone(id, done, dateStr) {
    const s = getDoneSet(dateStr); if (done) s.add(id); else s.delete(id);
    localStorage.setItem(doneKey(dateStr), JSON.stringify([...s]));
  }
  function getManualMap(dateStr) {
    try { return JSON.parse(localStorage.getItem(manualKey(dateStr))) || {}; } catch (e) { return {}; }
  }
  function setManual(id, done, dateStr) {
    const m = getManualMap(dateStr); m[id] = !!done;
    localStorage.setItem(manualKey(dateStr), JSON.stringify(m));
  }
  function autoCheckPastEvents(events) {
    const now = new Date(), manual = getManualMap(), s = getDoneSet();
    let changed = false;
    events.forEach(ev => {
      if (ev.allDay || !ev.end) return;
      if (Object.prototype.hasOwnProperty.call(manual, ev.id)) return;
      if (new Date(ev.end) < now && !s.has(ev.id)) { s.add(ev.id); changed = true; }
    });
    if (changed) localStorage.setItem(doneKey(), JSON.stringify([...s]));
  }
  function applyDoneStateToDOM() {
    try {
      const doneSet = getDoneSet();
      document.querySelectorAll('#calEventList .cal-event-item').forEach(li => {
        const done = doneSet.has(li.dataset.id);
        const cb = li.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = done;
        li.classList.toggle('is-done', done);
      });
    } catch (e) {}
    updateCount();
  }

  // ── status helpers ────────────────────────────────────────────────────────
  function showCalStatus(msg, isError) {
    const el = document.getElementById('calStatus');
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    setTimeout(() => { el.textContent = ''; el.classList.remove('is-error'); }, 4000);
  }
  function flashSaved(el) {
    if (!el) return;
    el.classList.add('cal-saved-flash');
    setTimeout(() => el.classList.remove('cal-saved-flash'), 600);
  }

  // ── UPDATE in Supabase, optimistic ───────────────────────────────────────
  // Accepts the same body keys the callers already speak (title / notes /
  // startTime / endTime / date) and maps them onto the events columns.
  async function patchEvent(ev, body, el) {
    if (el) el.classList.add('cal-saving');
    try {
      const supa = await getClient();
      if (!supa) throw Object.assign(new Error('not configured'), { notConfigured: true });
      // sync_state:'local' flags the row so the Google mirror (proxy step 4)
      // picks up this edit on the next sync. No-op when no calendar is linked.
      const upd = { updated_at: new Date().toISOString(), sync_state: 'local' };
      if (body.title !== undefined) upd.title = body.title;
      if (body.notes !== undefined) upd.notes = body.notes;
      if (body.startTime) upd.starts_at = new Date(body.startTime).toISOString();
      if (body.endTime)   upd.ends_at   = new Date(body.endTime).toISOString();
      // An all-day retarget: a date given with no explicit times.
      if (body.date && !body.startTime && !body.endTime) {
        upd.all_day = true;
        upd.starts_at = dayStartUTC(body.date);
        upd.ends_at   = dayStartUTC(body.date);
      }
      const { data, error } = await supa.from('events')
        .update(upd).eq('id', ev.id).select(EVENT_COLS).single();
      if (error) throw new Error(error.message || 'update failed');
      Object.assign(ev, rowToEvent(data));
      flashSaved(el);
    } catch {
      showCalStatus('Update failed — check your connection.', true);
      loadEvents();
    } finally {
      if (el) el.classList.remove('cal-saving');
    }
  }

  // Sentence case for display only (stored title is left untouched so edits see
  // the real value): first letter upper, the rest lower.
  function formatEventTitle(title) {
    if (!title) return '';
    const trimmed = title.trim();
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  }

  // ── inline text edit (title / notes) ──────────────────────────────────────
  function restoreField(el, ev, field) {
    if (field === 'notes') el.textContent = ev.notes ? ev.notes.split('\n')[0] : '';
    else el.textContent = formatEventTitle(ev.title);
  }
  function makeFieldEdit(el, ev, field) {
    el.classList.add('cal-editable');
    el.addEventListener('click', () => {
      if (el.querySelector('input')) return;
      const current = (field === 'notes' ? ev.notes : ev.title) || '';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'cal-edit-input'; input.value = current;
      el.textContent = ''; el.appendChild(input); input.focus(); input.select();
      let done = false;
      const commit = (save) => {
        if (done) return; done = true;
        const val = input.value.trim();
        if (save && val !== current.trim()) {
          ev[field] = val; restoreField(el, ev, field);
          patchEvent(ev, field === 'title' ? { title: val } : { notes: val }, el);
        } else { restoreField(el, ev, field); }
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      input.addEventListener('blur', () => commit(true));
    });
  }

  // ── inline duration edit ──────────────────────────────────────────────────
  function isoWithTime(originalIso, hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(originalIso); d.setHours(h, m, 0, 0);
    return toLocalISO(d);
  }
  function timeInput(d) {
    const i = document.createElement('input');
    i.type = 'time'; i.className = 'cal-edit-time';
    i.value = padZ(d.getHours()) + ':' + padZ(d.getMinutes());
    return i;
  }
  function microBtn(label, cls) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cal-mini-btn ' + cls; b.textContent = label;
    return b;
  }
  function makeDurationEdit(el, ev, li) {
    el.classList.add('cal-editable');
    el.addEventListener('click', () => {
      if (li.classList.contains('is-editing')) return;
      li.classList.add('is-editing');
      const startIn = timeInput(new Date(ev.start));
      const endIn = timeInput(new Date(ev.end));
      const wrap = document.createElement('span');
      wrap.className = 'cal-dur-edit';
      wrap.append(startIn, document.createTextNode('–'), endIn);
      el.textContent = ''; el.appendChild(wrap);
      const ok = microBtn('✓', 'cal-mini-save');
      const cancel = microBtn('×', 'cal-mini-cancel');
      const actions = document.createElement('span');
      actions.className = 'cal-row-actions';
      actions.append(ok, cancel); li.appendChild(actions);
      startIn.focus();
      const cleanup = () => {
        li.classList.remove('is-editing');
        if (actions.parentNode) actions.parentNode.removeChild(actions);
      };
      const close = () => { cleanup(); el.textContent = fmtRange(ev.start, ev.end); };
      ok.addEventListener('click', e => {
        e.stopPropagation();
        ev.start = isoWithTime(ev.start, startIn.value);
        ev.end = isoWithTime(ev.end, endIn.value);
        cleanup(); sortEvents(); renderEvents(currentEvents);
        patchEvent(ev, { startTime: ev.start, endTime: ev.end }, null);
      });
      cancel.addEventListener('click', e => { e.stopPropagation(); close(); });
      wrap.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
        if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
    });
  }

  // ── build one interactive event row ───────────────────────────────────────
  function buildEventRow(ev) {
    const isDone = getDoneSet().has(ev.id);
    const li = document.createElement('li');
    li.className = 'cal-event-item ' + eventClass(ev) + (isDone ? ' is-done' : '');
    li.dataset.id = ev.id;

    const dur = document.createElement('div');
    dur.className = 'cal-event-time';
    dur.textContent = ev.allDay ? 'all day' : fmtRange(ev.start, ev.end);
    if (!ev.allDay) makeDurationEdit(dur, ev, li);
    li.appendChild(dur);

    const title = document.createElement('div');
    title.className = 'cal-event-title'; title.textContent = formatEventTitle(ev.title);
    makeFieldEdit(title, ev, 'title'); li.appendChild(title);

    const notes = document.createElement('div');
    notes.className = 'cal-event-notes';
    notes.dataset.placeholder = 'Add note…';
    notes.textContent = ev.notes ? ev.notes.split('\n')[0] : '';
    makeFieldEdit(notes, ev, 'notes'); li.appendChild(notes);

    const cbWrap = document.createElement('label');
    cbWrap.className = 'cal-event-check'; cbWrap.title = 'Mark complete';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = isDone;
    const cbCustom = document.createElement('span');
    cbCustom.className = 'cal-check-custom';
    cb.addEventListener('change', () => {
      setManual(ev.id, cb.checked); setDone(ev.id, cb.checked);
      li.classList.toggle('is-done', cb.checked);
      updateCount();
      if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    });
    cbWrap.appendChild(cb); cbWrap.appendChild(cbCustom); li.appendChild(cbWrap);
    return li;
  }

  function updateCount() {
    const count = document.getElementById('calEventCount');
    const total = currentEvents.length;
    if (!total) { count.textContent = 'Nothing scheduled'; return; }
    const doneSet = getDoneSet();
    const doneCount = currentEvents.filter(ev => doneSet.has(ev.id)).length;
    count.textContent = doneCount + '/' + total + ' done';
  }
  function sortEvents() { currentEvents.sort((a, b) => new Date(a.start) - new Date(b.start)); }

  function renderEvents(events) {
    currentEvents = events;
    autoCheckPastEvents(events);
    const list = document.getElementById('calEventList');
    list.innerHTML = '';
    if (!events.length) {
      const when = selectedDate === todayStr() ? 'today' : 'this day';
      list.innerHTML = '<li class="cal-empty">No blocks scheduled ' + when + '</li>';
      updateCount();
    } else {
      events.forEach(ev => list.appendChild(buildEventRow(ev)));
      updateCount();
    }
    window.dispatchEvent(new CustomEvent('apt:calendar-loaded'));
  }

  // Refresh the schedule list for whichever day is selected. Caches the result
  // in eventsByDate and re-syncs that day's dot on the grid.
  //
  // Known Issue #22 (grid-click half): selectDay() fires this without waiting
  // for it, so clicking day A then day B before A's fetch resolves used to let
  // A's response land AFTER B took over — writing/rendering A's events under
  // B's now-current selectedDate. requestedDate snapshots which day THIS call
  // is actually for; if selectedDate has moved on by the time the awaited
  // fetch returns, the response is simply discarded instead of corrupting the
  // now-current day's cache/view. This closes the single-tab/rapid-click race
  // completely. It does NOT close the Shenlong half of #22 (two concurrent
  // ensureDate() calls targeting different days can still each see the wrong
  // day's currentEvents) — that needs findEvent()/applyIntent to read a
  // per-call snapshot instead of the shared currentEvents, a larger change
  // left open pending an architecture decision.
  async function loadEvents() {
    const requestedDate = selectedDate;
    const offlineEl = document.getElementById('calOfflineMsg');
    const countEl = document.getElementById('calEventCount');
    const refreshBtn = document.getElementById('calRefreshBtn');
    refreshBtn.classList.add('spinning');
    setTimeout(() => refreshBtn.classList.remove('spinning'), 700);
    try {
      // Over-fetch ±1 day (UTC) then keep only blocks whose LOCAL day is the
      // selected one, so a timezone offset can never drop or misplace an event.
      const rows = await fetchWindow(
        dayStartUTC(addDaysStr(requestedDate, -1)), dayEndUTC(addDaysStr(requestedDate, 1)));
      if (selectedDate !== requestedDate) return;   // superseded — see comment above
      if (rows === null) throw Object.assign(new Error('not configured'), { notConfigured: true });
      const events = rows.filter(ev => eventDateKey(ev) === requestedDate);
      offlineEl.style.display = 'none';
      eventsByDate[requestedDate] = events;
      renderEvents(events);
      markGridDot(requestedDate, events.length > 0);
    } catch (err) {
      if (selectedDate !== requestedDate) return;   // superseded — don't show a stale error either
      offlineEl.style.display = 'block';
      calShowError(offlineEl, countEl, err);
      document.getElementById('calEventList').innerHTML = '';
      currentEvents = [];
      window.dispatchEvent(new CustomEvent('apt:calendar-loaded'));
    }
  }

  // Known Issue #22 (Shenlong half) — request-scoped fetch for a specific
  // day, independent of loadEvents()/selectedDate/currentEvents/render. Used
  // by ensureDate() so a mutating applyIntent action always has a correct,
  // freshly-fetched array for the day it actually resolved, immune to a
  // concurrent command changing selectedDate out from under it. Still writes
  // eventsByDate[dateStr] (that key is always correct regardless of what's
  // currently selected) so the day's cache stays warm for later navigation.
  async function fetchEventsForDate(dateStr) {
    try {
      const rows = await fetchWindow(
        dayStartUTC(addDaysStr(dateStr, -1)), dayEndUTC(addDaysStr(dateStr, 1)));
      if (rows === null) return eventsByDate[dateStr] || [];
      const events = rows.filter(ev => eventDateKey(ev) === dateStr);
      eventsByDate[dateStr] = events;
      return events;
    } catch (err) {
      return eventsByDate[dateStr] || [];
    }
  }

  // Bulk-fetch the visible month in one range call, group events into the
  // per-date cache, and (re)paint the grid so days with blocks show a dot.
  async function loadMonth() {
    const start = ymd(viewY, viewM, 1);
    const last = new Date(viewY, viewM + 1, 0).getDate();
    const end = ymd(viewY, viewM, last);
    try {
      const all = await fetchWindow(
        dayStartUTC(addDaysStr(start, -1)), dayEndUTC(addDaysStr(end, 1)));
      if (all) {
        // Clear this month's cache buckets, then refill from the range payload.
        for (let d = 1; d <= last; d++) eventsByDate[ymd(viewY, viewM, d)] = [];
        all.forEach(ev => {
          const k = eventDateKey(ev);
          (eventsByDate[k] = eventsByDate[k] || []).push(ev);
        });
      }
    } catch (e) {
      // Offline/query failure: leave the grid dot-less, day fetch handles errors.
    }
    renderGrid();
  }

  // ── create (used by the assistant) ────────────────────────────────────────
  // Always a timed block (the assistant paths supply a start/end). user_id
  // defaults to auth.uid() (migration 0004) so RLS attributes the row without
  // the client sending it. starts_at/ends_at are stored as absolute UTC instants.
  async function createEvent({ title, notes, startDt, endDt }) {
    const supa = await getClient();
    if (!supa) throw Object.assign(new Error('not configured'), { notConfigured: true });
    const { data, error } = await supa.from('events').insert({
      title,
      notes: notes || '',
      all_day: false,
      starts_at: startDt.toISOString(),
      ends_at: endDt.toISOString(),
      tz: tzName(),
    }).select(EVENT_COLS).single();
    if (error) throw new Error(error.message || 'insert failed');
    return rowToEvent(data);
  }

  // ── month grid ────────────────────────────────────────────────────────────
  function hasEvents(dateStr) {
    const arr = eventsByDate[dateStr];
    return Array.isArray(arr) && arr.length > 0;
  }
  function markGridDot(dateStr, on) {
    const cell = document.querySelector('#dcwGrid .dcw-day[data-date="' + dateStr + '"]');
    if (cell) cell.classList.toggle('has-events', !!on);
  }
  function renderGrid() {
    const grid = document.getElementById('dcwGrid');
    const titleEl = document.getElementById('dcwTitle');
    if (!grid || !titleEl) return;
    titleEl.textContent = MONTH_NAMES[viewM] + ' ' + viewY;
    const firstDow = new Date(viewY, viewM, 1).getDay();
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const today = todayStr();
    let html = '';
    for (let i = 0; i < firstDow; i++) html += '<span class="dcw-day is-pad" aria-hidden="true"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = ymd(viewY, viewM, d);
      const cls = ['dcw-day'];
      if (ds === today) cls.push('is-today');
      if (ds === selectedDate) cls.push('is-selected');
      if (hasEvents(ds)) cls.push('has-events');
      html += '<button type="button" class="' + cls.join(' ') + '" role="gridcell"'
        + ' data-date="' + ds + '"' + (ds === selectedDate ? ' aria-current="date"' : '')
        + '><span class="dcw-num">' + d + '</span><span class="dcw-dot" aria-hidden="true"></span></button>';
    }
    grid.innerHTML = html;
  }
  // Switch the schedule to a given day: repaint the grid highlight, refresh the
  // header, show cached events instantly, then re-fetch that day to stay live.
  function selectDay(dateStr) {
    selectedDate = dateStr;
    const p = partsOf(dateStr);
    if (p.y !== viewY || p.m !== viewM) { viewY = p.y; viewM = p.m; loadMonth(); }
    document.getElementById('calDateLabel').textContent = fmtDateLabel(dateObj(dateStr));
    renderGrid();
    if (eventsByDate[dateStr]) renderEvents(eventsByDate[dateStr]);
    loadEvents();
  }
  function shiftMonth(delta) {
    const d = new Date(viewY, viewM + delta, 1);
    viewY = d.getFullYear(); viewM = d.getMonth();
    renderGrid();
    loadMonth();
  }

  // ── assistant-facing helpers ──────────────────────────────────────────────
  // Casual words that mean the same calendar block but share no substring with
  // its title ("workout" vs "Gym") — token-overlap alone can't find these.
  // Keep every group to a PROVEN miss (Known Issues #1 / roadmap E8a: a user
  // said "move my workout to 5pm" against an event literally titled "Gym" and
  // got "I couldn't find an event matching workout", even though Shenlong's
  // own replies use that exact word). The next *different* word reported
  // missing is the signal to give events a real category/tag, not to keep
  // growing this table — see the roadmap note next to this fix.
  const TITLE_SYNONYMS = [['workout', 'workouts', 'gym']];
  function synonymsOf(word) {
    const g = TITLE_SYNONYMS.find(group => group.includes(word));
    return g || [word];
  }
  // Score how well a query matches an event title. A contiguous substring wins;
  // otherwise we accept a token-subset match so filler-stripped phrases like
  // "read book" still find "Read a book". Returns 0 when there's no real match.
  function scoreMatch(title, q) {
    const tl = title.toLowerCase();
    if (tl.includes(q)) return 100 + q.length;
    const tokens = q.split(/\s+/).filter(Boolean);
    if (!tokens.length) return 0;
    const tokenHits = (w) => synonymsOf(w).some(s => tl.includes(s));
    const hit = tokens.filter(w => w.length > 1 && tokenHits(w)).length;
    if (hit === tokens.length) return 50 + hit;   // every word present
    return hit;                                    // partial (weak)
  }
  // Known Issue #24 / E8b, CLOSED (extreme adversarial pass V): two events
  // tying on match score ("Dentist AM checkup" / "Dentist PM follow-up" both
  // matching "dentist") used to be silently resolved via the `prefer`
  // tie-break below, with only a post-hoc "more than one event matched"
  // disclosure — guess-then-disclose, not ask-then-act. `lastAmbiguousCandidates`
  // (below) now lets `parseLocal`'s own resolve() call detect a genuine tie
  // BEFORE any mutation happens and ask which one is meant instead — see the
  // DELETE/RETIME/COMPLETE/UNCHECK/RENAME branches, each of which now reads
  // this right after its own resolve() call and attaches `ambiguous`/
  // `ambiguousCandidates` to the returned intent. This flag/array pairing is
  // still also read a SECOND time, post-mutation, by each apply* case in
  // applyIntent — that older mechanism is left in place unchanged as a safety
  // net for intents that don't come through parseLocal's own resolve() (a
  // Gemini-sourced intent, or a future caller), where the pre-emptive ask
  // can't run.
  let lastMatchWasAmbiguous = false;
  let lastAmbiguousCandidates = [];
  // Pick the event that best matches a keyword. `prefer` biases ties: 'done' for
  // unchecking (target the completed slot), 'undone' for completing, else the
  // upcoming/active one so "move my workout" hits the right block.
  // Known Issue #22 (Shenlong half): events defaults to the shared
  // currentEvents for every existing caller (the UI grid, matchTitle()'s
  // pre-resolution), but a mutating applyIntent action now passes its own
  // request-scoped array (see ensureDate/fetchEventsForDate) so it searches
  // the day IT resolved, not whatever currentEvents holds by the time this
  // call actually runs.
  function findEvent(match, prefer, events) {
    const q = String(match || '').toLowerCase().trim();
    if (!q) return null;
    const scored = (events || currentEvents).map(ev => ({ ev, s: scoreMatch(ev.title, q) })).filter(x => x.s > 0);
    if (!scored.length) return null;
    scored.sort((a, b) => b.s - a.s);
    const best = scored[0].s;
    const top = scored.filter(x => x.s === best).map(x => x.ev);
    // Only ever SET this true, never reset false here — the local parser
    // pre-resolves via resolve()/matchTitle() (an earlier, genuinely-ambiguous
    // findEvent call) before applyIntent calls the mutating action, which
    // triggers a SECOND findEvent call against the now-specific resolved
    // title (no longer ambiguous). Resetting on every call let that later,
    // already-disambiguated call silently clobber the real signal from the
    // first one. wasLastMatchAmbiguous() below is the one place this clears.
    if (top.length > 1) { lastMatchWasAmbiguous = true; lastAmbiguousCandidates = top; }
    const now = new Date(), doneSet = getDoneSet();
    if (prefer === 'done')   return top.find(ev => doneSet.has(ev.id))  || top[0];
    if (prefer === 'undone') return top.find(ev => !doneSet.has(ev.id)) || top[0];
    return top.find(ev => new Date(ev.end) >= now) || top[0];
  }
  // Resolve a phrase to a real event title (or null) — lets the parser decide
  // between mutating an existing block and creating a new one.
  function matchTitle(q) { const ev = findEvent(q); return ev ? ev.title : null; }
  // dateStr (optional, from ensureDate's request-scoped resolution — Known
  // Issue #22) targets a day other than whatever's currently selected; the
  // optimistic loadEvents() refresh only fires when it's the live-displayed
  // day, same convention as the other mutating api* functions below.
  async function apiAddEvent(title, hm, durationMin, notes, dateStr) {
    const startDt = dtOnSelected(hm.h, hm.m, dateStr);
    const endDt = new Date(startDt.getTime() + (durationMin || 30) * 60000);
    const made = await createEvent({ title, notes, startDt, endDt });
    if (!dateStr || dateStr === selectedDate) await loadEvents();
    return {
      title,
      when: fmtTime(made.start || startDt.toISOString()),
      end: fmtTime(made.end || endDt.toISOString()),
    };
  }
  // Re-time a block. opts: { start:{h,m}?, end:{h,m}?, durationMin?, deltaMin? }
  //   • start only          → shift, keep duration
  //   • start + end (range) → set both (end wraps past midnight, e.g. 10pm→12am)
  //   • durationMin         → absolute length from the (new or current) start
  //   • deltaMin            → grow/shrink by N minutes (reduce/extend)
  async function apiRetimeEvent(match, opts, dateStr) {
    const events = (dateStr && eventsByDate[dateStr]) || currentEvents;
    const ev = findEvent(match, undefined, events);
    if (!ev) return { ok: false };
    const origMs = new Date(ev.end) - new Date(ev.start);
    let start = new Date(ev.start);
    if (opts.start) start.setHours(opts.start.h, opts.start.m, 0, 0);
    // Cross-day move — relocate to a different calendar day, preserving the
    // (possibly just-updated) time-of-day. Previously this function had NO
    // way to change an event's day at all (only ever setHours() on the
    // existing date), so "move it to Friday" silently failed to relocate
    // anything even when the intent parsed correctly — the real root cause
    // behind the pre-fix "Move it to Friday" bug, not Gemini availability.
    // `opts.moveToDate` is always the DESTINATION (see the move_event/
    // retime_event applyIntent case for why `date` never means "search this
    // day" for this one action).
    if (opts.moveToDate) {
      const p = partsOf(opts.moveToDate);
      start = new Date(p.y, p.m, p.d, start.getHours(), start.getMinutes(), 0, 0);
    }
    let end = new Date(start.getTime() + origMs);
    if (opts.end) {
      end = new Date(start); end.setHours(opts.end.h, opts.end.m, 0, 0);
      if (end <= start) end.setDate(end.getDate() + 1);     // crosses midnight
    }
    if (opts.durationMin != null) end = new Date(start.getTime() + opts.durationMin * 60000);
    if (opts.deltaMin != null) end = new Date(end.getTime() + opts.deltaMin * 60000);
    if (end <= start) end = new Date(start.getTime() + 5 * 60000);  // never zero/negative
    ev.start = toLocalISO(start); ev.end = toLocalISO(end);
    await patchEvent(ev, { startTime: ev.start, endTime: ev.end }, null);
    // A same-day retime re-renders optimistically from the mutated in-memory
    // object; a cross-day move needs a real refetch of the CURRENT day
    // (Supabase is now authoritative), since the moved event must disappear
    // from today's list, not just show a stale time under the wrong day.
    const movedAway = opts.moveToDate && opts.moveToDate !== selectedDate;
    if (movedAway) {
      currentEvents = await fetchEventsForDate(selectedDate);
      renderEvents(currentEvents);
      markGridDot(selectedDate, currentEvents.length > 0);
    } else if (!dateStr || dateStr === selectedDate) {
      // Render the SAME array `ev` was mutated in (`events`, not necessarily
      // `currentEvents` — a caller-supplied dateStr searches eventsByDate[dateStr],
      // a separate array instance from currentEvents whenever it wasn't just
      // populated by this exact renderEvents call). Rendering the wrong
      // array would show the pre-mutation time until the next full reload.
      events.sort((a, b) => new Date(a.start) - new Date(b.start));
      renderEvents(events);
    }
    return {
      ok: true, title: ev.title, when: fmtTime(ev.start), end: fmtTime(ev.end),
      date: opts.moveToDate || null,
      durationMin: Math.round((end - start) / 60000),
    };
  }
  function apiCompleteEvent(match, dateStr) {
    const events = (dateStr && eventsByDate[dateStr]) || currentEvents;
    const ev = findEvent(match, 'undone', events);
    if (!ev) return { ok: false };
    setManual(ev.id, true, dateStr); setDone(ev.id, true, dateStr);
    if (!dateStr || dateStr === selectedDate) applyDoneStateToDOM();
    if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    return { ok: true, title: ev.title };
  }
  function apiUncheckEvent(match, dateStr) {
    const events = (dateStr && eventsByDate[dateStr]) || currentEvents;
    const ev = findEvent(match, 'done', events);
    if (!ev) return { ok: false };
    // Record an explicit "not done" so autoCheckPastEvents won't re-tick a past slot.
    setManual(ev.id, false, dateStr); setDone(ev.id, false, dateStr);
    if (!dateStr || dateStr === selectedDate) applyDoneStateToDOM();
    if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    return { ok: true, title: ev.title };
  }
  // Rename a block in place via the proxy PATCH (same path the inline title edit
  // uses) — no delete+recreate dance, so id/time/notes are preserved untouched.
  // `dateStr`, when given, targets a day other than whatever's currently
  // selected — same request-scoped pattern apiCompleteEvent/apiUncheckEvent/
  // apiDeleteEvent already use (Known Issue #22). Previously this function
  // took no date at all and always searched `currentEvents`, so "rename my
  // Friday meeting to X" silently failed to find anything whenever Friday
  // wasn't the currently-viewed day — found during a Phase 3 adversarial
  // pass, fixed at the root (the search scope) rather than special-cased.
  async function apiRenameEvent(match, newTitle, dateStr) {
    const events = (dateStr && eventsByDate[dateStr]) || currentEvents;
    const ev = findEvent(match, undefined, events);
    if (!ev) return { ok: false };
    const title = String(newTitle || '').trim();
    if (!title) return { ok: false, noTitle: true };
    ev.title = title;
    if (!dateStr || dateStr === selectedDate) renderEvents(currentEvents); // reflect instantly (display sentence-cases)
    await patchEvent(ev, { title }, null);  // reverts via loadEvents() on failure
    return { ok: true, title: ev.title };
  }
  async function apiDeleteEvent(match, dateStr) {
    const events = (dateStr && eventsByDate[dateStr]) || currentEvents;
    const ev = findEvent(match, undefined, events);
    if (!ev) return { ok: false };
    // Soft delete: set deleted_at (the row is filtered out of every live query)
    // and keep the id so a follow-up "recover/undo" clears the tombstone and the
    // exact same block — id, time, notes intact — comes back untouched.
    const snapshot = { id: ev.id, title: ev.title, start: ev.start, end: ev.end, notes: ev.notes || '', allDay: !!ev.allDay };
    try {
      const supa = await getClient();
      if (!supa) throw new Error('not configured');
      const { error } = await supa.from('events')
        .update({ deleted_at: new Date().toISOString(), sync_state: 'local' }).eq('id', ev.id);
      if (error) throw new Error(error.message || 'delete failed');
      lastDeletedEvent = snapshot;
      if (!dateStr || dateStr === selectedDate) await loadEvents();
      return { ok: true, title: ev.title };
    } catch { return { ok: false, error: true }; }
  }
  // Recover the last block dropped this session, re-creating it on its ORIGINAL
  // day/time (falls back to the selected day at 9am if it was somehow missing).
  // `match` is an optional name hint used only to confirm/relay what was brought
  // back; the single-slot history is the source of truth.
  async function apiRestoreEvent(match) {
    const snap = lastDeletedEvent;
    if (!snap) return { ok: false, empty: true };
    try {
      const supa = await getClient();
      if (!supa) throw new Error('not configured');
      let ev;
      if (snap.id) {
        // Preferred path: clear the tombstone so the original row returns verbatim.
        // sync_state:'local' re-mirrors it to Google (un-cancels) on the next sync.
        const { data, error } = await supa.from('events')
          .update({ deleted_at: null, sync_state: 'local' }).eq('id', snap.id).select(EVENT_COLS).single();
        if (error) throw new Error(error.message || 'restore failed');
        ev = rowToEvent(data);
      } else {
        // Fallback (snapshot with no id): re-create on the original slot.
        const startDt = snap.start ? new Date(snap.start) : dtOnSelected(9, 0);
        const endDt = snap.end ? new Date(snap.end) : new Date(startDt.getTime() + 30 * 60000);
        ev = await createEvent({ title: snap.title, notes: snap.notes, startDt, endDt });
      }
      lastDeletedEvent = null;             // consumed — don't double-restore
      await loadEvents();
      loadMonth();                         // refresh dots in case it's off the selected day
      return { ok: true, title: ev.title, when: fmtTime(ev.start) };
    } catch { return { ok: false, error: true }; }
  }
  function summarize() {
    const isToday = selectedDate === todayStr();
    // At most one deterministic nudge, and only about TODAY — browsing a past
    // or future day shouldn't surface "you haven't logged water" nonsense.
    const nudge = isToday ? proactiveNudge() : null;
    const nudgeLine = nudge ? '\n\n' + nudge : '';

    if (!currentEvents.length) {
      const offline = document.getElementById('calOfflineMsg');
      if (offline && offline.style.display !== 'none') {
        return "I can't see your calendar right now — you look offline. Once you're back I'll read your blocks.";
      }
      const where = isToday ? 'today' : 'on ' + fmtDateLabel(dateObj(selectedDate));
      return 'Nothing on the calendar ' + where + ' — a clean slate. Want me to add something?' + nudgeLine;
    }
    const now = new Date();
    // "Upcoming" only filters by clock-time on today; on other days show all.
    const upcoming = isToday ? currentEvents.filter(ev => ev.allDay || new Date(ev.end) >= now) : currentEvents;
    const lines = (upcoming.length ? upcoming : currentEvents)
      .map(ev => '• ' + ev.title + (ev.allDay ? ' (all day)' : ' at ' + fmtTime(ev.start)));
    const n = currentEvents.length;
    const when = isToday ? 'today' : fmtDateLabel(dateObj(selectedDate));
    const head = (window.__aiosGreeting ? window.__aiosGreeting() : 'Hi') +
      '! You have ' + n + ' block' + (n === 1 ? '' : 's') + ' scheduled ' + when + ':';
    return head + '\n' + lines.join('\n') + nudgeLine;
  }

  // ── wire up ───────────────────────────────────────────────────────────────
  window.addEventListener('calendar-synced', applyDoneStateToDOM);
  window.addEventListener('storage', applyDoneStateToDOM);
  document.getElementById('calDateLabel').textContent = fmtDateLabel(dateObj(selectedDate));
  document.getElementById('calRefreshBtn').addEventListener('click', () => { loadEvents(); loadMonth(); });

  // Month-calendar widget: prev/next month + click-to-select a day.
  const gridEl = document.getElementById('dcwGrid');
  document.getElementById('dcwPrev').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('dcwNext').addEventListener('click', () => shiftMonth(1));
  if (gridEl) {
    gridEl.addEventListener('click', e => {
      const cell = e.target.closest('.dcw-day[data-date]');
      if (cell && cell.dataset.date !== selectedDate) selectDay(cell.dataset.date);
    });
  }
  renderGrid();
  loadMonth();
  loadEvents();
  // Keep TODAY's view live; other days refresh on demand when selected.
  setInterval(() => { if (selectedDate === todayStr()) loadEvents(); }, 5 * 60 * 1000);

  // Public API the assistant drives.
  window.AptCal = {
    reload: loadEvents,
    selectDay,
    getEvents: () => currentEvents.map(ev => ({ title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, done: getDoneSet().has(ev.id) })),
    getSelectedDate: () => selectedDate,
    isOffline: () => { const o = document.getElementById('calOfflineMsg'); return !!o && o.style.display !== 'none'; },
    summarize, addEvent: apiAddEvent, retimeEvent: apiRetimeEvent,
    completeEvent: apiCompleteEvent, uncheckEvent: apiUncheckEvent, deleteEvent: apiDeleteEvent,
    renameEvent: apiRenameEvent,
    restoreEvent: apiRestoreEvent,
    wasLastMatchAmbiguous: () => { const v = lastMatchWasAmbiguous; lastMatchWasAmbiguous = false; return v; },
    getAmbiguousCandidates: () => lastAmbiguousCandidates,
    fetchEventsForDate,
    matchTitle, fmtTime, fmtTitle: formatEventTitle,
  };
})();

// =============================================================================
// AI ASSISTANT — hybrid. Local synchronous parser first (instant, offline),
// Gemini proxy fallback for free-form. Applies intents to AptCal + bridges.
// =============================================================================
(function () {
  const GEMINI_ENDPOINT = '/api/gemini/assistant';
  const log = document.getElementById('aiLog');
  const form = document.getElementById('aiForm');
  const input = document.getElementById('aiInput');
  const chipsWrap = document.getElementById('aiChips');
  const aiSub = document.getElementById('aiSub');
  if (!log || !form) return;

  // ── message UI ─────────────────────────────────────────────────────────────
  const chatEl = document.querySelector('.aios-chat');
  function scroll() { log.scrollTop = log.scrollHeight; }
  // Reveal/spin the Dragon-Balls processing loader while Shenlong is working;
  // it stays hidden the rest of the time so the chat reads clean. Local
  // commands resolve in a single microtask, so without a floor the class is
  // added and removed before the browser ever paints the spin — keep it up for
  // at least MIN_SPIN_MS so the rotation is always actually visible.
  const MIN_SPIN_MS = 900;
  let processingSince = 0, hideTimer = 0;
  // Reassigned by the voice-input block below (only when SpeechRecognition is
  // available) — starts as a no-op so setSummoning can call it unconditionally
  // regardless of load order, tying the mic's DISABLED visual state to the
  // exact same busy lifecycle every other "Shenlong is working" state already
  // uses, instead of a second, independently-tracked flag.
  let setMicDisabled = () => {};
  function setSummoning(on) {
    setMicDisabled(on);
    if (!chatEl) return;
    if (on) {
      clearTimeout(hideTimer);
      processingSince = Date.now();
      chatEl.classList.add('is-processing');
    } else {
      const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - processingSince));
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => chatEl.classList.remove('is-processing'), wait);
    }
  }
  // ── coreference memory ───────────────────────────────────────────────────────
  // The last event the user successfully acted on, so a follow-up pronoun
  // ("move it to 4pm", "delete that") can be resolved to a real title.
  let lastMentionedEventTaskName = null;
  function remember(name) { if (name) lastMentionedEventTaskName = name; }

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'aios-msg aios-msg-' + role;
    // Shenlong's replies get the jade outline; granted (✓) commands an amber accent.
    if (role === 'ai') {
      div.classList.add('shenlong-reply');
      if (/^\s*✓/.test(text)) div.classList.add('is-granted');
    }
    div.textContent = text;
    log.appendChild(div); scroll();
    return div;
  }
  function addThinking() {
    const div = document.createElement('div');
    div.className = 'aios-msg aios-msg-ai aios-msg-think';
    div.innerHTML = '<span class="aios-typing"><span></span><span></span><span></span></span>';
    log.appendChild(div); scroll();
    return div;
  }

  // ── time parsing ─────────────────────────────────────────────────────────────
  // Accepts "4pm", "4:30 pm", "16:00", "noon", "midnight". Returns {h,m} | null.
  function parseTime(text) {
    const t = text.toLowerCase();
    if (/\bnoon\b/.test(t)) return { h: 12, m: 0 };
    if (/\bmidnight\b/.test(t)) return { h: 0, m: 0 };
    let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (m) {
      let h = +m[1] % 12; if (m[3] === 'pm') h += 12;
      return { h, m: m[2] ? +m[2] : 0 };
    }
    m = t.match(/\b(\d{1,2}):(\d{2})\b/);
    // Known Issue #16 fix: reject an out-of-range HH:MM (e.g. "30:99") instead
    // of clamping it to 23:59 — a clamped value schedules a real event at a
    // time the user never asked for. window.Shelron.Intent.parseStrictTime is
    // the shared deterministic validator (js/shelron/intent-engine.js).
    if (m) return window.Shelron.Intent.parseStrictTime(m[1] + ':' + m[2]);
    return null;
  }
  // Every time token in a string, in order — for ranges like "10pm to 12am".
  function parseTimes(text) {
    const out = [];
    const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b|\b(noon|midnight)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      if (m[6]) out.push(/noon/i.test(m[6]) ? { h: 12, m: 0 } : { h: 0, m: 0 });
      else if (m[3]) { let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; out.push({ h, m: m[2] ? +m[2] : 0 }); }
      else if (m[4]) { const hm = window.Shelron.Intent.parseStrictTime(m[4] + ':' + m[5]); if (hm) out.push(hm); }
    }
    return out;
  }
  // Parse a SINGLE clock token, including a bare hour ("22" → 22:00). Bare hours
  // are read 24-hour because the only caller is the range parser, where a number
  // unmistakably denotes a clock. `mer` flags whether am/pm was explicit, so the
  // range parser can lend the end's meridiem to a bare start ("10 to 11:30pm").
  function parseClockToken(tok) {
    const t = String(tok).toLowerCase().trim();
    if (/noon/.test(t)) return { h: 12, m: 0, mer: true };
    if (/midnight/.test(t)) return { h: 0, m: 0, mer: true };
    let m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (m) { let h = +m[1] % 12; if (m[3] === 'pm') h += 12; return { h, m: m[2] ? +m[2] : 0, mer: true }; }
    m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      // Known Issue #16 fix: reject, don't clamp — see parseTime() above.
      const hm = window.Shelron.Intent.parseStrictTime(m[1] + ':' + m[2]);
      return hm ? { h: hm.h, m: hm.m, mer: false } : null;
    }
    m = t.match(/^(\d{1,2})$/);
    if (m && +m[1] >= 0 && +m[1] <= 23) return { h: +m[1], m: 0, mer: false };
    return null;
  }
  // Recognise a "X to Y" time range — 24-hour ("22 to 23:30"), 12-hour
  // ("10 to 11:30pm"), or mixed. Returns { start, end, durationMin, raw } where
  // `raw` is the exact matched span so callers can excise it from the title.
  // A bare start borrows the end's am/pm; an end ≤ start wraps past midnight.
  function parseTimeRange(text) {
    const re = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|until|till|through|thru|-|–|—)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;
    const m = text.match(re);
    if (!m) return null;
    const start = parseClockToken(m[1]);
    const end = parseClockToken(m[2]);
    if (!start || !end) return null;
    // Lend the end's meridiem to a bare 12-hour start ("10 to 11:30pm" → 10pm).
    if (!start.mer && end.mer && start.h <= 12) {
      const endPm = end.h >= 12;
      start.h = (start.h % 12) + (endPm ? 12 : 0);
    }
    let durationMin = (end.h * 60 + end.m) - (start.h * 60 + start.m);
    if (durationMin <= 0) durationMin += 24 * 60;          // crosses midnight
    return { start: { h: start.h, m: start.m }, end: { h: end.h, m: end.m }, durationMin, raw: m[0] };
  }
  // Strip every time/duration token so what's left is the task phrase.
  const TIME_TOKENS = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b|\b\d+\s*(?:min|minute|hour|hr)s?\b/gi;
  function fmtHm(hm) {
    let h = hm.h % 12 || 12;
    return h + (hm.m ? ':' + padZ(hm.m) : '') + ' ' + (hm.h >= 12 ? 'PM' : 'AM');
  }
  function cleanTitle(s) {
    return s.replace(/\s+/g, ' ').trim().replace(/^(to|a|an|the|my|me|that|some)\s+/i, '').trim()
      .replace(/^./, c => c.toUpperCase());
  }

  // ── date resolution ──────────────────────────────────────────────────────────
  // Recognises the explicit date references the assistant commits to acting
  // on: a bare "YYYY-MM-DD" token, or "tomorrow". "today"/"tonight" resolve to
  // null (no day change) since that's already the assistant's default target
  // — every existing caller that never mentions a date keeps behaving exactly
  // as before. Anything richer ("next Friday") is left to the Gemini
  // fallback, which resolves it to an absolute date server-side
  // (proxy/server.js, /api/gemini/assistant) the same way this used to work
  // in the now-retired js/shelron/parser.js.
  const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  function resolveDate(raw) {
    const t = raw.toLowerCase();
    const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso) return iso[1];
    // "tmrw"/"tmr" — common informal abbreviations. Without these, an
    // unrecognized date word silently fell back to whatever day happened to
    // be selected (not necessarily today) with the literal abbreviation left
    // sitting in the stored title — a false-confidence risk (the "✓
    // Scheduled" reply looks complete either way), not just a missed parse.
    // Live-caught 2026-09-03 hardening pass.
    if (/\b(tomorrow|tmrw|tmr)\b/.test(t)) {
      const d = new Date(); d.setDate(d.getDate() + 1);
      return d.getFullYear() + '-' + padZ(d.getMonth() + 1) + '-' + padZ(d.getDate());
    }
    // "yesterday" — added for symmetry with "tomorrow" (Phase 3 adversarial
    // pass found it entirely unhandled: "what did I train yesterday"/"what
    // was on yesterday" had no way to resolve a date at all).
    if (/\byesterday\b/.test(t)) {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + padZ(d.getMonth() + 1) + '-' + padZ(d.getDate());
    }
    // "next Friday" / "this Monday" / bare "Friday" — deterministic weekday
    // resolution (Shenlong Intelligence pass, 2026-08-03). "next X" = the
    // occurrence of X that is NOT today (1-7 days out); "this X" / a bare
    // weekday name = the closest upcoming occurrence, including today if
    // today IS X. The Gemini fallback (proxy/server.js) mirrors this exact
    // rule for richer phrases this local parser doesn't attempt ("next
    // Friday afternoon", "before gym").
    const wd = t.match(/\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
    if (wd) {
      const isNext = /^next\s+/.test(wd[0]);
      const targetDow = WEEKDAY_NAMES.indexOf(wd[2]);
      const d = new Date();
      let delta = (targetDow - d.getDay() + 7) % 7;
      if (isNext && delta === 0) delta = 7; // "next Friday" said on a Friday → 7 days out
      d.setDate(d.getDate() + delta);
      return d.getFullYear() + '-' + padZ(d.getMonth() + 1) + '-' + padZ(d.getDate());
    }
    return null;
  }

  // ── local intent parser ─────────────────────────────────────────────────────
  // Order matters: more specific bridges (water/food/notes) before the generic
  // calendar verbs so "log water" never reads as "complete an event".
  function parseLocal(raw) {
    const t = raw.toLowerCase().trim();
    const date = resolveDate(raw);

    // Gym-specific "what's my workout" question — must win over the generic
    // Calendar summarize catch-all right below, which only knows about
    // `events` and would otherwise answer "nothing on the calendar" even
    // with a real routine scheduled for today (Known Issue #53's companion
    // finding). Restricted to actual question phrasing (leading question
    // word or a trailing "?", same shape as `isQuestion` below) so a real
    // mutation like "move my workout to 4pm" is never misread as this.
    // "show me my weekly routine" / "what's my routine this week" / "my
    // routines" — reads the trainingDays schedule across every saved
    // routine. Checked BEFORE gym_today (a live adversarial pass found
    // "What's my routine this week?" answered as if asking about TODAY
    // only — gym_today's broader "any question containing routine" trigger
    // matched first and gym_week's own trigger required "week" to appear
    // BEFORE "routine"/"schedule", which real phrasing doesn't reliably do).
    // Order-independent now — but deliberately only "routine"/"split", NOT
    // "schedule"/"plan": a second live pass caught the broadened trigger
    // over-firing on "What's my schedule this week?" (a plainly calendar
    // question) purely because "schedule" is domain-neutral, not a real
    // gym signal the way "routine"/"split" are in this context.
    if ((/\bweek(ly)?\b/i.test(t) && /\b(routine|split)s?\b/i.test(t)) || /\bmy routines\b/i.test(t)) {
      return { action: 'gym_week' };
    }
    // Bare "training" (not just "training session") added after a Phase 4
    // pass caught "What am I training today?" — a natural rephrasing of
    // "what workout do I have today" — falling all the way through to
    // Calendar's summarize and answering from unrelated events, silently
    // ignoring the actual gym question. Still gated to real question
    // phrasing, same as before, to keep the false-positive risk low.
    if ((/^(what|which|how|is|are|do|does|did|have|has)\b/.test(t) || /\?\s*$/.test(raw.trim())) &&
        /\b(workout|routine|training( session)?)s?\b/i.test(t)) {
      return { action: 'gym_today', detail: /\bexercises?\b/i.test(t) };
    }
    // Gym routine AUTHORING/EDITING/DELETION — must win over Calendar's
    // delete/retime verb regexes just below ("remove", "change", "move" are
    // also gym vocabulary: "remove squats", "change bench press to 4
    // sets") and over the generic add/create catch-all further down (Known
    // Issue #53's original misrouting bug class). Restricted to phrasing
    // with NO explicit clock time — "add gym at 5pm" / "move workout to
    // 4pm" stay real calendar blocks (Known Issue #22), the same boundary
    // the narrower guard this supersedes already enforced.
    if (window.Shelron.Routines && !parseTime(t) && !parseTimeRange(raw)) {
      const gymIntent = window.Shelron.Routines.parseIntent(raw, t, date);
      if (gymIntent) return gymIntent;
    }
    // summarize / greeting
    if (/^(summari[sz]e|recap|overview|brief)\b/.test(t) ||
        // Known Issue: the trailing alternation had no leading \b, so "day"
        // matched as a mid-word substring of "yesterday"/"someday"/
        // "birthday" — found via a Phase 3 adversarial pass ("What did I
        // train yesterday?" was silently answered as a generic "what's on
        // today" summary). \b added before the group so each alternative
        // only matches as a real, standalone word.
        // Deliberately NOT including "yesterday" here — "what's on
        // yesterday" already matches via "on"; adding "yesterday" itself
        // would also catch "what did I TRAIN yesterday" (a gym question
        // with no real answer today, no history-query capability exists)
        // and confidently answer from an unrelated calendar day instead of
        // honestly declining. resolveDate() still resolves "yesterday"
        // wherever a date IS needed (delete/summarize-by-"on"/etc.).
        // Explicit weekday names ALSO end in "day" and, unlike "yesterday",
        // are a completely legitimate, common way to ask "what's on
        // Thursday" — the \b fix above accidentally excluded them too
        // (caught live: "What do I have Thursday?" stopped matching at
        // all). Listed explicitly rather than restoring the loose "day"
        // substring match that caused the original bug.
        /\b(what('?s| is)?|show|how('?s| is)?).*\b(today|tomorrow|tonight|schedule|day|plan|on|calendar|left|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.test(t) ||
        /^(good\s+(morning|afternoon|evening)|hi|hey|hello)\b/.test(t)) {
      return { action: 'summarize', date };
    }
    // A question about water/food ("how much water have I had", "did I log
    // lunch?") must NOT be misread as a command to log more of it — this
    // pre-existing gap let a plain question like "how much water so far"
    // silently log a phantom serving with no confirmation. Found by the
    // Shenlong Intelligence pass test suite (2026-08-03); falls through to
    // Gemini instead, which can answer accurately using the (now
    // domain-scoped) health context rather than mutating state.
    const isQuestion = /^(how|what|did|have|has|when|is|are|do|does)\b/.test(t) || /\?\s*$/.test(raw.trim());
    // water
    if (!isQuestion && (/\b(water|hydrat)/.test(t) || /\b(drank|drink|had)\b.*\b(glass|bottle|cup)\b/.test(t) ||
        /^log\s+(a\s+|one\s+)?(glass|bottle|cup)\b/.test(t))) {
      const n = (t.match(/\b(\d+)\b/) || [])[1];
      const unit = /bottle/.test(t) ? 'bottle' : /glass|cup/.test(t) ? 'glass' : null;
      return { action: 'log_water', servings: n ? +n : 1, unit };
    }
    // food
    if (!isQuestion && (/\b(ate|eaten|eating)\b/.test(t) || (/\bfood|meal|kcal|calorie/.test(t) && /\b(log|add|track|had)\b/.test(t)))) {
      const cal = (t.match(/(\d+)\s*(kcal|cal|calorie)/) || [])[1];
      let name = raw.replace(/\b(log|add|track)\b/gi, '').replace(/\b(that\s+)?i\s+(just\s+)?(ate|had|eaten)\b/gi, '')
        .replace(/[~]?\d+\s*(kcal|cal|calories?)/gi, '').replace(/\bfor\b\s*$/i, '').trim();
      return { action: 'log_food', name: cleanTitle(name) || 'Meal', calories: cal ? +cal : null };
    }
    // Durable fact/preference for Shenlong to remember long-term — distinct
    // from "remember to X" (a task/reminder, handled by the note branch right
    // below, unchanged). "remember that/I'm/my X", "keep in mind that X",
    // "don't forget that X" (Shenlong Intelligence pass, 2026-08-03).
    // Local-first: no round-trip to Gemini needed just to store a fact.
    if (/\bremember\s+(that\b|i'?m\b|i\s+am\b|my\b)/i.test(t) || /\b(keep in mind|don'?t forget)\s+that\b/i.test(t)) {
      let text = raw
        .replace(/\bremember\s+that\s+/i, '')
        .replace(/\bremember\s+(?=i'?m\b|i\s+am\b|my\b)/i, '')
        .replace(/\b(keep in mind|don'?t forget)\s+that\s+/i, '')
        .trim();
      if (text) {
        text = text.charAt(0).toUpperCase() + text.slice(1);
        return { action: 'remember_fact', text };
      }
    }
    // explicit note
    if (/^note[:\-]/i.test(raw) || /\b(jot|remember to|note that|add a note)\b/.test(t)) {
      let text = raw.replace(/^note[:\-]\s*/i, '').replace(/\b(jot down|jot|note that|add a note( to)?|remember to)\b/gi, '').trim();
      return { action: 'note', text: text || raw };
    }
    // ── STATE MUTATIONS — consult the live calendar so an EXISTING block always
    // wins over the broad "create" logic. This is the fix for "unmark read a
    // book" being mis-read as scheduling "Unmark read a": we strip the action
    // word, resolve the remaining phrase against today's blocks, and only fall
    // back to creation when no block matches.
    const A = window.AptCal;
    // Words that aren't part of a block title — dropped before fuzzy matching.
    const FILLER = /\b(the|my|a|an|that|this|please|it|i|just|to|item|entry|event|block|task|as|off|for|on|today|tonight|tomorrow|tmrw|tmr|already|done|complete[d]?|finished?)\b/gi;
    const phraseFrom = (re) => raw.replace(re, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
    const resolve = (phrase) => (A && A.matchTitle ? A.matchTitle(phrase) : null);
    // Coreference: a phrase that is empty or just a pronoun ("it", "that",
    // "this task", "the event") refers back to the last event acted on.
    const PRONOUN_ONLY = /^(it|that|this|this (task|event|one)|the (task|event|one))$/i;
    // "Move it to Thursday"/"Delete it tomorrow": the RETIME/DELETE/CHECK/
    // UNCHECK branches don't strip weekday names or "tomorrow" from their
    // own phrase extraction (only FILLER's today/tonight/tomorrow are
    // covered, and RETIME's own stripping doesn't even use FILLER) — so the
    // phrase reaching coref() was "it thursday", which fails the exact
    // PRONOUN_ONLY test and silently falls through to a literal (and
    // doomed) search for an event titled "it thursday". A live adversarial
    // pass caught this; an EARLIER live test had appeared to work only by
    // coincidence (the test event's title happened to contain "audit",
    // whose trailing "it" gave a false-positive weak substring match — not
    // genuine coreference at all). Stripped here, once, so every caller of
    // coref() benefits without duplicating this list at each call site.
    const DATE_WORDS_IN_PHRASE = /\b(tomorrow|tonight|today|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
    const coref = (phrase) => {
      const p = (phrase || '').trim();
      // A completely ordinary "Delete it." (trailing sentence punctuation)
      // left FILLER-stripping with a lone "." — which fails the exact
      // PRONOUN_ONLY test just like the unstripped date words above did.
      // Found live via a compound command's final clause ("...then delete
      // it.") but confirmed general: a single plain "Delete it." has the
      // identical failure, nothing compound-specific about it.
      const pForPronounCheck = p.replace(DATE_WORDS_IN_PHRASE, ' ').replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ').trim();
      return ((!pForPronounCheck || PRONOUN_ONLY.test(pForPronounCheck)) && lastMentionedEventTaskName) ? lastMentionedEventTaskName : p;
    };
    // Known Issue #24/E8b, closed: resolve a phrase to a real title AND, in
    // the same call, capture whether that resolution was a genuine tie —
    // read immediately after resolve() runs (findEvent sets the flag/
    // candidates synchronously, before resolve() returns), so this always
    // reflects THIS call, never a stale one. Every mutating branch below
    // uses this instead of a bare `resolve(phrase) || phrase`, so the
    // returned intent itself carries `ambiguous`/`ambiguousCandidates` —
    // applyIntent asks for clarification instead of mutating when set,
    // rather than guessing via findEvent's own tie-break and disclosing
    // only after the fact.
    const resolveWithAmbiguity = (phrase) => {
      const title = resolve(phrase);
      const ambiguous = A.wasLastMatchAmbiguous();
      const candidates = ambiguous ? A.getAmbiguousCandidates() : [];
      return { match: title || phrase, found: !!title, ambiguous, candidates };
    };
    // A message that clearly OPENS with a create-intent verb ("Add SHENLONG_TEST
    // check-in at 3pm") must never be hijacked by a mutation branch just
    // because a trigger word ("check") happens to appear inside the intended
    // TITLE. A live adversarial pass caught exactly this: "check-in" in a new
    // event's title matched the CHECK/complete_event branch (checked before
    // ADD), which fuzzy-matched and completed/moved an unrelated REAL event
    // instead of creating the intended one — a genuinely dangerous class of
    // bug (any of check/uncheck/delete/retime's trigger words appearing
    // inside a title text: "check-in", "clearance meeting", "pushup club",
    // "changeover review" ...). Guards UNCHECK/CHECK/DELETE/RETIME below,
    // NOT rename/recover (both require a much more specific full-sentence
    // pattern, not a bare trigger word, so a title collision can't fire them).
    //
    // SHENLONG P0 (2026-09-08, live-verified): the `^`-anchor above only
    // recognized the create verb as the message's literal first word, so any
    // ordinary request framing ("Please add...", "Can you schedule...", "I'd
    // like to create...") left clearlyAddIntent false — reopening exactly the
    // hijack this guard exists to prevent. Live reproduction: "Please add a
    // check-in about X tomorrow at 6am" never reached the ADD branch at all;
    // it silently marked an unrelated existing event complete instead,
    // reporting a confident "✓ Awesome" success.
    //
    // Fixed by stripping a small, fully-enumerated whitelist of request
    // framings from the START of the message before re-testing the same
    // anchor — never applied to phrase/title extraction, so the fix only
    // widens what counts as "clearly opens with a create verb," it never
    // weakens the anchor itself. A rename/delete/complete/move/mark command,
    // or a quoted title, does not open with "please"/"can you"/"could you"/
    // "would you"/"I'd like to"/"I want to"/"I need you to" immediately
    // followed by add/schedule/create/... — so none of those can accidentally
    // satisfy this test; only an actual polite creation request can. Looped a
    // few times so stacked framings ("Please, could you add...") resolve.
    const ADD_INTENT_LEAD_INS = [
      /^please[,]?\s+/i,
      /^(?:can|could|would|will)\s+you\s+(?:please[,]?\s+)?/i,
      /^i(?:'d|\s+would)?\s+like\s+(?:you\s+)?to\s+/i,
      /^i\s+(?:want|need)\s+(?:you\s+)?to\s+/i,
    ];
    let tForAddIntent = t;
    for (let pass = 0; pass < 3; pass++) {
      const before = tForAddIntent;
      for (const re of ADD_INTENT_LEAD_INS) tForAddIntent = tForAddIntent.replace(re, '');
      if (tForAddIntent === before) break;
    }
    const clearlyAddIntent = /^(add|schedule|create|new|remind(er)?|set up|block)\b/i.test(tForAddIntent);

    // RENAME — change an existing block's title. Checked before re-time / delete
    // / add so "change the name of X to Y" is read as a title edit (there's no
    // time involved) rather than a re-time, a delete, or a brand-new event.
    // Captures the target (match) and the new title; the new title drops a
    // trailing "without …" aside and any wrapping quotes, then sentence-cases.
    {
      const rm =
        raw.match(/\b(?:change|update|set|edit|fix|correct)\s+(?:the\s+)?(?:name|title)\s+of\s+(.+?)\s+(?:to|into)\s+(.+)$/i) ||
        raw.match(/\b(?:change|update|set|edit|fix|correct)\s+(.+?)(?:'s)?\s+(?:name|title)\s+(?:to|into)\s+(.+)$/i) ||
        raw.match(/\brename\s+(.+?)\s+(?:to|as|into)\s+(.+)$/i);
      if (rm) {
        const target = coref(rm[1].replace(FILLER, ' ').replace(/\s+/g, ' ').trim());
        const newTitle = cleanTitle(
          rm[2].trim()
            .replace(/\s+without\b.*$/i, '')          // "…to Walk without the typo"
            .replace(/^["'“”`]+|["'“”`]+$/g, '')       // wrapping quotes
            .trim()
        );
        if (newTitle) {
          const r = resolveWithAmbiguity(target);
          return { action: 'rename_event', match: r.match, newTitle, date, ambiguous: r.ambiguous, ambiguousCandidates: r.candidates };
        }
      }
    }

    // RECOVER / UNDO / regret — TOP PRIORITY among mutations. A correction like
    // "sorry, my mistake — recover the walk and delete the run" must RESTORE the
    // last dropped block; its negative keywords must never read as a fresh
    // delete. Compound clauses are split upstream in handle(), so by the time a
    // clause reaches here it carries a single intent ("recover the walk").
    if (/\b(recover|restore|re-?add|un-?delete|bring\s+back|put\s+back|revert)\b/.test(t) ||
        /\bundo\b/.test(t) ||
        /\bcancel\s+(that|it|this|the\s+last)\b/.test(t) ||
        /\b(my\s+mistake|my\s+bad|wrong\s+(one|event|block)|did\s?n'?t\s+mean)\b/.test(t)) {
      // Optional name hint of what to bring back (relayed in the confirmation);
      // the volatile history is the actual source of truth for what's restored.
      const phrase = phraseFrom(/\b(recover|restore|re-?add|un-?delete|bring|back|put|revert|undo|cancel|sorry|mean|meant|want|mistake|bad|wrong|did|did\s?n'?t|last)\b/gi);
      return { action: 'restore_event', match: phrase || null };
    }
    // UNCHECK / unmark / incomplete  → toggle done:false
    if (!clearlyAddIntent && (/\b(uncheck|unmark|un-?mark|incomplete|untick|unticked)\b/.test(t) || /\bnot\s+done\b/.test(t))) {
      const phrase = coref(phraseFrom(/\b(uncheck|unmark|un-?mark|incomplete|untick(ed)?|not\s+done)\b/gi));
      const r = resolveWithAmbiguity(phrase);
      if (r.found) return { action: 'uncheck_event', match: r.match, date, ambiguous: r.ambiguous, ambiguousCandidates: r.candidates };
      if (phrase) return { action: 'add_event', title: cleanTitle(phrase), time: parseTime(t), durationMin: null, date };
    }
    // CHECK / complete / finish / done / tick / "log that I…"  → toggle done:true
    if (!clearlyAddIntent && (/\b(check(\s*off)?|complete[d]?|finish(ed)?|done|tick(ed)?)\b/.test(t) ||
        /\bmark\b[\s\S]*\b(done|complete[d]?)\b/.test(t) || /^log\s+(that\s+)?i\b/.test(t))) {
      const phrase = coref(phraseFrom(/\b(log|check(\s*off)?|checkoff|complete[d]?|finish(ed)?|done|tick(ed)?|mark|did)\b/gi));
      const r = resolveWithAmbiguity(phrase);
      if (r.found) return { action: 'complete_event', match: r.match, date, ambiguous: r.ambiguous, ambiguousCandidates: r.candidates };
      if (phrase) return { action: 'add_event', title: cleanTitle(phrase), time: parseTime(t), durationMin: null, date };
    }
    // DELETE / remove / cancel  → remove the block entirely
    if (!clearlyAddIntent && /\b(delete|remove|cancel|clear|drop)\b/.test(t)) {
      const phrase = coref(phraseFrom(/\b(delete|remove|cancel|clear|drop)\b/gi));
      const r = resolveWithAmbiguity(phrase);
      return { action: 'delete_event', match: r.match, date, ambiguous: r.ambiguous, ambiguousCandidates: r.candidates };
    }
    // RE-TIME — move / reschedule / shift / reduce / extend / shorten / lengthen.
    // Pulls the task name + any time(s) or duration so it can recompute start AND
    // end of the block. A range ("10pm to 12am") sets both; a single time shifts;
    // "by/to N min|hr" resizes. "set"/"make" are excluded (they collide with the
    // "set up" create verb). The branch fires when a time/duration is given, OR
    // when only a date is given ("move it to Friday") — a date-only cross-day
    // move, previously unsupported (the retime mechanics had no notion of
    // changing an event's day at all — see apiRetimeEvent's opts.moveToDate).
    if (!clearlyAddIntent && /\b(move|reschedule|resched|shift|push|change|reduce|extend|shorten|lengthen|resize)\b/.test(t)) {
      // Prefer an explicit "X to Y" range (handles bare 24h hours like "22 to
      // 23:30"); fall back to the looser am/pm/colon scanner for "10pm to 12am".
      const range = parseTimeRange(t);
      const times = range ? [range.start, range.end] : parseTimes(t);
      const byMatch = t.match(/\bby\s+(\d+)\s*(min|minute|hour|hr)s?\b/);
      const toDur = !range && t.match(/\bto\s+(\d+)\s*(min|minute|hour|hr)s?\b/);
      const conv = (mm) => (/hour|hr/.test(mm[2]) ? +mm[1] * 60 : +mm[1]);
      if (times.length || byMatch || toDur || date) {
        let stripped = raw.replace(/\b(move|reschedule|resched|shift|push|change|reduce|extend|shorten|lengthen|resize)\b/gi, ' ');
        if (range) stripped = stripped.replace(range.raw, ' ');
        const phrase = coref(stripped
          .replace(/\bfrom\b|\bto\b|\bat\b|\bby\b/gi, ' ')
          .replace(TIME_TOKENS, ' ')
          .replace(/\b(my|the|a|an)\b/gi, ' ')
          .replace(/\s+/g, ' ').trim());
        const r = resolveWithAmbiguity(phrase);
        const out = { action: 'retime_event', match: r.match, date, ambiguous: r.ambiguous, ambiguousCandidates: r.candidates };
        if (times.length >= 2) { out.time = times[0]; out.endTime = times[1]; }
        else if (times.length === 1) { out.time = times[0]; }
        if (times.length < 2) {
          if (byMatch) out.deltaMin = (/extend|lengthen/.test(t) ? 1 : -1) * conv(byMatch);
          else if (toDur) out.durationMin = conv(toDur);
        }
        return out;
      }
    }
    // ADD / schedule / remind (broad — LAST). "book" is intentionally NOT a
    // trigger: it collides with real titles like "read a book".
    if (/\b(add|schedule|create|new|remind(er)?|set up|block)\b/.test(t)) {
      // Known Issue #53: this broad add/create match has no domain check, so a
      // routine-authoring request ("Create a 3-day workout routine", "Add
      // Bench Press to Monday") used to fall straight into add_event, which
      // then asked "when should I schedule '<the whole sentence>'?" — an
      // unsupported Gym operation silently became a Calendar one. Shenlong has
      // no capability to create or edit routines (that's the Routine Builder's
      // job, js/gym/routine-builder.js) — decline honestly instead of
      // proposing a bogus calendar event. Deliberately narrow: bare "gym"/
      // "workout" (e.g. "add gym at 5pm", "move workout to 4pm") are real,
      // pre-existing, intentional calendar-block titles (Known Issue #22's
      // fix) and must keep working — only fire on vocabulary that specifically
      // signals routine construction, not just a gym-flavored calendar block.
      const ROUTINE_AUTHORING = /\b(routine|workout plan|exercises?|reps?|sets?|bench(\s*press)?|squat|deadlift|leg day|push day|pull day|hypertrophy)\b/i;
      if (ROUTINE_AUTHORING.test(t) && !parseTime(t) && !parseTimeRange(raw)) {
        return { action: 'gym_unsupported' };
      }
      // A "X to Y" range ("22 to 23:30") wins: it pins start + auto-duration and
      // is excised whole from the title so no clock fragment leaks through.
      const range = parseTimeRange(raw);
      let time, endTime = null, durationMin = null;
      if (range) {
        time = range.start; endTime = range.end; durationMin = range.durationMin;
      } else {
        time = parseTime(t);
        const durM = (t.match(/(\d+)\s*(min|minute|hour|hr)/) || []);
        if (durM[1]) durationMin = /hour|hr/.test(durM[2]) ? +durM[1] * 60 : +durM[1];
      }
      let title = raw
        .replace(/\b(add|schedule|create|new|set up|block|a reminder to|reminder to|remind me to|reminder|remind)\b/gi, '');
      if (range) title = title.replace(range.raw, ' ');
      title = title
        .replace(/\bfrom\b/gi, ' ')
        .replace(/\bat\b\s*[\d:apm\s]+/i, '')
        .replace(/\bfor\b\s*\d+\s*(min|minute|hour|hr)s?/i, '')
        // A leading "for"/"on"/"in" immediately before a date reference is a
        // connector, not part of the title — consumed along with the date
        // word itself so it doesn't leak through as a dangling preposition
        // ("...call for tomorrow at 2pm" → title "...call for", live-caught
        // 2026-09-03). Weekday names (with the same optional connector, plus
        // "next"/"this") get the identical treatment — previously not
        // stripped from the title at all ("...dinner on Friday at 7pm" →
        // title "...dinner on Friday", also live-caught the same pass).
        .replace(/\b(?:(?:for|on|in|to)\s+)?(today|tomorrow|tmrw|tmr|tonight|this (morning|afternoon|evening))\b/gi, '')
        .replace(/\b(?:(?:for|on|in|to)\s+)?(?:next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, '')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
        .replace(/\s+/g, ' ').trim()
        .replace(/\b(event|block)s?\s*$/i, '')   // drop a dangling connector noun
        .trim();
      return { action: 'add_event', title: cleanTitle(title), time, durationMin, endTime, date };
    }
    // Bare "TASK from X to Y" (no verb) — re-time, but ONLY when the phrase maps
    // to an existing block, so it never hijacks creation of a brand-new entry.
    {
      const range = parseTimeRange(t);
      const times = range ? [range.start, range.end] : parseTimes(t);
      if (times.length >= 2) {
        let stripped = raw;
        if (range) stripped = stripped.replace(range.raw, ' ');
        const phrase = coref(stripped.replace(/\bfrom\b|\bto\b|\bat\b/gi, ' ').replace(TIME_TOKENS, ' ')
          .replace(/\b(my|the|a|an)\b/gi, ' ').replace(/\s+/g, ' ').trim());
        const title = resolve(phrase);
        if (title) return { action: 'retime_event', match: title, time: times[0], endTime: times[1], date };
      }
    }
    return null; // unknown → Gemini fallback
  }

  // ── water bridge — reuse the topbar's tested add pipeline (handles ml + sync) ─
  function logWater(servings) {
    const btn = document.getElementById('topbarWaterAdd');
    if (!btn) return false;
    for (let i = 0; i < Math.max(1, servings || 1); i++) btn.click();
    return true;
  }
  // ── food bridge — append to po_food_v1 (6AM-anchored day key, as health.js) ──
  function logFood(name, calories) {
    const KEY = 'po_food_v1';
    function dayKey() {
      const n = new Date(); if (n.getHours() < 6) n.setDate(n.getDate() - 1);
      return n.getFullYear() + '-' + padZ(n.getMonth() + 1) + '-' + padZ(n.getDate());
    }
    let all = {}; try { all = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    const k = dayKey();
    (all[k] = all[k] || []).push({
      id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      ts: Date.now(), meal_name: name, calories: calories || 0,
      protein: 0, carbs: 0, fats: 0, source: 'assistant',
    });
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {}
    if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    return true;
  }

  // ── apply a structured intent (from local parser OR Gemini) ──────────────────
  async function applyIntent(intent) {
    const A = window.AptCal;
    // Known Issue #24/E8b, closed: ask before mutating on a genuine tie,
    // instead of guessing via findEvent's tie-break and only disclosing
    // afterward. `parseLocal`'s rename/complete/uncheck/delete/retime
    // branches now attach `ambiguous`/`ambiguousCandidates` themselves
    // (right after their own resolve() call finds the tie) — checked here,
    // once, before any of those five cases below ever calls a mutating
    // AptCal method, so this covers all five without duplicating the check.
    // A Gemini-sourced intent (no `ambiguous` field at all) is unaffected —
    // falls through to the switch exactly as before.
    if (intent.ambiguous && Array.isArray(intent.ambiguousCandidates) && intent.ambiguousCandidates.length > 1) {
      const list = intent.ambiguousCandidates
        .map((ev) => '“' + ev.title + '” (' + A.fmtTime(ev.start) + (ev.allDay ? '' : ' – ' + A.fmtTime(ev.end)) + ')')
        .join(', ');
      addMsg('ai', "More than one event matches that — which one did you mean? " + list + '.');
      return;
    }
    // Accept times as {h,m} (local parser) or "HH:MM"/"4pm" strings (Gemini).
    // A malformed "HH:MM" (e.g. Gemini hallucinating "30:99") is rejected here
    // the same way parseTime() rejects one locally — Known Issue #16.
    const asTime = (v) => !v ? null
      : (typeof v === 'string'
          ? (parseTime(v) || window.Shelron.Intent.parseStrictTime((v.match(/(\d{1,2}):(\d{2})/) || []).slice(1).join(':')))
          : v);
    const time = asTime(intent.time);

    // Commands can now target a date other than whatever day is currently
    // selected in the calendar widget (intent.date, from resolveDate() or
    // Gemini's "date" field) — Known Issue #15 fix (reject a malformed date
    // deterministically). Known Issue #22 (Shenlong half): `target` is
    // captured HERE, synchronously, before any await — a concurrent command
    // (another tab, or a future automated caller) changing selectedDate after
    // this point can no longer affect what THIS command resolves against.
    // When a date is explicitly named, A.selectDay() still runs so the UI
    // visibly navigates there (unchanged behaviour) — but the returned
    // `date` is what every downstream find/mutate call actually uses, not
    // whatever selectedDate reads by the time they run. fetchEventsForDate()
    // always does a fresh, request-scoped fetch (see its own comment) so the
    // resolved date's data is guaranteed current, not whatever currentEvents
    // happened to hold.
    async function ensureDate(dateStr) {
      const target = dateStr || A.getSelectedDate();
      if (dateStr) {
        if (!window.Shelron.Intent.isValidCalendarDate(dateStr)) {
          addMsg('ai', "That doesn't look like a valid date.");
          return { ok: false };
        }
        A.selectDay(dateStr);
      }
      await A.fetchEventsForDate(target);
      return { ok: true, date: target };
    }

    switch (intent.action) {
      // Known Issue #53 — no mutation, no calendar fallback. Honest refusal
      // for a capability Shenlong genuinely doesn't have yet; points at the
      // one surface that actually can do this.
      // Recognized as gym-flavored (routine/exercise/sets vocabulary) but
      // didn't match any of the specific ops Shenlong actually supports —
      // NOT "no routine capability exists" (that framing went stale the
      // moment real create/add/remove/set-sets/assign-day/delete shipped,
      // v0.8). Points at the concrete phrasings that DO work instead of a
      // blanket "yet".
      case 'gym_unsupported':
        addMsg('ai', "I'm not sure what to change. I can create a routine (\"Monday chest and triceps\"), add/remove an exercise (\"add bench press to Monday\"), change sets (\"change bench press to 4 sets\"), or delete a routine (\"delete my Friday routine\") — or open the Routine Builder on the Gym page for anything more involved.");
        return;

      // Known Issue #53's companion finding — grounded in the same two
      // read-only sources the Gym page itself uses (a scheduled-by-weekday
      // routine, or an already in-progress session), never invented.
      case 'gym_today': {
        const scheduledName = todaysScheduledRoutineName();
        const gym = todayGymSummary();
        if (gym && gym.workoutInProgress) {
          addMsg('ai', 'You have an open ' + (gym.pinnedRoutineName || 'workout') + ' session — ' +
            gym.setsLoggedInOpenSession + ' set' + (gym.setsLoggedInOpenSession === 1 ? '' : 's') + ' logged so far. Resume when ready.');
        } else if (scheduledName) {
          // "What EXERCISES do I have today?" gets the actual exercise list
          // (grounded in the real routine object), not just its name.
          if (intent.detail && window.Shelron.Routines) {
            const routines = window.Shelron.Routines.getRoutines();
            const r = routines.find((x) => x.name === scheduledName);
            const names = r ? (r.exercises || []).map((e) => e.name) : [];
            addMsg('ai', names.length
              ? 'Today’s "' + scheduledName + '" routine: ' + names.join(', ') + '.'
              : 'Today’s scheduled routine is "' + scheduledName + '", but it has no exercises added yet.');
          } else {
            addMsg('ai', 'Today’s scheduled routine is "' + scheduledName + '".');
          }
        } else {
          addMsg('ai', 'Nothing scheduled for today in your routines. Want me to check the calendar instead?');
        }
        return;
      }

      case 'gym_week': {
        if (!window.Shelron.Routines) { addMsg('ai', "I can't reach the routine data right now."); return; }
        const week = window.Shelron.Routines.readWeek();
        if (!week.scheduled.length) {
          addMsg('ai', week.totalRoutines
            ? "You have " + week.totalRoutines + " routine" + (week.totalRoutines === 1 ? '' : 's') + " saved, but none are scheduled to specific days yet."
            : "You don't have any routines saved yet.");
          return;
        }
        const lines = week.scheduled.map((d) => d.label + ': ' + d.routine.name);
        addMsg('ai', 'Your weekly routine schedule — ' + lines.join('; ') + '.');
        return;
      }

      // A recognized gym-authoring request that genuinely needs more
      // information before anything can be created/changed — asks instead
      // of guessing (never fabricates exercises or a schedule the user
      // didn't specify), and is also how "move it to Friday"/"delete the
      // workout"-style bare gym-vs-calendar ambiguity gets resolved without
      // silently picking a domain.
      case 'gym_clarify':
        addMsg('ai', intent.question || 'Could you say a bit more about what you want?');
        return;

      // Known Issue #53's open half, closed: real routine create/add/
      // remove/set-sets/delete, dispatched to window.Shelron.Routines —
      // the deterministic write bridge (js/shelron/routine-authoring.js).
      // Every branch below reports based on the ACTUAL result of that
      // write, never an assumed success.
      case 'gym_routine_op': {
        if (!window.Shelron.Routines) { addMsg('ai', "I can't reach the routine data right now."); return; }
        const result = await window.Shelron.Routines.apply(intent);
        const op = intent.op;
        // A live adversarial pass caught "Create X and add Y, then move it
        // to Z" silently only doing the create, with the confirmation
        // giving no hint that "add Y"/"move it to Z" never happened.
        // Compound gym ops genuinely aren't supported yet (a real future
        // capability, not an inline special case) — disclose it instead of
        // letting a partial result read as a complete one.
        const compoundNote = op.hasUnexecutedCompoundStep
          ? ' (I only handled the first part of that — send the rest as its own message.)' : '';
        if (op.kind === 'create_multi') {
          if (!result.ok) { addMsg('ai', result.reason === 'catalog_unavailable' ? "I can't reach the exercise library right now — try again in a moment." : "That didn't work."); return; }
          const parts = result.created.map((r) => {
            const day = r.trainingDays[0] ? ' (' + window.Shelron.Routines.dayLabel(r.trainingDays[0]) + ')' : ' (unscheduled)';
            return '"' + r.name + '"' + day + ' — ' + r.exercises.map((e) => e.name).join(', ');
          });
          addMsg('ai', '✓ Created ' + result.created.length + ' routine' + (result.created.length === 1 ? '' : 's') + ': ' + parts.join('; ') + '.' +
            (result.cloudSynced ? '' : ' (saved locally — will sync once the connection is back.)') + compoundNote);
          return;
        }
        if (op.kind === 'assign_day') {
          if (!result.ok) { addMsg('ai', "That didn't work."); return; }
          addMsg('ai', '✓ ' + window.Shelron.Routines.dayLabel(op.day) + ' is now your "' + result.routine.name + '" day: ' +
            result.routine.exercises.map((e) => e.name).join(', ') + '.');
          return;
        }
        if (op.kind === 'add_exercise') {
          if (!result.ok) {
            if (result.reason === 'exercise_not_found') addMsg('ai', "I couldn't find \"" + op.exerciseQuery + '" in the exercise library — try a more common name (e.g. "bench press").');
            else if (result.reason === 'no_routine_for_day') addMsg('ai', "You don't have a routine scheduled for " + window.Shelron.Routines.dayLabel(op.day) + " yet — want me to create one first?");
            else if (result.reason === 'already_present') addMsg('ai', '"' + result.exerciseName + '" is already in "' + result.routine.name + '".');
            else addMsg('ai', "I'm not sure which routine to add that to — try naming a day, e.g. \"add bench press to Monday\".");
            return;
          }
          addMsg('ai', '✓ Added "' + result.exerciseName + '" to "' + result.routine.name + '".');
          return;
        }
        if (op.kind === 'remove_exercise') {
          if (!result.ok) { addMsg('ai', "I couldn't find \"" + op.exerciseQuery + '" in your routines.'); return; }
          addMsg('ai', '✓ Removed "' + result.exerciseName + '" from "' + result.routine.name + '".');
          return;
        }
        if (op.kind === 'set_sets') {
          if (!result.ok) {
            if (result.reason === 'ambiguous_routine') {
              addMsg('ai', '"' + result.exerciseName + '" is in more than one routine (' + result.candidates.join(', ') + ') — which one? Try "change bench press to 4 sets on Monday".');
            } else {
              addMsg('ai', "I couldn't find \"" + op.exerciseQuery + '" in your routines.');
            }
            return;
          }
          addMsg('ai', '✓ "' + result.exerciseName + '" is now ' + result.count + ' sets in "' + result.routine.name + '".');
          return;
        }
        if (op.kind === 'delete_routine') {
          if (!result.ok) { addMsg('ai', "I'm not sure which routine to delete — try naming a day, e.g. \"delete my Friday routine\"."); return; }
          addMsg('ai', '✓ Deleted "' + result.name + '".');
          return;
        }
        addMsg('ai', "That didn't work.");
        return;
      }

      case 'summarize':
        if (!(await ensureDate(intent.date)).ok) return;
        addMsg('ai', A.summarize());
        return;

      case 'add_event': {
        // Known Issue #23: a bare truthiness check let a malformed object/array
        // title (both truthy) or a whitespace-only string through to storage.
        if (typeof intent.title !== 'string' || !intent.title.trim()) { addMsg('ai', 'What should I call that block?'); return; }
        intent.title = intent.title.trim();
        if (!time) { addMsg('ai', 'When should I schedule “' + intent.title + '”? Try “at 4pm”.'); return; }
        const d1 = await ensureDate(intent.date);
        if (!d1.ok) return;
        if (A.isOffline()) { addMsg('ai', "I can't reach the calendar (proxy offline), so I couldn't add “" + intent.title + '”.'); return; }
        // Derive duration from an end time when only a range was supplied (e.g.
        // a Gemini intent that gives endTime but no durationMin).
        let durationMin = intent.durationMin;
        const endHm = asTime(intent.endTime);
        if (durationMin == null && endHm && time) {
          durationMin = (endHm.h * 60 + endHm.m) - (time.h * 60 + time.m);
          if (durationMin <= 0) durationMin += 24 * 60;
        }
        try {
          const r = await A.addEvent(intent.title, time, durationMin, intent.notes, d1.date);
          remember(r.title);
          // Show the full span when an explicit length/range was given; otherwise
          // just the start (default 30-min blocks read cleaner as a single time).
          addMsg('ai', (intent.durationMin != null || intent.endTime)
            ? '✓ Scheduled “' + r.title + '” from ' + r.when + ' to ' + r.end + '.'
            : '✓ Scheduled “' + r.title + '” at ' + r.when + '.');
        } catch { addMsg('ai', 'Adding that failed — is the proxy running?'); }
        return;
      }
      case 'move_event':
      case 'retime_event': {
        const opts = {};
        if (time) opts.start = time;
        if (intent.endTime) opts.end = asTime(intent.endTime);
        if (intent.durationMin != null) opts.durationMin = intent.durationMin;
        if (intent.deltaMin != null) opts.deltaMin = intent.deltaMin;
        // `intent.date` on a move/retime is always the DESTINATION day —
        // "move it to Friday" relocates the event; it never means "search
        // Friday for a match." The match itself always resolves against
        // whatever's currently loaded (selectedDate/currentEvents) plus
        // pronoun memory (lastMentionedEventTaskName), exactly like every
        // other mutating action. This is a deliberate simplification of a
        // genuinely ambiguous phrase ("move the Friday meeting to 5pm" could
        // theoretically mean "search Friday" instead) — chosen because every
        // required test phrasing ("move it to Friday", "move my meeting to
        // Friday") reads as a destination, and a single consistent rule
        // beats a second, harder-to-predict heuristic.
        if (intent.date) {
          if (!window.Shelron.Intent.isValidCalendarDate(intent.date)) {
            addMsg('ai', "That doesn't look like a valid date.");
            return;
          }
          opts.moveToDate = intent.date;
        }
        if (!opts.start && !opts.end && opts.durationMin == null && opts.deltaMin == null && !opts.moveToDate) {
          addMsg('ai', 'Re-time it to when? Try “move workout to 4pm” or “move it to Friday”.');
          return;
        }
        if (!intent.match) {
          addMsg('ai', "I'm not sure which event you mean — try naming it, e.g. “move the dentist appointment to Friday”.");
          return;
        }
        if (A.isOffline()) { addMsg('ai', "I can't reach the calendar (proxy offline) to re-time that."); return; }
        // Refresh the current day before searching (Known Issue #22's
        // freshness guarantee, preserved even though `date` no longer means
        // "which day to search") — then search that same freshly-fetched day.
        const searchDate = A.getSelectedDate();
        await A.fetchEventsForDate(searchDate);
        const r = await A.retimeEvent(intent.match, opts, searchDate);
        const ambiguous = A.wasLastMatchAmbiguous();
        if (r.ok) remember(r.title);
        const dayPrefix = r.ok && r.date
          ? new Date(r.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' at '
          : '';
        addMsg('ai', r.ok
          ? '✓ Moved “' + r.title + '” → ' + dayPrefix + r.when + '–' + r.end + ' (' + r.durationMin + ' min).'
          : "I couldn't find an event matching “" + (intent.match || '') + '”.');
        if (r.ok && ambiguous) addMsg('ai', 'More than one event matched that -- I used the most likely one.');
        return;
      }
      case 'rename_event':
      case 'update_event_title': {
        // Gemini may carry the new name in "title"; the local parser uses "newTitle".
        const next = intent.newTitle || intent.title;
        if (!next) { addMsg('ai', 'What should I rename it to?'); return; }
        if (A.isOffline()) { addMsg('ai', "I can't reach the calendar (proxy offline) to rename that."); return; }
        // `intent.date`, when present, is the day to SEARCH (renaming has no
        // "destination" concept, unlike move/retime) — same convention as
        // complete_event/uncheck_event/delete_event below.
        const d0 = await ensureDate(intent.date);
        if (!d0.ok) return;
        const r = await A.renameEvent(intent.match, next, d0.date);
        if (r.ok) { remember(r.title); addMsg('ai', '✓ Renamed event to “' + A.fmtTitle(r.title) + '”.'); }
        else addMsg('ai', r.noTitle ? 'What should I rename it to?'
          : "I couldn't find an event matching “" + (intent.match || '') + '”.');
        return;
      }
      case 'complete_event': {
        const d3 = await ensureDate(intent.date);
        if (!d3.ok) return;
        const r = A.completeEvent(intent.match, d3.date);
        const ambiguous = A.wasLastMatchAmbiguous();
        if (r.ok) remember(r.title);
        addMsg('ai', r.ok ? '✓ Awesome — marked “' + r.title + '” as completed.'
          : (A.isOffline() ? "I can't see your events (proxy offline) to check that off."
            : "I couldn't find an event matching “" + (intent.match || '') + '”.'));
        if (r.ok && ambiguous) addMsg('ai', 'More than one event matched that -- I used the most likely one.');
        return;
      }
      case 'uncheck_event': {
        const d4 = await ensureDate(intent.date);
        if (!d4.ok) return;
        const r = A.uncheckEvent(intent.match, d4.date);
        const ambiguous = A.wasLastMatchAmbiguous();
        if (r.ok) remember(r.title);
        addMsg('ai', r.ok ? "✓ I've unchecked “" + r.title + '” — back on your list.'
          : (A.isOffline() ? "I can't see your events (proxy offline) to uncheck that."
            : "I couldn't find an event matching “" + (intent.match || '') + '”.'));
        if (r.ok && ambiguous) addMsg('ai', 'More than one event matched that -- I used the most likely one.');
        return;
      }
      case 'delete_event': {
        const d5 = await ensureDate(intent.date);
        if (!d5.ok) return;
        if (A.isOffline()) { addMsg('ai', "I can't reach the calendar (proxy offline) to delete that."); return; }
        const r = await A.deleteEvent(intent.match, d5.date);
        const ambiguous = A.wasLastMatchAmbiguous();
        addMsg('ai', r.ok ? '✓ Deleted “' + r.title + '”.'
          : r.error ? 'Deleting that failed — is the proxy running?'
            : "I couldn't find an event matching “" + (intent.match || '') + '”.');
        if (r.ok && ambiguous) addMsg('ai', 'More than one event matched that -- I used the most likely one.');
        return;
      }
      case 'restore_event':
      case 'undo': {
        if (A.isOffline()) { addMsg('ai', "I can't reach the calendar (proxy offline) to recover that."); return; }
        const r = await A.restoreEvent(intent.match);
        if (r.ok) { remember(r.title); addMsg('ai', '✓ Recovered “' + r.title + '” at ' + r.when + '.'); }
        else if (r.empty) addMsg('ai', "There's nothing for me to undo — I haven't deleted anything recently.");
        else addMsg('ai', 'Bringing that back failed — is the proxy running?');
        return;
      }
      case 'log_water': {
        const n = intent.servings || 1;
        const ok = logWater(n);
        addMsg('ai', ok ? '✓ Logged ' + n + ' ' + (n === 1 ? 'serving' : 'servings') + ' of water. 💧'
          : "I couldn't reach the water tracker from here.");
        return;
      }
      case 'log_food': {
        logFood(intent.name || 'Meal', intent.calories);
        addMsg('ai', '✓ Logged “' + (intent.name || 'Meal') + '”'
          + (intent.calories ? ' · ' + intent.calories + ' kcal' : '') + ' to your nutrition log.');
        return;
      }
      case 'note': {
        window.QuickNotes.add(intent.text);
        addMsg('ai', '✓ Noted: “' + intent.text + '”.');
        return;
      }
      case 'remember_fact': {
        // rememberFact() is the deterministic validator (length cap, dedup,
        // oldest-eviction) — the model (or local parser) only ever proposes
        // text, this is what actually decides whether it's stored.
        const saved = rememberFact(intent.text);
        addMsg('ai', saved ? '✓ Got it — I\'ll remember that.' : 'I already know that — no need to repeat it.');
        return;
      }
      case 'chat':
      default:
        addMsg('ai', intent.reply || "I'm not sure how to act on that yet.");
        return;
    }
  }

  // ── Gemini fallback ──────────────────────────────────────────────────────────
  // Step 2 of the reasoning pipeline: contextual retrieval. classifyIntentDomain()
  // (step 1, already run) decides which domain summaries are worth the tokens —
  // a pure gym question doesn't need the calendar dumped in, and vice versa.
  // 'general'/'multi'/'unknown' stay maximal (safe default for cross-domain or
  // ambiguous asks). Memory (durable facts) rides along on every request —
  // it's small and capped, and a stored preference can matter regardless of
  // domain (e.g. a dietary note affecting gym nutrition advice).
  async function askGemini(message) {
    const domain = classifyIntentDomain(message);
    const wantsAll = domain === 'general' || domain === 'multi' || domain === 'unknown';
    const context = {
      date: todayStr(),
      domain,
      memory: memoryFactTexts(),
    };
    if (wantsAll || domain === 'calendar') context.events = window.AptCal.getEvents();
    if (wantsAll || domain === 'gym') context.gym = todayGymSummary();
    if (wantsAll || domain === 'health') context.health = todayHealthSummary();
    if (wantsAll || domain === 'wardrobe') context.wardrobe = todayWardrobeSummary();

    const res = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        window.__appAccessToken ? { 'Authorization': 'Bearer ' + window.__appAccessToken } : {}),
      body: JSON.stringify({ message, context }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ── compound command splitting ───────────────────────────────────────────────
  // Break "recover the walk and delete the run" into ordered clauses so each is
  // handled as its own intent. We only treat a message as compound when ≥2
  // clauses each resolve to a real local intent — otherwise it's a single command
  // that merely contains "and"/"then" (e.g. "add read a book and relax") and we
  // fall back to parsing the whole message intact.
  const CLAUSE_SPLIT = /\s*(?:,\s*(?:and|then)?\s+|\band\s+then\b|\bthen\b|\band\b|;|&|\+|\balso\b)\s*/i;
  // Gym compound commands ("Create my Monday routine, add bench press, make
  // it four sets, then rename it") previously always ran only the first
  // recognized op, silently — gym-flavored messages bypass parseCompound
  // below entirely (see its own comment), and Shelron.Routines' parseIntent
  // never executes more than one op per call. Deliberately narrow fix:
  // requires an explicit "then" — a comma/bare-"and" alone stays reserved
  // for the multi-day CREATE pattern ("Monday chest and triceps, Wednesday
  // back and biceps"), which has no verb per segment and would misparse if
  // split. "then" is the one connector a genuine multi-day create phrase
  // never uses, so it's a safe, unambiguous "these are separate steps"
  // signal. Real future work is full compound support without requiring
  // "then" specifically — tracked as a known scope limit, not solved here.
  function parseGymCompound(msg) {
    if (!(window.Shelron.Routines && window.Shelron.Routines.looksLikeGymRequest(msg))) return null;
    if (!/\bthen\b/i.test(msg)) return null;
    const clauses = msg.split(CLAUSE_SPLIT).map(s => s.trim()).filter(Boolean);
    if (clauses.length < 2) return null;
    // Same "count real intents, discard the parse" pattern parseCompound
    // uses below — the clauses are what's returned/executed, re-parsed
    // fresh right before each is applied (same reasoning as the pronoun-
    // staleness fix: a later clause's "it"/day context must see the effect
    // of an earlier clause actually running, not a snapshot from before
    // any of them ran). EVERY clause must independently show a real gym
    // signal — not just 2 of them — or this reverts to non-compound
    // handling entirely. Found live: "Create a Monday chest routine and add
    // bench press, then move it to Wednesday" split into 3 clauses, but
    // clause 3 ("move it to Wednesday") carries no gym vocabulary of its
    // own (a bare pronoun) — gym has no "move THIS routine" op at all, so
    // that clause fell through to CALENDAR's own retime branch instead,
    // meaning a gym compound command could leak into mutating an unrelated
    // real calendar event via a coincidentally-matching "it". Requiring
    // 100% of clauses to be gym-valid means a message like this simply
    // isn't treated as compound at all (falls back to the single-message
    // path, same disclosed "only handled the first part" behavior as
    // before) rather than guessing which domain a stray clause belongs to.
    const validCount = clauses.filter((c) => {
      const it = parseLocal(c);
      return it && (it.action === 'gym_routine_op' || it.action === 'gym_clarify');
    }).length;
    return (validCount >= 2 && validCount === clauses.length) ? clauses : null;
  }
  function parseCompound(msg) {
    // A gym-authoring request legitimately uses commas/"and" as ITS OWN
    // day/muscle-group separators ("Monday chest and triceps, Wednesday
    // back and biceps, Friday legs") — splitting it here would shred it
    // into fragments too small for Shelron.Routines' parser to recognize as
    // one coherent multi-day request (each fragment would either build an
    // incomplete routine or silently decline). Handled as ONE clause via
    // the normal parseLocal(msg) path below instead — never split here.
    if (window.Shelron.Routines && window.Shelron.Routines.looksLikeGymRequest(msg)) return null;
    const clauses = msg.split(CLAUSE_SPLIT).map(s => s.trim()).filter(Boolean);
    if (clauses.length < 2) return null;
    // Only used to DECIDE whether this message is genuinely multi-intent
    // (>=2 clauses each independently parse to something) — the CLAUSES are
    // returned, not this parse's results. A Phase 4 adversarial pass found
    // that returning the pre-parsed intents here made every pronoun in a
    // compound command resolve against STALE context: "Create X, rename it,
    // move it to Friday, then delete it" parsed ALL FOUR clauses up front,
    // before clause 1 had even run — so "it" in clauses 2-4 could never see
    // clause 1's just-created title (remember() only fires during apply,
    // which hadn't happened yet for any clause). Every clause after the
    // first silently failed with an empty or stale match. Clauses are
    // re-parsed one at a time, interleaved with applying them, in handle()
    // below — this pre-check's own parse is discarded, kept only as the
    // cheap gate that stops "add read a book and relax" (one real intent
    // that merely contains "and") from being misread as compound at all.
    const intents = clauses.map(c => parseLocal(c)).filter(Boolean);
    return intents.length >= 2 ? clauses : null;
  }

  // ── submit flow ──────────────────────────────────────────────────────────────
  let busy = false;
  async function handle(text) {
    const msg = text.trim();
    if (!msg || busy) return;
    busy = true; setSummoning(true);
    addMsg('user', msg);
    // Gym compound commands (explicit "then" only — see parseGymCompound's
    // own comment) checked first, same interleaved re-parse-then-apply
    // pattern as the calendar compound loop below. Stops after a clause
    // that comes back needing clarification — continuing past that would
    // mean guessing at exactly the thing the user was just asked about.
    const gymCompoundClauses = parseGymCompound(msg);
    if (gymCompoundClauses) {
      for (const c of gymCompoundClauses) {
        const it = parseLocal(c);
        if (!it) continue;
        try { await applyIntent(it); } catch (e) { addMsg('ai', 'Something went wrong handling that.'); }
        if (it.action === 'gym_clarify') break;
      }
      busy = false; setSummoning(false); return;
    }
    // Multi-intent corrections first: applying a restore BEFORE a delete is what
    // stops "recover X and delete Y" from collapsing into a second deletion.
    const compoundClauses = parseCompound(msg);
    if (compoundClauses) {
      for (const c of compoundClauses) {
        // Re-parse HERE, not earlier — pronoun/coreference state
        // (lastMentionedEventTaskName, Shelron.Routines' own lastRoutineRef)
        // only updates as each clause is actually applied, so "rename it"/
        // "move it"/"delete it" in clause 2+ needs clause 1's real effect,
        // not whatever the parser saw before this whole message arrived.
        const it = parseLocal(c);
        if (!it) continue; // this exact clause didn't reparse to anything actionable; skip, don't crash the rest
        try { await applyIntent(it); } catch (e) { addMsg('ai', 'Something went wrong handling that.'); }
      }
      busy = false; setSummoning(false); return;
    }
    const local = parseLocal(msg);
    if (local) {
      try { await applyIntent(local); } catch (e) { addMsg('ai', 'Something went wrong handling that.'); }
      busy = false; setSummoning(false); return;
    }
    // free-form → Gemini (only reachable on the deployed proxy)
    const thinking = addThinking();
    try {
      const intent = await askGemini(msg);
      thinking.remove();
      // Confidence is deliberately not surfaced as a UI badge (Shenlong stays
      // conversational, not clinical — low/medium confidence is voiced in
      // "reply" itself per the server prompt) — logged only, for local
      // inspection during testing (Shenlong Intelligence pass, 2026-08-03).
      if (intent && intent.confidence && intent.confidence !== 'high') {
        console.debug('[Shenlong] confidence:', intent.confidence, '· reply:', intent.reply);
      }
      // Gemini may return a compound plan in "steps" (restore-before-delete, etc.).
      if (intent && Array.isArray(intent.steps) && intent.steps.length) {
        for (const step of intent.steps) { try { await applyIntent(step); } catch (e) { addMsg('ai', 'Something went wrong handling that.'); } }
      } else if (intent && intent.reply && (!intent.action || intent.action === 'chat')) addMsg('ai', intent.reply);
      else await applyIntent(intent);
    } catch (e) {
      console.error('[Shenlong] Gemini assistant request failed:', e);
      thinking.remove();
      addMsg('ai', "I couldn't parse that locally, and the Gemini service isn't reachable here "
        + '(it runs on the deployed proxy). Try a direct command — e.g. “add gym at 5pm”, '
        + '“move workout to 4pm”, “log water”, or “what’s on today?”.');
    }
    busy = false; setSummoning(false);
  }

  // ── voice input — Voice Chat, auto-send (ADR-021; supersedes ADR-020 only on
  // the send-behavior question — the client-side Web Speech API decision below
  // is unchanged) ───────────────────────────────────────────────────────────
  // Audio never leaves the browser; a finished utterance is handed straight to
  // handle() below, the SAME entry point typed messages and quick chips already
  // use — handle()/parseLocal()/askGemini()/applyIntent()/classifyIntentDomain()
  // never learn a message originated as speech. Feature-detected; browsers
  // without support (e.g. Firefox) simply never see the mic button.
  const micBtn = document.getElementById('aiMic');
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (micBtn && !SpeechRec) {
    micBtn.hidden = true;
  } else if (micBtn) {
    let recognition = null;
    let voiceState = 'idle';   // idle | recording | processing
    let hadError = false;
    let wasCancelled = false;
    const subDefault = aiSub ? aiSub.textContent : '';

    function friendlyMicError(code) {
      if (code === 'not-allowed' || code === 'permission-denied' || code === 'service-not-allowed')
        return "Microphone access is blocked — allow it in your browser's site settings to use voice input.";
      if (code === 'no-speech') return "I didn't catch that — try again.";
      if (code === 'audio-capture') return 'No microphone was found.';
      if (code === 'network') return 'Voice recognition needs an internet connection.';
      return "Voice input didn't work — try typing instead.";
    }
    function setVoiceState(next) {
      voiceState = next;
      micBtn.classList.toggle('is-recording', next === 'recording');
      micBtn.classList.toggle('is-processing-voice', next === 'processing');
      micBtn.setAttribute('aria-pressed', String(next === 'recording'));
      if (aiSub) {
        aiSub.textContent = next === 'recording' ? 'Listening… (Esc to cancel)'
          : next === 'processing' ? 'Understanding…' : subDefault;
      }
    }
    // A fresh instance per recording (not reused) sidesteps known cross-browser
    // quirks restarting a single SpeechRecognition object, notably in Safari.
    function startRecording() {
      if (busy || voiceState !== 'idle') return;
      hadError = false; wasCancelled = false;
      recognition = new SpeechRec();
      recognition.lang = navigator.language || 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.__lastTranscript = '';
      recognition.onstart = () => setVoiceState('recording');
      recognition.onresult = (e) => {
        let t = '';
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        recognition.__lastTranscript = t;
      };
      recognition.onerror = (e) => {
        // 'aborted' fires from our own cancelRecording() call — not a real error.
        if (e.error === 'aborted') return;
        hadError = true;
        addMsg('ai', friendlyMicError(e.error));
      };
      recognition.onend = () => {
        const transcript = (recognition && recognition.__lastTranscript || '').trim();
        recognition = null;
        setVoiceState('idle');
        // Cancellation/error win no matter what onend delivers — checked FIRST,
        // before the transcript is even considered, so an abort() that still
        // yields a transcript (a real browser behavior in some engines) can
        // never be sent. Known Issue-worthy trap if this order were reversed.
        if (wasCancelled || hadError) return;
        if (transcript) handle(transcript);   // SAME pipeline as typed text/chips
      };
      try { recognition.start(); } catch (e) { setVoiceState('idle'); }
    }
    // Click while RECORDING = "I'm done" → finalize and send (stop() lets the
    // engine deliver whatever it already captured). Escape = "never mind" →
    // cancel (abort() + wasCancelled, which onend checks before anything else).
    // Two distinct gestures, never conflated.
    function finishRecording() {
      if (voiceState !== 'recording' || !recognition) return;
      setVoiceState('processing');
      recognition.stop();
    }
    function cancelRecording() {
      if (voiceState === 'idle' || !recognition) return;
      wasCancelled = true;   // set BEFORE abort() — onend reads this first, always
      recognition.abort();
    }
    micBtn.addEventListener('click', () => {
      if (voiceState === 'idle') startRecording();
      else if (voiceState === 'recording') finishRecording();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && voiceState !== 'idle') cancelRecording();
    });
    // DISABLED state — reassigns the no-op declared near setSummoning() above,
    // so the mic's busy-visual tracks the exact same lifecycle every other
    // "Shenlong is working" indicator already uses, instead of a second,
    // independently-tracked flag.
    setMicDisabled = (disabled) => {
      micBtn.classList.toggle('is-mic-disabled', disabled);
      micBtn.setAttribute('aria-disabled', String(disabled));
    };
  }

  // ── quick chips ──────────────────────────────────────────────────────────────
  const CHIPS = ["What's on today?", 'Log water', 'Add lunch at 1pm', 'Move workout to 4pm'];
  if (chipsWrap) {
    CHIPS.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'aios-chip'; b.textContent = c;
      b.addEventListener('click', () => { handle(c); });
      chipsWrap.appendChild(b);
    });
  }

  form.addEventListener('submit', e => { e.preventDefault(); const v = input.value; input.value = ''; handle(v); });

  // ── Unified Daily Brief — the proactive greeting ─────────────────────────────
  // Replaces the old "list today's events + maybe one nudge" greeting with ONE
  // synthesized recommendation across calendar/gym/health. The ranking
  // (selectTopSignals) is fully deterministic and already ran before this is
  // called; a model call only happens when there's genuine cross-domain
  // synthesis to do (2 signals) or single-domain phrasing to produce (1
  // signal) — it is never allowed to introduce a fact that isn't in the
  // pre-selected list. An open gym session is handled as its own immediate,
  // fully deterministic case (identical wording to the retired
  // proactiveNudge(), which this supersedes as the greeting's source) since
  // there's nothing to synthesize — it's the single most actionable fact
  // available and reusing proven wording beats reinventing it.
  // Extracted from generateDailyBrief() (Goal 4.1 — Narrative Dashboard
  // Refinement) so the narrative dashboard can synthesize a richer paragraph
  // (up to 3 pre-ranked facts, e.g. adding a "trained yesterday" fact
  // alongside the usual one calendar + one body signal) through the exact
  // same network/timeout/fallback path, instead of stitching sentences
  // together client-side. The ranking that produces `selected` is unchanged
  // and untouched — this only changes how many pre-ranked facts a caller may
  // hand to the model in one request; the model still never adds a fact.
  async function synthesizeBrief(selected, hasEvents) {
    if (!selected.length) return deterministicBriefFallback(selected, hasEvents);
    try {
      const res = await fetch(GEMINI_ENDPOINT, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' },
          window.__appAccessToken ? { 'Authorization': 'Bearer ' + window.__appAccessToken } : {}),
        body: JSON.stringify({
          message: "Generate today's unified daily brief.",
          context: { mode: 'daily_brief', date: todayStr(), signals: selected },
        }),
        signal: AbortSignal.timeout(8000), // shorter than the 15s command timeout — this is proactive, not a typed request, and has a good fallback
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const intent = await res.json();
      if (intent && intent.reply) return intent.reply;
      throw new Error('empty reply');
    } catch (e) {
      return deterministicBriefFallback(selected, hasEvents); // Gemini unreachable/misconfigured/slow — never leave the greeting blank
    }
  }

  async function generateDailyBrief() {
    const gym = todayGymSummary();
    if (gym && gym.workoutInProgress) {
      return 'You have an open ' + (gym.pinnedRoutineName || 'workout') + ' session'
        + (gym.setsLoggedInOpenSession ? ' — ' + gym.setsLoggedInOpenSession + ' set' + (gym.setsLoggedInOpenSession === 1 ? '' : 's') + ' logged' : '')
        + '. Resume when ready.';
    }
    const now = new Date();
    const events = window.AptCal.getEvents();
    const health = todayHealthSummary();
    const calSigs = computeCalendarSignals(events, now);
    const bodySigs = computeHealthSignals(health, now.getHours()).concat(computeGymSignals(recentGymSession()));
    const selected = selectTopSignals(calSigs, bodySigs);
    return synthesizeBrief(selected, events.length > 0);
  }
  // Bridges for js/narrative-dashboard.js (Goal 4/4.1) — the only consumer
  // outside this closure. Internal-ish, hence the `__` prefix per Module
  // Communication's convention; not part of the stable public API.
  window.__generateDailyBrief = generateDailyBrief;
  window.__synthesizeBrief = synthesizeBrief;

  // ── opening greeting — once the first calendar load resolves ─────────────────
  let greeted = false;
  async function greet() {
    if (greeted) return; greeted = true;
    // Under the Narrative Dashboard (Goal 4, feature-flagged), this chat log
    // is hidden until the user explicitly reveals it via "Ask Shenlong" —
    // js/narrative-dashboard.js already renders the same brief into the
    // narrative story. Skip the duplicate network call here (it would fire
    // an identical, redundant /api/gemini/assistant request purely into a
    // hidden panel); the tip line still renders so a revealed chat isn't
    // empty, and typed commands work exactly as before either way.
    var narrativeOn = document.documentElement.classList.contains('narrative-on');
    if (!narrativeOn) {
      const thinking = addThinking();
      let brief;
      try { brief = await generateDailyBrief(); }
      catch (e) { brief = deterministicBriefFallback([], (window.AptCal.getEvents() || []).length > 0); }
      thinking.remove();
      addMsg('ai', brief).classList.add('aios-brief');
    }
    addMsg('ai', 'Tell me what to change — e.g. “move my workout to 4pm”, “add a reminder to drink water at 6pm”, or “log that I finished my plank”.');
  }
  window.addEventListener('apt:calendar-loaded', greet, { once: true });
  // Safety net if the calendar event never fires (e.g. very slow proxy timeout).
  setTimeout(greet, 6000);

  // Exposed for debugging / tests — inspect how a phrase is parsed locally.
  window.Assistant = { parse: parseLocal, parseCompound, handle };
})();
