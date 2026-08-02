// =============================================================================
// SHELRON — Intent Engine validators
// Shelron is now purely the internal engine layer behind the single
// user-facing assistant, Shenlong (js/index.js, the `.aios-chat` card) — see
// aptron Brain/02 Architecture/Shelron.md. This file used to run its own v0.1
// classify()/validate() pipeline for a separate preview UI; that UI is
// retired (see the consolidation ADR) and Shenlong already has a richer,
// proven intent classifier of its own (parseLocal + Gemini's schema-
// constrained `action`). What survives here are the two deterministic
// validation primitives that classifier didn't have, now called directly by
// js/index.js as composition, not duplication:
//
//   - isValidCalendarDate — Known Issue #15 fix (leap-year-aware, rejects
//     rather than silently normalizing an out-of-range Y/M/D).
//   - parseStrictTime — Known Issue #16 fix (rejects rather than clamping an
//     out-of-range HH:MM).
//
// Zero AI, zero dependency on any other file — same "deterministic core"
// guarantee the whole Shelron design is built around.
// =============================================================================
'use strict';

window.Shelron = window.Shelron || {};

window.Shelron.Intent = (function () {
  // Known Issue #15 fix: strict calendar-date validation. A date arriving
  // from an LLM (or any free-text parse) is an unvalidated STRING — a
  // malformed or hallucinated value must be caught HERE, deterministically,
  // before it ever reaches window.AptCal. Deliberately does NOT construct a
  // JS Date and inspect it: `new Date(y, m, d)` silently NORMALIZES an
  // out-of-range day/month instead of rejecting it (e.g. 2026-02-30 silently
  // becomes 2026-03-02) — exactly the bug this closes. A pure calendar table
  // rejects instead of rolling over.
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }
  function isValidCalendarDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12) return false;
    const maxDay = mo === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[mo - 1];
    return d >= 1 && d <= maxDay;
  }

  // Known Issue #16 fix: reject out-of-range hours/minutes instead of
  // clamping them — `30:99` used to silently become `23:59` (Math.min),
  // which schedules a real event at a value the user never asked for. An
  // out-of-range value is exactly as invalid as a non-matching format, so it
  // returns `null` the same way, and every caller already handles `null`.
  function parseStrictTime(str) {
    const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    return { h, m: min };
  }

  return { isValidCalendarDate, parseStrictTime };
})();
