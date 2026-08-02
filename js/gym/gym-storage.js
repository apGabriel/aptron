/* ============================================================
   gym-storage.js — Progressive Overload Coach: storage + model.
   localStorage load/save/normalize, the session model (source of
   truth = G.state.sessions), the derived per-exercise log index,
   the routines bridge, and the prescription engine.
   Loads 2nd (after core). Shares state via G.state.
   ============================================================ */
(function () {
  'use strict';
  const G = window.GymApp;
  // Leaf helpers from core (defined earlier → safe to alias at load).
  const { unit, workingSets, roundToStep, isTimeMetric, fmtDuration } = G;

  // ============================================================
  // STATE — all logs + edits live in browser localStorage. Each
  // device has its own copy. Export JSON from settings to back up
  // or move to another device.
  // ============================================================
  const LS_KEY = 'po_coach_v1';

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) {}
    return normalize({});
  }
  function normalize(s) {
    s = s || {};
    s.units = s.units || CONFIG.units || 'kg';
    s.gyms  = (Array.isArray(s.gyms)  && s.gyms.length)  ? s.gyms  : CONFIG.gyms.slice();
    // Exercises start empty and are populated lazily by ensureRoutineExercises()
    // from the user's saved routines — there is no seed list any more.
    s.exercises = Array.isArray(s.exercises) ? s.exercises : [];
    s.logs = (s.logs && typeof s.logs === 'object') ? s.logs : {};
    s.filterGym = s.filterGym || s.gyms[0].id;
    // Selected routine (id from the Routine Builder). Validated at render time.
    if (typeof s.filterRoutine === 'undefined') s.filterRoutine = null;
    // Drop legacy state that newer models replaced, keeping the serialized blob
    // clean instead of carrying dead keys forward: split-rotation (removed) and
    // the day-split filter (superseded by routines).
    delete s.splitRotation;
    delete s.splitAnchor;
    delete s.days;
    delete s.filterDay;
    // ── Session model ──
    if (typeof s.activeSessionId === 'undefined') s.activeSessionId = null;
    migrateSessions(s);          // build sessions from legacy logs on first run
    // Auto-cleanup: drop empty CLOSED (ghost) sessions left by testing or
    // abandoned starts. Active (open) sessions are always kept, even at 0 sets.
    s.sessions = (s.sessions || []).filter(sess => !sess.endedAt || (sess.sets && sess.sets.length > 0));
    // Purge ghost-duplicate sets (legacy artifacts of the pre-fix merge bug)
    // BEFORE deriving the index, so charts/history rebuild from clean data.
    s.__ghostsPurged = dedupSessionSets(s);
    s.logs = buildLogIndex(s);   // logs is now a derived view of session sets
    return s;
  }
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(G.state)); } catch (e) {}
  }

  // ============================================================
  // SESSION MODEL (routine/session-driven, replaces date-driven)
  //
  // Source of truth: G.state.sessions — an ordered list of workout sessions,
  // each OWNING its own sets (nested). A session is "open" while endedAt is
  // null and "closed" once the user marks it Done / starts a new one.
  //   session = { id, label, startedAt, endedAt|null,
  //               sets: [ { exId, name, weight, reps, date } ] }
  //
  // G.state.logs[exId] is now a DERIVED flat index rebuilt from every session's
  // sets, so the prescription engine, PR badge, sparkline and history (which
  // all read the per-exercise array) keep working untouched.
  // ============================================================
  function uidSession() {
    return 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }
  // Flatten all session sets into the per-exercise chronological index.
  function buildLogIndex(s) {
    const idx = {};
    (s.sessions || []).forEach((sess) => {
      (sess.sets || []).forEach((set) => {
        (idx[set.exId] = idx[set.exId] || []).push({
          weight: set.weight, reps: set.reps, date: set.date, session: sess.id,
          is_dropset: !!set.is_dropset,
          // Carry the metric through so time sets render/track without the
          // consumers re-reading the owning session.
          metric: set.metric || 'reps', duration: set.duration,
        });
      });
    });
    Object.keys(idx).forEach((k) => idx[k].sort((a, b) => (a.date || '').localeCompare(b.date || '')));
    return idx;
  }
  function rebuildLogIndex() { G.state.logs = buildLogIndex(G.state); }

  // Canonical identity for a logged set: exId + the set's instant normalized to
  // epoch-ms, so "...789Z" and "...789+00:00" (the same instant in different
  // string forms) collapse to one key. Shared by the boot-time ghost purge AND
  // the cloud-merge dedup (gym-sync.js) so both use one identity.
  function logSetKey(exId, date) {
    const t = Date.parse(date);
    return exId + '|' + (Number.isNaN(t) ? String(date) : String(t));
  }
  // One-time cleanup of ghost duplicates baked in before the merge-dedup fix:
  // within EACH session, keep the first set of any (exId | epoch-ms) and drop the
  // rest. Returns how many were removed. Idempotent — safe to run on every load,
  // which also scrubs old duplicates that sync in from another device's blob.
  function dedupSessionSets(s) {
    let removed = 0;
    (s.sessions || []).forEach((sess) => {
      if (!Array.isArray(sess.sets)) return;
      const seen = new Set();
      sess.sets = sess.sets.filter((st) => {
        const k = logSetKey(st.exId, st.date);
        if (seen.has(k)) { removed++; return false; }
        seen.add(k);
        return true;
      });
    });
    return removed;
  }

  // One-time migration: fold any pre-existing flat logs into one CLOSED session
  // per calendar day, so historical data survives the model switch and shows up
  // under Past workouts. Runs only when sessions don't exist yet.
  function migrateSessions(s) {
    if (Array.isArray(s.sessions)) return;
    const nameById = {};
    (s.exercises || []).forEach((e) => { if (e && e.id) nameById[e.id] = e.name; });
    const byDay = {};
    Object.keys(s.logs || {}).forEach((exId) => {
      (s.logs[exId] || []).forEach((l) => {
        if (!l || !l.date) return;
        const day = l.date.slice(0, 10);
        (byDay[day] = byDay[day] || []).push({
          exId, name: nameById[exId] || exId, weight: l.weight, reps: l.reps, date: l.date,
        });
      });
    });
    s.sessions = Object.keys(byDay).sort().map((day) => {
      const sets = byDay[day].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      return {
        id: 'sess_legacy_' + day, label: 'Workout',
        startedAt: sets[0].date, endedAt: sets[sets.length - 1].date, sets, // legacy = closed
      };
    });
    s.activeSessionId = null;
  }

  // Label a new session from the currently selected routine (e.g. "Push").
  function currentSessionLabel() {
    try { const r = getCurrentRoutine(); if (r && r.name) return r.name; } catch (e) {}
    return 'Workout';
  }
  function getActiveSession() {
    if (!G.state.activeSessionId) return null;
    return (G.state.sessions || []).find((s) => s.id === G.state.activeSessionId && !s.endedAt) || null;
  }
  // Open session getter that auto-creates one — the auto-start on first log.
  function ensureActiveSession() {
    let s = getActiveSession();
    if (!s) {
      s = { id: uidSession(), label: currentSessionLabel(), startedAt: new Date().toISOString(), endedAt: null, sets: [] };
      (G.state.sessions = G.state.sessions || []).push(s);
      G.state.activeSessionId = s.id;
    }
    return s;
  }
  function closeActiveSession() {
    const s = getActiveSession();
    if (s) {
      if (!s.sets || s.sets.length === 0) {
        // Empty session (started then abandoned) — discard rather than leave a
        // 0-set ghost card in Past workouts.
        G.state.sessions = (G.state.sessions || []).filter(x => x.id !== s.id);
      } else {
        s.endedAt = new Date().toISOString();
      }
    }
    G.state.activeSessionId = null;
  }
  // Close the current session and open a fresh empty one (manual segmentation).
  function startNewSession() {
    closeActiveSession();
    ensureActiveSession();
  }
  // Group an active/closed session's sets by exercise for the summary cards.
  function summarizeSession(sess) {
    const byEx = {};
    (sess.sets || []).forEach((set) => {
      const ex = (G.state.exercises || []).find((e) => e.id === set.exId)
        || { id: set.exId, name: set.name || set.exId, bw: false };
      if (!byEx[ex.id]) byEx[ex.id] = { ex, sets: [] };
      byEx[ex.id].sets.push(set);
    });
    const perEx = Object.values(byEx);
    return {
      perEx,
      totalSets: perEx.reduce((a, e) => a + e.sets.length, 0),
    };
  }

  // Workout Summary — pure derivation over a just-finished session (Goal 3 —
  // Session Experience, 2026-08-02). Deliberately reuses, not reimplements:
  // summarizeSession() above for the per-exercise grouping, G.state.logs
  // (the same derived index the prescription/PR/history UI already reads)
  // for "was this session's max a new PR," and getRx() — the exact same
  // deterministic prescription engine #rxWrap uses during the workout — for
  // the "next time" recommendation. No new storage, no new stats invented.
  function buildWorkoutSummary(sess) {
    const sum = summarizeSession(sess);
    const startedMs = Date.parse(sess.startedAt) || Date.now();
    const endedMs = Date.parse(sess.endedAt) || Date.now();
    const durationSec = Math.max(0, Math.round((endedMs - startedMs) / 1000));

    let totalVolume = 0;
    const prs = [];
    const recs = [];
    sum.perEx.forEach(({ ex, sets }) => {
      sets.forEach((s) => { totalVolume += (Number(s.weight) || 0) * (Number(s.reps) || 0); });
      const allLogs = G.state.logs[ex.id] || [];
      // "PR" = this session's heaviest set for the movement beat every set
      // logged before this session (excluded by session id, already carried
      // on each log entry by buildLogIndex()).
      const priorMax = allLogs
        .filter((l) => l.session !== sess.id)
        .reduce((m, l) => Math.max(m, Number(l.weight) || 0), 0);
      const sessionMax = sets.reduce((m, s) => Math.max(m, Number(s.weight) || 0), 0);
      if (sessionMax > 0 && sessionMax > priorMax) prs.push({ name: ex.name, weight: sessionMax, bw: ex.bw });
      const rx = getRx(ex, allLogs);
      if (rx) recs.push({ name: ex.name, rx });
    });

    return {
      routineName: sess.label || 'Workout',
      durationSec,
      totalVolume: Math.round(totalVolume),
      exerciseCount: sum.perEx.length,
      setCount: sum.totalSets,
      prs,
      recs,
    };
  }

  // ── Routines bridge ──────────────────────────────────────────
  // The exercise list is driven by the user's saved routines from the Routine
  // Builder (localStorage 'rb_routines_v1'). Each routine exercise is mirrored
  // into G.state.exercises (id = 'rt_' + exId) so the whole logging /
  // prescription / stats engine keeps working unchanged. Logs key off that
  // stable id, so the same movement shares one history across every routine.
  const RB_ROUTINES_KEY = 'rb_routines_v1';
  function getRoutines() {
    try { return JSON.parse(localStorage.getItem(RB_ROUTINES_KEY)) || []; }
    catch (e) { return []; }
  }
  function getCurrentRoutine() {
    const rs = getRoutines();
    if (!rs.length) return null;
    let r = rs.find(x => x.id === G.state.filterRoutine);
    if (!r) { r = rs[0]; G.state.filterRoutine = r.id; }
    return r;
  }
  // Make sure every exercise referenced by any routine exists as a coach
  // exercise. Created lazily with sensible defaults derived from the routine's
  // target reps; the user can fine-tune (weight / step / bodyweight) via the
  // edit (pencil) button afterwards.
  function ensureRoutineExercises() {
    const rs = getRoutines();
    const byId = {};
    G.state.exercises.forEach(e => { byId[e.id] = e; });
    let changed = false;
    rs.forEach(r => (r.exercises || []).forEach(it => {
      const id = 'rt_' + it.exId;
      if (!byId[id]) {
        // Target reps for the coach's range = the highest planned set reps
        // (falls back to the legacy scalar `reps`, then 10).
        let reps = 10;
        if (Array.isArray(it.sets) && it.sets.length) {
          reps = Math.max.apply(null, it.sets.map(s => parseInt(s.reps, 10) || 0)) || 10;
        } else if (it.reps != null) {
          reps = parseInt(it.reps, 10) || 10;
        }
        const ex = {
          id, name: it.name, gym: 'both',
          bw: false, startWeight: 0,
          repMin: Math.max(1, reps - 2), repMax: Math.max(reps, 1),
          step: 2.5, gifUrl: it.gifUrl, muscleGroup: it.muscleGroup,
          fromRoutine: true
        };
        G.state.exercises.push(ex);
        byId[id] = ex;
        changed = true;
      } else if (byId[id].name !== it.name) {
        byId[id].name = it.name;        // keep the label in sync with the builder
        changed = true;
      }
    }));
    if (changed) saveState();
  }
  // Exercises of the currently selected routine, in routine order.
  function getFiltered() {
    const r = getCurrentRoutine();
    if (!r) return [];
    const byId = {};
    G.state.exercises.forEach(e => { byId[e.id] = e; });
    return (r.exercises || [])
      .map(it => byId['rt_' + it.exId])
      .filter(Boolean)
      .filter(e => e.gym === G.state.filterGym || e.gym === 'both');
  }
  // ── Routine-stat pure helpers (Hero card) ──────────────────────
  // Everything here is derived from data already on the routine / log index
  // — no new storage. Mirrored (deliberately, small) in
  // gym-routine-builder.js for the My Routines list, which never reaches
  // into window.GymApp — see that file's header comment.
  function routineMuscleGroups(r) {
    const seen = []; const has = {};
    (r.exercises || []).forEach(it => {
      if (it.muscleGroup && !has[it.muscleGroup]) { has[it.muscleGroup] = true; seen.push(it.muscleGroup); }
    });
    return seen;
  }
  // Rough estimate only (~work time per set + configured rest between sets)
  // — always presented with a "~" prefix so it reads as a heuristic.
  function estimateRoutineMinutes(r) {
    let totalSets = 0;
    (r.exercises || []).forEach(it => { totalSets += Array.isArray(it.sets) ? it.sets.length : 0; });
    if (!totalSets) return 0;
    const restSec = (r.restEnabled && r.rest) ? r.rest : 60;
    const workSec = 40;
    return Math.max(5, Math.round((totalSets * workSec + Math.max(0, totalSets - 1) * restSec) / 60));
  }
  // Latest logged date (epoch ms) across every exercise in the routine, or
  // null if it's never been logged. Reads the already-built log index.
  function routineLastPerformed(r) {
    let latest = 0;
    (r.exercises || []).forEach(it => {
      (G.state.logs['rt_' + it.exId] || []).forEach(l => {
        const t = Date.parse(l.date);
        if (t && t > latest) latest = t;
      });
    });
    return latest || null;
  }

  // ── Streak + schedule (pass-3 "lightweight context") ───────────
  // Streak reuses the already-built per-exercise log index (G.state.logs) —
  // no new storage, no re-walking of sessions.
  function fmtDayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function trainedDaySet() {
    const days = {};
    Object.keys(G.state.logs || {}).forEach(exId => {
      (G.state.logs[exId] || []).forEach(l => {
        if (!l || !l.date) return;
        const d = new Date(l.date);
        if (!isNaN(d)) days[fmtDayKey(d)] = true;
      });
    });
    return days;
  }
  // Consecutive trained days ending today (or yesterday, so an in-progress
  // streak doesn't read as broken before today's session happens).
  function computeStreak() {
    const days = trainedDaySet();
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    if (!days[fmtDayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (days[fmtDayKey(cursor)]) { streak++; cursor.setDate(cursor.getDate() - 1); }
    return streak;
  }

  // Training-days scheduling — routine.trainingDays is an optional array of
  // these codes, set by the routine-creation flow (gym-routine-builder.js).
  const WEEKDAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function todaysScheduledRoutine() {
    const code = WEEKDAY_CODES[new Date().getDay()];
    return getRoutines().find(r => Array.isArray(r.trainingDays) && r.trainingDays.includes(code)) || null;
  }
  // Looks ahead (not including today) for the next routine with a matching
  // training day. Returns null if no routine has any day configured.
  function nextPlannedRoutine() {
    const routines = getRoutines();
    const todayIdx = new Date().getDay();
    for (let offset = 1; offset <= 7; offset++) {
      const code = WEEKDAY_CODES[(todayIdx + offset) % 7];
      const match = routines.find(r => Array.isArray(r.trainingDays) && r.trainingDays.includes(code));
      if (match) return { routine: match, code: code, inDays: offset };
    }
    return null;
  }
  // Boot-time only (see gym-core.js G.boot()) — prefers today's scheduled
  // routine, but never overrides a routine with a session already in
  // progress, and never re-fires mid-session.
  function applyTodaysSchedule() {
    if (getActiveSession()) return;
    const scheduled = todaysScheduledRoutine();
    if (scheduled && G.state.filterRoutine !== scheduled.id) {
      G.state.filterRoutine = scheduled.id;
      G.state.currentEx = null;
      saveState();
    }
  }

  function getCurrentEx() {
    const f = getFiltered();
    if (!f.length) return null;
    let ex = f.find(e => e.id === G.state.currentEx);
    if (!ex) { ex = f[0]; G.state.currentEx = ex.id; saveState(); }
    return ex;
  }
  function getLogs() { return (G.state.logs[G.state.currentEx] || []).slice(); }

  // Rest-between-sets (seconds) for the ACTIVE routine — surfaced as the live
  // countdown after each logged set. The rest is now routine-wide (one value
  // for every movement), configured in the Routine Builder.
  //   New model:  routine.restEnabled (bool) + routine.rest (seconds).
  //               restEnabled === false → 0 (timer off).
  //   Legacy:     routines saved before this change have per-exercise `rest`
  //               and no routine-level fields → fall back to that exercise's
  //               value so old data keeps timing correctly.
  // Accepts either the coach id ('rt_<exId>') or the raw exId. Defaults to 90s.
  function getRestSeconds(exId) {
    const r = getCurrentRoutine();
    if (!r) return 90;
    if (typeof r.restEnabled === 'boolean') {
      if (!r.restEnabled) return 0;
      const rv = Number(r.rest);
      return Number.isFinite(rv) && rv >= 0 ? rv : 90;
    }
    // Legacy per-exercise rest.
    const raw = String(exId || '').replace(/^rt_/, '');
    const it = (r.exercises || []).find(e => String(e.exId) === raw);
    const v = it ? Number(it.rest) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : 90;
  }

  // Prescription engine — "what should I do next session?"
  // Upgrade trigger: hits CONFIG.upgradeAtReps (default 8) OR the exercise's
  // repMax, whichever fires first. So a 5-8 lifter hits upgrade at 8; a 6-12
  // lifter ALSO hits it at 8 instead of grinding 12 reps before adding weight.
  function getRx(ex, logs) {
    if (!logs.length) return null;
    if (isTimeMetric(ex)) return getRxTime(ex, logs);
    // Progress only off working sets — a trailing dropset must not be read as
    // the "last set" or counted in the stuck-streak (its lighter load would
    // wrongly trigger a deload).
    logs = workingSets(logs);
    if (!logs.length) return null;
    const last = logs[logs.length - 1];
    const { weight, reps } = last;
    const { repMin, repMax, step, bw } = ex;
    const upgradeAt = Math.min(CONFIG.upgradeAtReps || 8, repMax);
    let stuck = 0;
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].weight === weight) stuck++; else break;
    }
    if (bw) {
      if (reps >= upgradeAt) return { type: 'up', weight: 0, reps: reps + 1, tag: 'Push for more', reason: reps + ' reps — strong. Push for ' + (reps + 1) + ' next time.', bw: true };
      if (reps >= repMin) return { type: 'hold', weight: 0, reps: reps + 1, tag: 'Add a rep', reason: reps + ' reps. Push for ' + (reps + 1) + ' next session.', bw: true };
      return { type: 'hold', weight: 0, reps: repMin, tag: 'Repeat', reason: reps + ' reps fell short. Repeat until you hit ' + repMin + '+.', bw: true };
    }
    if (stuck >= 3 && reps < repMin) {
      const dl = roundToStep(weight * 0.9, step);
      return { type: 'down', weight: dl, reps: repMax, tag: 'Deload', reason: 'Stuck at ' + weight + unit() + ' for ' + stuck + ' sessions. Drop 10%, reset, build back cleaner.' };
    }
    if (reps >= upgradeAt) return { type: 'up', weight: weight + step, reps: repMin, tag: 'Add weight', reason: 'You hit ' + reps + ' reps — time to add ' + step + unit() + '. Expect ' + repMin + '-' + (repMin + 1) + ' next session.' };
    if (reps >= repMin && reps < upgradeAt) return { type: 'hold', weight: weight, reps: reps + 1, tag: 'Add a rep', reason: reps + ' reps in target. Stay at ' + weight + unit() + ', push for ' + (reps + 1) + '.' };
    return { type: 'hold', weight: weight, reps: repMin, tag: 'Repeat', reason: reps + ' reps short of ' + repMin + '-' + upgradeAt + '. Repeat ' + weight + unit() + ' until you hit ' + repMin + '+ clean.' };
  }

  // Time-metric prescription — progressive overload on hold-duration instead of
  // weight×reps. Add a fixed +5s each session; if the same duration repeats for
  // 3+ sessions, nudge past the plateau. Weight (if any) is held constant.
  function getRxTime(ex, logs) {
    logs = workingSets(logs);
    if (!logs.length) return null;
    const last = logs[logs.length - 1];
    const d = Number(last.duration) || 0;
    const w = ex.bw ? 0 : (Number(last.weight) || 0);
    const next = d + 5;
    let stuck = 0;
    for (let i = logs.length - 1; i >= 0; i--) {
      if ((Number(logs[i].duration) || 0) === d) stuck++; else break;
    }
    if (stuck >= 3) {
      return { type: 'hold', time: true, bw: ex.bw, weight: w, duration: next, tag: 'Break the plateau',
        reason: 'Held ' + fmtDuration(d) + ' for ' + stuck + ' sessions. Push for ' + fmtDuration(next) + ' to move forward.' };
    }
    return { type: 'up', time: true, bw: ex.bw, weight: w, duration: next, tag: 'Add time',
      reason: 'Held ' + fmtDuration(d) + ' — push for ' + fmtDuration(next) + ' next session.' };
  }

  // Expose the storage + model + routines API to the other modules.
  Object.assign(G, {
    LS_KEY,
    loadState, normalize, saveState,
    uidSession, buildLogIndex, rebuildLogIndex, logSetKey, dedupSessionSets, migrateSessions,
    currentSessionLabel, getActiveSession, ensureActiveSession, closeActiveSession,
    startNewSession, summarizeSession, buildWorkoutSummary,
    getRoutines, getCurrentRoutine, ensureRoutineExercises, getFiltered, getCurrentEx, getLogs, getRestSeconds, getRx,
    routineMuscleGroups, estimateRoutineMinutes, routineLastPerformed,
    computeStreak, todaysScheduledRoutine, nextPlannedRoutine, applyTodaysSchedule
  });
})();
