// =============================================================================
// SHELRON — Action Dispatcher (v0.1)
// The single enforcement chokepoint between "an intent was decided" and "the
// app changed". Routes a validated Intent to whichever handler a module
// registered for it. Contains ZERO business logic and ZERO AI — see
// aptron Brain/02 Architecture/Shelron.md, "The central law: AI proposes,
// deterministic code disposes". If this file ever grows an if/else that
// decides HOW to fulfill an intent, that logic belongs in a module adapter
// instead, not here.
//
// Load order: must load before any module adapter that calls
// registerHandler() at its own load time (see js/shelron/calendar-adapter.js).
// =============================================================================
'use strict';

window.Shelron = window.Shelron || {};

window.Shelron.Dispatch = (function () {
  const handlers = Object.create(null);

  // registerHandler(intentName, fn) — fn: (entities) => Promise<Result>
  // Result shape: { ok: boolean, reply: string, data?: any, error?: string }
  function registerHandler(intentName, fn) {
    if (typeof intentName !== 'string' || !intentName) {
      throw new Error('Shelron.Dispatch.registerHandler: intentName must be a non-empty string');
    }
    if (typeof fn !== 'function') {
      throw new Error('Shelron.Dispatch.registerHandler: handler must be a function');
    }
    handlers[intentName] = fn;
  }

  // execute(intentObj) -> Promise<Result>
  // intentObj comes from Shelron.Intent.classify() — { intent, entities, valid, errors }.
  // Validation failures never reach a handler; that's the enforcement this
  // engine exists for.
  async function execute(intentObj) {
    const intentObj_ = intentObj || {};
    const { intent, entities, valid, errors } = intentObj_;

    if (!valid) {
      const errs = errors || [];
      // Verification A fix: `invalid_date` isn't a MISSING field — saying
      // "missing: invalid_date" shows the user a raw error code inside a
      // sentence that contradicts itself. Give it a human phrase instead;
      // every other code keeps the existing "missing: X" wording unchanged.
      const rest = errs.filter(function (c) { return c !== 'invalid_date'; });
      const reply = errs.includes('invalid_date')
        ? "I couldn't understand that date." + (rest.length ? ' Also missing: ' + rest.join(', ') + '.' : '')
        : "I couldn't do that — missing: " + errs.join(', ') + '.';
      return { ok: false, reply, error: 'validation_failed', errors: errs };
    }

    const handler = handlers[intent];
    if (!handler) {
      return { ok: false, reply: 'Shelron does not know how to handle "' + intent + '" yet.', error: 'no_handler' };
    }

    try {
      const result = await handler(entities);
      return result && typeof result === 'object' ? result : { ok: false, reply: 'No result.', error: 'bad_handler_result' };
    } catch (e) {
      return { ok: false, reply: 'Something went wrong applying that.', error: 'handler_threw' };
    }
  }

  // registeredIntents() — introspection helper, used by nothing yet; exists so
  // a future UI/debug surface doesn't need to reach into the closure.
  function registeredIntents() {
    return Object.keys(handlers);
  }

  return { registerHandler, execute, registeredIntents };
})();
