// Regression test for js/calendar-link.js syncNow() ("Refresh events").
//
// Bug: POST /api/calendar/sync/trigger answers HTTP 202 {status:'already syncing'}
// when another sync for the user holds the lock — nothing was pulled. res.ok is
// true for 202, so syncNow() fell through to the "freshly pulled events" path
// (AptCal.reload + status refresh), which re-rendered the card back to plain
// "Connected": the user was told nothing and believed the refresh had happened.
//
// No browser, no network: runs the REAL calendar-link.js in a Node vm against a
// minimal fake DOM + fetch. Usage: node tools/smoke/calendar-sync-status-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/calendar-link.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures++;
}

// Loads calendar-link.js with a scripted /sync/trigger response and returns what
// the user could observe after clicking "Refresh events".
async function clickRefresh(triggerResponse) {
  const calls = { reload: 0, statusFetches: 0, trigger: 0 };
  const sub = { textContent: '', className: '' };
  let clickHandler = null;
  const mount = {
    set innerHTML(_v) { sub.textContent = 'Connected'; sub.className = 'callink-sub is-ok'; },
    get innerHTML() { return ''; },
    addEventListener(type, fn) { if (type === 'click') clickHandler = fn; },
    querySelector(sel) { return sel === '.callink-sub' ? sub : null; },
  };
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fakeFetch = async (url) => {
    if (String(url).includes('/api/calendar/sync/trigger')) { calls.trigger++; return triggerResponse; }
    if (String(url).includes('/api/calendar/status')) {
      calls.statusFetches++;
      return json(200, { configured: true, connected: true, email: 'x@example.com', sync_enabled: true, verified: true });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const window = {
    APP_AUTH_READY: Promise.resolve(), __appAccessToken: 't', APP_SUPABASE: null,
    addEventListener() {},
    AptCal: { reload() { calls.reload++; } },
  };
  const document = {
    getElementById(id) { return id === 'calLinkMount' ? mount : null; },
    createElement() { return { style: {}, appendChild() {} }; },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  const ctx = vm.createContext({
    window, document, fetch: fakeFetch, console: { error() {}, log() {} },
    AbortSignal, setInterval() { return 1; }, setTimeout, clearInterval() {}, Promise,
  });
  vm.runInContext(SRC, ctx);
  await new Promise(r => setTimeout(r, 20));          // let the boot status refresh settle
  const statusBefore = calls.statusFetches;
  clickHandler({ target: { closest: () => ({ dataset: { act: 'syncnow' } }) } });
  await new Promise(r => setTimeout(r, 50));
  return { sub, calls, statusAfterClick: calls.statusFetches - statusBefore };
}

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// 202: another sync is running → must say so, and must NOT behave as completed.
{
  const r = await clickRefresh(json(202, { status: 'already syncing' }));
  check('202: trigger endpoint was called once', r.calls.trigger === 1);
  check('202: user is told a sync is already running', /already running/i.test(r.sub.textContent), r.sub.textContent);
  check('202: shown as a warning, not success', /is-warn/.test(r.sub.className), r.sub.className);
  check('202: does NOT reload events as if freshly pulled', r.calls.reload === 0, 'reload calls=' + r.calls.reload);
  check('202: does NOT re-render the card back to "Connected"', r.statusAfterClick === 0, 'status fetches=' + r.statusAfterClick);
}

// 200: a completed sync keeps the existing behavior (reload + status refresh).
{
  const r = await clickRefresh(json(200, { ok: true, pushed: {}, pulled: {} }));
  check('200: events are reloaded after a completed sync', r.calls.reload === 1, 'reload calls=' + r.calls.reload);
  check('200: status is refreshed after a completed sync', r.statusAfterClick === 1, 'status fetches=' + r.statusAfterClick);
}

// 502: failure still surfaces as an error.
{
  const r = await clickRefresh(json(502, { error: 'Sync failed' }));
  check('502: user sees a failure message', /failed/i.test(r.sub.textContent), r.sub.textContent);
  check('502: shown as an error', /is-error/.test(r.sub.className), r.sub.className);
  check('502: does NOT reload events', r.calls.reload === 0);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
