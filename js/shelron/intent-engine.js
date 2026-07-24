// =============================================================================
// SHELRON — Intent Engine (v0.1)
// Deterministic, zero AI. Takes the Parser's raw entities plus the ORIGINAL
// text and decides exactly ONE canonical intent from a fixed, code-defined
// vocabulary (see aptron Brain/02 Architecture/Shelron.md §1). The Parser
// also returns its own "intent" guess, but classify() below never reads
// entities.intent at all — keyword rules on the raw text plus required-field
// validation are the ONLY inputs to the decision. This split (AI extracts,
// code decides) is the deliberate deterministic boundary the whole design is
// built around, not a stylistic choice — do not "simplify" this by wiring in
// the parser's intent field.
//
// Load order: none — pure function of its inputs, no dependency on any other
// Shelron file.
// =============================================================================
'use strict';

window.Shelron = window.Shelron || {};

window.Shelron.Intent = (function () {
  const SUPPORTED = [
    'calendar.create_event',
    'calendar.update_event',
    'calendar.delete_event',
    'calendar.query',
  ];

  // Order matters: checked most-specific-destructive-first so "cancel the
  // dentist and move lunch" style ambiguity resolves toward the safer read
  // in a single-clause v0.1 (no compound-command splitting — that's explicit
  // future scope, not built here).
  const DELETE_WORDS = /\b(delete|cancel|remove|drop)\b/i;
  const UPDATE_WORDS = /\b(move|reschedule|change|update|retime|shift|postpone)\b/i;
  const QUERY_WORDS  = /\b(what|show|list|when is|is there|do i have)\b/i;

  // classify(entities, rawText) -> Intent
  // Intent shape: { intent, entities, valid: boolean, errors: string[] }
  function classify(entities, rawText) {
    const text = String(rawText || '');
    const e = entities && typeof entities === 'object' ? entities : {};

    let intent;
    if (DELETE_WORDS.test(text)) intent = 'calendar.delete_event';
    else if (UPDATE_WORDS.test(text)) intent = 'calendar.update_event';
    else if (QUERY_WORDS.test(text)) intent = 'calendar.query';
    else intent = 'calendar.create_event';   // the deterministic default

    const errors = validate(intent, e);
    return { intent, entities: e, valid: errors.length === 0, errors };
  }

  // Known Issue #15 fix: strict calendar-date validation. `date` is a bare
  // STRING in the Parser's Gemini responseSchema — no format enforcement —
  // so a malformed or hallucinated value must be caught HERE, deterministically,
  // before any intent can reach a handler and touch window.AptCal. Deliberately
  // does NOT construct a JS Date and inspect it: `new Date(y, m, d)` silently
  // NORMALIZES an out-of-range day/month instead of rejecting it (e.g.
  // 2026-02-30 silently becomes 2026-03-02) — exactly the bug this closes. A
  // pure calendar table rejects instead of rolling over.
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

  // validate() is the other half of "deterministic" — required fields per
  // intent are a fixed table, not a model judgment call.
  function validate(intent, e) {
    const errors = [];
    switch (intent) {
      case 'calendar.create_event':
        if (!e.title) errors.push('missing_title');
        if (!e.date) errors.push('missing_date');
        else if (!isValidCalendarDate(e.date)) errors.push('invalid_date');
        if (!e.startTime) errors.push('missing_startTime');
        break;
      case 'calendar.update_event':
        if (!e.title) errors.push('missing_title_reference');
        if (e.date && !isValidCalendarDate(e.date)) errors.push('invalid_date');
        if (!e.startTime && !e.endTime) errors.push('missing_new_time');
        break;
      case 'calendar.delete_event':
        if (!e.title) errors.push('missing_title_reference');
        if (e.date && !isValidCalendarDate(e.date)) errors.push('invalid_date');
        break;
      case 'calendar.query':
        if (!e.date) errors.push('missing_date');
        else if (!isValidCalendarDate(e.date)) errors.push('invalid_date');
        break;
      default:
        errors.push('unsupported_intent');
    }
    return errors;
  }

  return { classify, SUPPORTED };
})();
