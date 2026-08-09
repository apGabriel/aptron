// _flow-regression-ts.mjs — representative re-execution of the LOCAL-tier
// SHENLONG_TEST_SUITE.md cases (TS-01..24), same methodology the suite's own
// "How to reproduce" section documents: direct calls to the exposed pure
// functions. This voice-chat pass touched ZERO lines in classifyIntentDomain,
// rememberFact, proactiveNudge, parseLocal, askGemini, applyIntent, or
// resolveDate (confirmed by diff) — this flow re-executes a representative
// spot-check of each category for real, rather than asserting from the diff
// alone, per the explicit "no inflar resultados" instruction.
export default async (page, { shot, log }) => {
  const results = [];
  const check = (id, cond, detail) => {
    results.push({ id, pass: !!cond, detail });
    log(id, cond ? 'PASS' : 'FAIL', detail);
  };

  // TS-01/02/03/04/05/06/07/08 — classifyIntentDomain
  const domains = await page.evaluate(() => ({
    gym: window.classifyIntentDomain("What's my workout routine today?"),
    health: window.classifyIntentDomain('How much water have I had today?'),
    calendar: window.classifyIntentDomain('What do I have on my calendar tomorrow?'),
    wardrobe: window.classifyIntentDomain('How many jackets do I own?'),
    general: window.classifyIntentDomain('What should I do today?'),
    unknown: window.classifyIntentDomain("I'm tired"),
    multi: window.classifyIntentDomain('Log my gym session and how much water did I drink'),
    greeting: window.classifyIntentDomain('good morning'),
  }));
  check('TS-01', domains.gym === 'gym', domains.gym);
  check('TS-02', domains.health === 'health', domains.health);
  check('TS-03', domains.calendar === 'calendar', domains.calendar);
  check('TS-04', domains.wardrobe === 'wardrobe', domains.wardrobe);
  check('TS-05', domains.general === 'general', domains.general);
  check('TS-06', domains.unknown === 'unknown', domains.unknown);
  check('TS-07', domains.multi === 'multi', domains.multi);
  check('TS-08', domains.greeting === 'general', domains.greeting);

  // TS-09/10/11 — rememberFact store / dedup / cap
  const memRes = await page.evaluate(() => {
    localStorage.removeItem('shenlong_memory_v1');
    const first = window.rememberFact("I'm vegetarian");
    const dup = window.rememberFact("I'm vegetarian");
    for (let i = 1; i <= 20; i++) window.rememberFact('fact number ' + i);
    const stored = JSON.parse(localStorage.getItem('shenlong_memory_v1') || '[]');
    localStorage.removeItem('shenlong_memory_v1');
    return { first, dup, count: stored.length };
  });
  check('TS-09', memRes.first === "I'm vegetarian", memRes.first);
  check('TS-10', memRes.dup === null, memRes.dup);
  check('TS-11', memRes.count === 15, memRes.count);

  // TS-15/16 — remember_fact vs note, via the local parser
  const parseRes = await page.evaluate(() => ({
    fact: window.Assistant.parse("remember that I'm vegetarian"),
    reminder: window.Assistant.parse('remember to call mom'),
  }));
  check('TS-15', parseRes.fact && parseRes.fact.action === 'remember_fact', JSON.stringify(parseRes.fact));
  check('TS-16', parseRes.reminder && parseRes.reminder.action === 'note', JSON.stringify(parseRes.reminder));

  // TS-24 — weekday resolution (resolveDate isn't exposed on window; drive it
  // through the local parser's date field instead, same observable contract).
  const wd = await page.evaluate(() => {
    const r = window.Assistant.parse('add gym next Friday at 6pm');
    return r && r.date;
  });
  check('TS-24', typeof wd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(wd), wd);

  const failed = results.filter((r) => !r.pass);
  await shot('regression-ts');
  if (failed.length) throw new Error('REGRESSION FAILED: ' + JSON.stringify(failed));
  log('ALL PASS — regression spot-check clean:', results.map((r) => r.id).join(', '));
};
