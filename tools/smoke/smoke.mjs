// Playwright smoke test for the split gym module (js/gym/*).
// Serves the repo over HTTP, BLOCKS Supabase (so the real cloud DB is never
// touched — the app runs local-only), seeds a routine, loads gym.html in a real
// Chromium, and drives the core interactions while watching for uncaught errors.
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

const PORT = 4599;
await new Promise(r => server.listen(PORT, r));

const ISO = new Date().toISOString();
const SEED = {
  rb_routines_v1: JSON.stringify([{
    id: 'r1', name: 'Push Day', updated_at: ISO,
    exercises: [
      { exId: 'bench', name: 'Bench Press', muscleGroup: 'Chest', gifUrl: '', sets: [{ weight: 60, reps: 8 }] },
      { exId: 'ohp', name: 'Overhead Press', muscleGroup: 'Shoulders', gifUrl: '', sets: [{ weight: 40, reps: 8 }] },
    ],
  }]),
  po_coach_v1: JSON.stringify({
    units: 'kg', filterRoutine: 'r1', currentEx: 'rt_bench',
    sessions: [{ id: 's_old', label: 'Push Day', startedAt: ISO, endedAt: ISO,
      sets: [{ exId: 'rt_bench', name: 'Bench Press', weight: 57.5, reps: 7, date: ISO }] }],
    activeSessionId: null,
  }),
  po_coach_photos: JSON.stringify([]),
};

const browser = await chromium.launch();
const ctx = await browser.newContext();

// Hard guard: abort anything heading to Supabase so real data is never touched.
await ctx.route('**://*.supabase.co/**', r => r.abort());
await ctx.route('**/@supabase/**', r => r.abort());           // block the JS bundle → window.supabase stays undefined

const page = await ctx.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.addInitScript(seed => {
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
}, SEED);

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

try {
  await page.goto(`http://localhost:${PORT}/gym.html`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.GymApp && window.GymApp.state, { timeout: 8000 });

  // 1. Boot + namespace
  ok('GymApp namespace + state present', await page.evaluate(() => !!(window.GymApp && window.GymApp.state)));
  ok('app title rendered', (await page.textContent('#appTitle'))?.includes('Progressive Overload'));

  // 2. Routine + exercise wiring rendered from seed
  ok('routine segment rendered', await page.locator('#daySeg .po-seg-btn').count() > 0);
  ok('exercise select populated', await page.locator('#exSelect option').count() >= 2);
  ok('prescription card rendered', (await page.locator('#rxWrap').innerHTML()).length > 0);
  ok('seeded past workout shows', await page.locator('#poTwPastBody .po-tw-past-day').count() >= 1);

  // 3. Log a working set
  await page.fill('#repsInput', '8');
  await page.fill('#weightInput', '60');
  await page.click('#logBtn');
  await page.waitForFunction(() => document.getElementById('poTwSetCount')?.textContent === '1', { timeout: 4000 });
  ok('logged set → active session count = 1', (await page.textContent('#poTwSetCount')) === '1');

  // 4. Arm dropset + log a chained set
  await page.click('#dsToggle');
  await page.fill('#repsInput', '6');
  await page.fill('#weightInput', '45');
  await page.click('#logBtn');
  await page.waitForFunction(() => document.getElementById('poTwSetCount')?.textContent === '2', { timeout: 4000 });
  ok('dropset logged → count = 2', (await page.textContent('#poTwSetCount')) === '2');
  ok('dropset ↳ DS marker rendered', await page.locator('.po-tw-set.is-drop, .po-ds-tag').count() > 0);
  ok('history rows rendered', await page.locator('#historyCard .po-hist-row').count() > 0);

  // 5. Mark the session done → moves to Past workouts
  const pastBefore = await page.locator('#poTwPastBody .po-tw-past-day').count();
  await page.click('#poTwDoneBtn');
  await page.waitForTimeout(300);
  ok('mark done → past workout added', await page.locator('#poTwPastBody .po-tw-past-day').count() > pastBefore);

  // 6. Switch routine exercise via the select
  await page.selectOption('#exSelect', { index: 1 });
  await page.waitForTimeout(150);
  ok('exercise switch did not error', true);

  // 7. Time-based tracking: toggle the (now-active) exercise to Time, log a
  // 90s hold, and confirm it stores/renders as duration (1:30), not reps.
  await page.click('#metricSeg button[data-metric="time"]');
  await page.waitForFunction(() => document.getElementById('repsLabel')?.textContent === 'Time (sec)', { timeout: 4000 });
  ok('metric toggle → label becomes Time (sec)', (await page.textContent('#repsLabel')) === 'Time (sec)');
  ok('time input bound to 3600s max', (await page.getAttribute('#repsInput', 'max')) === '3600');
  await page.fill('#weightInput', '20');
  await page.fill('#repsInput', '90');
  await page.click('#logBtn');
  await page.waitForFunction(() => document.getElementById('poTwSetCount')?.textContent === '1', { timeout: 4000 });
  ok('time set logged → new session count = 1', (await page.textContent('#poTwSetCount')) === '1');
  ok('history renders duration 1:30', (await page.locator('#historyCard .po-hist-row').first().textContent())?.includes('1:30'));
  ok('PR badge shows longest hold 1:30', (await page.textContent('#prStat'))?.includes('1:30'));
  ok('last-set chip shows duration', (await page.textContent('#lastSetValue'))?.includes('1:30'));
  // The set is stored as a time metric with no reps — never seconds in `reps`.
  ok('time set stored as metric=time, reps null', await page.evaluate(() => {
    const sess = window.GymApp.getActiveSession();
    const st = sess && sess.sets[sess.sets.length - 1];
    return !!st && st.metric === 'time' && st.duration === 90 && st.reps == null;
  }));
  // Toggle back to Reps so the field/label reset path is exercised too.
  await page.click('#metricSeg button[data-metric="reps"]');
  await page.waitForFunction(() => document.getElementById('repsLabel')?.textContent === 'Reps', { timeout: 4000 });
  ok('metric toggle back → label becomes Reps', (await page.textContent('#repsLabel')) === 'Reps');

  // 8. Settings modal open/close
  await page.click('#settingsBtn');
  await page.waitForTimeout(150);
  ok('settings modal opened', await page.locator('#setModalBg.show').count() === 1);
  ok('settings gyms rendered', await page.locator('#setGyms .po-set-row').count() >= 1);
  await page.click('#setModalClose');

  // 9. Routine Builder catalog loaded (real fetch of exercises-data.json)
  ok('routine builder initialised', await page.locator('#rbCard, #rbGrid').count() >= 1);

  await page.screenshot({ path: path.join(ROOT, 'tools/smoke/gym-smoke.png'), fullPage: true });
} catch (e) {
  ok('FATAL during run', false, e.message);
}

// Real JS errors fail the run. Network errors from the intentional Supabase /
// CDN blocks are expected and filtered out.
const realConsole = consoleErrors.filter(t =>
  !/supabase|jsdelivr|Failed to load resource|net::ERR|ERR_FAILED|blocked/i.test(t));

console.log('\n── Smoke results ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
if (pageErrors.length) { console.log('\nUncaught page errors:'); pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (realConsole.length) { console.log('\nConsole errors (non-network):'); realConsole.forEach(e => console.log('  ✗ ' + e)); }

const failed = results.filter(r => !r.pass).length + pageErrors.length + realConsole.length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'}  (screenshot: tools/smoke/gym-smoke.png)`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
