// _flow-voice-cancel-adversarial.mjs — VOICE-07 (critical)
// Requires: --init _mock-speech-recognition.js
// Proves Escape/abort() wins even when onend delivers a transcript AFTER
// the cancel — the exact guarantee the plan requires, not just "Escape
// calls abort()" in isolation.
export default async (page, { shot, log }) => {
  const clickMic = () => page.evaluate(() => document.getElementById('aiMic').click());
  const userMsgCount = () => page.evaluate(() => document.querySelectorAll('.aios-msg-user').length);
  const micState = () => page.evaluate(() => ({
    recording: document.getElementById('aiMic').classList.contains('is-recording'),
    processing: document.getElementById('aiMic').classList.contains('is-processing-voice'),
  }));

  // Case 1: cancel WHILE RECORDING, then onend delivers a transcript anyway.
  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireResult('delete the meeting'));
  const before = await userMsgCount();
  await page.keyboard.press('Escape');
  const abortCalled = await page.evaluate(() => window.__mockSR._abortCalled);
  if (!abortCalled) throw new Error('VOICE-07 FAILED: Escape did not call abort()');
  // Adversarial: fire onend with the transcript that was already captured —
  // real SpeechRecognition can deliver a final result even after abort().
  await page.evaluate(() => window.__mockSR.__fireEnd());
  await page.waitForTimeout(150);
  const after = await userMsgCount();
  const s1 = await micState();
  log('VOICE-07 case 1 (cancel during RECORDING):', 'before=' + before, 'after=' + after, JSON.stringify(s1));
  if (after !== before) throw new Error(`VOICE-07 FAILED (case 1): a message was sent after Escape — before=${before} after=${after}`);
  if (s1.recording || s1.processing) throw new Error('VOICE-07 FAILED (case 1): mic state not back to idle after cancel');
  await shot('voice-07-case1-no-send');

  // Case 2: cancel WHILE PROCESSING (after a manual finish click, before
  // onend resolves) — Escape must still work here, not only during RECORDING.
  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireResult('cancel my subscription'));
  await clickMic(); // finish -> enters processing, calls stop()
  const s2before = await micState();
  if (!s2before.processing) throw new Error('VOICE-07 FAILED (case 2 setup): expected processing state before cancel attempt');
  const before2 = await userMsgCount();
  await page.keyboard.press('Escape');
  const abortCalled2 = await page.evaluate(() => window.__mockSR._abortCalled);
  if (!abortCalled2) throw new Error('VOICE-07 FAILED (case 2): Escape during PROCESSING did not call abort()');
  await page.evaluate(() => window.__mockSR.__fireEnd());
  await page.waitForTimeout(150);
  const after2 = await userMsgCount();
  log('VOICE-07 case 2 (cancel during PROCESSING):', 'before=' + before2, 'after=' + after2);
  if (after2 !== before2) throw new Error(`VOICE-07 FAILED (case 2): a message was sent after Escape during PROCESSING`);

  log('ALL PASS: VOICE-07 (both RECORDING and PROCESSING cancel paths)');
};
