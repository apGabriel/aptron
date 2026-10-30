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
// `style` is optional (bottomStyle/footwearStyle) -- omitted, it matches real
// unstyled ingestion (addFromImage() only sets the field when one is passed).
async function seedItem(page, color, category, style) {
  await page.evaluate(async ({ color, category, style }) => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 260;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, 200, 260);
    ctx.fillStyle = color; ctx.fillRect(40, 40, 120, 180);
    await window.Wardrobe.Closet.addFromImage(c.toDataURL('image/jpeg', 0.85), category, style);
  }, { color, category, style });
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

  // 10. Tier 43 regression: item-edit Save must never invent a garment
  // style. Root cause (Tier 42 audit): #wrItemStyle is pre-filled with
  // options[0] purely for DISPLAY when an item has no style yet
  // (renderItemStyleSelect()), and the old saveItem() trusted that displayed
  // value unconditionally -- so opening an unstyled footwear/bottoms item
  // and saving for ANY unrelated reason silently persisted 'boots'/
  // 'trousers' with no user choice behind it. Fixed via itemStyleTouched in
  // js/wardrobe.js.
  await seedItem(page, '#1b1b1b', 'footwear');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
  await page.waitForFunction(() => document.querySelectorAll('.wr-item[data-id]').length === 4);

  const shoeId = await page.evaluate(() =>
    window.Wardrobe.Store.items().find((i) => i.category === 'footwear').id);
  const bottomsId2 = await page.evaluate(() =>
    window.Wardrobe.Store.items().find((i) => i.category === 'bottoms').id);
  const getItem = (id) => page.evaluate((itemId) => {
    const items = JSON.parse(localStorage.getItem('wardrobe:items') || '[]');
    return items.find((i) => i.id === itemId);
  }, id);

  // 10a. Unstyled footwear item: open, edit an unrelated field, save ->
  // footwearStyle must stay unset (not silently become 'boots'). Also
  // verifies the display-only side of the same fix: an unstyled item's
  // selector must show the explicit "Not set" placeholder (empty value,
  // disabled option), not a real style pre-selected as if it were saved.
  await page.click(`.wr-item[data-id="${shoeId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  const unstyledDisplay = await page.evaluate(() => {
    const sel = document.getElementById('wrItemStyle');
    return { value: sel.value, placeholderDisabled: sel.options[0].disabled, placeholderLabel: sel.options[0].text };
  });
  ok('unstyled footwear: selector displays no real value (not silently "boots")',
    unstyledDisplay.value === '', 'value=' + JSON.stringify(unstyledDisplay.value));
  ok('unstyled footwear: selector shows a disabled "Not set" placeholder',
    unstyledDisplay.placeholderDisabled === true && unstyledDisplay.placeholderLabel === 'Not set',
    JSON.stringify(unstyledDisplay));
  await page.fill('#wrItemTags', 'everyday');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  let shoe = await getItem(shoeId);
  ok('unstyled footwear: unrelated edit+Save leaves footwearStyle unset', !shoe.footwearStyle,
    'footwearStyle=' + JSON.stringify(shoe.footwearStyle));
  ok('unstyled footwear: the unrelated edit itself WAS saved', (shoe.tags || []).includes('everyday'));

  // 10b. Unstyled bottoms item: same sequence -> bottomStyle stays unset.
  // Mirrors 10a's display check -- the "Not set" placeholder is rendered by
  // the same category-agnostic renderItemStyleSelect(), but verifying it
  // only for footwear would leave the bottoms side of the fix unconfirmed.
  await page.click(`.wr-item[data-id="${bottomsId2}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  const unstyledBottomsDisplay = await page.evaluate(() => {
    const sel = document.getElementById('wrItemStyle');
    return { value: sel.value, placeholderDisabled: sel.options[0].disabled, placeholderLabel: sel.options[0].text };
  });
  ok('unstyled bottoms: selector displays no real value (not silently "trousers")',
    unstyledBottomsDisplay.value === '', 'value=' + JSON.stringify(unstyledBottomsDisplay.value));
  ok('unstyled bottoms: selector shows a disabled "Not set" placeholder',
    unstyledBottomsDisplay.placeholderDisabled === true && unstyledBottomsDisplay.placeholderLabel === 'Not set',
    JSON.stringify(unstyledBottomsDisplay));
  await page.fill('#wrItemTags', 'weekend');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  let bottoms = await getItem(bottomsId2);
  ok('unstyled bottoms: unrelated edit+Save leaves bottomStyle unset', !bottoms.bottomStyle,
    'bottomStyle=' + JSON.stringify(bottoms.bottomStyle));

  // 10c. Explicitly selecting a footwear style IS persisted.
  await page.click(`.wr-item[data-id="${shoeId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.selectOption('#wrItemStyle', 'sneakers');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  shoe = await getItem(shoeId);
  ok('explicit footwear style selection is persisted', shoe.footwearStyle === 'sneakers',
    'footwearStyle=' + shoe.footwearStyle);

  // 10d. Explicitly selecting a bottoms style IS persisted.
  await page.click(`.wr-item[data-id="${bottomsId2}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.selectOption('#wrItemStyle', 'shorts');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  bottoms = await getItem(bottomsId2);
  ok('explicit bottoms style selection is persisted', bottoms.bottomStyle === 'shorts',
    'bottomStyle=' + bottoms.bottomStyle);

  // 10e. Item that already has a style: an unrelated edit+Save must not
  // disturb it (this already worked by coincidence before the fix; locking
  // it in so the fix doesn't regress it the other direction).
  await page.click(`.wr-item[data-id="${shoeId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.fill('#wrItemTags', 'everyday, sneakers');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  shoe = await getItem(shoeId);
  ok('existing footwear style survives an unrelated edit+Save', shoe.footwearStyle === 'sneakers',
    'footwearStyle=' + shoe.footwearStyle);

  // 11. Tier 45 regression: category-round-trip style display/persistence.
  // Root cause (Tier 44 audit): the #wrItemCat 'change' handler always
  // re-rendered #wrItemStyle with a hardcoded null "current value", even
  // when the newly-picked category was the item's own original one -- so
  // toggling category away and back redisplayed the bare default
  // (options[0]) instead of the item's real stored style, and clicking that
  // visibly-wrong default would silently overwrite the real value. Fixed in
  // js/wardrobe.js by having that handler look up itemOriginalStyle for the
  // newly-selected category instead of always passing null.

  // 11a. Already-styled BOTTOMS item: unrelated edit+Save preserves it.
  // (The footwear equivalent is already covered by 10e above.)
  await page.click(`.wr-item[data-id="${bottomsId2}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.fill('#wrItemTags', 'weekend, shorts');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  bottoms = await getItem(bottomsId2);
  ok('existing bottoms style survives an unrelated edit+Save', bottoms.bottomStyle === 'shorts',
    'bottomStyle=' + bottoms.bottomStyle);

  // 11b. Changing an EXISTING style to a DIFFERENT valid style persists the
  // new choice (10c/10d only covered unstyled -> styled).
  await page.click(`.wr-item[data-id="${shoeId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  const styleBeforeChange = await page.evaluate(() => document.getElementById('wrItemStyle').value);
  await page.selectOption('#wrItemStyle', 'boots');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  shoe = await getItem(shoeId);
  ok('changing an existing style to a different one persists the new choice',
    styleBeforeChange === 'sneakers' && shoe.footwearStyle === 'boots',
    'before=' + styleBeforeChange + ' after=' + shoe.footwearStyle);

  // Dedicated, explicitly-styled fixture for the category-transition
  // scenarios below. Captured by the exact id of the just-unshifted item
  // (Closet.addFromImage() has no return value; Store.items()[0] is always
  // the newest) rather than a category-only lookup, which is now ambiguous
  // -- two footwear items (shoeId + this one) exist at this point.
  await seedItem(page, '#2244aa', 'footwear', 'sneakers');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
  await page.waitForFunction(() => document.querySelectorAll('.wr-item[data-id]').length === 5);
  const catTestId = await page.evaluate(() => window.Wardrobe.Store.items()[0].id);
  ok('category-transition fixture seeded with the expected starting style',
    (await getItem(catTestId)).footwearStyle === 'sneakers');

  // 11c. Category away from the original (footwear -> bottoms), then back
  // to the original -- the selector must redisplay the item's real stored
  // style ('sneakers'), not the bare default ('boots').
  await page.click(`.wr-item[data-id="${catTestId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.selectOption('#wrItemCat', 'bottoms');
  await page.selectOption('#wrItemCat', 'footwear');
  const restoredValue = await page.evaluate(() => document.getElementById('wrItemStyle').value);
  ok('category round-trip restores the original style in the selector', restoredValue === 'sneakers',
    'restoredValue=' + restoredValue);
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  let catTestItem = await getItem(catTestId);
  ok('category round-trip, untouched selector, Save preserves the original style',
    catTestItem.footwearStyle === 'sneakers', 'footwearStyle=' + catTestItem.footwearStyle);

  // 11d. Category change away, Save WITHOUT returning and WITHOUT touching
  // the newly-shown (bottoms) selector -- must not invent a bottomStyle,
  // and must clear footwearStyle (no longer a footwear item).
  await page.click(`.wr-item[data-id="${catTestId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.selectOption('#wrItemCat', 'bottoms');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  catTestItem = await getItem(catTestId);
  ok('category change + untouched new selector + Save does not invent a bottomStyle',
    !catTestItem.bottomStyle, 'bottomStyle=' + JSON.stringify(catTestItem.bottomStyle));
  ok('category change clears the no-longer-applicable footwearStyle',
    !catTestItem.footwearStyle, 'footwearStyle=' + JSON.stringify(catTestItem.footwearStyle));
  ok('category change itself was saved', catTestItem.category === 'bottoms');

  // 11e. From this new bottoms category, explicitly selecting a style and
  // saving persists the correct field/value.
  await page.click(`.wr-item[data-id="${catTestId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.selectOption('#wrItemStyle', 'shorts');
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  catTestItem = await getItem(catTestId);
  ok('explicit style selection after a category change persists correctly',
    catTestItem.bottomStyle === 'shorts', 'bottomStyle=' + catTestItem.bottomStyle);

  // 11f. Category changed multiple times (bottoms -> footwear -> outerwear
  // -> footwear) before saving, style selector never touched -- no style
  // may bleed across categories, and the selector itself must show the
  // "Not set" placeholder for footwear (this item's true original category
  // is bottoms, not footwear, so there is nothing of its own to restore
  // there, and it must not look like a real "boots" selection either).
  await page.click(`.wr-item[data-id="${catTestId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.selectOption('#wrItemCat', 'footwear');
  await page.selectOption('#wrItemCat', 'outerwear');
  await page.selectOption('#wrItemCat', 'footwear');
  const multiToggleValue = await page.evaluate(() => document.getElementById('wrItemStyle').value);
  ok('multiple category changes: non-original category shows "Not set", not a bled-over style',
    multiToggleValue === '', 'multiToggleValue=' + JSON.stringify(multiToggleValue));
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  catTestItem = await getItem(catTestId);
  ok('multiple category changes: no style bleed, footwearStyle not invented',
    !catTestItem.footwearStyle, 'footwearStyle=' + JSON.stringify(catTestItem.footwearStyle));
  ok('multiple category changes: previous bottoms style correctly cleared',
    !catTestItem.bottomStyle, 'bottomStyle=' + JSON.stringify(catTestItem.bottomStyle));

  // 11g. Close WITHOUT saving after touching the style selector, then
  // reopen -- the earlier touch must not leak into the next session (a
  // stale itemStyleTouched would otherwise persist an unconfirmed pick).
  await seedItem(page, '#335577', 'footwear'); // fresh, unstyled
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wardrobe-changed')));
  await page.waitForFunction(() => document.querySelectorAll('.wr-item[data-id]').length === 6);
  const closeTestId = await page.evaluate(() => window.Wardrobe.Store.items()[0].id);

  await page.click(`.wr-item[data-id="${closeTestId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.selectOption('#wrItemStyle', 'boots'); // touch it, but never save
  await page.click('#wrItemClose');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  let closeTestItem = await getItem(closeTestId);
  ok('closing without saving leaves the item completely unchanged', !closeTestItem.footwearStyle,
    'footwearStyle=' + JSON.stringify(closeTestItem.footwearStyle));

  await page.click(`.wr-item[data-id="${closeTestId}"]`);
  await page.waitForSelector('#wrItemModalBg.show');
  await page.fill('#wrItemTags', 'reopened'); // unrelated edit; style selector untouched this time
  await page.click('#wrItemSave');
  await page.waitForFunction(() => !document.getElementById('wrItemModalBg').classList.contains('show'));
  closeTestItem = await getItem(closeTestId);
  ok('reopening after an unsaved close does not retain the earlier (never-saved) touch',
    !closeTestItem.footwearStyle, 'footwearStyle=' + JSON.stringify(closeTestItem.footwearStyle));

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
