---
name: preview
description: Launch and visually drive the aptron static dashboards (gym.html, index.html, wardrobe.html, health.html) in cached Chromium to confirm a change works. Starts a local static server, drives the page with Playwright, captures screenshots + console errors. Use when asked to preview, run, screenshot, or verify a UI change in the real app.
---

Run an aptron dashboard the way a user meets it — real browser, real
`localStorage`/Supabase origin — and look at the result. This suite is **no
build, no framework**: edit `.html`/`.js`/`.css`, serve the repo root, open the
page. Never preview over `file://` (Supabase/CORS misbehave); always go through
the static server.

## One-time setup per machine (skip if already done)

The driver needs `playwright-core`; the Chromium binary is already cached under
`~/AppData/Local/ms-playwright/` (the driver globs for it, version-agnostic).
Install into THIS skill folder so the repo root stays clean (`node_modules/` is
gitignored):

```bash
npm install --prefix .claude/skills/preview
```

## Run it

1. **Start the static server** (background; it serves the repo root). `serve`
   redirects `/gym.html` → `/gym`, which the driver already handles:

   ```bash
   npx -y serve . -l 5055 >/tmp/aptron-serve.log 2>&1 &
   # confirm it's up:
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5055/gym
   ```

2. **Drive the page.** For a quick smoke (load + screenshot + error capture):

   ```bash
   node .claude/skills/preview/drive.mjs --page gym --shot gym-smoke
   ```

   `--page` is `gym | index | wardrobe | health` (or a full URL). Mobile
   viewport (430×900) is the default — this is a mobile-first suite; add
   `--desktop` for 1280×900. Screenshots land in
   `.claude/skills/preview/_shots/` (gitignored). A non-zero exit = console
   errors were seen; read them in the log.

3. **Trigger something directly** with the `--eval` escape hatch (the JS runs in
   the page and its return value is printed) — handy for overlays/widgets:

   ```bash
   node .claude/skills/preview/drive.mjs --page gym --wait 500 --shot rest-timer \
     --eval "window.GymRestTimer.start(15,'Bench Press'); return { open: document.getElementById('poRest').classList.contains('is-open'), readout: document.getElementById('poRestTime').textContent };"
   ```

4. **Multi-step feature flows** — when you need to click through real UI (add an
   exercise, log a set, assert the result), write a throwaway flow module and
   pass `--script`. It exports `default async (page, ctx) => {}`; `ctx.shot(name)`
   screenshots, `ctx.log(...)` prints. Example that mirrors the rest-timer
   verification (add exercise → read the rest stepper → fire the timer → tick →
   Skip):

   ```js
   // .claude/skills/preview/_flow.mjs   (temp; delete after)
   export default async (page, { shot, log }) => {
     await page.waitForSelector('#rbGrid .rb-ex-add', { timeout: 15000 });
     await page.click('#rbGrid .rb-ex-add');
     await page.waitForSelector('#rbRoutineList .rb-rest');
     log('rest:', await page.textContent('#rbRoutineList .rb-rest-val'));
     await shot('01-stepper');
     await page.evaluate(() => window.GymRestTimer.start(20, 'Bench Press'));
     await page.waitForTimeout(400); await shot('02-timer');
     await page.waitForTimeout(3000);
     log('ticked:', await page.textContent('#poRestTime'));
     await shot('03-ticking');
     await page.click('#poRestSkip');
   };
   ```
   ```bash
   node .claude/skills/preview/drive.mjs --page gym --script .claude/skills/preview/_flow.mjs
   ```

5. **Always look at the screenshots** (Read them). A blank/garbled frame is a
   launch failure, not a pass. Report what you saw + any console errors.

## Clean up

```bash
kill %1 2>/dev/null; pkill -f "serve . -l 5055" 2>/dev/null   # stop the server
rm -f .claude/skills/preview/_flow.mjs                         # drop temp flows
```

`_shots/` and `node_modules/` are gitignored — leave them; they make the next
run faster. Do not commit anything under this skill folder except the tracked
`SKILL.md`, `drive.mjs`, `package.json`, `.gitignore`.

## What this can't show

Audio (Web Audio beeps) and haptics (`navigator.vibrate`) don't fire under
headless automation — they need a real device + user gesture. For those, deploy
to `test` (Vercel auto-builds the preview) and check on a phone.
