// =============================================================================
// SHELRON — Natural Language Parser (v0.1)
// Entity extraction ONLY. Calls the proxy's Gemini-backed
// POST /api/shelron/parse route. NEVER executes anything, NEVER decides an
// intent, NEVER touches the calendar, localStorage, or Supabase — a pure
// function from text to structured entities (or a parse failure). See
// aptron Brain/02 Architecture/Shelron.md §1.
//
// This is the ONLY Shelron v0.1 component that calls an LLM, and it does so
// exactly the way the existing Shenlong assistant does (js/index.js
// askGemini): same relative endpoint pattern, same Authorization header
// attachment from window.__appAccessToken, same client-side timeout. The
// Gemini key itself never reaches the browser (ADR-009) — this file only
// ever talks to the proxy, never to Google directly.
//
// Load order: none required by other Shelron files, but the runtime needs
// window.__appAccessToken to exist for authenticated requests to succeed —
// same requirement every other proxy-calling module already has.
// =============================================================================
'use strict';

window.Shelron = window.Shelron || {};

window.Shelron.Parser = (function () {
  const ENDPOINT = '/api/shelron/parse';

  function todayLocalISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // parse(text) -> Promise<Entities>
  // Entities shape (success): { intent, title, description, date, startTime,
  //   endTime, location, people: [], confidence }
  // `intent` is a RAW HINT from the model only — the Intent Engine
  // (js/shelron/intent-engine.js) makes the real, deterministic decision and
  // must not trust it blindly. This function performs no validation beyond
  // "did the proxy return usable JSON".
  // Entities shape (failure): { error: 'empty_input' | 'http_<status>' | 'network' }
  async function parse(text) {
    const raw = String(text || '').trim();
    if (!raw) return { error: 'empty_input' };

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          window.__appAccessToken ? { 'Authorization': 'Bearer ' + window.__appAccessToken } : {}
        ),
        body: JSON.stringify({ text: raw, today: todayLocalISO() }),
        // Known Issue #18 fix: must stay >= the server's own Gemini timeout
        // (30000ms, proxy/server.js POST /api/shelron/parse) — a shorter
        // client timeout was aborting requests the server would have
        // finished successfully, showing a false "network" error. +2s buffer
        // for the extra network hop the client sees that the server doesn't.
        signal: AbortSignal.timeout(32000),
      });
      if (!res.ok) return { error: 'http_' + res.status };
      return await res.json();
    } catch (e) {
      return { error: 'network' };
    }
  }

  return { parse };
})();
