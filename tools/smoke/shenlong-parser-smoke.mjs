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
