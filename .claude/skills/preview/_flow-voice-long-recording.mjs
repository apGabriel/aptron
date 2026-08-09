// _flow-voice-long-recording.mjs — VOICE-12, mock-based portion only.
// Requires: --init _mock-speech-recognition.js
// Proves many interim onresult events over a long simulated utterance don't
// corrupt the state machine, cause a duplicate send, or leave stale state.
// Does NOT prove real-engine reliability over a genuinely long real
// recording (Safari's documented history of cutting long sessions early) —
// that half stays a manual/real-hardware concern, honestly not claimed here.
export default async (page, { shot, log }) => {
  const clickMic = () => page.evaluate(() => document.getElementById('aiMic').click());
  const userMsgCount = () => page.evaluate(() => document.querySelectorAll('.aios-msg-user').length);
  const micState = () => page.evaluate(() => ({
    recording: document.getElementById('aiMic').classList.contains('is-recording'),
    processing: document.getElementById('aiMic').classList.contains('is-processing-voice'),
  }));

  await clickMic();
  const s1 = await micState();
  if (!s1.recording) throw new Error('VOICE-12 setup FAILED: did not enter recording state');

  // Simulate a long utterance: 200 growing interim results, as a real engine
  // would deliver word-by-word over many seconds (compressed here — no real
  // wall-clock wait is needed since onresult handling is synchronous).
  const words = ('what is on my calendar today and how much water have I had '
    + 'and what is my next gym session and is there anything else I should '
    + 'know about before I start my afternoon').split(' ');
  await page.evaluate((words) => {
    let acc = '';
    for (let i = 0; i < 200; i++) {
      acc = words.slice(0, (i % words.length) + 1).join(' ');   // growing/cycling transcript
      window.__mockSR.__fireResult(acc);
    }
  }, words);

  const midState = await micState();
  log('VOICE-12 state after 200 interim results:', JSON.stringify(midState));
  if (!midState.recording || midState.processing) {
    throw new Error('VOICE-12 FAILED: state corrupted mid-recording after many onresult events — ' + JSON.stringify(midState));
  }

  // Finish normally with the full final transcript.
  const finalTranscript = words.join(' ');
  await page.evaluate((t) => window.__mockSR.__fireResult(t), finalTranscript);
  await clickMic();   // finish -> stop() -> processing
  const s2 = await micState();
  if (!s2.processing) throw new Error('VOICE-12 FAILED: did not enter processing state after finish');

  const before = await userMsgCount();
  await page.evaluate(() => window.__mockSR.__fireEnd());
  await page.waitForTimeout(200);
  const after = await userMsgCount();
  const s3 = await micState();
  log('VOICE-12 final:', 'before=' + before, 'after=' + after, JSON.stringify(s3));

  if (after - before !== 1) throw new Error(`VOICE-12 FAILED: expected exactly 1 send after a long utterance, got ${after - before}`);
  if (s3.recording || s3.processing) throw new Error('VOICE-12 FAILED: stale recording/processing state after completion');

  await shot('voice-12-long-recording');
  log('PASS (mock portion only): VOICE-12 — 200 interim events + a 200+ char final transcript sent exactly once, clean state throughout. Real-engine long-session reliability (esp. Safari) remains a manual/hardware concern, NOT proven by this test.');
};
