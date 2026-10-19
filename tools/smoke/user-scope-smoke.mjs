// Playwright smoke test for js/auth/user_scope.js — the user-boundary
// helper added to fix the multi-user localStorage leak (ADR-024,
// supersedes/extends ADR-013). Pure localStorage logic, no Supabase
// calls in the module itself, so this serves the repo over HTTP and
// exercises the module directly via dynamic import() — no network
// mocking needed, no real project touched.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
  '.mjs':'text/javascript', '.json':'application/json' };

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

const PORT = 4602;   // distinct from smoke.mjs (4599) / theme-smoke.mjs (4600) / confirm-smoke.mjs (4601)
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });
const clearAll = () => page.evaluate(() => localStorage.clear());
const set = (obj) => page.evaluate((o) => { for (const k in o) localStorage.setItem(k, o[k]); }, obj);
const get = (keys) => page.evaluate((ks) => {
  const out = {}; ks.forEach((k) => { out[k] = localStorage.getItem(k); }); return out;
}, keys);

try {
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // ── 1. First-ever run on a browser (ADR-025, supersedes ADR-024's
  //      grandfather clause): a never-before-reconciled browser is
  //      indistinguishable from a stale/contaminated one, so it clears
  //      too — closing the recurring cross-account leak ADR-024's
  //      grandfather exception left open. ──
  await clearAll();
  await set({
    aptron_profile_v1: JSON.stringify({ name: 'admin', theme: 'neon' }),
    rb_routines_v1: JSON.stringify([{ id: 'r1' }]),
  });
  const r1 = await page.evaluate(async () => {
    const mod = await import('/js/auth/user_scope.js');
    const changed = mod.reconcileUserScope('uidA');
    return {
      changed,
      lastUid: localStorage.getItem('aptron_last_uid'),
      profileKept: localStorage.getItem('aptron_profile_v1') !== null,
      routinesKept: localStorage.getItem('rb_routines_v1') !== null,
    };
  });
  ok('1a. first-ever run on an unreconciled browser clears (ADR-025)', r1.changed === true);
  ok('1b. first-ever run records the uid', r1.lastUid === 'uidA');
  ok('1c. first-ever run removes pre-existing profile — no grandfathering', r1.profileKept === false);
  ok('1d. first-ever run removes pre-existing routines — no grandfathering', r1.routinesKept === false);

  // ── 2. Same user returns: no clear ──
  await set({ aptron_profile_v1: JSON.stringify({ name: 'uidA-own-profile' }) });
  const r2 = await page.evaluate(async () => {
    const mod = await import('/js/auth/user_scope.js');
    const changed = mod.reconcileUserScope('uidA');
    return { changed, profileKept: localStorage.getItem('aptron_profile_v1') !== null };
  });
  ok('2a. same uid returning does not clear', r2.changed === false);
  ok('2b. same uid returning preserves profile', r2.profileKept === true);

  // ── 3. Different user arrives: full clear of the scoped inventory,
  //      pending-profile + auth session survive ──
  await set({
    po_coach_v1: JSON.stringify({ sessions: [1] }),
    'cal_done:2026-08-20': 'true',
    'wardrobe:profile': '{}',
    'stack:items': '[]',
    quicknotes_v1: '[]',
    shenlong_memory_v1: JSON.stringify([{ text: 'user A likes squats', savedAt: 1 }]),
    aptron_pending_profile_v1: JSON.stringify({ name: 'brand-new-signup' }),
    'aptron-auth': 'session-token-blob',
  });
  const r3ch = await page.evaluate(async () => {
    const mod = await import('/js/auth/user_scope.js');
    return { changed: mod.reconcileUserScope('uidB'), lastUid: localStorage.getItem('aptron_last_uid') };
  });
  const r3 = await get(['aptron_profile_v1', 'rb_routines_v1', 'po_coach_v1', 'cal_done:2026-08-20',
    'wardrobe:profile', 'stack:items', 'quicknotes_v1', 'shenlong_memory_v1', 'aptron_pending_profile_v1', 'aptron-auth']);
  ok('3a. different uid triggers a clear', r3ch.changed === true);
  ok('3b. last uid updated to the new one', r3ch.lastUid === 'uidB');
  ok('3c. stale profile (name/theme) removed — RC-6/RC-7 root data', r3.aptron_profile_v1 === null);
  ok('3d. stale gym routines removed — RC-4/RC-5 root data', r3.rb_routines_v1 === null);
  ok('3e. stale gym coach state removed — RC-2 twin (gym-sync.js)', r3.po_coach_v1 === null);
  ok('3f. stale calendar UI marker removed', r3['cal_done:2026-08-20'] === null);
  ok('3g. stale wardrobe state removed', r3['wardrobe:profile'] === null);
  ok('3h. stale health/nutrition state removed', r3['stack:items'] === null);
  ok('3i. stale notes removed', r3.quicknotes_v1 === null);
  ok('3j. in-flight pending-signup stash is NOT touched (own-user race)', r3.aptron_pending_profile_v1 !== null);
  ok('3k. Supabase auth session key is NOT touched (owned by supabase-js)', r3['aptron-auth'] !== null);
  ok('3l. stale Shenlong AI memory removed — F2', r3.shenlong_memory_v1 === null);

  // ── 4. Logout clears synced state immediately, independent of any uid ──
  await clearAll();
  await set({ po_coach_v1: '{"x":1}' });
  const r4res = await page.evaluate(async () => {
    const mod = await import('/js/auth/user_scope.js');
    mod.clearOnLogout();
    return localStorage.getItem('po_coach_v1');
  });
  ok('4. appSignOut-time clear removes synced state', r4res === null);

  // ── 5. Coverage: every key/prefix the audit's root causes named is
  //      actually in the scoped inventory ──
  const r5 = await page.evaluate(async () => {
    const mod = await import('/js/auth/user_scope.js');
    const keys = mod.USER_SCOPED_KEYS, prefixes = mod.USER_SCOPED_PREFIXES;
    return {
      hasProfile: keys.indexOf('aptron_profile_v1') !== -1,
      hasCoach: keys.indexOf('po_coach_v1') !== -1,
      hasRoutines: keys.indexOf('rb_routines_v1') !== -1,
      hasWardrobePrefix: prefixes.indexOf('wardrobe:') !== -1,
      hasStackTakenPrefix: prefixes.indexOf('stack:taken:') !== -1,
      hasCalDonePrefix: prefixes.indexOf('cal_done:') !== -1,
      hasBackfillPrefix: prefixes.indexOf('po_cloud_backfilled_v1:') !== -1,
      hasShenlongMemory: keys.indexOf('shenlong_memory_v1') !== -1,
    };
  });
  ok('5. audit-identified keys/prefixes are all covered', Object.values(r5).every(Boolean), JSON.stringify(r5));

  // ── 6. Per-uid backfill flag: the bare pre-fix flag is NOT swept by a
  //      user-scope clear (gym-cloud.js needs to read it once to migrate),
  //      but a per-uid flag from a previous user IS ──
  await clearAll();
  await set({
    aptron_last_uid: 'uidA',
    po_cloud_backfilled_v1: '1',           // pre-fix bare flag
    'po_cloud_backfilled_v1:uidA': '1',    // post-fix per-uid flag
  });
  await page.evaluate(async () => {
    const mod = await import('/js/auth/user_scope.js');
    mod.reconcileUserScope('uidB');
  });
  const r6 = await get(['po_cloud_backfilled_v1', 'po_cloud_backfilled_v1:uidA']);
  ok('6a. bare pre-fix backfill flag survives a user-scope clear (migration path)', r6.po_cloud_backfilled_v1 === '1');
  ok('6b. per-uid backfill flag from the OLD user is cleared for the new one', r6['po_cloud_backfilled_v1:uidA'] === null);

  // ── 6c-6d. Genuinely fresh browser (nothing pre-existing) — ADR-025
  //      still clears (nothing to lose) and records the uid normally. ──
  await clearAll();
  const r6c = await page.evaluate(async () => {
    const mod = await import('/js/auth/user_scope.js');
    return { changed: mod.reconcileUserScope('uidFresh'), lastUid: localStorage.getItem('aptron_last_uid') };
  });
  ok('6c. genuinely fresh browser records the uid', r6c.lastUid === 'uidFresh');
  ok('6d. genuinely fresh browser reports a clear even with nothing to lose', r6c.changed === true);

  // ── 7. Structural guard: main.js gates APP_AUTH_READY behind the
  //      reconcile, and appSignOut clears before signOut() — regression
  //      tripwire for the ordering the whole fix depends on. ──
  const mainSrc = fs.readFileSync(path.join(ROOT, 'js/auth/main.js'), 'utf8');
  const reconcileIdx = mainSrc.indexOf('reconcileUserScope(uid)');
  const resolveIdx = mainSrc.indexOf('resolveReady()', reconcileIdx);
  ok('7a. reconcileUserScope runs before resolveReady() in markReady()',
    reconcileIdx !== -1 && resolveIdx !== -1 && reconcileIdx < resolveIdx);
  const clearOnLogoutIdx = mainSrc.indexOf('clearOnLogout()');
  const signOutIdx = mainSrc.indexOf('supa.auth.signOut()');
  ok('7b. clearOnLogout runs before supa.auth.signOut() in appSignOut',
    clearOnLogoutIdx !== -1 && signOutIdx !== -1 && clearOnLogoutIdx < signOutIdx);

} catch (e) {
  ok('FATAL during run', false, e.message);
}

console.log('\n── User-scope (multi-user isolation) smoke results ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);

const failed = results.filter(r => !r.pass).length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'} (${results.length} checks)`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
