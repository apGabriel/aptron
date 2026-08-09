// _flow-voice-errors.mjs — VOICE-08 (no-speech variant), VOICE-10, VOICE-11
// Requires: --init _mock-speech-recognition.js
export default async (page, { shot, log }) => {
  const clickMic = () => page.evaluate(() => document.getElementById('aiMic').click());
  const userMsgCount = () => page.evaluate(() => document.querySelectorAll('.aios-msg-user').length);
  const lastAiMsg = () => page.evaluate(() => {
    const msgs = Array.from(document.querySelectorAll('.aios-msg-ai:not(.aios-msg-think)'));
    return msgs.length ? msgs[msgs.length - 1].textContent : null;
  });

  // VOICE-11: network error mid-recognition, after some interim results.
  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireResult('what is my'));
  await page.evaluate(() => window.__mockSR.__fireError('network'));
  await page.waitForTimeout(100);
  let msg = await lastAiMsg();
  log('VOICE-11 message:', msg);
  if (!msg || !msg.includes('internet connection')) throw new Error('VOICE-11 FAILED: wrong/missing network error message: ' + msg);

  // Adversarial, symmetric to VOICE-07: after onerror, onend STILL delivers
  // a transcript — hadError must win, exactly like wasCancelled does.
  const before = await userMsgCount();
  await page.evaluate(() => window.__mockSR.__fireEnd());
  await page.waitForTimeout(150);
  const after = await userMsgCount();
  log('VOICE-11 adversarial (onend after error):', 'before=' + before, 'after=' + after);
  if (after !== before) throw new Error('VOICE-11 FAILED: a message was sent after a recognition error');

  // VOICE-10: no-speech (also exercises VOICE-08's "silence" case via onerror
  // rather than an empty onend — the two real, documented ways engines report
  // "nothing was said").
  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireError('no-speech'));
  await page.waitForTimeout(100);
  msg = await lastAiMsg();
  log('VOICE-10 (no-speech) message:', msg);
  if (!msg || !msg.includes("didn't catch")) throw new Error('VOICE-10 FAILED: wrong/missing no-speech message: ' + msg);

  // VOICE-10b: unmapped/unknown error code -> generic fallback, never a raw code leaked.
  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireError('some-weird-vendor-code'));
  await page.waitForTimeout(100);
  msg = await lastAiMsg();
  log('VOICE-10b (unknown code) message:', msg);
  if (!msg || msg.includes('some-weird-vendor-code')) throw new Error('VOICE-10b FAILED: raw error code leaked to the user, or message missing');
  if (!msg.includes("try typing instead")) throw new Error('VOICE-10b FAILED: expected the generic fallback message');

  await shot('voice-errors-done');
  log('ALL PASS: VOICE-08 (error variant), VOICE-10, VOICE-11');
};
