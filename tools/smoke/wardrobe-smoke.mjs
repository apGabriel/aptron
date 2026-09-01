// Playwright smoke test for Wardrobe (js/wardrobe.js, css/wardrobe.css,
// wardrobe.html) — the 2026-09 UX pass (modal scroll-lock via js/topbar.js's
// shared MODAL_SELECTORS authority, Escape-to-close, persistent Saved-outfit
// badge, season-fit surfacing). Serves the repo over HTTP, BLOCKS Supabase
// (so the real cloud DB is never touched and the auth-gate never renders --
// the app runs local-only), seeds a few garments through the app's own real
// Closet.addFromImage() pipeline, and drives the actual Wardrobe UI while
// watching for uncaught errors. Same pattern as tools/smoke/theme-smoke.mjs.
//
// Native <input type="file"> pickers are outside CDP's reach (confirmed
// during the manual audit this test codifies — the OS-level color picker in
// js/account.js's Custom Theme customizer showed the identical limitation).
// Rather than fight that, this test seeds garments the same way the manual
// audit did: window.Wardrobe.Closet.addFromImage(dataUrl, category) is the
// exact function UI.confirmUpload() calls after a real file picker resolves
// -- same application code, only the picker step is skipped.
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

const PORT = 4604;   // distinct from smoke.mjs(4599)/theme-smoke.mjs(4600)/confirm-smoke.mjs(4601)/user-scope-smoke.mjs(4602)/user-scope-sync-interaction-smoke.mjs(4603)
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch();
const ctx = await browser.newContext();

// Hard guard: abort anything heading to Supabase, matching theme-smoke.mjs's
// verified technique -- blocking the @supabase bundle means js/auth/main.js
// never runs, so the auth-gate overlay never renders and the page boots
// local-only.
await ctx.route('**://*.supabase.co/**', r => r.abort());
await ctx.route('**/@supabase/**', r => r.abort());

const page = await ctx.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

const itemsCount = () => page.evaluate(() => (JSON.parse(localStorage.getItem('wardrobe:items') || '[]')).length);
const savedCount = () => page.evaluate(() => (JSON.parse(localStorage.getItem('wardrobe:saved_outfits') || '[]')).length);
const bodyLocked = () => page.evaluate(() => ({
  cls: document.body.classList.contains('topbar-modal-open'),
  overflow: getComputedStyle(document.body).overflow,
}));

// Generates a tiny solid-color swatch on a plain backdrop -- the same shape
// of synthetic garment image used during the real-browser manual audit, and
// enough for Vision's background-isolation + Color's k-means to run without
// throwing (both require a genuinely decodable image, not a 1x1 pixel).
async function seedItem(page, color, category) {
  await page.evaluate(async ({ color, category }) => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 260;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, 200, 260);
    ctx.fillStyle = color; ctx.fillRect(40, 40, 120, 180);
    await window.Wardrobe.Closet.addFromImage(c.toDataURL('image/jpeg', 0.85), category);
  }, { color, category });
}

try {
  await page.goto(`http://localhost:${PORT}/wardrobe.html`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.Wardrobe && window.AptTheme, { timeout: 8000 });

  // 1. Boot
  ok('Wardrobe + AptTheme present', await page.evaluate(() => !!(window.Wardrobe && window.AptTheme)));
  ok('wardrobe:* storage empty on first visit (no fixture leakage)', (await itemsCount()) === 0);

  // Force a deterministic season so season-fit assertions never depend on
  // the real calendar date: suitsSeason() hardcodes outerwear as
  // summer-inappropriate, so this alone makes the seeded outerwear item
  // reliably off-season without needing live/cached weather.
  await page.evaluate(() => {
    window.Wardrobe.Store.setSettings({ season: 'summer', tempC: null, location: '' });
  });

  // 2. Seed via the real Closet.addFromImage pipeline (see file header).
  await seedItem(page, '#2b3a55', 'tops');
  await seedItem(page, '#3a3a3a', 'bottoms');
  await seedItem(page, '#8a6a4e', 'outerwear');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
  await page.waitForSelector('.wr-item[data-id]');
  ok('3 seeded items persisted to wardrobe:items', (await itemsCount()) === 3);

  // 3. Category filtering
  await page.click('.wr-cat-chip[data-cat="outerwear"]');
  const outerwearVisible = await page.locator('.wr-closet-grid .wr-item[data-id]').count();
  ok('category filter shows only outerwear (1 item)', outerwearVisible === 1);
  await page.click('.wr-cat-chip[data-cat="all"]');
  const allVisible = await page.locator('.wr-closet-grid .wr-item[data-id]').count();
  ok('"All" filter restores all 3 items', allVisible === 3);

  // 4. Season-fit surfaces on the closet grid (reuses Weather.suitsSeason()).
  const offSeasonCount = await page.locator('.wr-item-offseason').count();
  ok('outerwear item marked off-season for forced "summer"', offSeasonCount === 1);

  // 5. Item modal: open, verify content, verify modal-lock, close via Escape.
  const outerwearId = await page.evaluate(() =>
    window.Wardrobe.Store.items().find(i => i.category === 'outerwear').id);
  await page.click(`.wr-item[data-id="${outerwearId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  ok('item modal opens', await page.locator('#wrItemModalBg').evaluate(el => el.classList.contains('show')));
  const seasonChip = await page.locator('#wrItemSeason').textContent();
  ok('modal season chip reflects off-season state', /Not summer/i.test(seasonChip || ''));
  const lockedState = await bodyLocked();
  ok('body gets topbar-modal-open while item modal is open', lockedState.cls === true);
  ok('body overflow is hidden while item modal is open', lockedState.overflow === 'hidden');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  ok('Escape closes the item modal', true);
  const unlockedState = await bodyLocked();
  ok('body modal-lock released after Escape close', unlockedState.cls === false && unlockedState.overflow !== 'hidden');

  // 6. Item lock cycle: neutral -> include -> exclude -> neutral.
  const lockBtn = page.locator(`.wr-item[data-id="${outerwearId}"] .wr-item-lock`);
  const cardLoc = page.locator(`.wr-item[data-id="${outerwearId}"]`);
  await lockBtn.click();
  ok('lock cycle: neutral -> include', await cardLoc.evaluate(el => el.classList.contains('wr-item-include')));
  await lockBtn.click();
  ok('lock cycle: include -> exclude', await cardLoc.evaluate(el => el.classList.contains('wr-item-exclude')));
  await lockBtn.click();
  ok('lock cycle: exclude -> neutral', await cardLoc.evaluate(el =>
    !el.classList.contains('wr-item-include') && !el.classList.contains('wr-item-exclude')));

  // 7. Generate outfits (needs >=1 top and >=1 bottom -- both seeded).
  await page.click('#wrGenBtn');
  await page.waitForSelector('#wrOutfits .wr-outfit-card', { timeout: 8000 });
  const outfitCount = await page.locator('#wrOutfits .wr-outfit-card').count();
  ok('Generate produces at least one outfit', outfitCount >= 1);

  // 8. Save outfit -> persistent badge (the actual regression this test
  // exists to lock in -- previously only a toast, indistinguishable a few
  // seconds later from an unsaved card).
  await page.click('#wrOutfits [data-save]');
  await page.waitForFunction(() => document.querySelector('#wrOutfits .wr-outfit-saved-badge'), { timeout: 4000 });
  ok('outfit persisted to wardrobe:saved_outfits', (await savedCount()) === 1);
  ok('generated card shows persistent Saved badge (not just a toast)',
    await page.locator('#wrOutfits .wr-outfit-saved-badge').count() === 1);
  ok('Saved Outfits panel shows the saved look', await page.locator('#wrSaved .wr-outfit-card').count() === 1);

  // 9. Remove saved outfit -> generated card's badge reverts to a Save button.
  await page.click('#wrSaved [data-remove]');
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('wardrobe:saved_outfits') || '[]')).length === 0);
  ok('removing clears wardrobe:saved_outfits', (await savedCount()) === 0);
  ok('Saved Outfits panel returns to empty state', await page.locator('#wrSaved .wr-empty').count() === 1);
  ok('generated card reverts from badge to a re-clickable Save button',
    await page.locator('#wrOutfits [data-save]').count() === outfitCount);

  await page.screenshot({ path: path.join(ROOT, 'tools/smoke/wardrobe-smoke.png'), fullPage: true });
} catch (e) {
  ok('FATAL during run', false, e.message);
}

// Same filter policy as theme-smoke.mjs: the intentional Supabase blocks and
// this static-file-only harness's lack of a proxy server produce expected
// network noise that is not a Wardrobe (or any application) bug.
const realConsole = consoleErrors.filter(t =>
  !/supabase|jsdelivr|Failed to load resource|net::ERR|ERR_FAILED|blocked|calendar-link/i.test(t));

console.log('\n── Wardrobe smoke results ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
if (pageErrors.length) { console.log('\nUncaught page errors:'); pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (realConsole.length) { console.log('\nConsole errors (non-network):'); realConsole.forEach(e => console.log('  ✗ ' + e)); }

const failed = results.filter(r => !r.pass).length + pageErrors.length + realConsole.length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'}  (screenshot: tools/smoke/wardrobe-smoke.png)`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
