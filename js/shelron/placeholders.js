// =============================================================================
// SHELRON — Future engine placeholders
// Shelron is the internal engine layer behind the single user-facing
// assistant, Shenlong (js/index.js) — see aptron Brain/02 Architecture/
// Shelron.md. These seven engines are architecturally reserved there but
// explicitly NOT implemented yet. Every export below throws if called, so a
// future accidental call surfaces immediately instead of silently no-op'ing.
//
// PLACEHOLDER SEAM (matching the existing js/wardrobe.js convention — see
// Known Issues / Ideas.md): do not implement a body here without first
// updating Shelron.md, and filing an ADR if the change is architectural —
// see the Maintenance Protocol change-type table.
// =============================================================================
'use strict';

window.Shelron = window.Shelron || {};

(function () {
  function notImplemented(name) {
    return function () {
      throw new Error('Shelron.' + name + ' is a v0.1 PLACEHOLDER SEAM — not implemented. See Shelron.md.');
    };
  }

  // PLACEHOLDER SEAM: Memory Engine — long-term memory (episodic + derived
  // preference), backed by shelron_memories (pgvector) once built.
  // Shelron.md §3.
  window.Shelron.Memory = {
    propose: notImplemented('Memory.propose'),
    commit:  notImplemented('Memory.commit'),
    query:   notImplemented('Memory.query'),
    forget:  notImplemented('Memory.forget'),
  };

  // PLACEHOLDER SEAM: Context Builder — assembles a bounded, provenance-
  // tagged ContextBundle for the Decision Engine / Prompt Builder. v0.1's
  // parser builds its own tiny inline context ({text, today}) instead —
  // extracting a real Context Builder is deferred until a second consumer
  // needs the same aggregation. Shelron.md §2.
  window.Shelron.Context = {
    build: notImplemented('Context.build'),
  };

  // PLACEHOLDER SEAM: Decision Engine — the reasoning layer; produces
  // Proposals only, never applies them directly. Shelron.md §5.
  window.Shelron.Decision = {
    propose: notImplemented('Decision.propose'),
  };

  // PLACEHOLDER SEAM: Planner — NOT one of Shelron.md's original 8 engines;
  // named by the owner as a v0.1 future placeholder. Multi-step task
  // planning (e.g. breaking "plan my week" into ordered proposals) looks
  // architecturally closest to an extension of the Decision Engine, but its
  // final shape is undecided — `[owner input needed]`, tracked as an open
  // question in Shelron.md rather than designed here.
  window.Shelron.Planner = {
    plan: notImplemented('Planner.plan'),
  };

  // PLACEHOLDER SEAM: Agent Manager — lifecycle/sandboxing for future named
  // agents, composed of the other engines only; never a parallel path to
  // data. Shelron.md §8.
  window.Shelron.Agents = {
    register: notImplemented('Agents.register'),
    run:      notImplemented('Agents.run'),
    list:     notImplemented('Agents.list'),
  };

  // PLACEHOLDER SEAM: Prompt Builder — the one place LLM prompt text would be
  // assembled once more than one AI-touching route exists. v0.1's parser
  // route builds its prompt inline in proxy/server.js on purpose — Shelron.md
  // §6 itself says extract this once there's real reuse, not speculatively.
  window.Shelron.Prompt = {
    build: notImplemented('Prompt.build'),
  };

  // PLACEHOLDER SEAM: Knowledge Engine — retrieval over a future Obsidian
  // Knowledge module (03 Modules/Knowledge.md) — NOT the Aptron Brain vault.
  // Would be built as a Memory Engine consumer, not a separate store.
  // Shelron.md § Relationship with Obsidian.
  window.Shelron.Knowledge = {
    retrieve: notImplemented('Knowledge.retrieve'),
  };
})();
