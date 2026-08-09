// _flow-voice-state-machine.mjs — VOICE-05, 06, 08, 13, 15, 16, 18
// Requires: --init _mock-speech-recognition.js
// Uses page.evaluate()-driven clicks, not page.click(): the dashboard's
// .auth-gate overlay (no local Supabase session in this environment)
// visually intercepts real Playwright pointer hit-testing, exactly the
// obstacle the 2026-08-09 dictation-pass session already hit and worked
// around the same way.
export default async (page, { shot, log }) => {
  const clickMic = () => page.evaluate(() => document.getElementById('aiMic').click());
  // logCount tracks USER messages specifically (.aios-msg-user), not total
  // log children — a single legitimate send produces both a user bubble AND
  // an AI reply, a 2-child bump that would falsely look like a double-send
  // if counted as raw children.
  const micState = async () => page.evaluate(() => ({
    recording: document.getElementById('aiMic').classList.contains('is-recording'),
    processing: document.getElementById('aiMic').classList.contains('is-processing-voice'),
    ariaPressed: document.getElementById('aiMic').getAttribute('aria-pressed'),
    logCount: document.querySelectorAll('.aios-msg-user').length,
  }));
  const lastUserMsg = async () => page.evaluate(() => {
    const msgs = Array.from(document.querySelectorAll('.aios-msg-user'));
    return msgs.length ? msgs[msgs.length - 1].textContent : null;
  });

  // VOICE-05: start recording
  await clickMic();
  let s = await micState();
  log('VOICE-05 after start:', JSON.stringify(s));
  if (!s.recording || s.ariaPressed !== 'true') throw new Error('VOICE-05 FAILED: not in recording state');
  await shot('voice-05-recording');

  // VOICE-08 (variant 1): onend with NO prior result -> empty transcript, no send
  const beforeCount = s.logCount;
  await page.evaluate(() => window.__mockSR.__fireEnd());
  await page.waitForTimeout(100);
  s = await micState();
  log('VOICE-08 after empty onend:', JSON.stringify(s));
  if (s.recording) throw new Error('VOICE-08 FAILED: still recording after onend');
  if (s.logCount !== beforeCount) throw new Error('VOICE-08 FAILED: a message was sent from an empty transcript');

  // VOICE-06 + VOICE-18: start again, produce a transcript that resolves
  // LOCALLY (no Gemini needed) via the existing parseLocal 'log_water' path,
  // click again to finish (stop(), not abort()), fire onend TWICE (simulating
  // a duplicate/buggy event) -> exactly ONE user bubble must appear.
  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireResult('log water'));
  await clickMic(); // finish
  s = await micState();
  log('VOICE-06 after finish click (should be processing):', JSON.stringify(s));
  const stopCalled = await page.evaluate(() => window.__mockSR._stopCalled);
  const abortCalledOnFinish = await page.evaluate(() => window.__mockSR._abortCalled);
  if (!stopCalled || abortCalledOnFinish) throw new Error('VOICE-06 FAILED: finish must call stop(), never abort()');
  if (!s.processing) throw new Error('VOICE-06 FAILED: expected processing state after finish click');

  const beforeSend = await micState();
  await page.evaluate(() => window.__mockSR.__fireEnd());   // 1st onend -> should send
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__mockSR.__fireEnd());   // 2nd onend -> must NOT send again
  await page.waitForTimeout(150);
  const afterSend = await micState();
  const userText = await lastUserMsg();
  log('VOICE-18 log count before/after double onend:', beforeSend.logCount, '->', afterSend.logCount, '· last user msg:', userText);
  if (afterSend.logCount - beforeSend.logCount !== 1) {
    throw new Error(`VOICE-18 FAILED: expected exactly 1 new message, got ${afterSend.logCount - beforeSend.logCount}`);
  }
  if (userText !== 'log water') throw new Error('VOICE-06 FAILED: sent transcript did not match spoken text');
  await shot('voice-06-18-sent');

  // VOICE-16: alternate voice -> text -> voice, confirm state stays clean
  await page.evaluate(() => {
    const input = document.getElementById('aiInput');
    input.value = 'log water';
    document.getElementById('aiForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  await page.waitForTimeout(150);
  s = await micState();
  if (s.recording || s.processing) throw new Error('VOICE-16 FAILED: mic state dirty after a typed message');

  // VOICE-13: rapid start/stop, must not throw or get stuck
  for (let i = 0; i < 5; i++) {
    await clickMic();
    await clickMic();
    await page.evaluate(() => { if (window.__mockSR) window.__mockSR.__fireEnd(); });
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(200);
  s = await micState();
  log('VOICE-13 final state after rapid toggling:', JSON.stringify(s));
  if (s.recording || s.processing) throw new Error('VOICE-13 FAILED: state stuck after rapid start/stop');

  log('ALL PASS: VOICE-05, 06, 08, 13, 16, 18');
};
