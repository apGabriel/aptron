// =============================================================================
// SHELRON — Calendar Adapter (v0.1)
// Translates Action Dispatcher calls into the EXISTING window.AptCal API
// (js/index.js) — no calendar logic is reimplemented here. This is the v0.1,
// deliberately minimal slice of what Shelron.md calls the "Calendar Engine";
// the full engine (free/busy queries, conflict detection) is not built yet —
// see the naming note in Shelron.md.
//
// Architecture rules this file exists to honor (Shelron.md "central law" +
// the owner's explicit v0.1 rules): Shelron never manipulates app state
// directly, never writes localStorage, never talks to Supabase directly,
// never updates UI components, never bypasses existing APIs. Every one of
// the four functions below does exactly one thing: call an existing AptCal
// method and translate its result into a Dispatcher Result.
//
// Load order: must load AFTER js/shelron/action-dispatcher.js (registers
// handlers at load time). May load before or after js/index.js — AptCal is
// only dereferenced when a handler actually RUNS, not at registration time.
// =============================================================================
'use strict';

window.Shelron = window.Shelron || {};

(function () {
  // Known Issue #16 fix: reject out-of-range hours/minutes instead of
  // clamping them — `30:99` used to silently become `23:59` (Math.min), which
  // schedules a real event at a value the user never asked for. An
  // out-of-range value is exactly as invalid as a non-matching format, so it
  // returns `null` the same way, and every caller already handles `null`.
  function hhmm(t) {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = +m[1], min = +m[2];
    if (h > 23 || min > 59) return null;
    return { h, m: min };
  }

  function minutesBetween(start, end) {
    if (!start || !end) return null;
    let d = (end.h * 60 + end.m) - (start.h * 60 + start.m);
    if (d <= 0) d += 24 * 60;   // crosses midnight
    return d;
  }

  // Known Issue #17 fix: `location`/`people[]` are part of the Parser's entity
  // schema, but none of AptCal's four calls below accept either — v0.1 only
  // ever passes through title/time/notes. Discarding them without a word would
  // be silent data loss, so a successful reply always names what was
  // understood but isn't supported yet, instead of just dropping it.
  function describeUnsupported(entities) {
    const parts = [];
    if (entities.location) parts.push('the location ("' + entities.location + '")');
    if (Array.isArray(entities.people) && entities.people.length) {
      parts.push((entities.people.length === 1 ? 'the person' : 'the people') + ' ("' + entities.people.join(', ') + '")');
    }
    if (!parts.length) return '';
    return ' I understood ' + parts.join(' and ') + ', but Shelron v0.1 doesn\'t support ' +
      (parts.length > 1 ? 'those' : 'that') + ' yet.';
  }

  // AptCal.selectDay() kicks off loadEvents() without awaiting it (it's built
  // for UI clicks, not a caller that needs the result before proceeding).
  // Any operation that depends on currentEvents being loaded for the target
  // day (findEvent-backed calls: update/delete/query) must re-await
  // AptCal.reload() defensively, or it can race a stale day's event list.
  // create_event does NOT need this — it only needs `selectedDate` to be set,
  // which selectDay() does synchronously.
  async function ensureDayLoaded(dateStr) {
    const A = window.AptCal;
    if (dateStr) A.selectDay(dateStr);
    await A.reload();
  }

  async function createEvent(entities) {
    const A = window.AptCal;
    if (!A) return { ok: false, reply: 'Calendar is not ready yet.', error: 'no_aptcal' };

    const start = hhmm(entities.startTime);
    if (!start) return { ok: false, reply: "I couldn't understand the start time.", error: 'bad_time' };

    if (entities.date) A.selectDay(entities.date);
    const end = hhmm(entities.endTime);
    const durationMin = end ? minutesBetween(start, end) : 30;

    const made = await A.addEvent(entities.title, start, durationMin, entities.description || null);
    return { ok: true, reply: '✓ "' + entities.title + '" scheduled ' + made.when + '–' + made.end + '.' + describeUnsupported(entities), data: made };
  }

  // v0.1 scope note: update_event only RETIMES. The entity schema has no way
  // to express "old title vs. new title" distinctly (title is the match
  // reference here), so renaming via Shelron is not implemented — a real,
  // recorded limitation, not an oversight. See the journal / Shelron.md.
  async function updateEvent(entities) {
    const A = window.AptCal;
    if (!A) return { ok: false, reply: 'Calendar is not ready yet.', error: 'no_aptcal' };

    const start = hhmm(entities.startTime);
    const end = hhmm(entities.endTime);
    if (!start && !end) return { ok: false, reply: 'Nothing to change — give a new time.', error: 'no_change' };

    await ensureDayLoaded(entities.date);
    const result = await A.retimeEvent(entities.title, { start: start || undefined, end: end || undefined });
    if (!result || !result.ok) {
      return { ok: false, reply: 'Could not find "' + entities.title + '" to update.', error: 'not_found' };
    }
    return { ok: true, reply: '✓ "' + result.title + '" moved to ' + result.when + '–' + result.end + '.' + describeUnsupported(entities), data: result };
  }

  async function deleteEvent(entities) {
    const A = window.AptCal;
    if (!A) return { ok: false, reply: 'Calendar is not ready yet.', error: 'no_aptcal' };

    await ensureDayLoaded(entities.date);
    const result = await A.deleteEvent(entities.title);
    if (!result || !result.ok) {
      return { ok: false, reply: 'Could not find "' + entities.title + '" to delete.', error: 'not_found' };
    }
    return { ok: true, reply: '✓ "' + result.title + '" deleted.' + describeUnsupported(entities), data: result };
  }

  async function queryEvents(entities) {
    const A = window.AptCal;
    if (!A) return { ok: false, reply: 'Calendar is not ready yet.', error: 'no_aptcal' };

    await ensureDayLoaded(entities.date);
    const reply = A.summarize();
    return { ok: true, reply: reply + describeUnsupported(entities), data: { events: A.getEvents() } };
  }

  window.Shelron.CalendarAdapter = { createEvent, updateEvent, deleteEvent, queryEvents };

  // Register with the Action Dispatcher — the ONLY place these handlers are
  // wired to intent names. Fails loudly (not silently) if Dispatch isn't
  // loaded yet, since that's a load-order bug worth surfacing immediately.
  if (!window.Shelron.Dispatch) {
    throw new Error('js/shelron/calendar-adapter.js loaded before js/shelron/action-dispatcher.js — fix script order.');
  }
  window.Shelron.Dispatch.registerHandler('calendar.create_event', createEvent);
  window.Shelron.Dispatch.registerHandler('calendar.update_event', updateEvent);
  window.Shelron.Dispatch.registerHandler('calendar.delete_event', deleteEvent);
  window.Shelron.Dispatch.registerHandler('calendar.query', queryEvents);
})();
