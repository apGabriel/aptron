/* ============================================================
   gym-rest-timer.js — between-sets Rest Timer overlay.
   Self-contained IIFE (own closure). Exposes a single bridge,
   window.GymRestTimer.start(seconds, label), called from the
   Coach log handler (gym-actions.js) after a set is saved.

   Holds NO workout/session state — it only owns its own countdown
   — so it can never disturb the logging session it overlays. The
   countdown is wall-clock based (endAt = now + seconds, remaining
   recomputed each tick) so it stays accurate under setInterval
   throttling instead of drifting. A 250ms tick plus a CSS
   stroke-dashoffset transition gives a smooth ring without a rAF
   loop. Loads after gym-cloud.js; only needs to exist by the time
   the first set is logged, so document order is sufficient.
   ============================================================ */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = 54;                       // ring radius (matches the SVG circle)
  const C = 2 * Math.PI * R;          // circumference → dash length

  let total = 0;          // planned duration (s), grows if the user extends
  let endAt = 0;          // wall-clock instant (ms) the countdown ends
  let timer = 0;          // setInterval handle
  let finished = false;   // guard so the finish cue fires exactly once
  let audioCtx = null;    // lazily created inside the log gesture (autoplay-safe)
  let onFinishCb = null;  // optional callback fired when the countdown hits 0 —
                          // e.g. log a completed Time-set hold. null for plain rest.
  let runId = 0;          // bumped on every start(); lets finish() detect that its
                          // callback opened a NEW countdown in this same overlay
                          // (hold → rest hand-off) and bow out instead of closing it.

  const root = () => $('poRest');

  // Remaining seconds → "M:SS". Ceil so the readout shows "0:01" until the
  // final instant and only flips to "0:00" at completion.
  function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function paint(remaining) {
    const ring = $('poRestRing');
    if (ring) {
      const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
      ring.style.strokeDasharray = C.toFixed(2);
      // Deplete the arc as time elapses (full at start → empty at 0).
      ring.style.strokeDashoffset = (C * (1 - frac)).toFixed(2);
    }
    const t = $('poRestTime');
    if (t) t.textContent = fmt(remaining);
  }

  function clearTick() { if (timer) { clearInterval(timer); timer = 0; } }

  function tick() {
    const remaining = (endAt - Date.now()) / 1000;
    if (remaining <= 0) { paint(0); finish(); return; }
    paint(remaining);
  }

  function close() {
    clearTick();
    // Drop any pending callback so a manual Skip (early close) of a hold can't
    // later log it, and so it never leaks into the next, unrelated countdown.
    onFinishCb = null;
    const el = root();
    if (!el) return;
    el.classList.remove('is-open', 'is-done');
    el.setAttribute('aria-hidden', 'true');
  }

  // Two-tone end chime via WebAudio (no asset to ship). Best-effort: silently
  // no-ops where audio is blocked (vibration + the visual flash still fire).
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime;
      [[0, 880], [0.18, 1320]].forEach(([off, freq]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + off);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + off + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(t0 + off); osc.stop(t0 + off + 0.18);
      });
    } catch (e) { /* audio unavailable — ignore */ }
  }

  // Timer hit 0 → fire the audio beep + haptic buzz, then run any completion
  // callback (e.g. log the held Time-set). If that callback starts a NEW
  // countdown in this overlay — the hold→rest hand-off, where commitSet kicks
  // off the between-sets rest — runId changes and we bow out so the green flash
  // + auto-close don't clobber the fresh rest countdown. Otherwise (plain rest,
  // or a hold with no rest planned) we green-flash and auto-dismiss as before.
  function finish() {
    if (finished) return;
    finished = true;
    clearTick();
    const cb = onFinishCb;
    onFinishCb = null;
    beep();
    try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) {}
    if (cb) {
      const token = runId;
      cb(total);                      // total = the duration actually held (grows with +15s)
      if (runId !== token) return;    // callback opened a new countdown → it owns the overlay now
    }
    const el = root();
    if (el) el.classList.add('is-done');
    setTimeout(close, 1400);
  }

  // Live ±15s while resting. Extending past the original total rescales the ring
  // so the arc stays proportional; trimming below 0 ends the rest immediately.
  function adjust(delta) {
    if (finished) return;
    endAt += delta * 1000;
    const remaining = (endAt - Date.now()) / 1000;
    if (remaining <= 0) { paint(0); finish(); return; }
    if (remaining > total) total = remaining;
    paint(remaining);
  }

  // Eyebrow caption — same chrome, different context. Plain rest reads
  // "REST · <EXERCISE>"; an in-progress Time-set hold reads
  // "KEEP HOLDING · <EXERCISE>" so the shared overlay never feels mislabelled.
  function buildEyebrow(label, mode) {
    const base = mode === 'hold' ? 'KEEP HOLDING' : 'REST';
    return label ? (base + ' · ' + String(label).toUpperCase()) : base;
  }

  // start(seconds, label[, opts]) — opts.mode ('rest' default | 'hold') picks the
  // caption; opts.onFinish(secondsHeld) runs when the countdown reaches 0. The
  // rest-between-sets caller passes no opts, so its behaviour is unchanged.
  function start(seconds, label, opts) {
    opts = opts || {};
    seconds = Math.max(1, Math.round(Number(seconds) || 0));
    const el = root();
    if (!el) return;
    clearTick();
    runId++;
    finished = false;
    onFinishCb = typeof opts.onFinish === 'function' ? opts.onFinish : null;
    total = seconds;
    endAt = Date.now() + seconds * 1000;

    const eye = $('poRestEyebrow');
    if (eye) eye.textContent = buildEyebrow(label, opts.mode);

    el.classList.remove('is-done');
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');

    // Prime the audio context inside the originating tap (the Log-set click) so
    // the end chime is allowed to play when the timer later reaches 0.
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* ignore */ }

    paint(seconds);
    timer = setInterval(tick, 250);
  }

  // ── Controls (wired once; the overlay markup is static in gym.html) ──
  const skip = $('poRestSkip'); if (skip) skip.addEventListener('click', close);
  const minus = $('poRestMinus'); if (minus) minus.addEventListener('click', () => adjust(-15));
  const plus = $('poRestPlus'); if (plus) plus.addEventListener('click', () => adjust(15));
  document.addEventListener('keydown', (e) => {
    const el = root();
    if (e.key === 'Escape' && el && el.classList.contains('is-open')) close();
  });

  window.GymRestTimer = { start: start, stop: close };
})();
