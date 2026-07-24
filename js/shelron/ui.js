// =============================================================================
// SHELRON — UI (v0.1)
// The smallest possible interface: one input, one output line. No chat log,
// no history, no avatars, no animation — deliberately, so this stays a proof
// of the architecture (Parser → Intent Engine → Action Dispatcher →
// Calendar Adapter) rather than a product surface. This is NOT a replacement
// for the Shenlong assistant elsewhere on this page — a separate, minimal
// harness that happens to sit on the same dashboard. See
// aptron Brain/02 Architecture/Shelron.md.
//
// Load order: must load after every other js/shelron/*.js file (needs
// Parser, Intent, and Dispatch all defined) and after the DOM elements below
// exist — safe as a `defer` script placed after them in index.html.
// =============================================================================
'use strict';

(function () {
  const form   = document.getElementById('shelronForm');
  const input  = document.getElementById('shelronInput');
  const output = document.getElementById('shelronOutput');
  if (!form || !input || !output) return;

  function setOutput(text, isError) {
    output.textContent = text;
    output.classList.toggle('is-error', !!isError);
  }

  // RC-1 polish: the user must never see a raw error code (http_503,
  // network, etc.) — only a plain-language sentence. The technical code
  // still goes to the console so it's debuggable. `code` is whatever
  // Shelron.Parser.parse() returned in its `error` field (see parser.js).
  function friendlyParseError(code) {
    if (typeof code === 'string' && code.indexOf('http_') === 0) {
      const status = code.slice(5);
      if (status === '429') return "You're sending requests too fast — please wait a moment and try again.";
      if (status === '503') return 'The AI service is temporarily unavailable.';
      return "I couldn't reach the AI service. Please try again in a moment.";
    }
    if (code === 'network') return "I couldn't reach the AI service. Please try again in a moment.";
    if (code === 'empty_input') return 'Type something first.';
    return 'Something went wrong. Please try again.';
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    input.disabled = true;
    setOutput('Thinking…', false);

    try {
      const entities = await window.Shelron.Parser.parse(text);
      if (entities.error) {
        console.error('[Shelron] parse failed:', entities.error);
        setOutput(friendlyParseError(entities.error), true);
        return;
      }
      const intentObj = window.Shelron.Intent.classify(entities, text);
      const result = await window.Shelron.Dispatch.execute(intentObj);
      setOutput(result.reply, !result.ok);
    } catch (e) {
      console.error('[Shelron] unexpected error:', e);
      setOutput('Something went wrong. Please try again.', true);
    } finally {
      input.disabled = false;
      input.value = '';
      input.focus();
    }
  });
})();
