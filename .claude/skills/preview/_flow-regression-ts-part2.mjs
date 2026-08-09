// _flow-regression-ts-part2.mjs — real execution of TS-12/13/14 (proactive
// nudge, needs clock control), TS-17..22 (contextual retrieval / local vs
// Gemini, needs network interception), TS-24 full 4-case weekday check.
// Companion to _flow-regression-ts.mjs (TS-01..11, 15, 16 — already covers
// the cases that don't need a faked clock or network interception).
export default async (page, { shot, log }) => {
  const results = [];
  const check = (id, cond, detail) => {
    results.push({ id, pass: !!cond, detail });
    log(id, cond ? 'PASS' : 'FAIL', detail);
  };

  // ── TS-12/13/14 — proactiveNudge(), needs a faked clock (real Date.now()
  // varies run to run; the suite's own cases are defined relative to a
  // specific hour) ───────────────────────────────────────────────────────
  await page.clock.install();

  // TS-12: open gym session, 2 sets, "Push Day" -> nudge names it
  await page.evaluate(() => {
    localStorage.setItem('rb_routines_v1', JSON.stringify([{ id: 'r1', name: 'Push Day', exercises: [] }]));
    localStorage.setItem('po_coach_v1', JSON.stringify({ filterRoutine: 'r1', sessions: [{ endedAt: null, label: 'Push Day', sets: [{}, {}] }] }));
  });
  let nudge = await page.evaluate(() => window.proactiveNudge());
  check('TS-12', nudge === 'You have an open Push Day session — 2 sets logged. Resume when ready.', nudge);

  // TS-13: no open session, clock 9am, nothing logged -> null (too early)
  await page.evaluate(() => {
    localStorage.removeItem('po_coach_v1');
    localStorage.setItem('po_water_v1', JSON.stringify({ logs: {} }));
  });
  await page.clock.setFixedTime(new Date('2026-08-09T09:00:00'));
  nudge = await page.evaluate(() => window.proactiveNudge());
  check('TS-13', nudge === null, JSON.stringify(nudge));

  // TS-14: no open session, clock 4pm, zero water logged -> water nudge
  await page.clock.setFixedTime(new Date('2026-08-09T16:00:00'));
  nudge = await page.evaluate(() => window.proactiveNudge());
  check('TS-14', nudge === "You haven't logged any water today.", nudge);

  // ── TS-24 (full 4-case, not just one) — weekday resolution, clock fixed
  // to a confirmed Monday (2026-08-03, verified via `node -e` before writing
  // this test: getDay() === 1) ──────────────────────────────────────────
  await page.clock.setFixedTime(new Date('2026-08-03T10:00:00'));
  const dates = await page.evaluate(() => ({
    thisFriday: window.Assistant.parse('add gym this Friday at 6pm').date,
    nextFriday: window.Assistant.parse('add gym next Friday at 6pm').date,
    bareFriday: window.Assistant.parse('add gym Friday at 6pm').date,
    nextMonday: window.Assistant.parse('add gym next Monday at 6pm').date,
  }));
  log('TS-24 dates:', JSON.stringify(dates));
  check('TS-24', dates.thisFriday === '2026-08-07' && dates.nextFriday === '2026-08-07'
    && dates.bareFriday === '2026-08-07' && dates.nextMonday === '2026-08-10', JSON.stringify(dates));

  await page.clock.setFixedTime(new Date('2026-08-09T15:00:00'));   // back to a normal afternoon for the rest

  // ── TS-17..22 — contextual retrieval / local-vs-Gemini, via page.route() ─
  const captured = [];
  await page.route('**/api/gemini/assistant', async (route) => {
    captured.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'chat', reply: 'ok', confidence: 'high' }) });
  });
  const submitText = (text) => page.evaluate((t) => {
    const input = document.getElementById('aiInput');
    input.value = t;
    document.getElementById('aiForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }, text);

  // TS-17: "log 3 bottles of water" resolves LOCALLY — zero Gemini calls
  await submitText('log 3 bottles of water');
  await page.waitForTimeout(200);
  check('TS-17', captured.length === 0, 'captured=' + captured.length);

  // TS-18: gym-domain question -> payload has `gym`, omits events/health/wardrobe
  await submitText('what is my gym routine like');
  await page.waitForTimeout(200);
  let body = captured[captured.length - 1];
  check('TS-18', body && 'gym' in body.context && !('events' in body.context) && !('health' in body.context) && !('wardrobe' in body.context), JSON.stringify(body && body.context));

  // TS-19: health-domain QUESTION -> payload has `health`, omits the rest
  await submitText('how much water so far');
  await page.waitForTimeout(200);
  body = captured[captured.length - 1];
  check('TS-19', body && 'health' in body.context && !('events' in body.context) && !('gym' in body.context) && !('wardrobe' in body.context), JSON.stringify(body && body.context));

  // TS-20: general/cross-domain phrasing -> ALL context keys present
  await submitText('I have one free hour, what should I do with it');
  await page.waitForTimeout(200);
  body = captured[captured.length - 1];
  check('TS-20', body && ['events', 'gym', 'health', 'wardrobe'].every((k) => k in body.context), JSON.stringify(body && body.context));

  // TS-21: gibberish -> unknown domain, no crash, still reaches Gemini (safe maximal default)
  const beforeCount = captured.length;
  await submitText('xyzzy plugh qwerty');
  await page.waitForTimeout(200);
  check('TS-21', captured.length === beforeCount + 1 && captured[captured.length - 1].context.domain === 'unknown', JSON.stringify(captured[captured.length - 1] && captured[captured.length - 1].context.domain));

  // TS-22: memory rides along even on a domain-scoped (gym) request
  await page.evaluate(() => { localStorage.removeItem('shenlong_memory_v1'); window.rememberFact("I'm vegetarian"); window.rememberFact('I train in the mornings'); });
  await submitText('what is my gym routine like');
  await page.waitForTimeout(200);
  body = captured[captured.length - 1];
  check('TS-22', body && Array.isArray(body.context.memory) && body.context.memory.length === 2, JSON.stringify(body && body.context.memory));

  await shot('regression-part2');

  const failed = results.filter((r) => !r.pass);
  if (failed.length) throw new Error('REGRESSION PART 2 FAILED: ' + JSON.stringify(failed));
  log('ALL PASS — part 2:', results.map((r) => r.id).join(', '));
};
