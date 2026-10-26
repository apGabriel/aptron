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

async function seedItem(page, color, category, style) {
  await page.evaluate(async ({ color, category, style }) => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 260;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, 200, 260);
    ctx.fillStyle = color; ctx.fillRect(40, 40, 120, 180);
    await window.Wardrobe.Closet.addFromImage(c.toDataURL('image/jpeg', 0.85), category, style);
  }, { color, category, style });
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

// Tier 1 garment-fidelity fix: bottomStyle/footwearStyle are optional,
// user-set signals the viewer uses to honestly disclose a shape mismatch
// (e.g. shorts rendered via the shared trousers-colored mesh, sneakers
// rendered via the one boots.glb model) instead of silently implying the
// wrong shape is correct. No new geometry exists yet, so this only checks
// the disclosure text, never "looks right" -- that's the documented Tier 1
// ceiling (see the plan this fix was built from).
async function runGarmentSubtypePass() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/@supabase/**', r => r.abort());

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  function noticeText(page) {
    return page.evaluate(() => {
      const n = document.getElementById('wrFitRoomNotice');
      return n && !n.hidden ? n.textContent : '';
    });
  }

  try {
    await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.Wardrobe && window.AptTheme, { timeout: 8000 });

    // Outfit A: explicit shorts + explicit sneakers -- both disclosures expected.
    await seedItem(page, '#2b3a55', 'tops');
    await seedItem(page, '#7a7a7a', 'bottoms', 'shorts');
    await seedItem(page, '#e8e8e8', 'footwear', 'sneakers');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.waitForSelector('.wr-item[data-id]');
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });

    const outfitA = await page.evaluate(() => JSON.parse(localStorage.getItem('wardrobe:outfits') || '[]')[0]);
    ok('generated outfit carries bottomStyle/footwearStyle through to pieces',
      outfitA && outfitA.pieces.some(p => p.bottomStyle === 'shorts') && outfitA.pieces.some(p => p.footwearStyle === 'sneakers'),
      JSON.stringify(outfitA && outfitA.pieces));

    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(400);

    let text = await noticeText(page);
    ok('shorts item: viewer discloses it can\'t show the real shape (not silently shown as trousers)',
      /shorts.*can.t be changed|isn.t trousers/i.test(text), text);
    // Tier 2: sneakers now have real geometry (models/sneakers.glb), so the
    // Tier 1 "generic boot placeholder" disclosure must NOT appear for them
    // anymore -- that was only ever a stand-in for the missing asset.
    ok('sneakers item: no placeholder disclosure now that real sneaker geometry exists',
      !/isn.t boot-shaped|generic boot placeholder/i.test(text), text);
    ok('sneakers.glb was actually fetched (real asset loaded, not inferred from absent disclosure alone)',
      await page.evaluate(() => performance.getEntriesByType('resource').some(e => /sneakers\.glb/.test(e.name))));

    await page.click('.wr-fitroom-close');
    await page.waitForFunction(() => !document.getElementById('wrFitRoomModalBg').classList.contains('show'));

    // Outfit B, same session: default/unset style on a fresh pair of items --
    // must render with NO new disclosure text (backward-compat default), and
    // must not carry over Outfit A's stale shorts/sneakers notices.
    await page.evaluate(() => window.Wardrobe.Closet.remove(JSON.parse(localStorage.getItem('wardrobe:items'))[0].id));
    await seedItem(page, '#333333', 'bottoms', 'trousers');
    await seedItem(page, '#5a3d2b', 'footwear', 'boots');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(400);

    text = await noticeText(page);
    ok('trousers + boots outfit: no mismatch notice shown (default/explicit-match case stays silent, no cross-outfit bleed)',
      !/shorts|boot-shaped|placeholder/i.test(text), text);

    await page.click('.wr-fitroom-close');

    // Defensive: a value the UI's own enum could never produce (direct
    // Closet.update patch, bypassing the <select>) must still disclose
    // gracefully, not throw. Tier 43: this no longer falls back to the
    // boots model (see fitting-room.js updateBoots()) -- it now gets the
    // same neutral "no footwear" treatment as an unset style, so boots.glb
    // must NOT gain a new fetch from this step (it was already fetched
    // earlier in this same pass, by the explicit-'boots' Outfit B case
    // above, so the assertion is "no additional fetch", not "zero ever").
    const bootsFetchCountBeforeSandals = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter(e => /boots\.glb/.test(e.name)).length);
    await page.evaluate(() => {
      const items = JSON.parse(localStorage.getItem('wardrobe:items'));
      const shoe = items.find(i => i.category === 'footwear');
      window.Wardrobe.Closet.update(shoe.id, { footwearStyle: 'sandals' });
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(400);
    text = await noticeText(page);
    ok('unrecognized footwearStyle value ("sandals") discloses gracefully, does not crash, and does not guess a shoe model',
      pageErrors.length === 0 && /shoe shape.*isn.t set yet/i.test(text), 'pageErrors=' + pageErrors.join('; ') + ' text=' + text);
    const bootsFetchCountAfterSandals = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter(e => /boots\.glb/.test(e.name)).length);
    ok('unrecognized footwearStyle value ("sandals") does not trigger a new boots.glb fetch',
      bootsFetchCountAfterSandals === bootsFetchCountBeforeSandals,
      `before=${bootsFetchCountBeforeSandals} after=${bootsFetchCountAfterSandals}`);

    await page.click('.wr-fitroom-close');
  } catch (e) {
    ok('FATAL during garment-subtype pass', false, e.message);
  }

  await browser.close();
  return { pageErrors };
}

// Tier 11: trousers overlay prop (bottomStyle === 'trousers') gained real
// geometry (models/trousers.glb -- CC0, Teh_Bucket/OpenGameArt, see
// Third-Party Models.md). The module exposes only {open, close} on
// window.WardrobeFittingRoom, so there is no runtime hook to read the live
// Three.js material's .emissive/.color off viewer.props.trousers directly
// from a black-box test. The emissive fix instead lives in the committed
// asset itself (corrected at conversion time, not patched at runtime), so
// the one deterministic, pixel-independent way to verify it is a static,
// Node-side read of the committed GLB's own material JSON -- the actual
// shipped fact, not a runtime-mutated copy.
function checkTrousersGlbMaterial() {
  const buf = fs.readFileSync(path.join(ROOT, 'models/trousers.glb'));
  const jsonChunkLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonChunkLength).toString('utf8'));
  const mat = json.materials && json.materials[0];
  const emissiveOk = !!mat && Array.isArray(mat.emissiveFactor) &&
    mat.emissiveFactor[0] === 0 && mat.emissiveFactor[1] === 0 && mat.emissiveFactor[2] === 0;
  const hasTexture = !!mat && !!mat.pbrMetallicRoughness && !!mat.pbrMetallicRoughness.baseColorTexture;
  const hasEmbeddedImage = !!(json.images && json.images[0] && json.images[0].bufferView !== undefined && !json.images[0].uri);
  ok('models/trousers.glb material has zero emissive contribution (committed asset, not a runtime patch)',
    emissiveOk, JSON.stringify(mat && mat.emissiveFactor));
  ok('models/trousers.glb material keeps its base-color texture reference (tintable via material.color)',
    hasTexture);
  ok('models/trousers.glb texture is embedded (no external texture URI required)',
    hasEmbeddedImage, JSON.stringify(json.images));
}

// Tier 11: trousers prop load, recolor caching, and coexistence with both
// existing footwear props. Does not duplicate the shorts-disclosure checks
// already covered by runGarmentSubtypePass above -- only re-exercises the
// shorts path once, to confirm it still works unchanged alongside the new
// trousers geometry, not in isolation.
async function runTrousersPass() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/@supabase/**', r => r.abort());

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  function noticeText(page) {
    return page.evaluate(() => {
      const n = document.getElementById('wrFitRoomNotice');
      return n && !n.hidden ? n.textContent : '';
    });
  }

  try {
    await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.Wardrobe && window.AptTheme, { timeout: 8000 });

    // Outfit A: explicit trousers + boots.
    await seedItem(page, '#2b3a55', 'tops');
    await seedItem(page, '#2a3f6b', 'bottoms', 'trousers');
    await seedItem(page, '#5a3d2b', 'footwear', 'boots');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.waitForSelector('.wr-item[data-id]');
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(600); // let the async trousers/boots prop loads settle

    ok('trousers.glb actually fetched for bottomStyle "trousers"',
      await page.evaluate(() => performance.getEntriesByType('resource').some(e => /trousers\.glb/.test(e.name))));

    let text = await noticeText(page);
    ok('trousers + boots: no shorts/shape-mismatch notice shown (trousers has real geometry now)',
      !/shorts|boot-shaped|placeholder|trousers preview/i.test(text), text);

    // Supplementary rendered-output evidence (not the primary tint check,
    // which is the static GLB-material assertion above): a full-page
    // screenshot for manual/visual review, same pattern as the existing
    // wardrobe-fitting-room-smoke-{open,final}.png artifacts. A direct
    // in-page canvas pixel sample was tried and discarded here -- the real
    // viewer's renderer is constructed without preserveDrawingBuffer (see
    // buildViewer()), so by the time a separate page.evaluate() round-trip
    // reads the canvas, the browser has already presented and cleared the
    // drawing buffer, yielding all-zero/transparent pixels regardless of
    // what was actually rendered. That read would be a false positive, not
    // a real check, so it is not included as an assertion.
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-trousers-boots.png') });

    await page.click('.wr-fitroom-close');
    await page.waitForFunction(() => !document.getElementById('wrFitRoomModalBg').classList.contains('show'));

    // Close/reopen: trousers.glb must not be re-fetched a second time.
    const trousersFetchCountBeforeReopen = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter(e => /trousers\.glb/.test(e.name)).length);
    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForTimeout(400);
    const trousersFetchCountAfterReopen = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter(e => /trousers\.glb/.test(e.name)).length);
    ok('close/reopen reuses the cached trousers prop (no duplicate fetch)',
      trousersFetchCountAfterReopen === trousersFetchCountBeforeReopen,
      `before=${trousersFetchCountBeforeReopen} after=${trousersFetchCountAfterReopen}`);
    const canvasCount = await page.evaluate(() => document.querySelectorAll('#wrFitRoomViewport canvas').length);
    ok('close/reopen does not duplicate the canvas', canvasCount === 1, 'canvasCount=' + canvasCount);

    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-trousers-boots-reopened.png') });

    await page.click('.wr-fitroom-close');
    await page.waitForFunction(() => !document.getElementById('wrFitRoomModalBg').classList.contains('show'));

    // Outfit B, same session: trousers + sneakers instead of boots -- must
    // coexist independently, no notice bleed from Outfit A.
    await page.evaluate(() => {
      const items = JSON.parse(localStorage.getItem('wardrobe:items'));
      const shoe = items.find(i => i.category === 'footwear');
      window.Wardrobe.Closet.update(shoe.id, { footwearStyle: 'sneakers' });
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(600);

    ok('sneakers.glb also fetched alongside trousers in the same outfit',
      await page.evaluate(() => performance.getEntriesByType('resource').some(e => /sneakers\.glb/.test(e.name))));
    text = await noticeText(page);
    ok('trousers + sneakers: no notice bleed from the previous boots outfit', text === '', JSON.stringify(text));

    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-trousers-sneakers.png') });

    await page.click('.wr-fitroom-close');
    await page.waitForFunction(() => !document.getElementById('wrFitRoomModalBg').classList.contains('show'));

    // Outfit C: explicit shorts -- the unchanged disclosure notice must
    // still show, and the trousers prop must be hidden (not visible
    // underneath/alongside the shorts-colored mannequin Pants material).
    await page.evaluate(() => {
      const items = JSON.parse(localStorage.getItem('wardrobe:items'));
      const bottomItem = items.find(i => i.category === 'bottoms');
      window.Wardrobe.Closet.update(bottomItem.id, { bottomStyle: 'shorts' });
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
    await page.click('#wrGenBtn');
    await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
    await page.locator('#wrOutfits .wr-outfit-card').first().locator('[data-try3d]').click();
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(400);
    text = await noticeText(page);
    ok('shorts item still shows the unchanged shape-disclosure notice alongside real trousers geometry existing elsewhere',
      /shorts.*can.t be changed/i.test(text), text);

    await page.click('.wr-fitroom-close');
  } catch (e) {
    ok('FATAL during trousers pass', false, e.message);
  }

  await browser.close();
  return { pageErrors };
}

// Tier 40: regression test for a state-bleed bug found during review --
// viewer.materials.Shirt/Pants are long-lived (built once in buildViewer(),
// reused across every open()/close()), so applyOutfit() only ever WROTE a
// color into them when that category was present in the outfit, never
// reset them when a later outfit omitted the category -- leaving the
// previous outfit's shirt/trousers color visibly bleeding through onto a
// mannequin that outfit no longer has anything to say about. The fix
// restores the mannequin's own originally-authored color (captured once,
// at build time, before any outfit is ever applied) whenever a category is
// absent. There is no DOM-observable signal for this (unlike the
// notice-text checks elsewhere in this file) -- Shirt/Pants recoloring
// produces no notice, and reading the live, continuously-re-rendered WebGL
// canvas back via a second page.evaluate() round-trip is the same
// unreliable readback already rejected by runTrousersPass()'s comment
// above (no preserveDrawingBuffer, so the drawing buffer can already be
// cleared by the time the round-trip resumes). This pass therefore only
// asserts the automatable facts (no crash, modal opens/closes cleanly
// through every transition) and captures a screenshot at each state for
// direct visual review -- it does NOT claim to prove the color reset by
// itself; that claim is made separately, from actually looking at the
// screenshots.
async function runStateBleedPass() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/@supabase/**', r => r.abort());

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  // The real outfit generator (#wrGenBtn) requires at least one top AND one
  // bottom to ever emit a card (see js/wardrobe.js simulate(): it iterates
  // tops, pairs each with its best-scoring bottom, and skips entirely when
  // no bottom exists) -- it can never produce the "neither category"/
  // "one category only" combinations this regression needs. Calling
  // window.WardrobeFittingRoom.open() directly with hand-built pieces is
  // the same technique runConcurrentOpenPass already uses above (passing
  // outfits[0].pieces straight to open()), just with explicit category
  // control instead of reading a real generated outfit.
  async function openPieces(pieces) {
    await page.evaluate((p) => { window.WardrobeFittingRoom.open(p); }, pieces);
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(500);
  }

  async function closeModal() {
    await page.evaluate(() => window.WardrobeFittingRoom.close());
    await page.waitForFunction(() => !document.getElementById('wrFitRoomModalBg').classList.contains('show'));
  }

  try {
    await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.Wardrobe && window.AptTheme && window.WardrobeFittingRoom, { timeout: 8000 });

    // 1. Baseline outfit with a saturated, easy-to-recognize shirt AND
    // trousers color -- both base-mannequin categories present.
    await openPieces([
      { category: 'tops', color: '#1b5e4f' },                       // teal
      { category: 'bottoms', color: '#5b2c91', bottomStyle: 'trousers' } // purple
    ]);
    ok('state-bleed: colored baseline outfit opens cleanly', pageErrors.length === 0, pageErrors.join('; '));
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-state-bleed-1-colored.png') });
    await closeModal();

    // 2. New outfit with NEITHER tops nor bottoms -- only footwear/accessories.
    await openPieces([
      { category: 'footwear', color: '#1b1b1b', footwearStyle: 'boots' },
      { category: 'accessories', color: '#d4a017' }
    ]);
    ok('state-bleed: outfit with neither tops nor bottoms opens cleanly after a colored outfit', pageErrors.length === 0, pageErrors.join('; '));
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-state-bleed-2-neither.png') });
    await closeModal();

    // 3. New outfit with ONLY bottoms (no tops) -- Shirt must reset to
    // default, Pants must take the new color, not the Tier-1 purple.
    await openPieces([
      { category: 'bottoms', color: '#d4751c', bottomStyle: 'trousers' }, // orange
      { category: 'footwear', color: '#1b1b1b', footwearStyle: 'boots' }
    ]);
    ok('state-bleed: bottoms-only outfit opens cleanly', pageErrors.length === 0, pageErrors.join('; '));
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-state-bleed-3-bottoms-only.png') });
    await closeModal();

    // 4. New outfit with ONLY tops (no bottoms) -- Pants must reset to
    // default, Shirt must take the new color, not the Tier-1 teal.
    await openPieces([
      { category: 'tops', color: '#c23b7a' }, // pink
      { category: 'footwear', color: '#1b1b1b', footwearStyle: 'boots' }
    ]);
    ok('state-bleed: tops-only outfit opens cleanly', pageErrors.length === 0, pageErrors.join('; '));
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-state-bleed-4-tops-only.png') });
    await closeModal();
  } catch (e) {
    ok('FATAL during state-bleed pass', false, e.message);
  }

  await browser.close();
  return { pageErrors };
}

// Tier 43: regression test for the footwear-style fallback fix in
// updateBoots() (fitting-room.js) -- an unspecified/unrecognized
// footwearStyle must no longer silently select either boots.glb or
// sneakers.glb (Tier 42's audit found the real ingestion flow leaves this
// field unset unless the user explicitly picks a style, so the old
// `piece.footwearStyle || 'boots'` fallback misrepresented ordinary
// sneakers as boots for most real items). Uses
// window.WardrobeFittingRoom.open() directly, same technique as
// runStateBleedPass() above, for exact per-case control over the style
// value -- the real outfit generator has no way to force a specific value
// deterministically case to case.
//
// What this proves: which GLB (if any) gets FETCHED for each style value
// (a reliable, real network-level signal), and the notice text each case
// produces. What it does NOT prove: that the mannequin's own feet/socks
// are actually VISIBLE on screen at each step -- there is no safe way to
// read the live, continuously-re-rendered WebGL canvas back from a second
// page.evaluate() round-trip (no preserveDrawingBuffer; see
// runTrousersPass()'s comment above), and the module deliberately exposes
// only {open, close}, no internal state accessor. Screenshots are captured
// at each step for direct visual review of that specific claim instead.
async function runUnknownFootwearStylePass() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/@supabase/**', r => r.abort());

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  async function openPieces(pieces) {
    await page.evaluate((p) => { window.WardrobeFittingRoom.open(p); }, pieces);
    await page.waitForSelector('#wrFitRoomModalBg.show', { timeout: 4000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('wrFitRoomState');
      return st && st.hidden === true;
    }, { timeout: 20000 });
    await page.waitForTimeout(500);
  }
  async function closeModal() {
    await page.evaluate(() => window.WardrobeFittingRoom.close());
    await page.waitForFunction(() => !document.getElementById('wrFitRoomModalBg').classList.contains('show'));
  }
  function noticeText() {
    return page.evaluate(() => {
      const n = document.getElementById('wrFitRoomNotice');
      return n && !n.hidden ? n.textContent : '';
    });
  }
  function fetchCount(pattern) {
    return page.evaluate((p) =>
      performance.getEntriesByType('resource').filter(e => new RegExp(p).test(e.name)).length, pattern);
  }

  try {
    await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.Wardrobe && window.AptTheme && window.WardrobeFittingRoom, { timeout: 8000 });

    // 1. footwearStyle field entirely absent -- the real, most common case
    // (an item never edited through the style chip/select).
    await openPieces([{ category: 'footwear', color: '#5a3d2b' }]);
    ok('missing footwearStyle: boots.glb NOT fetched', (await fetchCount('boots\\.glb')) === 0);
    ok('missing footwearStyle: sneakers.glb NOT fetched', (await fetchCount('sneakers\\.glb')) === 0);
    let text = await noticeText();
    ok('missing footwearStyle: neutral "shoe shape isn\'t set" notice shown, not a silent guess',
      /shoe shape.*isn.t set yet/i.test(text), text);
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-unknown-footwear-1-missing.png') });
    await closeModal();

    // 2. footwearStyle explicitly null (what Closet.update's default patch
    // actually stores) -- same neutral path as case 1.
    await openPieces([{ category: 'footwear', color: '#5a3d2b', footwearStyle: null }]);
    ok('null footwearStyle: boots.glb still not fetched', (await fetchCount('boots\\.glb')) === 0);
    ok('null footwearStyle: sneakers.glb still not fetched', (await fetchCount('sneakers\\.glb')) === 0);
    await closeModal();

    // 3. Unrecognized explicit value -- same neutral path, not a third
    // silent guess.
    await openPieces([{ category: 'footwear', color: '#5a3d2b', footwearStyle: 'sandals' }]);
    ok('unrecognized footwearStyle ("sandals"): boots.glb still not fetched', (await fetchCount('boots\\.glb')) === 0);
    ok('unrecognized footwearStyle ("sandals"): sneakers.glb still not fetched', (await fetchCount('sneakers\\.glb')) === 0);
    await closeModal();

    // 4. Explicit 'boots' DOES fetch boots.glb, exactly once, no notice.
    await openPieces([{ category: 'footwear', color: '#5a3d2b', footwearStyle: 'boots' }]);
    ok('explicit "boots": boots.glb fetched exactly once', (await fetchCount('boots\\.glb')) === 1);
    ok('explicit "boots": sneakers.glb still never fetched', (await fetchCount('sneakers\\.glb')) === 0);
    text = await noticeText();
    ok('explicit "boots": no footwear notice', !/shoe shape|placeholder/i.test(text), text);
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-unknown-footwear-2-explicit-boots.png') });
    await closeModal();

    // 5. Explicit 'sneakers' DOES fetch sneakers.glb, no notice.
    await openPieces([{ category: 'footwear', color: '#5a3d2b', footwearStyle: 'sneakers' }]);
    ok('explicit "sneakers": sneakers.glb fetched exactly once', (await fetchCount('sneakers\\.glb')) === 1);
    text = await noticeText();
    ok('explicit "sneakers": no footwear notice', !/shoe shape|placeholder/i.test(text), text);
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-unknown-footwear-3-explicit-sneakers.png') });
    await closeModal();

    // 6. Boots, then an unknown-style outfit right after -- the notice
    // must switch to the neutral explanation (proving this code path ran
    // again, not stuck showing the previous boots state); no safe
    // automated readback of the boots prop's actual .visible exists (see
    // function-level comment above), so the "not left stale-visible" claim
    // itself rests on the screenshot, reviewed directly, not on this
    // assertion alone.
    await openPieces([{ category: 'footwear', color: '#5a3d2b', footwearStyle: 'boots' }]);
    await closeModal();
    await openPieces([{ category: 'footwear', color: '#5a3d2b' }]);
    text = await noticeText();
    ok('boots outfit immediately followed by unknown-style outfit: notice switches to the neutral explanation',
      /shoe shape.*isn.t set yet/i.test(text), text);
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-unknown-footwear-4-boots-then-unknown.png') });
    await closeModal();

    // 7. Unrelated categories (tops/trousers/accessories) alongside an
    // unknown-style footwear piece in the SAME outfit -- no cross-category
    // regression from this fix.
    await openPieces([
      { category: 'tops', color: '#2b3a55' },
      { category: 'bottoms', color: '#2a3f6b', bottomStyle: 'trousers' },
      { category: 'footwear', color: '#5a3d2b' },
      { category: 'accessories', color: '#d4a017' }
    ]);
    ok('unrelated categories (tops/trousers/accessories) unaffected alongside unknown-style footwear in the same outfit',
      pageErrors.length === 0, pageErrors.join('; '));
    await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-fitting-room-unknown-footwear-5-mixed-outfit.png') });
    await closeModal();
  } catch (e) {
    ok('FATAL during unknown-footwear-style pass', false, e.message);
  }

  await browser.close();
  return { pageErrors };
}

checkTrousersGlbMaterial();
const main = await runMainPass();
const cdnFail = await runCdnFailPass();
await runConcurrentOpenPass();
await runWebglFailPass();
const subtype = await runGarmentSubtypePass();
const trousers = await runTrousersPass();
const stateBleed = await runStateBleedPass();
const unknownFootwear = await runUnknownFootwearStylePass();

console.log('\n── Wardrobe fitting-room smoke results ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
if (main.pageErrors.length) { console.log('\nUncaught page errors (main pass):'); main.pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (main.consoleErrors.length) { console.log('\nConsole errors (main pass, non-network):'); main.consoleErrors.forEach(e => console.log('  ✗ ' + e)); }
if (cdnFail.pageErrors.length) { console.log('\nUncaught page errors (CDN-fail pass):'); cdnFail.pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (subtype.pageErrors.length) { console.log('\nUncaught page errors (garment-subtype pass):'); subtype.pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (trousers.pageErrors.length) { console.log('\nUncaught page errors (trousers pass):'); trousers.pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (stateBleed.pageErrors.length) { console.log('\nUncaught page errors (state-bleed pass):'); stateBleed.pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (unknownFootwear.pageErrors.length) { console.log('\nUncaught page errors (unknown-footwear-style pass):'); unknownFootwear.pageErrors.forEach(e => console.log('  ✗ ' + e)); }

const failed = results.filter(r => !r.pass).length + main.pageErrors.length + main.consoleErrors.length + cdnFail.pageErrors.length + subtype.pageErrors.length + trousers.pageErrors.length + stateBleed.pageErrors.length + unknownFootwear.pageErrors.length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'}  (screenshots: tools/smoke/wardrobe-fitting-room-smoke-*.png)`);

server.close();
process.exit(failed ? 1 : 0);
