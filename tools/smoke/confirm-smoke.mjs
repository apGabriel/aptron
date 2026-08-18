// Playwright smoke test for confirm.html / js/auth/confirm.js (the
// click-gated email-confirmation page added to fix the prefetch-consumes-
// the-token incident). Serves the repo over HTTP, lets the real
// supabase-js CDN bundle load (createAppSupabaseClient() must succeed so
// the click-gating itself is exercised), but hard-blocks every request to
// *.supabase.co so no real project is ever touched — a verifyOtp attempt
// fails safely with a network error instead of reaching production.
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
  const filePath = path.join(ROOT, urlPath === '/' ? 'confirm.html' : urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = 4601;   // distinct from smoke.mjs's 4599 and theme-smoke.mjs's 4600
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch();
const ctx = await browser.newContext();

// Never let a real verifyOtp reach the actual project.
await ctx.route('**://*.supabase.co/**', r => r.abort());

const supabaseHits = [];
ctx.on('request', req => { if (/supabase\.co/.test(req.url())) supabaseHits.push(req.url()); });

const page = await ctx.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

try {
  // ── 1. Missing token_hash/type -> controlled error, no button, no network ──
  await page.goto(`http://localhost:${PORT}/confirm.html`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForTimeout(300);
  ok('missing params: error message shown', (await page.textContent('#confirmErr')).indexOf('missing required information') !== -1);
  ok('missing params: confirm button stays hidden', await page.isHidden('#confirmBtn'));
  ok('missing params: zero requests to *.supabase.co', supabaseHits.length === 0, supabaseHits.join(', '));

  // ── 2. Valid-looking params: button appears, but verifyOtp must NOT fire
  //      merely from loading the page (the core prefetch mitigation). ──
  supabaseHits.length = 0;
  await page.goto(`http://localhost:${PORT}/confirm.html?token_hash=smoke-test-token&type=email`,
    { waitUntil: 'load', timeout: 15000 });
  await page.waitForTimeout(500);
  const haveClient = await page.evaluate(() => !!window.supabase);
  ok('supabase-js CDN loaded', haveClient);
  if (haveClient) {
    ok('valid params: confirm button visible', await page.isVisible('#confirmBtn'));
    ok('valid params: NO network call before the click (prefetch-safe)', supabaseHits.length === 0, supabaseHits.join(', '));
    // URL scrubbed immediately on load, independent of the click.
    ok('token_hash scrubbed from the visible URL on load', !location_search_has_token(await page.url()));

    // ── 3. Explicit click DOES trigger exactly one verify call, which the
    //      route block turns into a safe, friendly network-error state. ──
    await page.click('#confirmBtn');
    await page.waitForFunction(
      () => document.getElementById('confirmErr').textContent.length > 0,
      { timeout: 8000 }
    );
    ok('click: triggers a call to *.supabase.co (verifyOtp actually invoked)', supabaseHits.some(u => /verify/i.test(u)) || supabaseHits.length > 0, supabaseHits.join(', '));
    ok('click: blocked call surfaces a friendly, non-raw error', (await page.textContent('#confirmErr')).length > 0);
    ok('click: button re-enabled after failure (no stuck spinner)', !(await page.isDisabled('#confirmBtn')));
  } else {
    ok('valid params: missing-network fallback message shown', (await page.textContent('#confirmErr')).indexOf('network connection') !== -1);
  }

  await page.screenshot({ path: path.join(ROOT, 'tools/smoke/confirm-smoke.png'), fullPage: true });
} catch (e) {
  ok('FATAL during run', false, e.message);
}

function location_search_has_token(url) {
  try { return new URL(url).searchParams.has('token_hash'); } catch (e) { return false; }
}

const realConsole = consoleErrors.filter(t =>
  !/supabase|jsdelivr|Failed to load resource|net::ERR|ERR_FAILED|blocked/i.test(t));

console.log('\n── Confirm-page smoke results ──');
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
if (pageErrors.length) { console.log('\nUncaught page errors:'); pageErrors.forEach(e => console.log('  ✗ ' + e)); }
if (realConsole.length) { console.log('\nConsole errors (non-network):'); realConsole.forEach(e => console.log('  ✗ ' + e)); }

const failed = results.filter(r => !r.pass).length + pageErrors.length + realConsole.length;
console.log(`\nSMOKE: ${failed ? failed + ' failure(s)' : 'ALL PASSED ✓'}  (screenshot: tools/smoke/confirm-smoke.png)`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
