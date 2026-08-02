// ===================== Streak Engine =====================
// Generic "consecutive days a trigger happened" calculator, shared by any
// module that wants a habit streak (meal logging today; water/workout/sleep/
// journal streaks can reuse this unchanged — only the trigger changes).
//
// Deterministic, no timers, no background jobs: callers recompute on demand
// from data they already store, keyed by day. day-key format is YYYY-MM-DD;
// callers choose their own day-boundary convention (calendar day, 6 AM
// rollover, etc.) as long as hitDays' keys and todayKey use the same one.
(function () {
  'use strict';

  function parseKey(key) {
    const p = String(key).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function fmtKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shiftKey(key, days) {
    const d = parseKey(key);
    d.setDate(d.getDate() + days);
    return fmtKey(d);
  }

  // hitDays: a Set or plain object whose keys are day-key strings that
  // count as "hit" days. todayKey: today's day-key (defaults to the real
  // calendar day) — pass the caller's own day-boundary key if it differs.
  //
  // Streak counts consecutive hit days ending at todayKey, or at the day
  // before it if today hasn't happened yet — so an in-progress streak
  // doesn't read as broken before today's trigger occurs.
  function compute(hitDays, todayKey) {
    const has = (typeof hitDays.has === 'function') ? (k) => hitDays.has(k) : (k) => !!hitDays[k];
    let cursor = todayKey || fmtKey(new Date());
    if (!has(cursor)) cursor = shiftKey(cursor, -1);
    let current = 0, lastDate = null;
    while (has(cursor)) {
      if (!lastDate) lastDate = cursor;
      current++;
      cursor = shiftKey(cursor, -1);
    }
    return { current: current, lastDate: lastDate };
  }

  window.StreakEngine = { compute: compute, fmtKey: fmtKey };
})();
