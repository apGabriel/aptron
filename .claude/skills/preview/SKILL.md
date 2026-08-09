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

5. **Replace a window API before the page loads** with `--init <path>` — for
   cases where the page checks for a browser API (e.g.
   `window.SpeechRecognition`) at load time, so a `--script`/`--eval`
   (which only run *after* `goto()`) would be too late. The file is plain
   browser JS (no `import`/`export` — it's injected as raw script content,
   not loaded as a module), injected via Playwright's `addInitScript()`:

   ```bash
   node .claude/skills/preview/drive.mjs --page index \
     --init .claude/skills/preview/_mock-speech-recognition.js \
     --script .claude/skills/preview/_flow-voice-state-machine.mjs
   ```

6. **Auto-grant a real permission prompt** (mic/camera) with `--chromium-args`
   — passed verbatim to `chromium.launch({ args })`. Chromium's fake-device
   flags grant the permission instantly and provide a synthetic media
   stream, so real (not mocked) browser APIs like `SpeechRecognition` can be
   exercised past the permission gate — though a synthetic device produces
   no real speech/image content, so this proves the permission/start path,
   not real recognition/transcription accuracy:

   ```bash
   node .claude/skills/preview/drive.mjs --page index \
     --chromium-args "use-fake-ui-for-media-stream use-fake-device-for-media-stream" \
     --script .claude/skills/preview/_flow-voice-permission-granted.mjs
   ```
   Note: flag names go **without** their leading `--` — the existing tiny
   `arg()` parser in `drive.mjs` treats any value starting with `--` as
   another flag rather than this flag's value, so `--chromium-args` adds the
   `--` back itself rather than changing that shared parser.

7. **Always look at the screenshots** (Read them). A blank/garbled frame is a
   launch failure, not a pass. Report what you saw + any console errors.

## Clean up

```bash
kill %1 2>/dev/null; pkill -f "serve . -l 5055" 2>/dev/null   # stop the server
rm -f .claude/skills/preview/_flow.mjs                         # drop temp flows
```

`_shots/` and `node_modules/` are gitignored — leave them; they make the next
run faster. Do not commit anything under this skill folder except the tracked
`SKILL.md`, `drive.mjs`, `package.json`, `package-lock.json`, `.gitignore` —
**plus one deliberate exception**: the `_flow-voice-*.mjs` files and
`_mock-speech-recognition.js` are re-run regression tests (Shenlong's
`VOICE-*` suite, `docs/testing/SHENLONG_TEST_SUITE.md`), not one-off
exploration — keep them tracked, don't `rm` them after use like a throwaway
`_flow.mjs`.

## What this can't show

Audio (Web Audio beeps) and haptics (`navigator.vibrate`) don't fire under
headless automation — they need a real device + user gesture. For those, deploy
to `test` (Vercel auto-builds the preview) and check on a phone.
