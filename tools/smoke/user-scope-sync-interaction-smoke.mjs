// Playwright regression suite for ADR-024 F1 (logout-triggered empty-state
// cloud push) and F2 (Shenlong memory isolation). Closes the coverage gap
// the 2026-08-20 closure audit found in user-scope-smoke.mjs: that suite
// only exercises js/auth/user_scope.js in isolation and never loads the real
// sync.js / js/gym/gym-sync.js, so it could not catch F1's class of bug.
//
// This suite serves the REAL repo (sync.js, js/gym/gym-sync.js,
// js/auth/user_scope.js, unmodified) against a small local mock of
// window.supabase + window.fetch (tools/smoke/_fixtures/sync-interaction-
// harness.html) — deterministic, no real network, no real Supabase project
// touched (per the task's explicit instruction to prefer local test doubles
// over live tests that could affect production data).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/tools/smoke/_fixtures/sync-interaction-harness.html' : urlPath;
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});
const PORT = 4603;   // distinct from smoke.mjs/theme-smoke.mjs/confirm-smoke.mjs/user-scope-smoke.mjs
await new Promise((r) => server.listen(PORT, r));

const HARNESS = `http://localhost:${PORT}/tools/smoke/_fixtures/sync-interaction-harness.html`;

const browser = await chromium.launch();
const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

async function freshPage() {
  const page = await browser.newPage();
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded', timeout: 15000 });
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);

try {
  // ── TEST 1 — generic sync (sync.js) logout cleanup ──────────────────────
  {
    const page = await freshPage();
    await page.evaluate(() => {
      window.initCloudSync({
        appKey: 'goals',
        syncedPrefixes: ['cal_done:', 'cal_manual:', 'quicknotes_v1', 'aptron_profile_v1'],
      });
      window.__resolveAuthReady();
    });
    await wait(page, 350); // let init() + any legit empty-state decision settle

    // A populated, already-logged-in user's local state.
    await page.evaluate(() => {
      localStorage.setItem('aptron_profile_v1', JSON.stringify({ name: 'admin', theme: 'neon' }));
      localStorage.setItem('quicknotes_v1', JSON.stringify([{ text: 'buy milk', ts: 1 }]));
      localStorage.setItem('cal_done:2026-08-20', 'true');
    });
    await wait(page, 350); // let the legitimate push these writes triggered land
    await page.evaluate(() => { window.__testUpserts.length = 0; window.__testFetches.length = 0; });

    await page.evaluate(async () => { const mod = await import('/js/auth/user_scope.js'); mod.clearOnLogout(); });
    const cleared = await page.evaluate(() => ({
      profile: localStorage.getItem('aptron_profile_v1'),
      notes: localStorage.getItem('quicknotes_v1'),
      calDone: localStorage.getItem('cal_done:2026-08-20'),
    }));
    ok('T1a. clearOnLogout still removes the keys', cleared.profile === null && cleared.notes === null && cleared.calDone === null);

    await wait(page, 400); // past the 250ms debounce window
    const afterDebounce = await page.evaluate(() => ({ upserts: window.__testUpserts.length }));
    ok('T1b. no debounced pushNow() upsert as a RESULT of the clear', afterDebounce.upserts === 0, JSON.stringify(afterDebounce));

    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await wait(page, 50);
    const afterUnload = await page.evaluate(() => ({ upserts: window.__testUpserts.length, fetches: window.__testFetches.length }));
    ok('T1c. no flushOnUnload push/fetch of the cleared state on beforeunload', afterUnload.upserts === 0 && afterUnload.fetches === 0, JSON.stringify(afterUnload));

    await page.close();
  }

  // ── TEST 2 — gym sync (gym-sync.js) logout cleanup ──────────────────────
  {
    const page = await freshPage();
    await page.evaluate(() => { window.__resolveAuthReady(); }); // unblocks gym-sync.js's own pending init()
    await wait(page, 350);

    await page.evaluate(() => {
      localStorage.setItem('po_coach_v1', JSON.stringify({ sessions: [{ id: 's1', sets: [{ exId: 'e1' }] }] }));
      localStorage.setItem('po_coach_workout_done', 'true');
    });
    await wait(page, 350);
    await page.evaluate(() => { window.__testUpserts.length = 0; window.__testFetches.length = 0; });

    await page.evaluate(async () => { const mod = await import('/js/auth/user_scope.js'); mod.clearOnLogout(); });
    const cleared = await page.evaluate(() => ({
      coach: localStorage.getItem('po_coach_v1'),
      done: localStorage.getItem('po_coach_workout_done'),
    }));
    ok('T2a. po_coach_v1 and gym-related state cleared', cleared.coach === null && cleared.done === null);

    await wait(page, 400);
    const afterDebounce = await page.evaluate(() => ({ upserts: window.__testUpserts.length }));
    ok('T2b. no pcPushNow() upsert as a RESULT of the clear', afterDebounce.upserts === 0, JSON.stringify(afterDebounce));

    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    await wait(page, 50);
    const afterUnload = await page.evaluate(() => ({ upserts: window.__testUpserts.length, fetches: window.__testFetches.length }));
    ok('T2c. no pcFlushPushOnUnload push/fetch of the cleared state on beforeunload', afterUnload.upserts === 0 && afterUnload.fetches === 0, JSON.stringify(afterUnload));

    await page.close();
  }

  // ── TEST 3 — Shenlong memory isolation (F2) ──────────────────────────────
  {
    const page = await freshPage();
    await page.evaluate(() => { window.__resolveAuthReady(); });
    await wait(page, 100);

    // User A saves a memory fact.
    await page.evaluate(() => {
      localStorage.setItem('shenlong_memory_v1', JSON.stringify([{ text: 'A prefers morning workouts', savedAt: 1 }]));
    });
    const r3a = await page.evaluate(async () => {
      const mod = await import('/js/auth/user_scope.js');
      return { changed: mod.reconcileUserScope('uidA') }; // first-ever run (ADR-025): clears too, now
    });
    ok('T3a. first-ever reconcile on an unreconciled browser clears (ADR-025)', r3a.changed === true);
    const stillA = await page.evaluate(() => localStorage.getItem('shenlong_memory_v1'));
    ok('T3b. pre-existing memory does NOT survive the first-ever run — no grandfathering', stillA === null);

    // User B arrives on the same browser.
    const r3b = await page.evaluate(async () => {
      const mod = await import('/js/auth/user_scope.js');
      return { changed: mod.reconcileUserScope('uidB') };
    });
    const forB = await page.evaluate(() => localStorage.getItem('shenlong_memory_v1'));
    ok('T3c. crossing to uidB clears A\'s memory', r3b.changed === true && forB === null);

    // B never gets to read A's memory before it's cleared; simulate B saving her own.
    await page.evaluate(() => {
      localStorage.setItem('shenlong_memory_v1', JSON.stringify([{ text: 'B prefers evening workouts', savedAt: 2 }]));
    });

    // A returns.
    const r3c = await page.evaluate(async () => {
      const mod = await import('/js/auth/user_scope.js');
      return { changed: mod.reconcileUserScope('uidA') };
    });
    const forA2 = await page.evaluate(() => localStorage.getItem('shenlong_memory_v1'));
    ok('T3d. A returning clears B\'s memory (A does not inherit B\'s facts)', r3c.changed === true && forA2 === null);

    // A saves a fresh memory (as if Shenlong just re-learned it), then A
    // reloads/re-authenticates as the SAME uid — must NOT be wiped.
    await page.evaluate(() => {
      localStorage.setItem('shenlong_memory_v1', JSON.stringify([{ text: 'A prefers morning workouts (re-saved)', savedAt: 3 }]));
    });
    const r3d = await page.evaluate(async () => {
      const mod = await import('/js/auth/user_scope.js');
      return { changed: mod.reconcileUserScope('uidA') }; // same uid returning
    });
    const forA3 = await page.evaluate(() => localStorage.getItem('shenlong_memory_v1'));
    ok('T3e. same-user persistence: A\'s freshly re-saved memory is NOT cleared', r3d.changed === false && forA3 !== null);

    await page.close();
  }

  // ── TEST 4 — same-user persistence across representative domains ────────
  {
    const page = await freshPage();
    await page.evaluate(() => {
      window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['aptron_profile_v1'] });
      window.__resolveAuthReady();
    });
    await wait(page, 200);
    // Establish uidA as already onboarded on this browser (ADR-025: the
    // first-ever reconcile now clears too, so do it before seeding uidA's
    // OWN representative data — otherwise this step would just wipe it).
    await page.evaluate(async () => {
      const mod = await import('/js/auth/user_scope.js');
      mod.reconcileUserScope('uidA');
    });
    await page.evaluate(() => {
      localStorage.setItem('aptron_profile_v1', JSON.stringify({ name: 'admin', theme: 'neon' }));
      localStorage.setItem('po_coach_v1', JSON.stringify({ sessions: [1] }));
      localStorage.setItem('rb_routines_v1', JSON.stringify([{ id: 'r1' }]));
    });
    const r4b = await page.evaluate(async () => {
      const mod = await import('/js/auth/user_scope.js');
      return mod.reconcileUserScope('uidA'); // same uid — simulates logout -> re-login as A
    });
    const state = await page.evaluate(() => ({
      profile: localStorage.getItem('aptron_profile_v1'),
      coach: localStorage.getItem('po_coach_v1'),
      routines: localStorage.getItem('rb_routines_v1'),
    }));
    ok('T4. same-uid re-login does not clear ANY representative domain (not read as a cross-user migration)',
      r4b === false && state.profile !== null && state.coach !== null && state.routines !== null);
    await page.close();
  }

  // ── TEST 5 — ordering: reconcile/clear completes BEFORE APP_AUTH_READY,
  //             which is what sync init() awaits ───────────────────────────
  {
    const page = await freshPage(); // APP_AUTH_READY starts UNRESOLVED in the harness
    await page.evaluate(() => {
      window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['aptron_profile_v1', 'po_coach_v1'] });
    });
    // Stale local data, as if left behind by a previous different user —
    // written while APP_AUTH_READY is still pending, exactly like a page
    // load with a not-yet-resolved session.
    await page.evaluate(() => {
      localStorage.setItem('aptron_profile_v1', JSON.stringify({ name: 'stale-previous-user' }));
    });
    // The reconcile/clear runs BEFORE APP_AUTH_READY resolves — this is the
    // exact ordering js/auth/main.js's markReady() uses.
    // Exploratory-only run (first-ever reconcile on THIS harness instance,
    // not asserted below) — the real race this test targets needs an
    // actual uid *change*, exercised properly on page2 below with a
    // pre-seeded aptron_last_uid.
    await page.evaluate(async () => {
      const mod = await import('/js/auth/user_scope.js');
      return mod.reconcileUserScope('uidB');
    });
    await page.close();

    const page2 = await freshPage();
    await page2.evaluate(() => { window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['aptron_profile_v1', 'po_coach_v1'] }); });
    await page2.evaluate(() => {
      localStorage.setItem('aptron_last_uid', 'uidA');
      localStorage.setItem('aptron_profile_v1', JSON.stringify({ name: 'stale-previous-user' }));
    });
    const orderResult = await page2.evaluate(async () => {
      const mod = await import('/js/auth/user_scope.js');
      const changed = mod.reconcileUserScope('uidB'); // BEFORE APP_AUTH_READY resolves
      const clearedBeforeReady = localStorage.getItem('aptron_profile_v1');
      window.__resolveAuthReady(); // NOW unblock sync.js's init()
      return { changed, clearedBeforeReady };
    });
    await wait(page2, 400); // let sync.js's init() + any push decision run to completion
    const afterInit = await page2.evaluate(() => ({
      profile: localStorage.getItem('aptron_profile_v1'),
      upserts: window.__testUpserts.map((u) => u.payload && u.payload.data),
    }));
    ok('T5a. reconcile clears the stale key BEFORE APP_AUTH_READY is resolved (not after)',
      orderResult.changed === true && orderResult.clearedBeforeReady === null);
    ok('T5b. sync init(), running after, never sees or pushes the stale data',
      afterInit.profile === null && afterInit.upserts.every((d) => !d || d.aptron_profile_v1 === undefined),
      JSON.stringify(afterInit));
    await page2.close();
  }

  // ── TEST 6 — normal sync still works (F1 fixed by suppression, not by
  //             disabling synchronization) ────────────────────────────────
  {
    const page = await freshPage();
    await page.evaluate(() => {
      window.initCloudSync({ appKey: 'goals', syncedPrefixes: ['aptron_profile_v1'] });
      window.__resolveAuthReady();
    });
    await wait(page, 300);
    await page.evaluate(() => { window.__testUpserts.length = 0; });

    // A genuine, ordinary edit — NOT part of any user-boundary clear.
    await page.evaluate(() => {
      localStorage.setItem('aptron_profile_v1', JSON.stringify({ name: 'admin', theme: 'gold' }));
    });
    await wait(page, 400); // past the 250ms debounce
    const pushed = await page.evaluate(() => window.__testUpserts.some((u) => {
      const d = u.payload && u.payload.data;
      return d && d.aptron_profile_v1 && d.aptron_profile_v1.theme === 'gold';
    }));
    ok('T6. an ordinary authenticated edit still triggers a real push (sync not globally disabled)', pushed === true);
    await page.close();
  }
} catch (e) {
  ok('FATAL during run', false, e.stack || e.message);
}

console.log('\n── user_scope <-> sync.js/gym-sync.js interaction regression (ADR-024 F1/F2) ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'} (${results.length} checks)`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
