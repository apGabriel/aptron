// _flow-voice-payload-parity.mjs — VOICE-17 (critical), VOICE-19, VOICE-14
// Requires: --init _mock-speech-recognition.js
// "I'm tired" is deliberately reused from docs/testing/SHENLONG_TEST_SUITE.md
// TS-06 — already documented there as classifying 'unknown' and falling
// through to the Gemini fallback reliably, so both sends actually produce a
// request to compare (a phrase the local parser resolves would leave nothing
// to diff).
export default async (page, { shot, log }) => {
  const clickMic = () => page.evaluate(() => document.getElementById('aiMic').click());
  const captured = [];

  await page.route('**/api/gemini/assistant', async (route) => {
    const body = route.request().postDataJSON();
    captured.push(body);
    await new Promise((r) => setTimeout(r, 300));   // deliberate delay -> gives VOICE-14 a window
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ action: 'chat', reply: 'ok', confidence: 'high' }),
    });
  });

  // Send 1: typed
  await page.evaluate(() => {
    const input = document.getElementById('aiInput');
    input.value = "I'm tired";
    document.getElementById('aiForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });

  // VOICE-14: while the typed send is still pending (300ms delay above),
  // the mic must be visually disabled and must not start recording.
  await page.waitForTimeout(80);   // inside the 300ms window, request in flight
  const midFlightMic = await page.evaluate(() => ({
    ariaDisabled: document.getElementById('aiMic').getAttribute('aria-disabled'),
  }));
  await clickMic();   // attempt to use the mic mid-flight
  await page.waitForTimeout(50);
  const afterAttempt = await page.evaluate(() => ({
    recording: document.getElementById('aiMic').classList.contains('is-recording'),
    mockInstanceExists: !!window.__mockSR,
  }));
  log('VOICE-14 mid-flight:', JSON.stringify(midFlightMic), 'after mic-click attempt:', JSON.stringify(afterAttempt));
  if (midFlightMic.ariaDisabled !== 'true') throw new Error('VOICE-14 FAILED: mic not visually disabled while busy');
  if (afterAttempt.recording) throw new Error('VOICE-14 FAILED: mic entered recording state while Shenlong was busy');

  await page.waitForTimeout(400);   // let send 1 fully resolve

  // Send 2: voice, same exact phrase
  await clickMic();
  await page.evaluate(() => window.__mockSR.__fireResult("I'm tired"));
  await clickMic();   // finish
  await page.evaluate(() => window.__mockSR.__fireEnd());
  await page.waitForTimeout(500);

  log('Captured request count (VOICE-19):', captured.length);
  if (captured.length !== 2) throw new Error(`VOICE-19 FAILED: expected exactly 2 requests (1 per send), got ${captured.length}`);

  const [typedBody, voiceBody] = captured;
  log('typed body:', JSON.stringify(typedBody));
  log('voice body:', JSON.stringify(voiceBody));
  const same = JSON.stringify(typedBody) === JSON.stringify(voiceBody);
  if (!same) throw new Error('VOICE-17 FAILED: typed and voice payloads differ:\n' + JSON.stringify(typedBody) + '\nvs\n' + JSON.stringify(voiceBody));

  await shot('voice-17-payload-parity');
  log('ALL PASS: VOICE-14, VOICE-17 (critical), VOICE-19');
};
