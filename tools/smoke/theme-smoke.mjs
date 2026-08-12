// Playwright smoke test for the Custom Theme Engine (js/theme.js, Preferences
// customizer in js/account.js). Serves the repo over HTTP, BLOCKS Supabase (so
// the real cloud DB is never touched and the auth-gate never renders — the app
// runs local-only, exactly the pattern smoke.mjs already established for Gym),
// seeds a known baseline theme, loads index.html in a real Chromium, and drives
// the actual Preferences UI while watching for uncaught errors.
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

const PORT = 4600;   // distinct from smoke.mjs's 4599 so both can run independently
await new Promise(r => server.listen(PORT, r));

// Baseline: a real built-in theme, deliberately not "dark" (the no-attribute
// default) so Cancel-restoration and Reset are each unambiguous to observe.
const SEED = { aptron_profile_v1: JSON.stringify({ theme: 'nordic' }) };

const browser = await chromium.launch();
const ctx = await browser.newContext();

// Hard guard: abort anything heading to Supabase so real data is never
// touched. Also confirmed (this session) that blocking the @supabase bundle
// means js/auth/main.js never runs, so the .auth-gate overlay never renders
// at all -- real page.click()/page.fill() work throughout with no workaround.
await ctx.route('**://*.supabase.co/**', r => r.abort());
await ctx.route('**/@supabase/**', r => r.abort());

const page = await ctx.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// addInitScript re-runs on every navigation, including page.reload() -- guard
// it to only seed once, or the reload assertion below would always see the
// baseline re-applied instead of whatever the test itself just saved.
await page.addInitScript(seed => {
  if (!localStorage.getItem('__smoke_seeded__')) {
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    localStorage.setItem('__smoke_seeded__', '1');
  }
}, SEED);

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

// Reads observable, persisted state -- never internal engine functions --
// matching this suite's own philosophy of testing the application, not its
// own implementation.
const getProfile = () => page.evaluate(() => localStorage.getItem('aptron_profile_v1'));
const getDataAptTheme = () => page.evaluate(() => document.documentElement.getAttribute('data-apt-theme'));
const getComputedVar = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.AptTheme && window.AptAccount, { timeout: 8000 });

  // 1. Boot
  ok('AptTheme + AptAccount present', await page.evaluate(() => !!(window.AptTheme && window.AptAccount)));
  ok('baseline theme applied at boot', await getDataAptTheme() === 'nordic');
  const baselineProfile = await getProfile();

  // 2. Open Preferences -> Personalizado
  await page.click('#acctBtn');
  await page.click('[data-pane="prefs"]');
  await page.click('.acct-themecard[data-theme="custom"]');
  await page.waitForSelector('#acctCtAccent', { state: 'visible' });
  ok('customizer opened', await page.isVisible('#acctCustomPanel'));

  // 3. "Ajustar automáticamente" -- opt-in, preview-only, never silent.
  await page.fill('#acctCtAccent', '#151515');   // fails against the default dark bg
  ok('failing accent shows bad badge', (await page.textContent('#acctCtAccentContrast')).includes('requires at least'));
  ok('adjust button visible on failure', await page.isVisible('#acctCtAccentAdjust'));
  ok('input NOT changed merely by failing (no silent correction)', (await page.inputValue('#acctCtAccent')) === '#151515');
  ok('Save disabled while a field fails', await page.isDisabled('#acctCtSave'));
  ok('nothing persisted yet (still failing, still preview)', await getProfile() === baselineProfile);

  await page.click('#acctCtAccentAdjust');
  const adjustedAccent = await page.inputValue('#acctCtAccent');
  ok('adjust button changed the input value', adjustedAccent !== '#151515');
  ok('adjusted value is a normalized hex', /^#[0-9a-f]{6}$/.test(adjustedAccent));
  ok('badge now valid after adjustment', (await page.textContent('#acctCtAccentContrast')).includes('valid'));
  ok('adjust button hides once passing', await page.isHidden('#acctCtAccentAdjust'));
  ok('adjustment is still preview-only, not persisted', await getProfile() === baselineProfile);

  // 4. Cancel -- exact restoration, regardless of how many preview changes.
  await page.fill('#acctCtAccent2', '#eeeeee');
  await page.click('#acctCtCancel');
  ok('Cancel restores data-apt-theme', await getDataAptTheme() === 'nordic');
  ok('Cancel restores inline --accent (cleared)', (await getComputedVar('--accent')) !== '#eeeeee' && (await getComputedVar('--accent')) !== adjustedAccent.replace('#',''));
  ok('Cancel leaves localStorage byte-identical to pre-open state', await getProfile() === baselineProfile);

  // 5. Save -> a valid custom-light theme -> genuine reload.
  await page.click('.acct-themecard[data-theme="custom"]');
  await page.waitForSelector('#acctCtAccent', { state: 'visible' });
  await page.fill('#acctCtAccent', '#1D5FA8');
  await page.fill('#acctCtAccent2', '#111111');
  await page.click('#acctCtAdvanced summary');   // expand the disclosure -- #acctCtBgEnable lives inside it
  await page.click('#acctCtBgEnable');
  await page.fill('#acctCtBgPage', '#fafafa');
  await page.fill('#acctCtBgSurface', '#ffffff');
  ok('Save enabled once every field passes', !(await page.isDisabled('#acctCtSave')));
  await page.click('#acctCtSave');

  const savedProfile = JSON.parse(await getProfile());
  ok('theme persisted as "custom"', savedProfile.theme === 'custom');
  ok('customTheme persisted with normalized lowercase hex', savedProfile.customTheme && savedProfile.customTheme.accent === '#1d5fa8');
  ok('classified custom-light immediately after Save', await getDataAptTheme() === 'custom-light');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.AptTheme, { timeout: 8000 });
  ok('custom-light survives a GENUINE page reload', await getDataAptTheme() === 'custom-light');
  ok('reloaded --accent matches saved value', (await getComputedVar('--accent')) === '#1d5fa8');
  ok('reloaded --bg-page matches saved value', (await getComputedVar('--bg-page')) === '#fafafa');
  ok('reloaded --text-primary is light-family ink', (await getComputedVar('--text-primary')) === '#1D2129');
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('reloaded body background matches the custom bgPage', bodyBg === 'rgb(250, 250, 250)');

  // 6. Reset -- unconditional, from an active custom theme.
  await page.click('#acctBtn');
  await page.click('[data-pane="prefs"]');
  await page.click('.acct-themecard[data-theme="custom"]');
  await page.waitForSelector('#acctCtReset', { state: 'visible' });
  await page.click('#acctCtReset');
  const resetProfile = JSON.parse(await getProfile());
  ok('Reset clears customTheme and forces dark', JSON.stringify(resetProfile) === JSON.stringify({ theme: 'dark' }));
  ok('Reset removes data-apt-theme', await getDataAptTheme() === null);
  ok('Reset deactivates Personalizado card', !(await page.locator('.acct-themecard[data-theme="custom"]').evaluate(el => el.classList.contains('is-active'))));

  await page.screenshot({ path: path.join(ROOT, 'tools/smoke/theme-smoke.png'), fullPage: true });
} catch (e) {
  ok('FATAL during run', false, e.message);
}

// Real JS errors fail the run. Network errors from the intentional Supabase
// blocks are expected and filtered out, same policy as smoke.mjs. calendar-
// link.js's own status refresh 404s here too -- there is no proxy server
// running under this static-file-only harness, same class of expected
// environmental noise, not a Custom Theme (or any application) bug.
const realConsole = consoleErrors.filter(t =>
  !/supabase|jsdelivr|Failed to load resource|net::ERR|ERR_FAILED|blocked|calendar-link/i.test(t));

console.log('\n── Theme smoke results ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
if (pageErrors.length) { console.log('\nUncaught page errors:'); pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (realConsole.length) { console.log('\nConsole errors (non-network):'); realConsole.forEach(e => console.log('  ✗ ' + e)); }

const failed = results.filter(r => !r.pass).length + pageErrors.length + realConsole.length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'}  (screenshot: tools/smoke/theme-smoke.png)`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
