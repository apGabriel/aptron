// _mock-speech-recognition.js — injected via `drive.mjs --init` (Playwright
// page.addInitScript()) BEFORE navigation, so it replaces window
// SpeechRecognition/webkitSpeechRecognition before js/index.js's IIFE ever
// checks for it at page-load time. Plain browser JS — no import/export, it's
// injected as raw script content, not loaded as an ES module.
//
// Lets Shenlong's VOICE-* test suite (docs/testing/SHENLONG_TEST_SUITE.md)
// drive every recognition event deterministically — no real microphone, no
// real STT service — while still exercising the ACTUAL code in js/index.js,
// not a simulation of it. window.__mockSR always holds the most recently
// constructed instance so a test flow can fire events on it directly.
(function () {
  function MockSpeechRecognition() {
    this.lang = '';
    this.interimResults = false;
    this.continuous = false;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this._started = false;
    this._stopCalled = false;
    this._abortCalled = false;
    window.__mockSR = this;
  }
  MockSpeechRecognition.prototype.start = function () {
    this._started = true;
    if (this.onstart) this.onstart();
  };
  // Real SpeechRecognition semantics: stop() lets any in-flight result
  // finalize (onend still fires, possibly with a transcript). The test decides
  // exactly what onend delivers by calling __fireEnd() itself — this mock
  // never fires onend automatically, so a flow can insert whatever delay/
  // sequence a case needs (e.g. VOICE-07's adversarial "abort, then onend
  // delivers a transcript anyway").
  MockSpeechRecognition.prototype.stop = function () { this._stopCalled = true; };
  MockSpeechRecognition.prototype.abort = function () { this._abortCalled = true; };

  // ── test-only driver methods (not part of the real Web Speech API) ───────
  // Shape matches exactly what js/index.js's onresult handler reads:
  // `for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript`
  MockSpeechRecognition.prototype.__fireResult = function (transcript) {
    if (this.onresult) this.onresult({ results: [[{ transcript: transcript }]] });
  };
  MockSpeechRecognition.prototype.__fireError = function (code) {
    if (this.onerror) this.onerror({ error: code });
  };
  MockSpeechRecognition.prototype.__fireEnd = function () {
    if (this.onend) this.onend();
  };

  window.SpeechRecognition = MockSpeechRecognition;
  window.webkitSpeechRecognition = MockSpeechRecognition;
})();
