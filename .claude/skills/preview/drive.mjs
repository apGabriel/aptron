/* ============================================================
   drive.mjs — reusable preview driver for the aptron static suite.
   Launches one of the static dashboards in the Playwright-cached
   Chromium, captures console/page errors, optionally runs page JS
   or a custom steps module, and writes a screenshot. Pairs with the
   /preview skill, which starts the `serve` static server first.

   Usage (server must already be running — the skill starts it):
     node drive.mjs --page gym [--port 5055] [--shot NAME]
                    [--wait MS] [--desktop]
                    [--eval "<expr evaluated in the page>"]
                    [--script ./flow.mjs]

   --page     gym | index | wardrobe | health  (or a full path)   [gym]
   --port     port the static server is on                        [5055]
   --shot     screenshot basename written under _shots/           [preview]
   --wait     ms to settle before the screenshot                  [600]
   --desktop  use a 1280x900 viewport instead of mobile 430x900
   --eval     a JS expression run via page.evaluate; its (JSON-able)
              return value is printed. Escape hatch for triggering
              things directly, e.g. window.GymRestTimer.start(15,'x').
   --script   a module exporting `default async (page, ctx) => {}`
              for multi-step flows; ctx = { shot(name), log(...) }.
   ============================================================ */
import { chromium } from 'playwright-core';
import { readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

// ── tiny arg parser ──────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const page   = String(arg('page', 'gym'));
const port   = String(arg('port', '5055'));
const shot   = String(arg('shot', 'preview'));
const wait   = Number(arg('wait', 600));
const desktop = !!arg('desktop', false);
const evalJs = arg('eval', null);
const script = arg('script', null);

const SHOTS = join(import.meta.dirname, '_shots');
const log = (...a) => console.log('[preview]', ...a);

// ── resolve the Playwright-cached Chromium (version-agnostic) ──
// Browsers are installed under ~/AppData/Local/ms-playwright/chromium-<rev>/.
// Glob the newest chromium-* (NOT chromium_headless_shell-*) so this keeps
// working when Playwright bumps the cached revision.
function resolveChrome() {
  const base = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  let rev = null;
  try {
    rev = readdirSync(base)
      .filter(d => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
  } catch {}
  if (rev) {
    const exe = join(base, rev, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  // Fall back to whatever playwright-core resolves for its bundled build.
  try { return chromium.executablePath(); } catch { return undefined; }
}

// ── page → URL. `serve` redirects /gym.html → /gym, so use the clean path. ──
function pageUrl(p) {
  if (p.startsWith('http')) return p;
  const clean = p.replace(/\.html$/, '');
  const path = clean === 'index' ? '' : clean;
  return `http://localhost:${port}/${path}`;
}

const exe = resolveChrome();
log('chromium:', exe || '(default)');
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctxPage = await browser.newPage({
  viewport: desktop ? { width: 1280, height: 900 } : { width: 430, height: 900 }
});

const errors = [];
ctxPage.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
ctxPage.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

const url = pageUrl(page);
await ctxPage.goto(url, { waitUntil: 'networkidle' });
log('loaded', url, '·', await ctxPage.title());

const shotPath = (name) => join(SHOTS, `${name}.png`);
const ctx = {
  shot: async (name) => { await ctxPage.screenshot({ path: shotPath(name) }); log('shot', shotPath(name)); },
  log
};

// ── custom multi-step flow (preferred for feature driving) ──
if (script) {
  const modPath = isAbsolute(String(script)) ? String(script) : join(process.cwd(), String(script));
  const mod = await import('file://' + modPath);
  await mod.default(ctxPage, ctx);
}

// ── one-shot page eval escape hatch ──
if (evalJs && evalJs !== true) {
  try {
    const out = await ctxPage.evaluate(`(async () => { ${evalJs} })()`);
    log('eval =>', JSON.stringify(out));
  } catch (e) { log('eval error:', e.message); }
}

if (wait) await ctxPage.waitForTimeout(wait);
await ctxPage.screenshot({ path: shotPath(shot) });
log('shot', shotPath(shot));
log('console errors:', errors.length ? errors : 'none');

await browser.close();
process.exit(errors.length ? 1 : 0);
