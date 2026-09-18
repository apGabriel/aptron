// Playwright smoke test for Shenlong's LOCAL parser (js/index.js) and the
// new routine-authoring engine (js/shelron/routine-authoring.js).
//
// Serves the repo over HTTP, hard-blocks every request to *.supabase.co (the
// same pattern theme-smoke.mjs/confirm-smoke.mjs already established — the
// @supabase CDN bundle import itself is blocked too, so js/auth/main.js
// never runs, the auth gate never renders, and the dashboard boots fully
// local-only). This means real CALENDAR mutations (which require a working
// Supabase client) always fail with an "offline" message — that failure
// message is itself the assertion for calendar-routing cases below, since a
// DIFFERENT message (a gym-domain one, or none at all) would mean the
// command was misrouted. Gym-routine authoring does NOT depend on Supabase
// for its primary write (rb_routines_v1 is plain localStorage) — those
// assertions read localStorage directly, never trusting the chat reply
// alone, per this project's own testing philosophy.
//
// This is the automated regression suite flagged as missing in Known Issue
// #53/#54's write-up ("no automated Shenlong/local-parser regression suite
// exists yet") — it locks in the 2026-09-02 hardening pass' gym/calendar
// routing fixes AND the new real routine-CRUD capability this pass adds.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
  '.mjs':'text/javascript', '.json':'application/json', '.gif':'image/gif',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});
const PORT = 4602; // distinct from smoke.mjs (4599) / theme-smoke.mjs (4600) / confirm-smoke.mjs (4601)
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route('**://*.supabase.co/**', r => r.abort());
await ctx.route('**/@supabase/**', r => r.abort());

const page = await ctx.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

// Send a chat message, wait for a new non-thinking AI reply, return its text.
async function send(text) {
  const prevCount = await page.evaluate(() => document.querySelectorAll('.aios-msg-ai:not(.aios-msg-think)').length);
  await page.fill('#aiInput', text);
  await page.click('#aiSend');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.aios-msg-ai:not(.aios-msg-think)').length > n,
    prevCount, { timeout: 8000 }
  );
  return page.evaluate(() => {
    const nodes = document.querySelectorAll('.aios-msg-ai:not(.aios-msg-think)');
    return nodes[nodes.length - 1].textContent;
  });
}
async function routines() {
  return page.evaluate(() => { try { return JSON.parse(localStorage.getItem('rb_routines_v1')) || []; } catch (e) { return []; } });
}
async function clearRoutines() { await page.evaluate(() => localStorage.removeItem('rb_routines_v1')); }
// P10a: direct localStorage seeding — the P10a day-scoped set_sets tests need
// exact control over routine id, array order, and trainingDays (two same-day
// routines, a multi-day routine, reversed order) that chat-driven creation
// can't reliably produce. Mirrors rb_routines_v1's real schema (same shape
// applyCreateMulti/applyAddExercise write).
async function setRoutines(rs) { await page.evaluate((rs) => localStorage.setItem('rb_routines_v1', JSON.stringify(rs)), rs); }
// Existing test hook (routine-authoring.js's own `forgetLastRoutine`) — resets
// the module's domain-scoped coreference pointer without touching storage,
// so a "no context" case can be tested without a page reload.
async function forgetLastRoutine() { await page.evaluate(() => window.Shelron.Routines.forgetLastRoutine()); }
const TODAY_CODE = ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];

try {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForSelector('#aiForm', { timeout: 10000 });
  await page.waitForTimeout(300); // let deferred scripts finish attaching handlers
  await clearRoutines();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION A — Calendar vs Gym vs Ambiguous routing matrix (items 1 & 4)
  // ══════════════════════════════════════════════════════════════════════

  {
    const r = await send('Create a 3-day workout routine');
    ok('A1: routine create w/ no specifics asks, does not fabricate', /focus/i.test(r) && !/schedule/i.test(r), r);
  }
  {
    const r = await send('Add Bench Press to Monday');
    ok('A2: exercise-add stays in the gym domain (no calendar prompt)', /monday/i.test(r) && !/schedule .*bench/i.test(r), r);
  }
  {
    const r = await send('What workout do I have today?');
    ok('A3: gym_today answers from routine data, not calendar', /routine/i.test(r) && !/proxy/i.test(r), r);
  }
  {
    // Regression (Phase 4): bare "training" (no "session") fell all the way
    // through to Calendar's generic summarize, silently ignoring the real
    // gym question and answering from unrelated events instead.
    const r = await send('What am I training today?');
    ok('A3b: "what am I training today" reaches gym_today, not calendar summarize', /routine/i.test(r) && !/blocks scheduled today/i.test(r), r);
  }
  {
    const r = await send('Add gym at 5pm');
    ok('A4: REGRESSION — "add gym at 5pm" still a real calendar block attempt (Known Issue #22)', /calendar/i.test(r), r);
  }
  {
    const r = await send('Move it to Friday');
    ok('A5: date-only retime now reaches calendar logic (not the old generic "can\'t think through" fallback)',
      /event you mean|calendar/i.test(r) && !/currently think through/i.test(r), r);
  }
  {
    // Regression (Phase 4): a completely ordinary "Delete it." (trailing
    // sentence punctuation) left coref() checking "it." against the exact
    // PRONOUN_ONLY regex, which fails on the trailing period — surfaced as
    // "I couldn't find an event matching '.'" instead of ever attempting
    // real pronoun resolution. Not compound-specific; a single plain
    // message has the identical bug. Offline here so this only proves
    // parsing reaches the calendar layer at all (no prior remembered event
    // exists in this harness) — the live pass is the real proof.
    const r = await send('Delete it.');
    ok('A5e: trailing punctuation after a pronoun does not itself break parsing', !/matching\s*[""]\.[""]/.test(r), r);
  }
  {
    // Regression for a SERIOUS bug a live adversarial pass caught: a create
    // request whose intended TITLE happens to contain a mutation trigger
    // word ("check-in" contains "check") got hijacked by the CHECK/
    // complete_event branch (checked before ADD) — live-verified to
    // fuzzy-match and mark an unrelated REAL event as done, then a later
    // "move it" (inheriting the wrong remembered title) moved that same
    // real event. Fixed: a message that clearly OPENS with a create verb
    // ("add"/"schedule"/"create"/...) now skips every mutation-detection
    // branch entirely for that message.
    const r = await send('Add a check-in with the dentist tomorrow at 3pm');
    ok('A5b: a title containing "check" does not get hijacked into completing/matching an existing event',
      !/more than one event matched|couldn.t find an event matching/i.test(r), r);
  }
  {
    // Same class of bug, the DELETE-trigger version ("clear" is inside
    // "clearance").
    const r = await send('Add a clearance sale reminder tomorrow at 2pm');
    ok('A5c: a title containing "clear" (DELETE trigger) does not get hijacked either',
      !/more than one event matched|couldn.t find an event matching/i.test(r), r);
  }

  // ══════════════════════════════════════════════════════════════════════
  // SHENLONG P0 (2026-09-08, live-verified) — clearlyAddIntent's `^`-anchor
  // only recognized a create verb as the message's literal FIRST word, so
  // any ordinary request framing ("Please add...", "Can you schedule...")
  // reopened the exact A5b/A5c hijack on everyday phrasing. Live
  // reproduction: "Please add a check-in about X tomorrow at 6am" never
  // reached ADD at all — it silently marked an unrelated real event
  // complete, reporting "✓ Awesome". Fixed with a small, enumerated
  // whitelist of request framings stripped only from the message's start.
  // Positive cases below reuse A5b/A5c's exact assertion (not a "couldn't
  // find"/"ambiguous" reply — the CHECK/DELETE-hijack signature in this
  // offline harness); negative cases assert the opposite: a mutation
  // command must NOT produce an ADD-shaped reply.
  // ══════════════════════════════════════════════════════════════════════
  const NOT_HIJACKED = (r) => !/more than one event matched|couldn.t find an event matching/i.test(r);
  const NOT_ADD_SHAPED = (r) => !/adding that failed|couldn.t add|what should i call that block|when should i schedule/i.test(r);

  {
    const r = await send('Please add a check-in with the dentist tomorrow at 3pm');
    ok('P0-1: "Please add" + a CHECK-trigger title reaches ADD, not CHECK', NOT_HIJACKED(r), r);
  }
  {
    const r = await send('Can you schedule a check-in with the dentist tomorrow at 3pm?');
    ok('P0-2: "Can you schedule" + a CHECK-trigger title reaches ADD, not CHECK', NOT_HIJACKED(r), r);
  }
  {
    const r = await send('Could you create a check-in with the dentist tomorrow at 3pm?');
    ok('P0-3: "Could you create" + a CHECK-trigger title reaches ADD, not CHECK', NOT_HIJACKED(r), r);
  }
  {
    const r = await send("I'd like to add a check-in with the dentist tomorrow at 3pm");
    ok('P0-4: "I\'d like to add" + a CHECK-trigger title reaches ADD, not CHECK', NOT_HIJACKED(r), r);
  }
  {
    const r = await send('I want to schedule a check-in with the dentist tomorrow at 3pm');
    ok('P0-5: "I want to schedule" + a CHECK-trigger title reaches ADD, not CHECK', NOT_HIJACKED(r), r);
  }
  {
    const r = await send('Would you add a clearance sale reminder tomorrow at 2pm?');
    ok('P0-6: "Would you add" + a DELETE-trigger title reaches ADD, not DELETE', NOT_HIJACKED(r), r);
  }
  {
    const r = await send('Please, add a check-in with the dentist tomorrow at 3pm');
    ok('P0-7: "Please," (comma) + a CHECK-trigger title reaches ADD, not CHECK', NOT_HIJACKED(r), r);
  }
  {
    const r = await send('PLEASE ADD a check-in with the dentist tomorrow at 3pm');
    ok('P0-8: all-caps "PLEASE ADD" + a CHECK-trigger title reaches ADD, not CHECK', NOT_HIJACKED(r), r);
  }
  {
    // Content/title traps that must STILL be creation (already start with
    // the real verb) — proves the fix didn't touch this pre-existing path.
    const r = await send('Create an event called "Please add dentist" tomorrow at 9am');
    ok('P0-9: "Create an event called \\"Please add dentist\\"" stays ADD', NOT_HIJACKED(r), r);
  }
  {
    const r = await send('Schedule an event called "Create appointment" tomorrow at 9am');
    ok('P0-10: "Schedule an event called \\"Create appointment\\"" stays ADD', NOT_HIJACKED(r), r);
  }
  {
    // Adversarial: a lead-in word ("please"/"can you"/"could you") followed
    // by a NON-create verb must still route to its real mutation branch —
    // proves the new whitelist doesn't overreach into "any polite prefix
    // means ADD".
    const r = await send('Please delete the dentist appointment tomorrow');
    ok('P0-11: "Please delete..." still routes to DELETE, not ADD', NOT_ADD_SHAPED(r), r);
  }
  {
    // Not "Can you check off..." here: CHECK/UNCHECK have a separate,
    // pre-existing (unrelated to this fix) fallback that offers to ADD when
    // no matching event is found at all — expected in this harness (zero
    // events ever load), and not the P0's threat model (no REAL event gets
    // mutated by it). DELETE/RETIME have no such fallback, so "cancel" here
    // cleanly isolates the guard this fix actually changes.
    const r = await send('Would you cancel the dentist appointment tomorrow?');
    ok('P0-12: "Would you cancel..." still routes to DELETE, not ADD', NOT_ADD_SHAPED(r), r);
  }
  {
    const r = await send('Could you move the dentist appointment to Friday?');
    ok('P0-13: "Could you move..." still routes to RETIME, not ADD', NOT_ADD_SHAPED(r), r);
  }
  {
    // Mutation traps: a create-like word inside quoted/target content, with
    // no lead-in at the message's start, must never become ADD (these never
    // depended on clearlyAddIntent — RENAME/DELETE/CHECK match independently
    // — but are exactly the mission's required content-trap coverage).
    const r = await send('Rename the event to "add gym"');
    ok('P0-14: "Rename the event to \\"add gym\\"" stays RENAME, not ADD', NOT_ADD_SHAPED(r), r);
  }
  {
    const r = await send('Delete the event called "please add dentist"');
    ok('P0-15: "Delete the event called \\"please add dentist\\"" stays DELETE, not ADD', NOT_ADD_SHAPED(r), r);
  }
  {
    // Combined trap: a leading polite lead-in AND a create-like word inside
    // the target content, in the same message.
    const r = await send('Please rename the event to "add gym"');
    ok('P0-16: "Please rename the event to \\"add gym\\"" stays RENAME, not ADD', NOT_ADD_SHAPED(r), r);
  }

  {
    // Regression for a bug THIS pass's own "yesterday" fix introduced:
    // every weekday name also ends in "day" and was relying on the same
    // loose substring match the "yesterday" fix correctly removed —
    // "What do I have Thursday?" stopped matching summarize at all.
    const r = await send('What do I have Thursday?');
    ok('A5d: "What do I have <Weekday>?" still reaches calendar summarize', !/couldn.t parse that locally/i.test(r), r);
  }
  {
    const r = await send("What's on today?");
    ok('A6: generic "what\'s on" stays calendar-flavored, not gym', !/routine|workout/i.test(r), r);
  }
  {
    const r = await send('Delete the gym event');
    ok('A7: explicit "event" word disambiguates to calendar delete', /calendar/i.test(r), r);
  }
  {
    const r = await send('Delete the workout');
    ok('A8: bare "workout" delete is ambiguous — asks, does not guess', /delete a calendar event, or delete a gym routine/i.test(r), r);
  }
  {
    const r = await send('Change my workout to Friday');
    ok('A9: bare "workout" move is ambiguous — asks, does not guess', /move a calendar event, or reschedule/i.test(r), r);
  }
  {
    const r = await send('Move my meeting to Friday');
    ok('A10: "meeting" is unambiguously calendar (no ambiguity prompt)', /event you mean|calendar/i.test(r) && !/gym routine/i.test(r), r);
  }
  {
    const r = await send('Move my appointment to Friday');
    ok('A11: "appointment" is unambiguously calendar (no ambiguity prompt)', /event you mean|calendar/i.test(r) && !/gym routine/i.test(r), r);
  }
  {
    const r = await send('Change bench press to 4 sets');
    ok('A12: sets-change never becomes a calendar retime', !/re-time it to when/i.test(r), r);
  }
  {
    const r = await send('Remove squats from Friday');
    ok('A13: exercise-remove stays in the gym domain', !/couldn.t find an event matching/i.test(r), r);
  }
  // A14-A16: regressions for a real bug a live adversarial pass caught —
  // "delete"/"add" + a bare weekday, with ZERO gym-domain vocabulary, must
  // stay in the calendar domain. An earlier version of the gym DELETE-
  // routine trigger fired on any "delete" + weekday/pronoun; an earlier
  // ADD/REMOVE trigger fired on any "add/remove X to/from Y" shape with no
  // check that X was actually an exercise — both hijacked genuine calendar
  // commands (e.g. "delete the meeting on Monday", "add dentist to Monday")
  // purely because they named a day.
  {
    const r = await send('Delete the AUDIT_TEST meeting on Monday');
    ok('A14: calendar delete naming a weekday stays calendar (no gym hijack)', /calendar/i.test(r) && !/routine/i.test(r), r);
  }
  {
    const r = await send('Add dentist appointment to Monday');
    ok('A15: calendar add naming a weekday, with no real exercise match, stays calendar', !/exercise library|routine/i.test(r), r);
    ok('A15b: the weekday connector ("to Monday") does not leak into the title', /“Dentist appointment”/.test(r), r);
  }
  {
    // Regression (pass V, live-caught): a connector word immediately before
    // a relative-date/weekday reference used to leak into the stored title
    // verbatim, since only the date word itself was stripped, never the
    // preposition right before it. "...call for tomorrow at 2pm" produced
    // the real title "...call for" — live-verified via direct SQL against
    // the real Supabase project before being fixed here.
    const r = await send('Schedule SHENLONG_PHASE5_DAYTEST2 call for tomorrow at 2pm');
    ok('A24: a "for <date-word>" connector does not leak into the event title', /“SHENLONG_PHASE5_DAYTEST2 call”/.test(r), r);
  }
  {
    // Regression (pass V, live-caught): weekday names were not stripped
    // from add_event titles AT ALL (only today/tomorrow/tonight were) —
    // "...dinner on Friday at 7pm" produced the real title "...dinner on
    // Friday", live-verified via direct SQL before being fixed here.
    const r = await send('Schedule SHENLONG_PHASE5_DAYTEST3 dinner on Friday at 7pm');
    ok('A25: a weekday name does not leak into the event title', /“SHENLONG_PHASE5_DAYTEST3 dinner”/.test(r), r);
  }
  {
    // Regression (pass V, live-caught): "tmrw" (a common informal spelling
    // of "tomorrow") was not recognized by resolveDate() at all, so the
    // event silently landed on whatever day happened to be currently
    // selected (not necessarily today) with the literal word "tmrw" left in
    // the title — a false-confidence risk, since the "✓ Scheduled" reply
    // looked identical either way. Fixed by adding "tmrw"/"tmr" as
    // recognized tomorrow-synonyms in both resolveDate() and the title
    // strip chain.
    const r = await send('add SHENLONG_PHASE5_DAYTEST4 standup at 9am tmrw');
    ok('A26: "tmrw" does not leak into the event title', /“SHENLONG_PHASE5_DAYTEST4 standup”/.test(r), r);
  }
  {
    // Fresh session (no lastRoutineRef set yet in THIS page load) — a bare
    // pronoun delete with no prior gym context must never guess gym.
    const r = await send('Delete it');
    ok('A16: bare "delete it" with no gym context stays calendar (not silently gym)', !/routine/i.test(r), r);
  }
  {
    // A bare muscle-group word can appear in an entirely innocent sentence
    // with no gym intent at all — must not trip the gym_unsupported decline.
    const r = await send('What time is the welcome back party?');
    ok('A17: incidental muscle-group word ("back") with no action verb does not trigger gym decline', !/workout routines|Routine Builder/i.test(r), r);
  }
  // A18-A21: regressions for real bugs a Phase 3 live adversarial pass caught.
  {
    // set_sets' weekday-stripping used to empty exerciseQuery to '' when the
    // weekday WAS the entire (mistaken) query, surfacing as a confusing
    // "I couldn't find \"\" in your routines." instead of an honest decline.
    const r = await send('Change Monday to 4 sets');
    ok('A18: "change <weekday> to N sets" (no exercise at all) never produces an empty-quotes match failure', !/couldn.t find "" /i.test(r), r);
  }
  {
    // gym_today's "any question containing routine/workout" trigger used to
    // fire before gym_week's, and gym_week's own trigger required "week"
    // to appear literally before "routine" in the text — neither held for
    // natural phrasing, so a weekly question was silently answered as if
    // asking about today only.
    const r = await send("What's my routine this week?");
    ok('A19: "what\'s my routine this week" reaches gym_week, not gym_today', /weekly routine schedule|routines? saved|don.t have any routines/i.test(r) && !/^Nothing scheduled for today/i.test(r), r);
  }
  {
    // Regression for a bug this very pass introduced and then caught live:
    // broadening gym_week's trigger to be order-independent also made
    // "schedule" alone (paired with "week") enough to fire it — but
    // "schedule" is domain-neutral, so "What's my schedule this week?" (a
    // plainly calendar question) was wrongly answered from routine data.
    const r = await send("What's my schedule this week?");
    ok('A19b: "what\'s my SCHEDULE this week" (no "routine"/"split") stays calendar, not gym', !/routines? saved|weekly routine schedule/i.test(r), r);
  }
  {
    // The old summarize trigger regex had no \b before its trailing
    // alternation, so "day" matched as a mid-word substring of "yesterday" —
    // "what did I train yesterday" was silently answered as a generic
    // "what's on today" calendar summary instead of falling through honestly.
    const r = await send('What did I train yesterday?');
    ok('A20: "yesterday" no longer false-positives into a generic today-summary', !/blocks scheduled today/i.test(r), r);
  }
  {
    // "give" was not recognized as a routine-creation verb at all.
    const r = await send('Give me a chest and triceps workout for Monday');
    ok('A21: "give me a ... workout" is recognized as a create request', !/couldn.t parse that locally/i.test(r), r);
  }
  {
    // Regression: a compound gym command ("X and Y, then Z") used to only
    // ever execute the FIRST recognized op, with the confirmation message
    // giving no indication anything after it was dropped — "✓ Created..."
    // read as if the whole compound request had succeeded.
    await send('Delete my Monday routine'); // clean up A21's routine first
    const r = await send('Create a Monday chest routine and add bench press, then move it to Wednesday.');
    ok('A22: a compound gym command discloses that only the first part ran', /only handled the first part/i.test(r), r);
    const rb = await routines();
    const mon = rb.find(x => (x.trainingDays || []).includes('mon'));
    const wed = rb.find(x => (x.trainingDays || []).includes('wed'));
    ok('A22: the routine genuinely stayed on Monday (the "move to Wednesday" part was NOT silently applied)', !!mon && !wed);
    await send('Delete my Monday routine'); // clean up
  }
  {
    // Regression (pass V): the positive case for the parseGymCompound fix —
    // when EVERY clause of a "then"-joined message is independently a real
    // gym op, all of them must actually execute in order, not just the
    // first. This is the mirror image of A22 (which proved a mixed-domain
    // compound correctly declines rather than silently mutating the wrong
    // thing); this proves the same mechanism doesn't over-correct into
    // refusing genuinely-supported all-gym compounds.
    const r = await send('Create a Monday chest routine and add bench press, then change bench press to 4 sets');
    ok('A23: an all-gym-valid compound command does NOT disclose a dropped step', !/only handled the first part/i.test(r), r);
    const rb = await routines();
    const mon = rb.find(x => (x.trainingDays || []).includes('mon'));
    ok('A23: the routine was created', !!mon);
    const bp = mon && (mon.exercises || []).find(e => /bench press/i.test(e.name));
    ok('A23: bench press was genuinely added (step 2 ran)', !!bp, JSON.stringify(mon));
    ok('A23: bench press sets were genuinely updated to 4 (step 3 ran)', !!bp && Array.isArray(bp.sets) && bp.sets.length === 4, JSON.stringify(bp));
    await send('Delete my Monday routine'); // clean up
  }
  {
    // Regression (Phase 4): spelled-out numbers ("four sets") were not
    // recognized at all — the regex required a literal digit, so this
    // silently fell through to the generic gym_unsupported decline even
    // though set_sets genuinely supports the request once it has a number.
    await send('Create a chest workout for Monday');
    await send('Make bench press four sets');
    const rb = await routines();
    const bench = rb.find(x => (x.trainingDays || []).includes('mon')).exercises.find(e => /bench press/i.test(e.name));
    ok('A23: "four sets" (spelled out) genuinely persists as 4', bench && bench.sets.length === 4, bench && bench.sets.length);
    await send('Delete my Monday routine'); // clean up
  }

  // ══════════════════════════════════════════════════════════════════════
  // SECTION B — Real routine CRUD, verified against localStorage directly
  // (item 3 — never trust the chat reply alone)
  // ══════════════════════════════════════════════════════════════════════
  await clearRoutines();

  {
    await send('Create a 3-day workout routine: Monday chest and triceps, Wednesday back and biceps, Friday legs.');
    const rs = await routines();
    ok('B1: creates exactly 3 routines', rs.length === 3, JSON.stringify(rs.map(r => r.name)));
    const mon = rs.find(r => (r.trainingDays || []).includes('mon'));
    const wed = rs.find(r => (r.trainingDays || []).includes('wed'));
    const fri = rs.find(r => (r.trainingDays || []).includes('fri'));
    ok('B1: Monday routine has real exercises (chest+triceps)', !!mon && mon.exercises.length >= 3, mon && mon.exercises.map(e => e.name).join(', '));
    ok('B1: Wednesday routine has real exercises (back+biceps)', !!wed && wed.exercises.length >= 3, wed && wed.exercises.map(e => e.name).join(', '));
    ok('B1: Friday routine has real exercises (legs)', !!fri && fri.exercises.length >= 3, fri && fri.exercises.map(e => e.name).join(', '));
    ok('B1: every exercise resolved to a REAL catalog entry (has exId+muscleGroup)', rs.every(r => r.exercises.every(e => e.exId && e.muscleGroup)));
  }
  {
    // Deliberately an exercise NOT already in the chest+triceps template
    // (bench press/incline press/push up/skull crusher/triceps pushdown),
    // so a real increment proves the add — not a pre-existing duplicate.
    const before = (await routines()).find(r => (r.trainingDays || []).includes('mon')).exercises.length;
    await send('Add shoulder press to Monday');
    const mon = (await routines()).find(r => (r.trainingDays || []).includes('mon'));
    ok('B2: add_exercise genuinely persists to rb_routines_v1', mon.exercises.length === before + 1, mon.exercises.map(e => e.name).join(', '));
    ok('B2: the added exercise is a real "shoulder press" match', mon.exercises.some(e => /shoulder press/i.test(e.name)));
  }
  {
    const before = (await routines()).find(r => (r.trainingDays || []).includes('fri')).exercises.length;
    await send('Remove squats from Friday');
    const fri = (await routines()).find(r => (r.trainingDays || []).includes('fri'));
    ok('B3: remove_exercise genuinely persists', fri.exercises.length === before - 1, fri.exercises.map(e => e.name).join(', '));
    ok('B3: the squat entry is actually gone', !fri.exercises.some(e => /squat/i.test(e.name)));
  }
  {
    // Regression (Phase 3 adversarial pass): remove/set_sets originally fell
    // back to a raw substring check against the routine's own exercise
    // NAME ("barbell incline bench press".indexOf("bench press") !== -1),
    // so a routine containing BOTH "Barbell Bench Press" and "Barbell
    // Incline Bench Press" could have the WRONG one silently matched.
    // Monday already has "Barbell Bench Press" from B1 — add the Incline
    // variant deliberately, then prove "bench press" only ever resolves to
    // the exact catalog match, never the substring-colliding neighbor.
    await send('Add incline bench press to Monday');
    const withBoth = (await routines()).find(r => (r.trainingDays || []).includes('mon'));
    ok('B3b: setup — Monday now has both "Bench Press" and "Incline Bench Press"',
      withBoth.exercises.some(e => e.name === 'Barbell Bench Press') && withBoth.exercises.some(e => /incline bench press/i.test(e.name)));
    const beforeCount = withBoth.exercises.length;
    const inclineSetsBefore = withBoth.exercises.find(e => /incline bench press/i.test(e.name)).sets.length;
    await send('Remove bench press from Monday');
    const afterRemove = (await routines()).find(r => (r.trainingDays || []).includes('mon'));
    ok('B3b: "remove bench press" removes the EXACT match, not the substring-colliding Incline variant',
      !afterRemove.exercises.some(e => e.name === 'Barbell Bench Press') && afterRemove.exercises.some(e => /incline bench press/i.test(e.name)) && afterRemove.exercises.length === beforeCount - 1,
      afterRemove.exercises.map(e => e.name).join(', '));
    // Re-add plain bench press, then attack set_sets the same way.
    await send('Add bench press to Monday');
    await send('Change bench press to 6 sets');
    const afterSets = (await routines()).find(r => (r.trainingDays || []).includes('mon'));
    const plain = afterSets.exercises.find(e => e.name === 'Barbell Bench Press');
    const incline = afterSets.exercises.find(e => /incline bench press/i.test(e.name));
    ok('B3b: "change bench press to 6 sets" changes the EXACT match only, not the Incline variant',
      plain && plain.sets.length === 6 && incline && incline.sets.length === inclineSetsBefore,
      `plain=${plain && plain.sets.length}, incline=${incline && incline.sets.length} (was ${inclineSetsBefore})`);
    // Clean up the Incline variant so later B-section tests see the
    // exercise set they were originally written against.
    await send('Remove incline bench press from Monday');
    await send('Change bench press to 4 sets'); // restore the count B4 expects
  }
  {
    // Regression for a real bug a live adversarial pass caught: set_sets
    // originally applied to EVERY routine containing the exercise, silently
    // mutating unrelated routines the user never mentioned. Monday is the
    // only routine with Bench Press at this point, so this must touch ONLY it.
    await send('Change bench press to 4 sets');
    const rs = await routines();
    const mon = rs.find(r => (r.trainingDays || []).includes('mon'));
    const wed = rs.find(r => (r.trainingDays || []).includes('wed'));
    const bench = mon.exercises.find(e => /bench press/i.test(e.name));
    ok('B4: set_sets genuinely persists the new set count', bench && bench.sets.length === 4, bench && bench.sets.length);
    ok('B4: set_sets does NOT touch an unrelated routine without bench press', !wed.exercises.some(e => /bench press/i.test(e.name)));
  }
  {
    // Regression (pass V, live-caught): an absurdly large set count ("a
    // stray extra digit") used to be silently accepted — allocating and
    // storing an array of that many {weight,reps} objects, taking 10-25+
    // seconds and producing an unusable routine. Now asks for confirmation
    // instead of silently accepting (or silently clamping) the number.
    const r = await send('change bench press to 999999 sets');
    ok('B4d: an absurdly large set count asks for confirmation instead of silently writing it', /more than i.d expect/i.test(r), r);
    const rs = await routines();
    const mon = rs.find(r2 => (r2.trainingDays || []).includes('mon'));
    const bench = mon.exercises.find(e => /bench press/i.test(e.name));
    ok('B4d: the absurd count was NOT written — the exercise still has its prior, sane set count', bench && bench.sets.length === 4, bench && bench.sets.length);
  }
  {
    // Regression for the same bug, the genuinely-ambiguous half: bench press
    // now exists in TWO routines (Monday, and a temporary second one), and
    // the most-recent gym command touched neither (a deliberate intervening
    // command clears that recency signal) — no day/context to disambiguate,
    // so this must ASK, never silently pick one just because it's first/last.
    await send('Add bench press to Wednesday');
    await send('Remove romanian deadlift from Friday'); // unrelated — redirects "last touched" away from Monday/Wednesday
    const before = await routines();
    const r = await send('Change bench press to 5 sets');
    const after = await routines();
    const monBefore = before.find(x => (x.trainingDays || []).includes('mon')).exercises.find(e => /bench press/i.test(e.name));
    const monAfter = after.find(x => (x.trainingDays || []).includes('mon')).exercises.find(e => /bench press/i.test(e.name));
    const wedBefore = before.find(x => (x.trainingDays || []).includes('wed')).exercises.find(e => /bench press/i.test(e.name));
    const wedAfter = after.find(x => (x.trainingDays || []).includes('wed')).exercises.find(e => /bench press/i.test(e.name));
    ok('B4b: ambiguous set_sets (2 routines, no recency/day signal) mutates NEITHER', monBefore.sets.length === monAfter.sets.length && wedBefore.sets.length === wedAfter.sets.length,
      `mon ${monBefore.sets.length}->${monAfter.sets.length}, wed ${wedBefore.sets.length}->${wedAfter.sets.length}`);
    ok('B4b: asks which routine instead of silently guessing', /more than one routine|which one/i.test(r), r);
    // Clean up the temporary second bench-press entry so later tests
    // (B5+) see the same single-bench-press state they were written against.
    await send('Remove bench press from Wednesday');
  }
  {
    // Short-irregular-plural matching ("push ups" -> catalog's "Push up").
    const before = (await routines()).find(r => (r.trainingDays || []).includes('mon')).exercises.length;
    await send('Remove push ups from Monday');
    const mon = (await routines()).find(r => (r.trainingDays || []).includes('mon'));
    ok('B4c: "push ups" (short irregular plural) matches "Push up"', mon.exercises.length === before - 1 && !mon.exercises.some(e => /push up/i.test(e.name)), mon.exercises.map(e => e.name).join(', '));
  }
  {
    const before = await routines();
    await send('Make Wednesday my back day');
    const after = await routines();
    const wed = after.find(r => (r.trainingDays || []).includes('wed'));
    ok('B5: assign_day creates/reassigns Wednesday to a real Back routine', wed && /back/i.test(wed.name) && wed.exercises.length >= 2, wed && wed.name);
    ok('B5: no two routines claim Wednesday at once', after.filter(r => (r.trainingDays || []).includes('wed')).length === 1);
  }
  {
    await send('Delete my Friday routine');
    const rs = await routines();
    ok('B6: delete_routine genuinely removes it from storage', !rs.some(r => (r.trainingDays || []).includes('fri')));
  }
  {
    const r = await send('Show me my weekly routine');
    ok('B7: gym_week reads the real remaining schedule', /monday/i.test(r) && /wednesday/i.test(r) && !/friday:/i.test(r), r);
  }

  // ══════════════════════════════════════════════════════════════════════
  // SHENLONG P1 (2026-09-09, live-verified) — parseDelete (routine-authoring.js
  // :369-375) always filled `namePhrase` with something, including a bare "it"/
  // "that", which is truthy and so defeated applyDeleteRoutine's own
  // lastRoutineRef fallback (guarded by `!op.namePhrase`) — the exact
  // mechanism built for "create a routine, then say delete it" never
  // triggered. Fixed by having parseDelete normalize an EXACT bare-pronoun
  // extraction to '' (no explicit name), so the pre-existing fallback runs.
  // Proven via routines() directly (a real localStorage mutation), not just
  // reply text, matching this file's own convention (see B6 above).
  // ══════════════════════════════════════════════════════════════════════
  {
    await send('Create a Thursday shoulders routine');
    const created = (await routines()).find((r) => (r.trainingDays || []).includes('thu'));
    ok('P1-1: setup — a Thursday routine exists (becomes lastRoutineRef)', !!created, created && created.name);
    const r = await send('Delete it');
    const after = await routines();
    ok('P1-1: "Delete it" genuinely removes the just-created routine via lastRoutineRef',
      created && !after.some((x) => x.id === created.id), after.map((x) => x.name).join(', '));
    ok('P1-1: reports genuine success, not the "not sure which routine" failure', /^✓ deleted/i.test(r), r);
  }
  {
    // Same class, the "that" variant — already-intended vocabulary per the
    // existing pronoun trigger at routine-authoring.js:485 (`/\bit\b|\bthat\b/i`).
    // A different weekday (Saturday) than P1-1 (Thursday) so the two cases
    // can never interact even if one were to fail.
    await send('Create a Saturday legs routine');
    const created = (await routines()).find((r) => (r.trainingDays || []).includes('sat'));
    ok('P1-2: setup — a Saturday routine exists (becomes lastRoutineRef)', !!created, created && created.name);
    const r = await send('Delete that');
    const after = await routines();
    ok('P1-2: "Delete that" genuinely removes the just-created routine via lastRoutineRef',
      created && !after.some((x) => x.id === created.id), after.map((x) => x.name).join(', '));
    ok('P1-2: reports genuine success, not the "not sure which routine" failure', /^✓ deleted/i.test(r), r);
  }
  {
    // Negative case: a bare pronoun with NO valid lastRoutineRef must not
    // guess. P1-2's own successful delete already nulls lastRoutineRef (it
    // deletes exactly the routine that was referenced), but forgetLastRoutine
    // is called explicitly so this case doesn't depend on that side effect.
    // With no lastRoutineRef, routine-authoring.js:485's own guard
    // (`lastRoutineRef && ...`) never engages at all, so this correctly never
    // becomes a gym intent in the first place — it falls through to
    // Calendar's own "delete it" handling, exactly like the pre-existing A16
    // case just above (same scenario, same architecture) — not a gym-side
    // "not sure which routine" reply.
    await forgetLastRoutine();
    const before = await routines();
    const r = await send('Delete it');
    const after = await routines();
    ok('P1-3: "Delete it" with no lastRoutineRef removes nothing (does not guess)',
      before.length === after.length && before.every((b) => after.some((a) => a.id === b.id)), after.map((x) => x.name).join(', '));
    ok('P1-3: no fabricated success, and correctly stays out of the gym domain', !/^✓/.test(r) && !/routine/i.test(r), r);
  }
  {
    // Explicit target text merely CONTAINING "it" as a substring ("legit")
    // must not be treated as a bare pronoun (proves the fix is an exact
    // whole-phrase match, not a substring test) — and, since no routine is
    // named "legit", must fail honestly rather than silently falling back to
    // lastRoutineRef (which is null here anyway, but this proves the
    // namePhrase-truthy branch is what's actually stopping it).
    const before = await routines();
    const r = await send('Delete the legit routine');
    const after = await routines();
    ok('P1-4: a name merely containing "it" ("legit") is not treated as a bare pronoun',
      before.length === after.length && before.every((b) => after.some((a) => a.id === b.id)), after.map((x) => x.name).join(', '));
    ok('P1-4: fails honestly (does not fabricate a match)', /not sure which routine/i.test(r), r);
  }

  // ══════════════════════════════════════════════════════════════════════
  // SHENLONG P7 (2026-09-13, live-verified): findRoutineByName's substring
  // fallback let "delete the triceps routine" silently delete "Chest &
  // Triceps" (the first array match) while a routine actually named
  // "Triceps Focus" sat untouched, with no ambiguity/error reported —
  // reproduced live before this fix. findRoutineByName is applyDeleteRoutine's
  // ONLY name-based resolution path (its only caller), so this exact-match-
  // only fix cannot affect any other mutation kind. Uses a directly-seeded
  // fixture (not `send('Create ...')`) since the real "Triceps Focus" name
  // has no natural-language template that would produce it.
  // ══════════════════════════════════════════════════════════════════════
  function testRoutine(id, name) {
    return { id, name, trainingDays: [], exercises: [], restEnabled: true, rest: 90, updated_at: new Date().toISOString() };
  }
  // SHENLONG P9: same shape as testRoutine(), plus explicit trainingDays —
  // needed for day-collision fixtures (testRoutine() always seeds []).
  function testRoutineOnDays(id, name, days) {
    return { id, name, trainingDays: days, exercises: [], restEnabled: true, rest: 90, updated_at: new Date().toISOString() };
  }
  async function seedRoutines(list) {
    await page.evaluate((arr) => { localStorage.setItem('rb_routines_v1', JSON.stringify(arr)); }, list);
  }

  {
    // P7-1: an exact name match (no collision at all — "Triceps Focus" is
    // named exactly) still deletes correctly. Proves the fix didn't also
    // break the legitimate exact-match case.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p7_wrong', 'Chest & Triceps'), testRoutine('rt_p7_right', 'Triceps Focus')]);
    const r = await send('Delete the Triceps Focus routine');
    const rs = await routines();
    ok('P7-1: an exact routine-name match still deletes correctly',
      !rs.some((x) => x.id === 'rt_p7_right') && rs.some((x) => x.id === 'rt_p7_wrong'),
      rs.map((x) => x.name).join(', '));
    ok('P7-1: reports genuine success', /^✓ deleted/i.test(r), r);
  }
  {
    // P7-2: the exact reported bug — "triceps" is a substring of BOTH
    // routine names but an exact name of NEITHER. Must delete neither, and
    // must not report a false success.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p7_a', 'Chest & Triceps'), testRoutine('rt_p7_b', 'Triceps Focus')]);
    const r = await send('Delete the triceps routine');
    const rs = await routines();
    ok('P7-2: a substring collision between two routine names deletes NEITHER',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p7_a') && rs.some((x) => x.id === 'rt_p7_b'),
      rs.map((x) => x.name).join(', '));
    ok('P7-2: fails honestly — no false-success deletion message', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P7-3: only ONE routine exists and "triceps" is a substring of its
    // name — no collision, no genuine ambiguity to ask about. Still must
    // not delete: this proves the fix is "exact match required," not
    // "unique partial match wins," which would have silently reintroduced
    // the same class of risk the moment a second routine appeared later.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p7_c', 'Chest & Triceps')]);
    const r = await send('Delete the triceps routine');
    const rs = await routines();
    ok('P7-3: a unique substring match still does NOT delete (exact-match-only, not "unique wins")',
      rs.length === 1 && rs[0].id === 'rt_p7_c', rs.map((x) => x.name).join(', '));
    ok('P7-3: operation is non-mutating and fails honestly', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P7-4: exact normalization (case-insensitive, whitespace-collapsing —
    // existing normTokens() behavior, nothing new added by this fix) still
    // resolves and deletes. Proves the fix removed only the substring
    // fallback, not exact-match normalization itself.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p7_d', 'Upper Body')]);
    const r = await send('delete upper   body routine');
    const rs = await routines();
    ok('P7-4: exact normalized match (case/whitespace-insensitive) still deletes',
      !rs.some((x) => x.id === 'rt_p7_d'), rs.map((x) => x.name).join(', '));
    ok('P7-4: reports genuine success', /^✓ deleted/i.test(r), r);
  }
  await clearRoutines();

  // ══════════════════════════════════════════════════════════════════════
  // SHENLONG P8 (2026-09-13, live-verified): even after P7's exact-match-
  // only fix, two routines CAN legitimately normalize to the same key
  // ("Legs"/"legs", "Upper Body"/"upper   body") and findRoutineByName's old
  // `routines.find(...)` silently returned/deleted whichever one was FIRST
  // in the array — proven array-order dependent by reversing the seed order
  // and watching the deleted routine flip. findRoutineByName now returns
  // EVERY exact match (still exact-only, never substring); applyDeleteRoutine
  // treats 2+ as genuine ambiguity and returns immediately with no mutation,
  // never falling through to lastRoutineRef/day/any other resolver.
  // ══════════════════════════════════════════════════════════════════════
  {
    // P8-1: two routines both normalize to "leg" ("Legs" seeded first).
    // Neither may be deleted; the response must not claim success.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p8_a', 'Legs'), testRoutine('rt_p8_b', 'legs')]);
    const r = await send('Delete the Legs routine');
    const rs = await routines();
    ok('P8-1: two routines sharing the same normalized name are NOT silently deleted',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p8_a') && rs.some((x) => x.id === 'rt_p8_b'),
      rs.map((x) => x.name).join(', '));
    ok('P8-1: response indicates uncertainty, never a false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P8-2: identical scenario, array order REVERSED ("legs" seeded first
    // this time). Must be equally safe — this is the exact invariant that
    // was previously broken (reversing seed order used to flip which
    // routine got deleted for the identical command).
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p8_b2', 'legs'), testRoutine('rt_p8_a2', 'Legs')]);
    const r = await send('Delete the Legs routine');
    const rs = await routines();
    ok('P8-2: reversed seed order is equally safe (no array-order-dependent deletion)',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p8_a2') && rs.some((x) => x.id === 'rt_p8_b2'),
      rs.map((x) => x.name).join(', '));
    ok('P8-2: response indicates uncertainty, never a false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P8-3: a genuinely unique exact name (no collision at all) must still
    // delete normally — the ambiguity guard must not overreach into the
    // ordinary single-match case.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p8_legs', 'Legs'), testRoutine('rt_p8_upper', 'Upper Body')]);
    const r = await send('Delete the Legs routine');
    const rs = await routines();
    ok('P8-3: a genuinely unique exact name still deletes correctly',
      !rs.some((x) => x.id === 'rt_p8_legs') && rs.some((x) => x.id === 'rt_p8_upper'),
      rs.map((x) => x.name).join(', '));
    ok('P8-3: reports genuine success', /^✓ deleted/i.test(r), r);
  }
  {
    // P8-4: P7's substring protection remains intact after this change —
    // "triceps" is a substring of both names but an exact name of neither,
    // so this must still be a plain not_found (0 exact matches), not the
    // new ambiguous_name path, and certainly not a deletion.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p8_c', 'Chest & Triceps'), testRoutine('rt_p8_d', 'Triceps Focus')]);
    const r = await send('Delete the triceps routine');
    const rs = await routines();
    ok('P8-4: P7\'s partial-name protection remains intact (0 exact matches, not deleted)',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p8_c') && rs.some((x) => x.id === 'rt_p8_d'),
      rs.map((x) => x.name).join(', '));
    ok('P8-4: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P8-5: P1's pronoun/lastRoutineRef deletion path is untouched by this
    // change — parseDelete blanks a bare pronoun's namePhrase to '', so the
    // new ambiguity-count logic (gated on `op.namePhrase` being truthy)
    // never even runs for "Delete it"; the pre-existing lastRoutineRef
    // fallback still resolves and deletes exactly the intended routine.
    await clearRoutines();
    await send('Create a Sunday shoulders routine');
    const created = (await routines()).find((x) => (x.trainingDays || []).includes('sun'));
    ok('P8-5: setup — a Sunday routine exists (becomes lastRoutineRef)', !!created, created && created.name);
    const r = await send('Delete it');
    const after = await routines();
    ok('P8-5: "Delete it" still resolves via lastRoutineRef and deletes the intended routine',
      created && !after.some((x) => x.id === created.id), after.map((x) => x.name).join(', '));
    ok('P8-5: reports genuine success, not the ambiguity/not-found path', /^✓ deleted/i.test(r), r);
  }
  await clearRoutines();

  // ══════════════════════════════════════════════════════════════════════
  // SHENLONG P9 (2026-09-14, live-verified): applyDeleteRoutine checked
  // op.day BEFORE op.namePhrase, and findRoutineByDay was a bare first-match
  // — "Delete my Friday routine" against two real Friday routines silently
  // deleted whichever was array-order-first, and "Delete my Friday Legs
  // routine" against ["Upper Body","Legs"] (both Friday) could delete
  // "Upper Body" — the routine the user did NOT name — purely by array
  // order. parseDelete() also left the bare weekday word inside namePhrase
  // ("friday"), which could be mistaken for a real name signal. Day
  // resolution is now its own fully-scoped candidate set: exactly one day
  // match still deletes outright (day-uniqueness alone is authoritative,
  // unchanged from before); 2+ day matches require an explicit name to
  // narrow that SAME candidate set down to exactly one, or the whole
  // request fails honestly — never falling through to an unscoped name
  // search, a different day, or lastRoutineRef.
  // ══════════════════════════════════════════════════════════════════════
  {
    // P9-1: unique day — the ordinary, most common case. Must still work
    // exactly as before this fix.
    await clearRoutines();
    await seedRoutines([testRoutineOnDays('rt_p9_unique', 'Legs', ['fri'])]);
    const r = await send('Delete my Friday routine');
    const rs = await routines();
    ok('P9-1: a unique day match still deletes correctly', !rs.some((x) => x.id === 'rt_p9_unique'), rs.map((x) => x.name).join(', '));
    ok('P9-1: reports genuine success', /^✓ deleted/i.test(r), r);
  }
  {
    // P9-2: two routines share Friday, no name to disambiguate. Neither may
    // be deleted.
    await clearRoutines();
    await seedRoutines([testRoutineOnDays('rt_p9_a', 'Friday A', ['fri']), testRoutineOnDays('rt_p9_b', 'Friday B', ['fri'])]);
    const r = await send('Delete my Friday routine');
    const rs = await routines();
    ok('P9-2: two routines sharing a day are NOT silently deleted',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p9_a') && rs.some((x) => x.id === 'rt_p9_b'), rs.map((x) => x.name).join(', '));
    ok('P9-2: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-3: identical scenario, array order reversed — proves the day
    // resolver's safety doesn't depend on array order either.
    await clearRoutines();
    await seedRoutines([testRoutineOnDays('rt_p9_b2', 'Friday B', ['fri']), testRoutineOnDays('rt_p9_a2', 'Friday A', ['fri'])]);
    const r = await send('Delete my Friday routine');
    const rs = await routines();
    ok('P9-3: reversed seed order is equally safe (no array-order-dependent day deletion)',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p9_a2') && rs.some((x) => x.id === 'rt_p9_b2'), rs.map((x) => x.name).join(', '));
    ok('P9-3: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-4: THE confirmed bug, reproduced as a regression test. Two Friday
    // routines, the user explicitly names the one they want ("Legs"), and
    // it must be the one deleted — never "Upper Body" merely because it's
    // array-first.
    await clearRoutines();
    await seedRoutines([testRoutineOnDays('rt_p9_upper', 'Upper Body', ['fri']), testRoutineOnDays('rt_p9_legs', 'Legs', ['fri'])]);
    const r = await send('Delete my Friday Legs routine');
    const rs = await routines();
    ok('P9-4: an explicit name correctly narrows a duplicate-day match — deletes the NAMED routine, not the array-first one',
      !rs.some((x) => x.id === 'rt_p9_legs') && rs.some((x) => x.id === 'rt_p9_upper'), rs.map((x) => x.name).join(', '));
    ok('P9-4: reports genuine success', /^✓ deleted/i.test(r), r);
  }
  {
    // P9-5: duplicate day, but the explicit name matches NEITHER day
    // candidate — and a same-named routine exists on a DIFFERENT day. Name
    // matching must stay scoped to the day's own candidates; the cross-day
    // "Legs" must never be reachable from a Friday-scoped request.
    await clearRoutines();
    await seedRoutines([
      testRoutineOnDays('rt_p9_upper2', 'Upper Body', ['fri']),
      testRoutineOnDays('rt_p9_chest', 'Chest', ['fri']),
      testRoutineOnDays('rt_p9_legs_mon', 'Legs', ['mon']),
    ]);
    const r = await send('Delete my Friday Legs routine');
    const rs = await routines();
    ok('P9-5: no Friday routine is deleted when the name matches none of the day\'s candidates',
      rs.some((x) => x.id === 'rt_p9_upper2') && rs.some((x) => x.id === 'rt_p9_chest'), rs.map((x) => x.name).join(', '));
    ok('P9-5: the same-named routine on a DIFFERENT day is untouched (name scoping cannot cross days)',
      rs.some((x) => x.id === 'rt_p9_legs_mon'), rs.map((x) => x.name).join(', '));
    ok('P9-5: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-6: duplicate day AND the explicit name itself collides (P8's
    // ambiguity rule) between the two day candidates — proves P8's exact-
    // name ambiguity check still works when nested inside a day-scoped set.
    await clearRoutines();
    await seedRoutines([testRoutineOnDays('rt_p9_legs_a', 'Legs', ['fri']), testRoutineOnDays('rt_p9_legs_b', 'legs', ['fri'])]);
    const r = await send('Delete my Friday Legs routine');
    const rs = await routines();
    ok('P9-6: a duplicate normalized name WITHIN the day candidates is still ambiguous, not array-order-picked',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p9_legs_a') && rs.some((x) => x.id === 'rt_p9_legs_b'), rs.map((x) => x.name).join(', '));
    ok('P9-6: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-7: three routines share the day, no name — guards the general
    // ">= 2" invariant rather than only the exact two-item case.
    await clearRoutines();
    await seedRoutines([
      testRoutineOnDays('rt_p9_t1', 'Friday One', ['fri']),
      testRoutineOnDays('rt_p9_t2', 'Friday Two', ['fri']),
      testRoutineOnDays('rt_p9_t3', 'Friday Three', ['fri']),
    ]);
    const r = await send('Delete my Friday routine');
    const rs = await routines();
    ok('P9-7: three same-day routines are equally safe — no first-match selection',
      rs.length === 3, rs.map((x) => x.name).join(', '));
    ok('P9-7: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-8: a multi-day routine sharing the requested day with a single-day
    // routine. The multi-day routine must not be silently selected just
    // because it happens to be array-first — this is a DELETE ROUTINE
    // request, not "unschedule Friday from a routine."
    await clearRoutines();
    await seedRoutines([testRoutineOnDays('rt_p9_full', 'Full Body', ['mon', 'fri']), testRoutineOnDays('rt_p9_other', 'Friday Only', ['fri'])]);
    const r = await send('Delete my Friday routine');
    const rs = await routines();
    ok('P9-8: a multi-day routine is not silently selected merely because it is array-first',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p9_full') && rs.some((x) => x.id === 'rt_p9_other'), rs.map((x) => x.name).join(', '));
    ok('P9-8: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-9: explicit name + a day that is ALREADY unique on its own, AND
    // the name genuinely matches that same candidate — a unique day match
    // is no longer sufficient on its own; the name (when present) is now
    // actively checked against it too, and here it correctly agrees.
    await clearRoutines();
    await seedRoutines([testRoutineOnDays('rt_p9_legs3', 'Legs', ['fri']), testRoutineOnDays('rt_p9_upper3', 'Upper Body', ['sat'])]);
    const r = await send('Delete my Friday Legs routine');
    const rs = await routines();
    ok('P9-9: a unique day match whose name AGREES with the explicit name still deletes correctly',
      !rs.some((x) => x.id === 'rt_p9_legs3') && rs.some((x) => x.id === 'rt_p9_upper3'), rs.map((x) => x.name).join(', '));
    ok('P9-9: reports genuine success', /^✓ deleted/i.test(r), r);
  }
  {
    // P9-14: THE just-caught regression — exactly ONE routine matches the
    // day, but the explicit name in the SAME command does NOT match it
    // ("Upper Body" is the only Friday routine; "Legs" is a real routine,
    // just on a different day). The first version of this fix treated
    // day-uniqueness alone as authoritative and silently ignored the
    // contradictory name here, deleting "Upper Body" — the routine the
    // user explicitly did NOT ask for. Neither routine may be deleted.
    await clearRoutines();
    await seedRoutines([testRoutineOnDays('rt_p9_upper5', 'Upper Body', ['fri']), testRoutineOnDays('rt_p9_legs5', 'Legs', ['mon'])]);
    const r = await send('Delete my Friday Legs routine');
    const rs = await routines();
    ok('P9-14: a unique day match whose name CONTRADICTS the explicit name is NOT deleted',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p9_upper5') && rs.some((x) => x.id === 'rt_p9_legs5'), rs.map((x) => x.name).join(', '));
    ok('P9-14: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-10: an explicit-but-ambiguous day request must NEVER fall through
    // to lastRoutineRef, even when a valid lastRoutineRef exists pointing
    // at a real, different routine.
    await clearRoutines();
    await send('Create a Monday chest routine');
    const mondayRoutine = (await routines()).find((x) => (x.trainingDays || []).includes('mon'));
    ok('P9-10: setup — a Monday routine exists (becomes lastRoutineRef)', !!mondayRoutine, mondayRoutine && mondayRoutine.name);
    await seedRoutines([mondayRoutine, testRoutineOnDays('rt_p9_fri_a', 'Friday A', ['fri']), testRoutineOnDays('rt_p9_fri_b', 'Friday B', ['fri'])]);
    const r = await send('Delete my Friday routine');
    const rs = await routines();
    ok('P9-10: an ambiguous explicit day request deletes nothing, including not the lastRoutineRef target',
      rs.length === 3 && rs.some((x) => x.id === mondayRoutine.id) && rs.some((x) => x.id === 'rt_p9_fri_a') && rs.some((x) => x.id === 'rt_p9_fri_b'),
      rs.map((x) => x.name).join(', '));
    ok('P9-10: fails honestly, no fallback to implicit lastRoutineRef context', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-11: P1's bare-pronoun/lastRoutineRef path is untouched — "Delete
    // it" carries no day at all, so none of this fix's day logic engages.
    await clearRoutines();
    await send('Create a Sunday shoulders routine');
    const created = (await routines()).find((x) => (x.trainingDays || []).includes('sun'));
    ok('P9-11: setup — a Sunday routine exists (becomes lastRoutineRef)', !!created, created && created.name);
    const r = await send('Delete it');
    const after = await routines();
    ok('P9-11: "Delete it" still resolves via lastRoutineRef, unaffected by the day-resolution fix',
      created && !after.some((x) => x.id === created.id), after.map((x) => x.name).join(', '));
    ok('P9-11: reports genuine success', /^✓ deleted/i.test(r), r);
  }
  {
    // P9-12: P7's partial-name protection remains intact — no weekday
    // present, so resolution proceeds through the name-only branch exactly
    // as before this fix.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p9_c1', 'Chest & Triceps'), testRoutine('rt_p9_c2', 'Triceps Focus')]);
    const r = await send('Delete the triceps routine');
    const rs = await routines();
    ok('P9-12: P7\'s partial-name protection remains intact (no day present, name-only path)',
      rs.length === 2 && rs.some((x) => x.id === 'rt_p9_c1') && rs.some((x) => x.id === 'rt_p9_c2'), rs.map((x) => x.name).join(', '));
    ok('P9-12: fails honestly, no false success', /not sure which routine/i.test(r) && !/^✓/.test(r), r);
  }
  {
    // P9-13: P8's exact-name-only (no day at all) deletion remains intact.
    await clearRoutines();
    await seedRoutines([testRoutine('rt_p9_legs4', 'Legs'), testRoutine('rt_p9_upper4', 'Upper Body')]);
    const r = await send('Delete the Legs routine');
    const rs = await routines();
    ok('P9-13: P8\'s exact-name-only deletion (no day present) remains intact',
      !rs.some((x) => x.id === 'rt_p9_legs4') && rs.some((x) => x.id === 'rt_p9_upper4'), rs.map((x) => x.name).join(', '));
    ok('P9-13: reports genuine success', /^✓ deleted/i.test(r), r);
  }
  await clearRoutines();

  // ══════════════════════════════════════════════════════════════════════
  // SECTION C — natural-language variants (item 3's adversarial list)
  // ══════════════════════════════════════════════════════════════════════
  await clearRoutines();

  {
    const r = await send('Create me a 3 day gym routine.');
    ok('C1: fully vague create asks instead of inventing a split', /focus|split/i.test(r), r);
  }
  {
    const r = await send('Make me a Monday Wednesday Friday routine.');
    ok('C2: days named but no focus — asks instead of guessing content', /focus|split/i.test(r), r);
  }
  {
    await send('Build me a push pull legs routine.');
    const rs = await routines();
    const names = rs.map(r => r.name.toLowerCase());
    ok('C3: named split creates Push/Pull/Legs as 3 real routines', rs.length === 3 && names.includes('push') && names.includes('pull') && names.includes('legs'), names.join(', '));
    ok('C3: "push" was not swallowed by the incidental "legs" keyword match', names.includes('push') && names.includes('pull'));
  }
  await clearRoutines();
  {
    await send('Create a chest and triceps workout for Monday.');
    const rs = await routines();
    const mon = rs.find(r => (r.trainingDays || []).includes('mon'));
    ok('C4: single day + focus creates one grounded routine', !!mon && mon.exercises.length >= 3, mon && mon.exercises.map(e => e.name).join(', '));
  }

  // ══════════════════════════════════════════════════════════════════════
  // SECTION D — today-grounded read (gym_today with a real routine)
  // ══════════════════════════════════════════════════════════════════════
  await clearRoutines();
  await send('Create a chest and triceps workout for ' + { sun:'Sunday',mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday' }[TODAY_CODE] + '.');
  {
    const r = await send('What exercises are in today\'s workout?');
    ok('D1: exercise-detail question lists real exercises, not just the routine name', /chest|triceps|press|push|skull|extension/i.test(r), r);
  }

  await page.screenshot({ path: path.join(ROOT, 'tools/smoke/shenlong-parser-smoke.png'), fullPage: true });

  // ══════════════════════════════════════════════════════════════════════
  // SECTION E — SHENLONG P2 (2026-09-10): auth-readiness gating for
  // greet()'s (and narrative-dashboard.js's run()'s) user-scoped context
  // reads. js/auth/main.js is NOT actually blocked in this harness — only
  // the classic (non-module) <script src=".../@supabase/..."> CDN tag is,
  // so window.supabase stays undefined but main.js's own module script
  // still runs. It hits its documented "local-only fallback" branch
  // (`if (!window.supabase || ...) resolveReady();`) and resolves
  // window.APP_AUTH_READY immediately — which is exactly why every test
  // above passes without any real auth. A first attempt at these tests set
  // window.APP_AUTH_READY to a pending mock via addInitScript, only to
  // have main.js's own fallback silently REASSIGN it to a fresh, already-
  // resolved promise moments later (confirmed via a Promise.race probe).
  // Fixed by pinning the property with a getter/setter that ignores any
  // reassignment, so the mock survives main.js's own local-only-mode
  // write. Each scenario also installs Playwright's virtual clock
  // (deterministic control over the 6000/6500ms safety-nets — no real
  // waiting) to prove the actual invariant: a stale, pre-reconciliation
  // localStorage value must never reach a rendered greeting, regardless
  // of trigger ordering.
  // ══════════════════════════════════════════════════════════════════════
  async function seedOpenSession(pg, setCount) {
    await pg.evaluate((n) => {
      localStorage.setItem('po_coach_v1', JSON.stringify({ sessions: [{ endedAt: null, sets: Array.from({ length: n }, () => ({})) }] }));
    }, setCount);
  }
  async function resolvePendingAuth(pg) {
    await pg.evaluate(() => { if (window.__p2ResolveAuth) window.__p2ResolveAuth(); });
  }
  const STALE_SETS = 1;   // "1 set logged" — pre-reconciliation account
  const CURRENT_SETS = 7; // "7 sets logged" — post-reconciliation account

  // Both the pending-auth Promise AND the stale marker MUST exist before
  // the page's own scripts run at all — a first attempt at these tests set
  // both via a post-load page.evaluate() and found the real page's own
  // boot sequence had already raced ahead: with window.APP_AUTH_READY
  // still genuinely undefined at that instant, Calendar's getClient()
  // resolved immediately, the network-blocked fetch failed near-instantly,
  // and apt:calendar-loaded fired — completing greet() — before the
  // Playwright round-trip installing the override could land. addInitScript
  // runs before ANY page script, closing that gap entirely.
  async function newGatedPage(setCount) {
    const pg = await ctx.newPage();
    await pg.addInitScript((n) => {
      let mockResolve;
      const mockReady = new Promise((r) => { mockResolve = r; });
      window.__p2ResolveAuth = mockResolve;
      Object.defineProperty(window, 'APP_AUTH_READY', {
        get() { return mockReady; },
        set() { /* ignore main.js's own local-only-mode reassignment */ },
        configurable: true,
      });
      localStorage.setItem('po_coach_v1', JSON.stringify({ sessions: [{ endedAt: null, sets: Array.from({ length: n }, () => ({})) }] }));
    }, setCount);
    await pg.clock.install();
    return pg;
  }

  {
    const p2 = await newGatedPage(STALE_SETS);
    await p2.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 15000 });
    await p2.waitForSelector('#aiForm', { timeout: 10000 });

    // P2-1: fast-forward past the 6s safety net with auth still pending —
    // must not read the (stale) context yet at all.
    await p2.clock.runFor(6001);
    const briefCountPending = await p2.evaluate(() => document.querySelectorAll('.aios-brief').length);
    ok('P2-1: 6s safety-net does not read/render user-scoped context while auth is still pending',
      briefCountPending === 0, 'brief count after 6s with pending auth: ' + briefCountPending);

    // P2-2: simulate reconciliation (the value a real reconcileUserScope()
    // pass would leave behind) BEFORE resolving auth, then resolve. The
    // already-in-flight greet() call (paused at its own await, not a new
    // invocation) must proceed using the value present AT RESOLUTION time.
    await seedOpenSession(p2, CURRENT_SETS);
    await resolvePendingAuth(p2);
    await p2.waitForFunction(() => document.querySelectorAll('.aios-brief').length > 0, null, { timeout: 5000 });
    const brief2 = await p2.evaluate(() => { const b = document.querySelector('.aios-brief'); return b ? b.textContent : null; });
    ok('P2-2: rendered brief reflects CURRENT (post-reconciliation) data, never the stale value',
      new RegExp(CURRENT_SETS + ' sets logged').test(brief2) && !new RegExp(STALE_SETS + ' set logged').test(brief2), brief2);
    ok('P2-2/P2-6: exactly one brief, no duplicate',
      (await p2.evaluate(() => document.querySelectorAll('.aios-brief').length)) === 1);

    // P2-6 (explicit): a later, redundant apt:calendar-loaded (greeted is
    // already true) must be a genuine no-op, not a second brief.
    await p2.evaluate(() => window.dispatchEvent(new CustomEvent('apt:calendar-loaded')));
    await p2.waitForTimeout(50);
    ok('P2-6: a later apt:calendar-loaded does not produce a duplicate greeting',
      (await p2.evaluate(() => document.querySelectorAll('.aios-brief').length)) === 1);
    await p2.close();
  }

  {
    // P2-4: adversarial ordering — force apt:calendar-loaded to fire
    // BEFORE auth resolves at all. The real app's own structure should
    // make this impossible (loadEvents() always awaits AptCal's own
    // getClient(), which awaits the same APP_AUTH_READY first) — but
    // greet()'s own gate must independently hold even if that structural
    // guarantee were ever bypassed elsewhere. {once:true} still consumes
    // the listener on this dispatch; the assertion is that the resulting
    // (already-invoked, now-paused) greet() call still doesn't read stale
    // context until its own await resolves.
    const p2b = await newGatedPage(STALE_SETS);
    await p2b.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 15000 });
    await p2b.waitForSelector('#aiForm', { timeout: 10000 });

    await p2b.evaluate(() => window.dispatchEvent(new CustomEvent('apt:calendar-loaded')));
    await p2b.waitForTimeout(50);
    const briefCountEarly = await p2b.evaluate(() => document.querySelectorAll('.aios-brief').length);
    ok('P2-4: an early apt:calendar-loaded (before auth-ready) still does not read stale context',
      briefCountEarly === 0, 'brief count: ' + briefCountEarly);

    await seedOpenSession(p2b, CURRENT_SETS);
    await resolvePendingAuth(p2b);
    await p2b.waitForFunction(() => document.querySelectorAll('.aios-brief').length > 0, null, { timeout: 5000 });
    const brief4 = await p2b.evaluate(() => { const b = document.querySelector('.aios-brief'); return b ? b.textContent : null; });
    ok('P2-4: once auth resolves, the same already-invoked greet() call proceeds with CURRENT data',
      new RegExp(CURRENT_SETS + ' sets logged').test(brief4) && !new RegExp(STALE_SETS + ' set logged').test(brief4), brief4);
    await p2b.close();
  }

  // P2-3/P2-5 (auth-ready before/at the time of calendar-loaded — the
  // normal, common-case ordering): not a separate dedicated test — every
  // one of the 93 checks above already exercises exactly this path (the
  // main `page`'s own boot: APP_AUTH_READY undefined → resolves
  // immediately → calendar-loaded fires shortly after via the
  // network-blocked catch path) and all passed, which already proves
  // greet() completes correctly, exactly once, with no hang, under this
  // ordering. A separate dedicated test here would be redundant.
  // P2-7: existing suite regression — proven by this run's own 93/93 above.

  {
    // Narrative Dashboard parity (Phase 5): js/narrative-dashboard.js's
    // run() reads the exact same todayGymSummary() shape via the exact
    // same dual-trigger (apt:calendar-loaded / setTimeout(start, 6500))
    // pattern, and received the identical one-line fix. One pair of
    // checks proves the same invariant holds there — not a full re-
    // derivation of P2-1..P2-6, since the underlying mechanism is already
    // proven correct above and this file received a byte-for-byte
    // equivalent change.
    const p3 = await newGatedPage(STALE_SETS);
    await p3.goto(`http://localhost:${PORT}/index.html?narrative=1`, { waitUntil: 'load', timeout: 15000 });
    await p3.waitForSelector('#narrStory', { timeout: 10000 });

    await p3.clock.runFor(6501);
    const storyDuring = await p3.evaluate(() => document.getElementById('narrStory').textContent);
    ok('P2-N1: narrative-dashboard\'s 6.5s safety-net does not read stale context while auth is pending',
      !new RegExp(STALE_SETS + ' set logged').test(storyDuring), storyDuring);

    await seedOpenSession(p3, CURRENT_SETS);
    await resolvePendingAuth(p3);
    await p3.waitForFunction((n) => new RegExp(n + ' sets logged').test(document.getElementById('narrStory').textContent), CURRENT_SETS, { timeout: 5000 });
    const storyAfter = await p3.evaluate(() => document.getElementById('narrStory').textContent);
    ok('P2-N2: narrative-dashboard renders the CURRENT (post-reconciliation) session once auth resolves',
      new RegExp(CURRENT_SETS + ' sets logged').test(storyAfter) && !new RegExp(STALE_SETS + ' set logged').test(storyAfter), storyAfter);
    await p3.close();
  }

  // ══════════════════════════════════════════════════════════════════════
  // SHENLONG P6 (2026-09-13): closes a test-coverage gap found by the P5
  // investigation. P2-N1/P2-N2 above deliberately seed an OPEN workout
  // session, so they only ever exercise run()'s early-return branch (line
  // ~168 of narrative-dashboard.js) — none of the committed suite ever
  // reached the real synthesis path:
  //   narrative-dashboard.run() -> window.__synthesizeBrief(narrativeSignals, hasEvents)
  // This wraps the REAL window.__synthesizeBrief (never replacing its
  // implementation — the wrapper calls straight through to the original and
  // returns its result unchanged) to prove that exact call site is reached,
  // with workoutInProgress genuinely false and a real signal selected.
  // ══════════════════════════════════════════════════════════════════════
  async function seedCompletedGymSession(pg, label) {
    // Deliberately NOT the P2 open-session fixture — endedAt is set, so
    // todayGymSummary().workoutInProgress is false, and recentGymSession()
    // sees a real same-day completed session (daysAgo === 0), which
    // computeGymSignals() turns into a genuine 'trained_today' signal.
    await pg.evaluate((lbl) => {
      localStorage.setItem('po_coach_v1', JSON.stringify({
        sessions: [{ endedAt: new Date().toISOString(), label: lbl, sets: [{ weight: 100, reps: 8 }] }],
      }));
    }, label);
  }
  async function installBridgeSpy(pg) {
    await pg.evaluate(() => {
      const original = window.__synthesizeBrief;
      window.__p6BridgeCalls = [];
      window.__synthesizeBrief = async function (...args) {
        window.__p6BridgeCalls.push({
          argCount: args.length,
          signalsIsArray: Array.isArray(args[0]),
          signalsSnapshot: JSON.parse(JSON.stringify(args[0] || [])),
          hasEventsType: typeof args[1],
        });
        return original.apply(this, args);
      };
    });
  }

  {
    const p6 = await newGatedPage(0); // its open-session seed is irrelevant — overwritten below before auth resolves
    await p6.goto(`http://localhost:${PORT}/index.html?narrative=1`, { waitUntil: 'load', timeout: 15000 });
    await p6.waitForSelector('#narrStory', { timeout: 10000 });
    await installBridgeSpy(p6);
    await seedCompletedGymSession(p6, 'Push Day');

    // Fire narrative-dashboard's own 6.5s safety-net while auth is still
    // pending — run() must reach its auth await and stop there, never
    // calling the bridge yet (mirrors P2-N1's invariant, applied here to
    // the synthesis path instead of the early-return path).
    await p6.clock.runFor(6501);
    const callsWhilePending = await p6.evaluate(() => window.__p6BridgeCalls.length);
    ok('P6-1: the bridge is not called while auth is still pending', callsWhilePending === 0, 'calls: ' + callsWhilePending);

    await resolvePendingAuth(p6);
    await p6.waitForFunction(() => window.__p6BridgeCalls && window.__p6BridgeCalls.length > 0, null, { timeout: 5000 });

    const calls = await p6.evaluate(() => window.__p6BridgeCalls);
    const story = await p6.evaluate(() => document.getElementById('narrStory').textContent);
    const workoutInProgress = await p6.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('po_coach_v1')).sessions.some((s) => !s.endedAt); }
      catch (e) { return null; }
    });

    ok('P6-2: workoutInProgress was genuinely false for this run (proves the synthesis path ran, not the early-return path)',
      workoutInProgress === false);
    ok('P6-3: narrative-dashboard.run() reached the real window.__synthesizeBrief bridge exactly once',
      calls.length === 1, JSON.stringify(calls));
    ok('P6-4: the bridge received an array as its first argument',
      calls[0] && calls[0].signalsIsArray, JSON.stringify(calls[0]));
    ok('P6-5: at least one selected signal is a plausible signal object (tier/domain/key/fact)',
      calls[0] && Array.isArray(calls[0].signalsSnapshot) && calls[0].signalsSnapshot.length > 0 &&
      calls[0].signalsSnapshot.every((s) => s && typeof s.tier === 'number' && typeof s.domain === 'string' && typeof s.key === 'string' && typeof s.fact === 'string'),
      JSON.stringify(calls[0] && calls[0].signalsSnapshot));
    ok('P6-6: the selected signals include the seeded "trained today" gym fact',
      calls[0] && calls[0].signalsSnapshot.some((s) => s.key === 'trained_today'), JSON.stringify(calls[0] && calls[0].signalsSnapshot));
    ok('P6-7: the bridge received hasEvents as a boolean second argument',
      calls[0] && calls[0].hasEventsType === 'boolean', calls[0] && calls[0].hasEventsType);
    ok('P6-8: the final #narrStory text is non-empty', typeof story === 'string' && story.trim().length > 0, story);
    ok('P6-9: the final story is not the "still loading" placeholder', !/your day is still loading/i.test(story), story);

    await p6.close();
  }

  // ══════════════════════════════════════════════════════════════════════
  // SECTION P10a — applySetSets() day-scoped resolution hardening
  // ══════════════════════════════════════════════════════════════════════
  // P10 investigation proved three defects in applySetSets()'s explicit-day
  // branch (it resolved op.day via findRoutineByDay() against the FULL
  // routine list, independent of `hits` — the exercise-containing routines):
  //   1. a day match outside `hits` made `hits.find(...)` return undefined,
  //      and the next line's `hit.e.sets` access threw a TypeError;
  //   2. a day matching zero routines fell through to lastRoutineRef/
  //      uniqueRoutines, silently mutating a routine on the WRONG day;
  //   3. a day matching 2+ hit-routines picked the first by array order,
  //      bypassing the ambiguity check — the same bug class P9 already
  //      fixed for deletion.
  // P10a scopes op.day resolution exclusively to `hits`. These tests seed
  // rb_routines_v1 directly (stable synthetic ids, exact array order,
  // multi-day arrays) rather than building routines via chat — the chat
  // parser can't reliably produce the precise fixtures these cases need.
  // Assertions read stored routine state directly, never response text
  // alone (response text is also checked as a secondary signal).
  {
    const benchId = await page.evaluate(async () => {
      const catalog = await window.Shelron.Routines.loadCatalog();
      const m = window.Shelron.Routines.matchExercise('bench press', catalog);
      return m ? m.id : 'barbell_bench_press';
    });
    const squatId = await page.evaluate(async () => {
      const catalog = await window.Shelron.Routines.loadCatalog();
      const m = window.Shelron.Routines.matchExercise('squat', catalog);
      return m ? m.id : 'squat';
    });
    const mkEx = (name, exId, sets) => ({ exId, name, muscleGroup: 'chest', sets: Array.from({ length: sets }, () => ({ weight: 0, reps: 10 })), restEnabled: true, rest: 90 });
    const mkRoutine = (id, name, trainingDays, exercises) => ({ id, name, exercises, restEnabled: true, rest: 90, goal: null, trainingDays, updated_at: new Date().toISOString() });
    const bench = (exId, sets) => mkEx('Barbell Bench Press', exId, sets);

    // P10a-1: day-matching routine exists but does NOT have the exercise;
    // a different-day routine does. Structural crash reproduction — before
    // the fix this threw inside apply() (caught by index.js's generic
    // try/catch as "Something went wrong handling that.").
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10a-1-fri', 'Upper Body', ['fri'], [mkEx('Squat', squatId, 3)]),
        mkRoutine('p10a-1-mon', 'Push Day', ['mon'], [bench(benchId, 3)]),
      ]);
      const before = await routines();
      const r = await send('Change bench press to 4 sets on friday');
      const after = await routines();
      // No try/catch wraps send() itself — if applySetSets threw (the
      // pre-fix TypeError), index.js's own handle()-level try/catch still
      // produces SOME reply ("Something went wrong handling that."), so
      // send() resolving at all here already proves no page-level crash
      // reached Playwright. The real proof this is now a clean, HONEST
      // failure (not a caught crash) is the specific message below.
      ok('P10a-1: no success response (the day-named routine has no Bench Press)', !/^✓/.test(r), r);
      ok('P10a-1: an honest "not found" reply, not the generic caught-exception message', !/something went wrong/i.test(r), r);
      ok('P10a-1: neither routine is mutated', JSON.stringify(before) === JSON.stringify(after), r);
    }

    // P10a-2: explicit day matches ZERO routines at all; the exercise is
    // unique on a different day. Must not silently drop the day constraint
    // and fall back to the unique-hit routine.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10a-2-mon', 'Push Day', ['mon'], [bench(benchId, 3)])]);
      const before = await routines();
      const r = await send('Change bench press to 4 sets on friday');
      const after = await routines();
      ok('P10a-2: the only (Monday) routine remains unchanged', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10a-2: no success response — the explicit Friday constraint was not dropped', !/^✓/.test(r), r);
    }

    // P10a-2b: same shape as P10a-2, but lastRoutineRef is deliberately
    // pointed at the Monday routine first (via a prior successful no-day
    // set_sets call) — proves an explicit day never consults lastRoutineRef,
    // even when it points at a routine that DOES have the exercise.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10a-2b-mon', 'Push Day', ['mon'], [bench(benchId, 3)])]);
      await send('Change bench press to 3 sets'); // no day — uniquely resolves, sets lastRoutineRef
      const midway = await routines();
      ok('P10a-2b: setup — lastRoutineRef now points at the Monday routine', midway[0].exercises[0].sets.length === 3, midway);
      const r = await send('Change bench press to 4 sets on friday');
      const after = await routines();
      ok('P10a-2b: an explicit (unmatched) day is not overridden by lastRoutineRef', JSON.stringify(midway) === JSON.stringify(after), r);
    }

    // P10a-3 / P10a-4: two Friday routines, BOTH contain Bench Press —
    // genuine ambiguity. Run in both array orders to prove the outcome is
    // no longer array-order-dependent (both must ask, neither must mutate).
    for (const [label, order] of [['P10a-3', 'A-first'], ['P10a-4', 'B-first']]) {
      await clearRoutines(); await forgetLastRoutine();
      const rA = mkRoutine('p10a-34-a', 'Push A', ['fri'], [bench(benchId, 3)]);
      const rB = mkRoutine('p10a-34-b', 'Push B', ['fri'], [bench(benchId, 3)]);
      await setRoutines(order === 'A-first' ? [rA, rB] : [rB, rA]);
      const before = await routines();
      const r = await send('Change bench press to 5 sets on friday');
      const after = await routines();
      ok(`${label} (${order}): neither Friday routine is modified`, JSON.stringify(before) === JSON.stringify(after), r);
      ok(`${label} (${order}): ambiguity is reported, not a silent pick`, /more than one routine|which one/i.test(r), r);
    }

    // P10a-5: two Friday routines, only ONE contains Bench Press — must
    // resolve unambiguously to that one; the other stays untouched.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10a-5-a', 'Upper Body', ['fri'], [mkEx('Squat', squatId, 3)]),
        mkRoutine('p10a-5-b', 'Push Day', ['fri'], [bench(benchId, 3)]),
      ]);
      const r = await send('Change bench press to 4 sets on friday');
      const after = await routines();
      const a = after.find(x => x.id === 'p10a-5-a');
      const b = after.find(x => x.id === 'p10a-5-b');
      ok('P10a-5: the routine containing Bench Press is modified', b.exercises[0].sets.length === 4, r);
      ok('P10a-5: the other Friday routine (no Bench Press) is untouched', a.exercises[0].sets.length === 3, JSON.stringify(a));
    }

    // P10a-6: two Friday routines with Bench Press + an unrelated Monday
    // routine that also has it — ambiguity must stay SCOPED to Friday;
    // Monday must never be considered or touched.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10a-6-a', 'Push A', ['fri'], [bench(benchId, 3)]),
        mkRoutine('p10a-6-b', 'Push B', ['fri'], [bench(benchId, 3)]),
        mkRoutine('p10a-6-mon', 'Push Mon', ['mon'], [bench(benchId, 3)]),
      ]);
      const before = await routines();
      const r = await send('Change bench press to 5 sets on friday');
      const after = await routines();
      ok('P10a-6: no mutation occurs anywhere, including Monday', JSON.stringify(before) === JSON.stringify(after), r);
      const cands = (r.match(/\(([^)]+)\)/) || [])[1] || '';
      ok('P10a-6: ambiguity candidates are Friday-only (Push Mon not listed)', /push a/i.test(cands) && /push b/i.test(cands) && !/push mon/i.test(cands), r);
    }

    // P10a-7: a multi-day routine ([mon, fri]) with Bench Press, plus a
    // second Friday-only routine with Bench Press — both are legitimate
    // Friday candidates, so this is ambiguous too.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10a-7-multi', 'Push Multi', ['mon', 'fri'], [bench(benchId, 3)]),
        mkRoutine('p10a-7-fri', 'Push Fri', ['fri'], [bench(benchId, 3)]),
      ]);
      const before = await routines();
      const r = await send('Change bench press to 5 sets on friday');
      const after = await routines();
      ok('P10a-7: neither the multi-day nor the Friday-only routine is modified', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10a-7: ambiguity is reported', /more than one routine|which one/i.test(r), r);
    }

    // P10a-8: the day-matched routine contains the SAME exercise twice —
    // must still be treated as ONE routine candidate (not two), and the
    // existing "first entry wins" set-count behavior is unaffected by the
    // day-scoping change.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10a-8-fri', 'Push Day', ['fri'], [bench(benchId, 3), bench(benchId, 6)]),
      ]);
      const r = await send('Change bench press to 4 sets on friday');
      const rs = await routines();
      ok('P10a-8: resolves unambiguously (one routine, not treated as 2 candidates)', /^✓/.test(r), r);
      ok('P10a-8: still exactly one routine, with both original exercise entries intact', rs.length === 1 && rs[0].exercises.length === 2, JSON.stringify(rs));
      ok('P10a-8: the first (matched) entry now has the new count', rs[0].exercises[0].sets.length === 4, JSON.stringify(rs[0].exercises));
      ok('P10a-8: the second entry is untouched (existing first-match behavior, unaffected by day-scoping)', rs[0].exercises[1].sets.length === 6, JSON.stringify(rs[0].exercises));
    }

    // P10a-9: existing NO-DAY ambiguity regression (pre-existing B4b
    // behavior) remains intact — two routines with Bench Press, no day
    // named, no recency signal: must still ask and mutate neither.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10a-9-a', 'Routine A', ['tue'], [bench(benchId, 3)]),
        mkRoutine('p10a-9-b', 'Routine B', ['thu'], [bench(benchId, 3)]),
      ]);
      const before = await routines();
      const r = await send('Change bench press to 5 sets');
      const after = await routines();
      ok('P10a-9: no-day ambiguity regression — neither routine mutates', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10a-9: no-day ambiguity regression — still asks which one', /more than one routine|which one/i.test(r), r);
    }

    // P10a-10: existing lastRoutineRef behavior WITHOUT an explicit day
    // remains intact — the exercise is unique to the last-touched routine's
    // context is irrelevant here since uniqueRoutines already resolves it;
    // this proves lastRoutineRef still disambiguates a genuinely-split
    // exercise when no day is given (the no-day branch is untouched code,
    // this is a regression check on that untouched path).
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10a-10-a', 'Routine A', ['tue'], [bench(benchId, 3)]),
        mkRoutine('p10a-10-b', 'Routine B', ['thu'], [bench(benchId, 3)]),
      ]);
      await send('Remove bench press from tuesday'); // Routine A is the sole Tuesday routine — unambiguous day-scoped remove, establishes it as lastRoutineRef via remove_exercise's own remember()
      const r = await send('Change bench press to 5 sets'); // no day — only Routine B still has it, resolves via uniqueRoutines (lastRoutineRef points at A, which no longer has it)
      const after = await routines();
      const b = after.find(x => x.id === 'p10a-10-b');
      ok('P10a-10: lastRoutineRef path (no day) still works — unique remaining hit resolves correctly', b.exercises[0].sets.length === 5, JSON.stringify(after));
    }

    await clearRoutines(); await forgetLastRoutine();
  }

  // ══════════════════════════════════════════════════════════════════════
  // SECTION P10b — applyAddExercise() day-scoped resolution hardening
  // ══════════════════════════════════════════════════════════════════════
  // P10b investigation proved applyAddExercise() had NO ambiguity guard at
  // all on its explicit-day path (resolveTargetRoutine() → findRoutineByDay()
  // is a bare first-match Array.find()): 2+ routines sharing a day silently
  // received the exercise on whichever was first in array order, reachable
  // through the real Gym app's own routine-creation flow (no cross-routine
  // day-uniqueness check there). The fix is local to applyAddExercise() —
  // resolveTargetRoutine() and applyRemoveExercise() (which shares it) are
  // deliberately untouched; that caller's own independently-reachable day
  // ambiguity is a separate follow-up, not fixed here. As with P10a, these
  // tests seed rb_routines_v1 directly (stable ids, exact array order,
  // multi-day arrays) and assert on stored state, not response text alone.
  {
    const benchId = await page.evaluate(async () => {
      const catalog = await window.Shelron.Routines.loadCatalog();
      const m = window.Shelron.Routines.matchExercise('bench press', catalog);
      return m ? m.id : 'barbell_bench_press';
    });
    const squatId = await page.evaluate(async () => {
      const catalog = await window.Shelron.Routines.loadCatalog();
      const m = window.Shelron.Routines.matchExercise('squat', catalog);
      return m ? m.id : 'squat';
    });
    const mkEx = (name, exId, sets) => ({ exId, name, muscleGroup: 'chest', sets: Array.from({ length: sets }, () => ({ weight: 0, reps: 10 })), restEnabled: true, rest: 90 });
    const mkRoutine = (id, name, trainingDays, exercises) => ({ id, name, exercises, restEnabled: true, rest: 90, goal: null, trainingDays, updated_at: new Date().toISOString() });
    const bench = (exId) => mkEx('Barbell Bench Press', exId, 3);

    // P10b-1: unique day — single Friday routine — must succeed and mutate
    // exactly that routine.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10b-1', 'Push Day', ['fri'], [])]);
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-1: succeeds', /^✓/.test(r), r);
      ok('P10b-1: exactly that routine receives Bench Press', after[0].exercises.some(e => e.exId === benchId), JSON.stringify(after));
    }

    // P10b-2: two same-day routines — no mutation, no success, honest
    // ambiguity (routine-authoring.js's new 'ambiguous_day' reason, rendered
    // via js/index.js's existing generic add_exercise fallback message).
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-2-a', 'Upper Body', ['fri'], []),
        mkRoutine('p10b-2-b', 'Push Day', ['fri'], []),
      ]);
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-2: no mutation', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10b-2: no success response', !/^✓/.test(r), r);
      ok('P10b-2: an honest ambiguity response, not a false "not found"', /not sure which routine/i.test(r), r);
    }

    // P10b-3: reversed array order — identical safe outcome, proving array
    // order is now irrelevant.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-3-b', 'Push Day', ['fri'], []),
        mkRoutine('p10b-3-a', 'Upper Body', ['fri'], []),
      ]);
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-3: reversed order — no mutation', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10b-3: reversed order — no success response', !/^✓/.test(r), r);
    }

    // P10b-4: three same-day routines — no hardcoded 2-candidate assumption.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-4-a', 'Friday One', ['fri'], []),
        mkRoutine('p10b-4-b', 'Friday Two', ['fri'], []),
        mkRoutine('p10b-4-c', 'Friday Three', ['fri'], []),
      ]);
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-4: three same-day routines — no mutation', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10b-4: three same-day routines — ambiguity reported', /not sure which routine/i.test(r), r);
    }

    // P10b-5: a multi-day routine ([mon,fri]) plus a Friday-only routine —
    // both are legitimate Friday candidates, so this is ambiguous too.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-5-multi', 'Full Body', ['mon', 'fri'], []),
        mkRoutine('p10b-5-fri', 'Push Day', ['fri'], []),
      ]);
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-5: multi-day + Friday-only — no mutation', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10b-5: multi-day + Friday-only — ambiguity reported', /not sure which routine/i.test(r), r);
    }

    // P10b-6: zero matching day — existing no_routine_for_day failure is
    // preserved unchanged; the Monday routine is untouched.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10b-6-mon', 'Push Day', ['mon'], [])]);
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-6: no mutation', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10b-6: existing no_routine_for_day message preserved', /don.t have a routine scheduled for friday/i.test(r), r);
    }

    // P10b-7a: lastRoutineRef points at Monday; an explicit, unambiguous
    // Friday match must still win — day is authoritative over lastRoutineRef
    // even when lastRoutineRef resolves successfully to a DIFFERENT routine.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-7a-mon', 'Push Day', ['mon'], []),
        mkRoutine('p10b-7a-fri', 'Upper Body', ['fri'], []),
      ]);
      await send('Add shoulder press to Monday'); // establishes lastRoutineRef = Monday routine
      const midway = await routines();
      ok('P10b-7a: setup — lastRoutineRef now points at Monday', midway.find(x => x.id === 'p10b-7a-mon').exercises.some(e => /shoulder press/i.test(e.name)), midway);
      const r = await send('Add bench press to friday');
      const after = await routines();
      const mon = after.find(x => x.id === 'p10b-7a-mon');
      const fri = after.find(x => x.id === 'p10b-7a-fri');
      ok('P10b-7a: the Friday routine is selected', fri.exercises.some(e => e.exId === benchId), JSON.stringify(fri));
      ok('P10b-7a: Monday (lastRoutineRef) is NOT selected', !mon.exercises.some(e => e.exId === benchId), JSON.stringify(mon));
    }

    // P10b-7b: stronger variant — no Friday routine exists at all,
    // lastRoutineRef points at Monday. Must NOT fall back to Monday.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10b-7b-mon', 'Push Day', ['mon'], [])]);
      await send('Add shoulder press to Monday'); // establishes lastRoutineRef = Monday routine
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-7b: no mutation — no fallback to lastRoutineRef when the day matches nothing', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10b-7b: honest no_routine_for_day, not a silent Monday success', !/^✓/.test(r) && /don.t have a routine scheduled for friday/i.test(r), r);
    }

    // P10b-8: existing already-present behavior preserved — one Friday
    // routine (unique for that day), already contains Bench Press.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10b-8', 'Push Day', ['fri'], [bench(benchId)])]);
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-8: no duplicate exercise added', after[0].exercises.length === before[0].exercises.length, JSON.stringify(after));
      ok('P10b-8: existing already-present response preserved', /already in/i.test(r), r);
      ok('P10b-8: routine count and exercise count unchanged', after.length === 1 && after[0].exercises.length === 1, JSON.stringify(after));
    }

    // P10b-9: no-day behavior preserved — untouched code path. Verifies
    // lastRoutineRef still resolves the target when no day is given.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-9-a', 'Routine A', ['tue'], []),
        mkRoutine('p10b-9-b', 'Routine B', ['thu'], []),
      ]);
      await send('Add shoulder press to tuesday'); // establishes lastRoutineRef via the untouched day-1-candidate path
      const r = await send('Add bench press'); // no day at all — must resolve via lastRoutineRef (existing, untouched behavior)
      const after = await routines();
      const a = after.find(x => x.id === 'p10b-9-a');
      const b = after.find(x => x.id === 'p10b-9-b');
      ok('P10b-9: no-day add resolves via the existing (untouched) lastRoutineRef path', a.exercises.some(e => e.exId === benchId), JSON.stringify(a));
      ok('P10b-9: the other routine is untouched', !b.exercises.some(e => e.exId === benchId), JSON.stringify(b));
    }

    // P10b-10: same-day ambiguity with DIFFERING unrelated exercise content
    // in each routine — neither sibling is partially mutated.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-10-a', 'Upper Body', ['fri'], [mkEx('Squat', squatId, 3)]),
        mkRoutine('p10b-10-b', 'Push Day', ['fri'], [mkEx('Squat', squatId, 5)]), // different set count — proves no partial/wrong-object mutation either
      ]);
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-10: neither routine changes at all', JSON.stringify(before) === JSON.stringify(after), r);
    }

    // P10b-11: a phrase that LOOKS like it names a routine must NOT act as
    // newly-supported disambiguation grammar — parseAddOrRemove() still
    // only extracts {exerciseQuery, day}, so with 2 Friday routines this
    // must remain ambiguous exactly like P10b-2, not silently resolve to
    // "Push Day" because the text happened to say so.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-11-a', 'Upper Body', ['fri'], []),
        mkRoutine('p10b-11-b', 'Push Day', ['fri'], []),
      ]);
      const before = await routines();
      const r = await send('Add bench press to my Push Day routine on friday');
      const after = await routines();
      ok('P10b-11: the named text does not disambiguate — still no mutation', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10b-11: still an honest ambiguity response, not a name-resolved success', !/^✓/.test(r) && /not sure which routine/i.test(r), r);
    }

    // P10b-12: same-day ambiguity where one candidate already has the
    // exercise and the other doesn't. EXPECTED (per the actual
    // implementation, documented before asserting): add_exercise's day
    // candidates are computed purely from `trainingDays` membership,
    // independent of exercise content — the already_present check only
    // ever runs AFTER a single unique target is resolved (routine-
    // authoring.js:676, unchanged by this fix). So this must resolve
    // exactly like P10b-2 (ambiguous, no mutation) — the exercise already
    // existing in ONE candidate must NOT make that candidate the unique
    // target, and must NOT be silently treated as an idempotent no-op.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10b-12-a', 'Upper Body', ['fri'], [bench(benchId)]), // already has it
        mkRoutine('p10b-12-b', 'Push Day', ['fri'], []),                  // does not
      ]);
      const before = await routines();
      const r = await send('Add bench press to friday');
      const after = await routines();
      ok('P10b-12: neither "already present" state nor "missing" state breaks day-based ambiguity — no mutation', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10b-12: reports ambiguity, not "already in" and not success', !/already in/i.test(r) && !/^✓/.test(r) && /not sure which routine/i.test(r), r);
    }

    await clearRoutines(); await forgetLastRoutine();
  }

  // ══════════════════════════════════════════════════════════════════════
  // SECTION P10c — applyRemoveExercise() day-scoped resolution hardening
  // ══════════════════════════════════════════════════════════════════════
  // P10c investigation proved applyRemoveExercise() compounded the P10b-era
  // findRoutineByDay() first-match defect with its OWN extra fallback
  // (`targets = r ? [r] : routines`): when an explicit day matched zero
  // routines, the day constraint was silently dropped and EVERY routine in
  // the app became a candidate — proven live to silently remove an
  // exercise from an unrelated, different-day routine while reporting full
  // success. 2+ same-day routines also picked the array-first one
  // regardless of exercise content, producing either a wrong-routine
  // removal or a false "not found". The fix is local to
  // applyRemoveExercise() — resolveTargetRoutine(), applyAddExercise(),
  // applySetSets(), and applyDeleteRoutine() are all untouched; the
  // separate no-day/no-lastRoutineRef global-ambiguity behavior (CASE 7 of
  // the P10c investigation — no ambiguity check at all when neither a day
  // nor lastRoutineRef narrows the candidate set) is deliberately NOT
  // fixed here and is tested below only as an out-of-scope regression lock.
  // js/index.js's remove_exercise handler renders any `!result.ok` with a
  // single existing, reason-agnostic message — since that can't
  // distinguish 'ambiguous_day' from 'exercise_not_found' in the rendered
  // text, several tests below call window.Shelron.Routines.apply()
  // directly to verify the exact internal `reason`, not just the safe
  // absence of a mutation.
  {
    const benchId = await page.evaluate(async () => {
      const catalog = await window.Shelron.Routines.loadCatalog();
      const m = window.Shelron.Routines.matchExercise('bench press', catalog);
      return m ? m.id : 'barbell_bench_press';
    });
    // Only needed below by P10d-7/P10d-8's stale-lastRoutineRef setup (a
    // second, unrelated exercise used to establish a reference via a
    // routine that's then removed from storage entirely).
    const squatId = await page.evaluate(async () => {
      const catalog = await window.Shelron.Routines.loadCatalog();
      const m = window.Shelron.Routines.matchExercise('squat', catalog);
      return m ? m.id : 'squat';
    });
    const mkEx = (name, exId, sets) => ({ exId, name, muscleGroup: 'chest', sets: Array.from({ length: sets }, () => ({ weight: 0, reps: 10 })), restEnabled: true, rest: 90 });
    const mkRoutine = (id, name, trainingDays, exercises) => ({ id, name, exercises, restEnabled: true, rest: 90, goal: null, trainingDays, updated_at: new Date().toISOString() });
    const bench = (exId) => mkEx('Barbell Bench Press', exId, 3);
    // Calls the real apply() path directly, bypassing chat text, to read
    // the exact { ok, reason } the implementation returns.
    async function applyDirect(op) {
      return page.evaluate((op) => window.Shelron.Routines.apply({ action: 'gym_routine_op', op }), op);
    }

    // P10c-1: one matching day routine, has the exercise — successful
    // removal from that routine.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10c-1', 'Push Day', ['fri'], [bench(benchId)])]);
      const r = await send('Remove bench press from friday');
      const after = await routines();
      ok('P10c-1: succeeds', /^✓/.test(r), r);
      ok('P10c-1: the exercise is genuinely removed', !after[0].exercises.some(e => e.exId === benchId), JSON.stringify(after));
    }

    // P10c-2: two same-day routines, BOTH contain the exercise — no
    // mutation, and the exact internal reason is 'ambiguous_day'.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10c-2-a', 'Upper Body', ['fri'], [bench(benchId)]),
        mkRoutine('p10c-2-b', 'Push Day', ['fri'], [bench(benchId)]),
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press', day: 'fri' });
      const after = await routines();
      ok('P10c-2: reason is exactly ambiguous_day', result.ok === false && result.reason === 'ambiguous_day', JSON.stringify(result));
      ok('P10c-2: no mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10c-3: reversed array order — identical safe ambiguous outcome.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10c-3-b', 'Push Day', ['fri'], [bench(benchId)]),
        mkRoutine('p10c-3-a', 'Upper Body', ['fri'], [bench(benchId)]),
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press', day: 'fri' });
      const after = await routines();
      ok('P10c-3: reversed order — reason is still ambiguous_day', result.ok === false && result.reason === 'ambiguous_day', JSON.stringify(result));
      ok('P10c-3: reversed order — no mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10c-4: two same-day routines, ONLY the second (array order) contains
    // the exercise. Day ambiguity must win BEFORE exercise inspection —
    // must NOT report success, and must NOT resolve to 'exercise_not_found'
    // (which would incorrectly imply the exercise is absent everywhere,
    // when it genuinely exists in one of the two ambiguous candidates).
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10c-4-a', 'Upper Body', ['fri'], []),          // first, no bench press
        mkRoutine('p10c-4-b', 'Push Day', ['fri'], [bench(benchId)]), // second, HAS it
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press', day: 'fri' });
      const after = await routines();
      ok('P10c-4: ambiguity wins before exercise inspection — reason is ambiguous_day, not exercise_not_found', result.ok === false && result.reason === 'ambiguous_day', JSON.stringify(result));
      ok('P10c-4: no mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10c-5: zero matching day routines, but the exercise exists on a
    // DIFFERENT day — the highest-priority regression. Explicit Friday must
    // never delete from Monday.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10c-5-mon', 'Push Day', ['mon'], [bench(benchId)])]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press', day: 'fri' });
      const after = await routines();
      ok('P10c-5: honest exercise_not_found, no widening to all routines', result.ok === false && result.reason === 'exercise_not_found', JSON.stringify(result));
      ok('P10c-5: the Monday routine is completely untouched', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10c-6: a multi-day routine ([mon,fri]) plus a Friday-only routine,
    // both contain the exercise — ambiguous, no mutation.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10c-6-multi', 'Full Body', ['mon', 'fri'], [bench(benchId)]),
        mkRoutine('p10c-6-fri', 'Push Day', ['fri'], [bench(benchId)]),
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press', day: 'fri' });
      const after = await routines();
      ok('P10c-6: multi-day + Friday-only — ambiguous_day', result.ok === false && result.reason === 'ambiguous_day', JSON.stringify(result));
      ok('P10c-6: multi-day + Friday-only — no mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10c-7: explicit Friday + lastRoutineRef pointing at Monday, with
    // exactly ONE Friday candidate — Friday must be selected; Monday must
    // NOT be touched, even though lastRoutineRef points at it.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10c-7-mon', 'Push Day', ['mon'], [bench(benchId)]),
        mkRoutine('p10c-7-fri', 'Upper Body', ['fri'], [bench(benchId)]),
      ]);
      await send('Remove bench press from monday'); // establishes lastRoutineRef = Monday via a genuine successful removal
      const midway = await routines();
      ok('P10c-7: setup — Monday lost Bench Press and became lastRoutineRef', !midway.find(x => x.id === 'p10c-7-mon').exercises.some(e => e.exId === benchId), midway);
      const r = await send('Remove bench press from friday');
      const after = await routines();
      const fri = after.find(x => x.id === 'p10c-7-fri');
      ok('P10c-7: the Friday routine is selected', !fri.exercises.some(e => e.exId === benchId), JSON.stringify(fri));
      ok('P10c-7: reports genuine success, not a stale lastRoutineRef path', /^✓/.test(r), r);
    }

    // P10c-8: explicit Friday + lastRoutineRef pointing at Monday, with
    // ZERO Friday candidates — must NOT mutate, must NOT fall back to
    // Monday despite lastRoutineRef pointing at it.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10c-8-mon', 'Push Day', ['mon'], [bench(benchId)])]);
      await send('Add shoulder press to monday'); // establishes lastRoutineRef = Monday without touching Bench Press
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press', day: 'fri' });
      const after = await routines();
      ok('P10c-8: honest failure, no fallback to lastRoutineRef (Monday)', result.ok === false && result.reason === 'exercise_not_found', JSON.stringify(result));
      ok('P10c-8: no mutation at all', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10c-9: a phrase that names a routine must NOT silently disambiguate
    // — parseAddOrRemove() still only extracts {exerciseQuery, day}. Uses
    // phrasing WITHOUT the word "routine" (which would otherwise exclude
    // this from the remove_exercise parser entirely via ROUTINE_WORD, a
    // separate, unrelated parser quirk discovered during investigation —
    // not the subject of this fix).
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10c-9-a', 'Upper Body', ['fri'], [bench(benchId)]),
        mkRoutine('p10c-9-b', 'Push Day', ['fri'], [bench(benchId)]),
      ]);
      const before = await routines();
      const r = await send('Remove bench press from Push Day on friday');
      const after = await routines();
      ok('P10c-9: the named "Push Day" text does not disambiguate — no mutation', JSON.stringify(before) === JSON.stringify(after), r);
      ok('P10c-9: no success response', !/^✓/.test(r), r);
    }

    // P10c-10: exercise genuinely absent from the unique day candidate —
    // existing not-found behavior, no mutation.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10c-10', 'Push Day', ['fri'], [])]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press', day: 'fri' });
      const after = await routines();
      ok('P10c-10: existing exercise_not_found behavior preserved', result.ok === false && result.reason === 'exercise_not_found', JSON.stringify(result));
      ok('P10c-10: no mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10c-11: the no-day path is untouched — with no day and a valid
    // lastRoutineRef, removal still targets that referenced routine
    // exactly as before this fix.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10c-11-a', 'Routine A', ['tue'], [bench(benchId)]),
        mkRoutine('p10c-11-b', 'Routine B', ['thu'], []),
      ]);
      await send('Remove bench press from tuesday'); // Routine A is the sole Tuesday routine — establishes lastRoutineRef = Routine A
      const midway = await routines();
      ok('P10c-11: setup — Routine A lost Bench Press, becomes lastRoutineRef', !midway.find(x => x.id === 'p10c-11-a').exercises.some(e => e.exId === benchId), midway);
      await send('Add bench press to tuesday'); // re-add so there is something to remove via the no-day path; re-establishes lastRoutineRef = Routine A
      const r = await send('Remove bench press'); // no day at all — must resolve via the existing, untouched lastRoutineRef path
      const after = await routines();
      const a = after.find(x => x.id === 'p10c-11-a');
      ok('P10c-11: no-day removal still resolves via the untouched lastRoutineRef path', !a.exercises.some(e => e.exId === benchId), JSON.stringify(a));
      ok('P10c-11: reports genuine success', /^✓/.test(r), r);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SECTION P10d — applyRemoveExercise() no-day/no-reference ambiguity fix
    // ══════════════════════════════════════════════════════════════════════
    // P10d investigation (2026-09-16) proved the no-day branch's fallback
    // (`targets = r ? [r] : routines`) had no ambiguity check at all when no
    // valid lastRoutineRef existed: it silently picked whichever routine
    // containing the exercise happened to be FIRST in array order, and a
    // stale lastRoutineRef (pointing at an id no longer present) fell
    // through to that exact same unguarded global scan. The fix mirrors
    // applySetSets's own no-day branch: a lastRoutineRef is only trusted if
    // it still resolves against the CURRENT routine list; otherwise every
    // routine containing the exercise is collected up front and exactly one
    // must survive before any mutation — two or more now fails immediately
    // with 'ambiguous_routine' (the same reason applySetSets already uses
    // for this identical shape), never a silent first-match pick.
    //
    // P10d-1/2 replace the old "P10c-legacy" test, which used to lock in
    // and document the pre-fix silent-first-match behavior as deliberately
    // out of scope; it is now a regression test for the corrected behavior.

    // P10d-1: two routines contain the exercise, no day, no lastRoutineRef
    // — must fail as ambiguous, not silently pick one.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10d-1-a', 'Routine A', ['tue'], [bench(benchId)]),
        mkRoutine('p10d-1-b', 'Routine B', ['thu'], [bench(benchId)]),
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press' });
      const after = await routines();
      ok('P10d-1: reason is ambiguous_routine', result.ok === false && result.reason === 'ambiguous_routine', JSON.stringify(result));
      ok('P10d-1: neither routine mutated', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10d-2: same two routines, reversed array order — result must not
    // depend on array order (still ambiguous, same candidate set, still no
    // mutation).
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10d-2-b', 'Routine B', ['thu'], [bench(benchId)]),
        mkRoutine('p10d-2-a', 'Routine A', ['tue'], [bench(benchId)]),
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press' });
      const after = await routines();
      ok('P10d-2: reversed order — still ambiguous_routine', result.ok === false && result.reason === 'ambiguous_routine', JSON.stringify(result));
      ok('P10d-2: reversed order — candidate set unchanged regardless of order',
        JSON.stringify((result.candidates || []).slice().sort()) === JSON.stringify(['Routine A', 'Routine B'].sort()), JSON.stringify(result));
      ok('P10d-2: reversed order — neither routine mutated', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10d-3: three routines contain the exercise — still ambiguous, zero
    // mutation (not just a 2-candidate special case).
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10d-3-a', 'Routine A', [], [bench(benchId)]),
        mkRoutine('p10d-3-b', 'Routine B', [], [bench(benchId)]),
        mkRoutine('p10d-3-c', 'Routine C', [], [bench(benchId)]),
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press' });
      const after = await routines();
      ok('P10d-3: three candidates — still ambiguous_routine', result.ok === false && result.reason === 'ambiguous_routine', JSON.stringify(result));
      ok('P10d-3: three candidates — zero mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10d-4: exactly ONE routine contains the exercise, no day, no
    // reference — the unique candidate is unambiguous and must still
    // resolve and mutate normally.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10d-4-a', 'Routine A', [], [bench(benchId)]),
        mkRoutine('p10d-4-b', 'Routine B', [], []),
      ]);
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press' });
      const after = await routines();
      const a = after.find(x => x.id === 'p10d-4-a');
      const b = after.find(x => x.id === 'p10d-4-b');
      ok('P10d-4: unique candidate succeeds', result.ok === true, JSON.stringify(result));
      ok('P10d-4: the unique routine is mutated', !a.exercises.some(e => e.exId === benchId), JSON.stringify(a));
      ok('P10d-4: the unrelated routine is unaffected', JSON.stringify(b.exercises) === '[]', JSON.stringify(b));
    }

    // P10d-5: zero routines contain the exercise — honest not-found, zero
    // mutation (unchanged pre-existing behavior, re-asserted for this path).
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10d-5-a', 'Routine A', [], [])]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press' });
      const after = await routines();
      ok('P10d-5: exercise_not_found', result.ok === false && result.reason === 'exercise_not_found', JSON.stringify(result));
      ok('P10d-5: zero mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10d-6: valid lastRoutineRef with 2+ candidate routines — the
    // referenced routine is selected; the other matching routine is
    // untouched (the reference path remains deterministic and unaffected).
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10d-6-a', 'Routine A', ['tue'], [bench(benchId)]),
        mkRoutine('p10d-6-b', 'Routine B', ['thu'], [bench(benchId)]),
      ]);
      await send('Remove bench press from tuesday'); // establishes lastRoutineRef = Routine A
      await send('Add bench press to tuesday'); // re-add so there's something to remove via the no-day path
      const r = await send('Remove bench press'); // no day — must resolve via lastRoutineRef, not the ambiguity check
      const after = await routines();
      const a = after.find(x => x.id === 'p10d-6-a');
      const b = after.find(x => x.id === 'p10d-6-b');
      ok('P10d-6: reports genuine success via lastRoutineRef, not ambiguity', /^✓/.test(r), r);
      ok('P10d-6: the referenced routine (A) is mutated', !a.exercises.some(e => e.exId === benchId), JSON.stringify(a));
      ok('P10d-6: the other matching routine (B) is untouched', b.exercises.some(e => e.exId === benchId), JSON.stringify(b));
    }

    // P10d-7: stale/invalid lastRoutineRef (points at an id no longer
    // present) with 2+ candidate routines — must be treated as unusable and
    // fall to the ambiguity check, NEVER the old first-match fallback.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10d-7-ghost', 'Ghost Routine', ['tue'], [mkEx('Squat', squatId, 3)])]);
      await send('Remove squat from tuesday'); // establishes lastRoutineRef = Ghost Routine
      // Replace storage entirely: Ghost Routine is gone; two new routines both have Bench Press.
      await setRoutines([
        mkRoutine('p10d-7-a', 'Routine A', [], [bench(benchId)]),
        mkRoutine('p10d-7-b', 'Routine B', [], [bench(benchId)]),
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press' });
      const after = await routines();
      ok('P10d-7: stale ref — ambiguous_routine, not a silent first-match', result.ok === false && result.reason === 'ambiguous_routine', JSON.stringify(result));
      ok('P10d-7: stale ref — zero mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10d-8: stale/invalid lastRoutineRef with exactly ONE candidate — a
    // reference that can't be used must not prevent the (unambiguous)
    // unique candidate from resolving normally.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10d-8-ghost', 'Ghost Routine', ['tue'], [mkEx('Squat', squatId, 3)])]);
      await send('Remove squat from tuesday'); // establishes lastRoutineRef = Ghost Routine
      await setRoutines([
        mkRoutine('p10d-8-a', 'Routine A', [], [bench(benchId)]),
        mkRoutine('p10d-8-b', 'Routine B', [], []),
      ]);
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press' });
      const after = await routines();
      const a = after.find(x => x.id === 'p10d-8-a');
      ok('P10d-8: stale ref + unique candidate — succeeds', result.ok === true, JSON.stringify(result));
      ok('P10d-8: stale ref + unique candidate — that routine is mutated', !a.exercises.some(e => e.exId === benchId), JSON.stringify(a));
    }

    // P10d-9: explicit-day behavior (P10c) is unaffected by the no-day
    // branch change — smallest possible re-assertion, not a re-run of the
    // full P10c suite: an explicit day matching 2+ routines still fails as
    // 'ambiguous_day' before any exercise lookup, exactly as P10c-2 proved.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([
        mkRoutine('p10d-9-a', 'Upper Body', ['fri'], [bench(benchId)]),
        mkRoutine('p10d-9-b', 'Push Day', ['fri'], [bench(benchId)]),
      ]);
      const before = await routines();
      const result = await applyDirect({ kind: 'remove_exercise', exerciseQuery: 'bench press', day: 'fri' });
      const after = await routines();
      ok('P10d-9: explicit-day ambiguity (P10c) unaffected by the P10d fix', result.ok === false && result.reason === 'ambiguous_day', JSON.stringify(result));
      ok('P10d-9: explicit-day — no mutation', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    }

    // P10d-10: no-day + VALID lastRoutineRef, single candidate — the
    // existing reference-resolves-directly path (already covered end-to-end
    // by P10c-11) is unaffected by the P10d fix — smallest re-assertion.
    {
      await clearRoutines(); await forgetLastRoutine();
      await setRoutines([mkRoutine('p10d-10-a', 'Routine A', ['tue'], [bench(benchId)])]);
      await send('Remove bench press from tuesday'); // establishes lastRoutineRef = Routine A
      await send('Add bench press to tuesday'); // re-add so there's something to remove via the no-day path
      const r = await send('Remove bench press'); // no day — resolves via lastRoutineRef
      const after = await routines();
      ok('P10d-10: no-day + valid lastRoutineRef still resolves directly, unaffected by the ambiguity check',
        /^✓/.test(r) && !after.find(x => x.id === 'p10d-10-a').exercises.some(e => e.exId === benchId), r);
    }

    await clearRoutines(); await forgetLastRoutine();
  }
} catch (e) {
  ok('FATAL during run', false, e.message + '\n' + e.stack);
}

// calendar-link's status poll and the Gemini assistant route both hit the
// (unavailable, in this static-file-only harness) proxy — same class of
// expected noise as the network failures already filtered below, not
// caused by anything under test here (A17 deliberately falls through to
// the Gemini fallback to prove it ISN'T mis-declined as gym_unsupported).
const realConsole = consoleErrors.filter(t =>
  !/supabase|jsdelivr|Failed to load resource|net::ERR|ERR_FAILED|blocked|calendar-link|Gemini assistant request failed/i.test(t));

console.log('\n── Shenlong parser/routine-authoring smoke results ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
if (pageErrors.length) { console.log('\nUncaught page errors:'); pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (realConsole.length) { console.log('\nConsole errors (non-network):'); realConsole.forEach(e => console.log('  ✗ ' + e)); }

const failed = results.filter(r => !r.pass).length + pageErrors.length + realConsole.length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'} (${results.length} checks, screenshot: tools/smoke/shenlong-parser-smoke.png)`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
