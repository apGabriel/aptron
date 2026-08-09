// _flow-voice-permission-granted.mjs — VOICE-03
// Requires: --chromium-args "--use-fake-ui-for-media-stream --use-fake-device-for-media-stream"
// NO --init here on purpose: this drives the REAL SpeechRecognition, not the
// mock, to prove the permission-grant path works end to end in an actual
// browser. The fake device provides a synthetic (silent/tone) stream, not
// real speech, so this can only prove "permission granted -> recording
// starts", never real transcription accuracy (that stays VOICE-09,
// hardware-only, BLOCKED).
export default async (page, { shot, log }) => {
  const clickMic = () => page.evaluate(() => document.getElementById('aiMic').click());
  const micState = () => page.evaluate(() => ({
    recording: document.getElementById('aiMic').classList.contains('is-recording'),
    ariaPressed: document.getElementById('aiMic').getAttribute('aria-pressed'),
  }));

  await clickMic();
  await page.waitForTimeout(500);   // real permission grant + engine startup, not instantaneous like the mock
  const s = await micState();
  log('VOICE-03 state after real click + fake-device auto-grant:', JSON.stringify(s));
  await shot('voice-03-permission-granted');

  if (!s.recording || s.ariaPressed !== 'true') {
    throw new Error('VOICE-03 FAILED: real SpeechRecognition did not enter recording state with the permission auto-granted — ' + JSON.stringify(s));
  }
  log('VOICE-03 PASS (permission-grant/start path only — fake device has no real speech, transcription accuracy is NOT proven by this test, see VOICE-09)');
};
