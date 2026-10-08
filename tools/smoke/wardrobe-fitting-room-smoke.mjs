// Playwright smoke test for the Wardrobe "3D Outfit Visualization"
// fitting room (js/wardrobe-fitting-room/fitting-room.js,
// css/wardrobe-fitting-room.css, models/*.glb, and the small
// wardrobe.js integration hook in outfitCard()/renderOutfits()/
// renderSaved()). Same harness shape as tools/smoke/wardrobe-smoke.mjs:
// serves the repo over HTTP, BLOCKS Supabase (auth-gate never renders,
// app boots local-only, real cloud DB untouched), seeds garments
// through the app's own real Closet.addFromImage() pipeline, and
// drives the actual UI while watching for uncaught errors.
//
// Three.js itself is NOT blocked by default -- the whole point of this
// test is to exercise the real lazy-load path against the real CDN.
// A second pass (RUN_MODE=cdn-fail) blocks only the Three.js CDN to
// verify the "CDN unavailable" fail-closed state, and a third
// (RUN_MODE=webgl-fail) strips WebGL to verify that fail-closed state.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
  '.mjs':'text/javascript', '.json':'application/json', '.gif':'image/gif',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.glb':'model/gltf-binary' };

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

const PORT = 4605;   // distinct from smoke.mjs(4599)/theme-smoke.mjs(4600)/confirm-smoke.mjs(4601)/user-scope-smoke.mjs(4602)/user-scope-sync-interaction-smoke.mjs(4603)/wardrobe-smoke.mjs(4604)
await new Promise(r => server.listen(PORT, r));

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

async function seedItem(page, color, category) {
  await page.evaluate(async ({ color, category }) => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 260;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, 200, 260);
    ctx.fillStyle = color; ctx.fillRect(40, 40, 120, 180);
    await window.Wardrobe.Closet.addFromImage(c.toDataURL('image/jpeg', 0.85), category);
  }, { color, category });
}

async function runMainPass() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/@supabase/**', r => r.abort());

  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  try {
    await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.Wardrobe && window.AptTheme, { timeout: 8000 });

    // 1. Baseline: page works without Three.js ever having loaded.
    const threeLoadedAtBoot = await page.evaluate(() =>
      performance.getEntriesByType('resource').some(e => /three@/.test(e.name)));
    ok('Three.js NOT loaded on normal page load', threeLoadedAtBoot === false);
    ok('window.WardrobeFittingRoom registered (module present, nothing eager-loaded)',
      await page.evaluate(() => typeof window.WardrobeFittingRoom === 'object' && typeof window.WardrobeFittingRoom.open === 'function'));

    // Force winter so the outfit generator's needLayer logic includes an
    // outerwear piece (targetWarmth('winter')=6 >= 4) -- otherwise the
    // "outerwear not visualized" path can never be exercised.
    await page.evaluate(() => window.Wardrobe.Store.setSettings({ season: 'winter', tempC: null, location: '' }));

    // 2. Seed one item per category (all 5) via the real ingestion pipeline.
    await seedItem(page, '#2b3a55', 'tops');
    await seedItem(page, '#c0392b', 'bottoms');
    await seedItem(page, '#8a6a4e', 'outerwear');
    await seedItem(page, '#1b1b1b', 'footwear');
    await seedItem(page, '#d4a017', 'accessories');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.waitForSelector('.wr-item[data-id]');
    ok('5 seeded items persisted', (await page.evaluate(() =>
      JSON.parse(localStorage.getItem('wardrobe:items') || '[]').length)) === 5);

    // 3. Existing wardrobe behavior unchanged: generate outfits as before.
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
    ok('Generate still produces outfit cards', await page.locator('#wrOutfits .wr-outfit-card').count() >= 1);

    // 4. "Try in 3D" button present on the generated card, with all 5 pieces.
    const pieceCount = await page.evaluate(() => {
      const outfits = JSON.parse(localStorage.getItem('wardrobe:outfits') || '[]');
      return outfits[0] ? outfits[0].pieces.length : 0;
    });
    ok('first generated outfit carries all 5 piece categories (incl. outerwear)', pieceCount === 5, 'pieces=' + pieceCount);
    const try3dBtn = page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]');
    ok('"Try in 3D" button present on outfit card', await try3dBtn.count() === 1);

    // 5. Click it -- lazy-loads Three.js, builds the scene.
    await try3dBtn.click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    ok('fitting-room modal opens', true);

    // Loading state should show, then clear once the mannequin is ready.
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 }).then(() => ok('loading state clears once mannequin is ready', true))
      .catch(e => ok('loading state clears once mannequin is ready', false, e.message));

    const threeLoadedAfterOpen = await page.evaluate(() =>
      performance.getEntriesByType('resource').some(e => /three@0\.186\.0\/build\/three\.module\.js/.test(e.name)));
    ok('Three.js lazy-loaded only after "Try in 3D" click, pinned to 0.186.0', threeLoadedAfterOpen);

    await page.waitForTimeout(500); // let a few frames render + async garment loads settle
    const canvasSize = await page.evaluate(() => {
      const c = document.querySelector('#wrFitRoomViewport canvas');
      return c ? { w: c.clientWidth, h: c.clientHeight } : null;
    });
    ok('canvas present with non-zero size', !!canvasSize && canvasSize.w > 0 && canvasSize.h > 0, JSON.stringify(canvasSize));

    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-smoke-open.png') });

    // 6. Outerwear notice (winter season guarantees an outerwear piece).
    const noticeText = await page.evaluate(() => {
      const n = document.getElementById('wrFitRoomNotice');
      return n && !n.hidden ? n.textContent : '';
    });
    ok('explicit "outerwear not visualized yet" notice shown', /not visualized yet/i.test(noticeText), noticeText);

    // 7. Close, then reopen -- Three.js must NOT be fetched a second time.
    await page.click('.wr-fitroom-close');
    await page.waitForFunction(() => !document.getElementById('wrFitRoomModalBg').classList.contains('show'));
    ok('close works', true);

    const resourceCountBeforeReopen = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter(e => /three@0\.186\.0\/build\/three\.module\.js/.test(e.name)).length);
    await try3dBtn.click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForTimeout(300);
    const resourceCountAfterReopen = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter(e => /three@0\.186\.0\/build\/three\.module\.js/.test(e.name)).length);
    ok('second open reuses the already-loaded Three.js runtime (no duplicate fetch)',
      resourceCountAfterReopen === resourceCountBeforeReopen,
      `before=${resourceCountBeforeReopen} after=${resourceCountAfterReopen}`);

    // 8. Rotate (drag) + zoom (wheel) don't throw; bounded zoom doesn't runaway.
    const viewport = page.locator('#wrFitRoomViewport');
    const box = await viewport.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(200);
      ok('rotate/zoom interactions run without throwing', pageErrors.length === 0, pageErrors.join('; '));
    } else {
      ok('rotate/zoom interactions run without throwing', false, 'viewport not visible');
    }

    await page.click('.wr-fitroom-close');

    // 9. Saved-outfit card also gets the button and it works independently.
    await page.click('#wrOutfits [data-save]');
    await page.waitForFunction(() => document.querySelector('#wrOutfits .wr-outfit-saved-badge'), { timeout: 4000 });
    const savedTry3d = page.locator('#wrSaved .wr-outfit-card').first().locator('[data-try3d]');
    ok('"Try in 3D" also present on saved-outfit card', await savedTry3d.count() === 1);
    await savedTry3d.click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    ok('saved-outfit card\'s "Try in 3D" opens the viewer too', true);
    await page.click('.wr-fitroom-close');

    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-smoke-final.png'), fullPage: true });
  } catch (e) {
    ok('FATAL during main pass', false, e.message);
  }

  // Same filter policy as wardrobe-smoke.mjs: the intentional Supabase
  // route-abort produces a generic "Failed to load resource: net::ERR_FAILED"
  // with no identifying URL in the console text, not a feature bug.
  const realConsole = consoleErrors.filter(t =>
    !/supabase|jsdelivr|Failed to load resource|net::ERR|ERR_FAILED|blocked|calendar-link/i.test(t));

  await browser.close();
  return { pageErrors, consoleErrors: realConsole };
}

async function runCdnFailPass() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/@supabase/**', r => r.abort());
  // Block only the Three.js CDN -- everything else (including the rest of
  // the page) must keep working.
  await ctx.route('**://cdn.jsdelivr.net/npm/three@**', r => r.abort());

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  try {
    await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.Wardrobe && window.AptTheme, { timeout: 8000 });
    await seedItem(page, '#2b3a55', 'tops');
    await seedItem(page, '#c0392b', 'bottoms');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.waitForSelector('.wr-item[data-id]');
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && !st.hidden && /couldn.t load/i.test(st.textContent);
    }, { timeout: 8000 });
    ok('CDN failure: viewer shows a graceful "couldn\'t load" state, not a broken canvas', true);
    const canvasPresent = await page.evaluate(() => !!document.querySelector('#wrFitRoomViewport canvas'));
    ok('CDN failure: no canvas element left behind (nothing to break)', !canvasPresent);
    // Rest of the app still usable: close the modal and confirm wardrobe UI responds.
    await page.click('.wr-fitroom-close');
    await page.waitForFunction(() => !document.getElementById('wrFitRoomModalBg').classList.contains('show'));
    ok('CDN failure: rest of Wardrobe remains usable after closing the failed viewer', true);
  } catch (e) {
    ok('FATAL during CDN-fail pass', false, e.message);
  }

  await browser.close();
  return { pageErrors };
}

async function runConcurrentOpenPass() {
  // Regression test for a real race found during implementation review:
  // firing open() twice before the shared runtime/build promise settles
  // must NOT build two independent scenes (two renderers/canvases). Only
  // the outer build-promise memoization (not just the inner Three.js
  // import promise) prevents this -- see ensureViewerBuilt()'s comment.
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/@supabase/**', r => r.abort());

  const page = await ctx.newPage();
  try {
    await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.Wardrobe && window.AptTheme, { timeout: 8000 });
    await seedItem(page, '#2b3a55', 'tops');
    await seedItem(page, '#c0392b', 'bottoms');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.waitForSelector('.wr-item[data-id]');
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });

    // Fire open() twice back-to-back, synchronously, before either has a
    // chance to settle -- this is the actual race surface, independent of
    // real click-event timing.
    await page.evaluate(() => {
      const outfits = JSON.parse(localStorage.getItem('wardrobe:outfits') || '[]');
      window.WardrobeFittingRoom.open(outfits[0].pieces);
      window.WardrobeFittingRoom.open(outfits[0].pieces);
    });
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(300);

    const canvasCount = await page.evaluate(() => document.querySelectorAll('#wrFitRoomViewport canvas').length);
    ok('concurrent open() calls build exactly one canvas/renderer, not two', canvasCount === 1, 'canvasCount=' + canvasCount);
  } catch (e) {
    ok('FATAL during concurrent-open pass', false, e.message);
  }

  await browser.close();
}

async function runWebglFailPass() {
  const browser = await chromium.launch({ args: ['--disable-webgl', '--disable-webgl2', '--disable-gpu'] });
  const ctx = await browser.newContext();
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/@supabase/**', r => r.abort());
  // Belt-and-suspenders: Chromium flags alone don't reliably disable WebGL
  // in all configurations, so also neuter getContext for webgl/webgl2 via
  // an init script, matching how the viewer itself probes availability.
  await ctx.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (type === 'webgl' || type === 'webgl2') return null;
      return orig.call(this, type, ...rest);
    };
  });

  const page = await ctx.newPage();
  try {
    await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.Wardrobe && window.AptTheme, { timeout: 8000 });
    await seedItem(page, '#2b3a55', 'tops');
    await seedItem(page, '#c0392b', 'bottoms');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.waitForSelector('.wr-item[data-id]');
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && !st.hidden && /webgl/i.test(st.textContent);
    }, { timeout: 8000 });
    ok('WebGL failure: viewer shows a graceful WebGL-unavailable state', true);
  } catch (e) {
    ok('FATAL during WebGL-fail pass', false, e.message);
  }

  await browser.close();
}

const main = await runMainPass();
const cdnFail = await runCdnFailPass();
await runConcurrentOpenPass();
await runWebglFailPass();

console.log('\n── Wardrobe fitting-room smoke results ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
if (main.pageErrors.length) { console.log('\nUncaught page errors (main pass):'); main.pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (main.consoleErrors.length) { console.log('\nConsole errors (main pass, non-network):'); main.consoleErrors.forEach(e => console.log('  ✗ ' + e)); }
if (cdnFail.pageErrors.length) { console.log('\nUncaught page errors (CDN-fail pass):'); cdnFail.pageErrors.forEach(e => console.log('  ✗ ' + e)); }

const failed = results.filter(r => !r.pass).length + main.pageErrors.length + main.consoleErrors.length + cdnFail.pageErrors.length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'}  (screenshots: tools/smoke/wardrobe-fitting-room-smoke-*.png)`);

server.close();
process.exit(failed ? 1 : 0);
