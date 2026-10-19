/* ============================================================
   routine-authoring.js — window.Shelron.Routines. Deterministic
   gym-routine authoring/editing/reading for Shenlong (js/index.js).

   Why this exists: Known Issue #53's open half — Shenlong could
   correctly DECLINE a routine-authoring request (gym_unsupported)
   but never actually build/edit one. This module is the real
   capability: it parses the required natural-language phrasings
   into a structured op, resolves exercise names against the same
   748-entry catalog the Routine Builder uses, and writes through
   the SAME two channels gym-cloud.js already writes through
   (localStorage 'rb_routines_v1' in its exact schema, plus a direct
   Supabase 'routines' upsert mirroring gym-cloud.js's toRoutineRow)
   — never a third, parallel storage mechanism.

   Architectural note (index.html never loads the Gym module suite,
   same constraint documented at js/index.js's todayGymSummary()):
   this module can't call window.GymApp / the Routine Builder's own
   functions. It mirrors their exact localStorage schema instead —
   the established precedent in this file's sibling read-only
   helpers — and additionally performs an immediate, targeted
   Supabase write (mirroring gym-cloud.js's row mapping) so a
   routine created here is genuinely verifiable in Supabase right
   away, not only after the user next opens gym.html. This does NOT
   duplicate gym-cloud.js's sync ENGINE (queueing, retry, polling) —
   it is one deterministic write bridge, the same shape as the
   pre-existing logFood() bridge in js/index.js.

   Central law (Shelron.md): AI proposes, deterministic code
   disposes. Nothing in this file calls an LLM. parseIntent() is a
   pure, synchronous pattern matcher; apply() is deterministic
   validation + the actual write. If a future Gemini tier ever
   proposes a routine structure, it still has to pass through
   apply()'s same validation — never a second write path.
   ============================================================ */
(function () {
  'use strict';

  const RB_KEY = 'rb_routines_v1';
  const CATALOG_URL = 'js/exercises-data.json';
  const WEEKDAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const DEFAULT_SETS = 3, DEFAULT_REPS = 10;

  // ── catalog (js/exercises-data.json) ─────────────────────────────────────
  let catalogPromise = null;
  let catalogCache = null; // synchronously available once warm — see below
  function loadCatalog() {
    if (!catalogPromise) {
      catalogPromise = fetch(CATALOG_URL, { cache: 'no-cache' })
        .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then((data) => (Array.isArray(data) ? data : []))
        .catch(() => []);
      catalogPromise.then((data) => { catalogCache = data; });
    }
    return catalogPromise;
  }
  // Fire-and-forget warm-up at module load — by the time a user actually
  // types a command (seconds later, at minimum), catalogCache is normally
  // already populated, which is what lets parseIntent (synchronous, no
  // await) require a REAL exercise-catalog match before ever committing an
  // "add X to Y" / "remove X from Y" phrase to the gym domain. See the ADD/
  // REMOVE branches below for why that check matters.
  loadCatalog();

  // Deterministic best-match against the catalog. Every query token must
  // appear as a whole word in the candidate name (no fuzzy/typo tolerance —
  // false matches on gym equipment are worse than an honest "not found").
  // Among candidates, prefers fewer extra words, then plainer equipment
  // (barbell/dumbbell/bodyweight over band/cable/machine/assisted), then the
  // shortest name — the deterministic tie-break validated against this
  // catalog's real content before shipping (see the Brain's Gym notes).
  const EQUIP_RANK = { barbell: 1, dumbbell: 2, bodyweight: 3, kettlebell: 4, machine: 5, cable: 6, smith: 7, lever: 8, sled: 9, band: 10, assisted: 11 };
  // Best-effort English singularization so "remove squats"/"add curls" match
  // the catalog's singular naming ("Squat", "Bicep Curl") — a naive exact-
  // token match would otherwise silently fail on the plural a user actually
  // types. Deliberately simple (no dictionary); a handful of irregular
  // plurals (e.g. "raises" → "rais") stay imperfect, an accepted trade-off
  // since the resolved exercise name is always disclosed back to the user.
  // Short irregular plurals the length-guarded rule below would otherwise
  // miss ("push ups"/"pull ups"/"sit ups" are common gym phrasing) or wrongly
  // mangle if the guard were simply lowered ("abs" is not "ab"+s).
  const SHORT_PLURALS = { ups: 'up', downs: 'down', abs: 'abs' };
  function singularize(tok) {
    if (SHORT_PLURALS[tok]) return SHORT_PLURALS[tok];
    if (/(?:ch|sh|s|x|z)es$/.test(tok) && tok.length > 4) return tok.slice(0, -2);
    if (/[^s]s$/.test(tok) && tok.length > 3) return tok.slice(0, -1);
    return tok;
  }
  function normTokens(s) {
    return String(s || '').toLowerCase().replace(/%[0-9a-f]{2}/gi, ' ')
      .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(singularize);
  }
  function matchExercise(query, catalog) {
    const q = normTokens(query);
    if (!q.length || !Array.isArray(catalog) || !catalog.length) return null;
    let best = null;
    for (const e of catalog) {
      if (!e || !e.name) continue;
      const t = normTokens(e.name);
      const tset = new Set(t);
      if (!q.every((tok) => tset.has(tok))) continue;
      const extra = t.filter((tok) => !q.includes(tok));
      const equipToken = extra.find((tok) => EQUIP_RANK[tok]);
      const rank = equipToken ? EQUIP_RANK[equipToken] : 20;
      const cand = { e, extraCount: extra.length, rank, len: t.length };
      if (!best ||
          cand.extraCount < best.extraCount ||
          (cand.extraCount === best.extraCount && cand.rank < best.rank) ||
          (cand.extraCount === best.extraCount && cand.rank === best.rank && cand.len < best.len)) {
        best = cand;
      }
    }
    return best ? best.e : null;
  }

  // ── muscle-group day templates ───────────────────────────────────────────
  // Curated canonical queries per body-part keyword, each resolved through
  // matchExercise() at runtime (not hardcoded catalog ids — stays correct if
  // js/exercises-data.json is ever regenerated, per CLAUDE.md's "edit the
  // generator, not the generated file" rule). A deliberate, documented
  // default — same spirit as the Routine Builder's own DEFAULTS (3 sets,
  // 10 reps) — never fabricated per-request, always disclosed by full
  // resolved name in Shenlong's confirmation message.
  const MUSCLE_TEMPLATES = {
    chest: ['bench press', 'incline dumbbell press', 'push up'],
    triceps: ['skull crusher', 'triceps pushdown'],
    back: ['seated row', 'lat pulldown'],
    biceps: ['bicep curl', 'hammer curl'],
    legs: ['squat', 'romanian deadlift', 'leg curl', 'lunge'],
    shoulders: ['shoulder press', 'lateral raise'],
    core: ['plank', 'bicycle crunch'],
    glutes: ['glute bridge', 'hip thrust'],
  };
  const MUSCLE_KEYWORDS = [
    [/\bchest\b|\bpecs?\b/, 'chest'],
    [/\btriceps?\b|\btris\b/, 'triceps'],
    [/\bback\b|\blats?\b/, 'back'],
    [/\bbiceps?\b|\bbis\b/, 'biceps'],
    [/\blegs?\b|\bquads?\b|\bhamstrings?\b|\bcalves\b|\bleg day\b/, 'legs'],
    [/\bshoulders?\b|\bdelts?\b/, 'shoulders'],
    [/\bcore\b|\babs?\b/, 'core'],
    [/\bglutes?\b/, 'glutes'],
  ];
  function muscleGroupsIn(text) {
    const found = [];
    MUSCLE_KEYWORDS.forEach(([re, key]) => { if (re.test(text) && found.indexOf(key) === -1) found.push(key); });
    return found;
  }
  // Named splits: each entry is a list of {label, groups} "days" — used both
  // when the user names a template ("push pull legs") and to label the
  // resulting routines. Unscheduled by default (no trainingDays) unless the
  // request also names explicit weekdays, handled separately in parseCreate.
  const SPLIT_TEMPLATES = {
    'push pull legs': [
      { label: 'Push', groups: ['chest', 'shoulders', 'triceps'] },
      { label: 'Pull', groups: ['back', 'biceps'] },
      { label: 'Legs', groups: ['legs'] },
    ],
    'ppl': null, // alias, resolved below
    'upper lower': [
      { label: 'Upper', groups: ['chest', 'back', 'shoulders', 'biceps', 'triceps'] },
      { label: 'Lower', groups: ['legs'] },
    ],
    'full body': [
      { label: 'Full Body', groups: ['chest', 'back', 'legs', 'shoulders', 'core'] },
    ],
  };
  SPLIT_TEMPLATES.ppl = SPLIT_TEMPLATES['push pull legs'];
  function findSplitTemplate(t) {
    if (/\bpush\b.*\bpull\b.*\blegs?\b|\bppl\b/i.test(t)) return SPLIT_TEMPLATES['push pull legs'];
    if (/\bupper\b.*\blower\b|\bupper[\s/-]lower\b/i.test(t)) return SPLIT_TEMPLATES['upper lower'];
    if (/\bfull[\s-]body\b/i.test(t)) return SPLIT_TEMPLATES['full body'];
    return null;
  }
  function labelFor(groups) {
    const names = groups.map((g) => g.charAt(0).toUpperCase() + g.slice(1));
    return names.length > 1 ? names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1] : (names[0] || 'Workout');
  }
  function queriesFor(groups) {
    const seen = new Set(), out = [];
    groups.forEach((g) => (MUSCLE_TEMPLATES[g] || []).forEach((q) => { if (!seen.has(q)) { seen.add(q); out.push(q); } }));
    return out;
  }

  // ── weekday extraction ───────────────────────────────────────────────────
  function weekdayCodeIn(segment) {
    const m = segment.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    return m ? WEEKDAY_CODES[WEEKDAY_NAMES.indexOf(m[1].toLowerCase())] : null;
  }
  function allWeekdaysIn(text) {
    const codes = [];
    WEEKDAY_NAMES.forEach((name, i) => { if (new RegExp('\\b' + name + '\\b', 'i').test(text)) codes.push(WEEKDAY_CODES[i]); });
    return codes;
  }
  function dayLabel(code) {
    const i = WEEKDAY_CODES.indexOf(code);
    return i === -1 ? code : WEEKDAY_NAMES[i].charAt(0).toUpperCase() + WEEKDAY_NAMES[i].slice(1);
  }

  // ── local storage (rb_routines_v1) — exact Routine Builder schema ───────
  function getRoutines() {
    try { return JSON.parse(localStorage.getItem(RB_KEY)) || []; } catch (e) { return []; }
  }
  function saveRoutines(arr) {
    try { localStorage.setItem(RB_KEY, JSON.stringify(arr)); } catch (e) {}
    // Same cross-tab/same-page signal gym-routine-builder.js emits on every
    // save, so an open Gym tab picks this up live instead of only on reload.
    try { window.dispatchEvent(new CustomEvent('rb:routines-changed')); } catch (e) {}
  }
  function uidRoutine() { return 'rt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function toRoutineExercise(catalogEntry, sets, reps) {
    return {
      exId: catalogEntry.id, name: catalogEntry.name, muscleGroup: catalogEntry.muscleGroup, gifUrl: catalogEntry.gifUrl,
      sets: Array.from({ length: sets || DEFAULT_SETS }, () => ({ weight: 0, reps: reps || DEFAULT_REPS })),
    };
  }

  // ── Supabase write bridge — mirrors gym-cloud.js's toRoutineRow exactly ──
  async function getClient() {
    await (window.APP_AUTH_READY || Promise.resolve());
    return window.APP_SUPABASE || null;
  }
  function toRoutineRow(r) {
    return {
      client_id: r.id, name: r.name || 'Untitled routine', exercises: r.exercises || [],
      updated_at: r.updated_at || new Date().toISOString(),
      training_days: Array.isArray(r.trainingDays) ? r.trainingDays : [],
      goal: r.goal || null,
      rest: (r.rest != null ? r.rest : null),
      rest_enabled: r.restEnabled !== false
    };
  }
  async function pushRoutineNow(r) {
    const supa = await getClient();
    if (!supa) return false;
    try { const { error } = await supa.from('routines').upsert(toRoutineRow(r), { onConflict: 'client_id' }); return !error; }
    catch (e) { return false; }
  }
  async function deleteRoutineNow(id) {
    const supa = await getClient();
    if (!supa) return false;
    try { const { error } = await supa.from('routines').delete().eq('client_id', id); return !error; }
    catch (e) { return false; }
  }

  // ── domain-scoped coreference — separate from Calendar's, deliberately.
  // "remove it" after a gym command must never resolve against the last
  // CALENDAR event, and vice versa (item 6 of the hardening brief). ──
  let lastRoutineRef = null; // { id, name } of the last routine this module touched
  function remember(r) { if (r && r.id) lastRoutineRef = { id: r.id, name: r.name }; }

  // ── routine resolution — "Friday" / "my Friday routine" / "it" / a name ─
  function findRoutineByDay(routines, day) { return routines.find((r) => Array.isArray(r.trainingDays) && r.trainingDays.includes(day)) || null; }
  // SHENLONG P9 (2026-09-14, live-verified): applyDeleteRoutine's ONLY use
  // of findRoutineByDay() used to take its first-match result as final —
  // "Delete my Friday routine" with two real routines both scheduled Friday
  // silently deleted whichever was FIRST in the array (proven array-order
  // dependent), and "Delete my Friday Legs routine" against ["Upper Body",
  // "Legs"] (both Friday) could delete "Upper Body" — the routine the user
  // did NOT name — purely because it happened to be first. findRoutineByDay()
  // itself is left unchanged (add_exercise/set_sets/read_week are
  // non-destructive callers, out of this fix's scope — see the Brain note);
  // this deletion-only helper returns EVERY day match so applyDeleteRoutine
  // can require an exact candidate count, the same way P8 already requires
  // an exact name-candidate count.
  function findRoutinesByDay(routines, day) {
    return routines.filter((r) => Array.isArray(r.trainingDays) && r.trainingDays.includes(day));
  }
  // SHENLONG P7 (2026-09-13, live-verified): this fed applyDeleteRoutine's
  // ONLY name-based resolution path, and its substring fallback used to let
  // "delete the triceps routine" silently delete "Chest & Triceps" (the
  // first array match) while a routine actually named "Triceps Focus" sat
  // untouched — no ambiguity/error was ever reported. The exact same bug
  // class was already caught and fixed for exercise-level matching (see
  // findExerciseByQuery below): a substring hit is not a real match, it's a
  // coincidence, and coincidences must not drive a destructive delete. The
  // substring fallback was removed; exact normalized-name match only.
  //
  // SHENLONG P8 (2026-09-13, live-verified): exact-match alone wasn't
  // enough — two routines CAN legitimately normalize to the same key
  // ("Legs" / "legs" / " LEGS ", or "Upper Body" / "upper   body"), and the
  // old `routines.find(...)` returned whichever one happened to be FIRST in
  // the array, silently deleting it with no ambiguity warning. Proven
  // array-order dependent: reversing the seed order flipped which routine
  // got deleted for the identical command. Returns EVERY exact match now
  // (still exact-only, never substring — P7's protection is unchanged) so
  // the caller can tell "one real target" apart from "genuinely ambiguous,"
  // mirroring the hits-collection style applySetSets already uses below for
  // the same "same exercise, ambiguous which routine" problem.
  function findRoutineByName(routines, name) {
    const q = normTokens(name).join(' ');
    if (!q) return [];
    return routines.filter((r) => normTokens(r.name).join(' ') === q);
  }

  // ── PARSING ───────────────────────────────────────────────────────────
  const ROUTINE_WORD = /\b(routine|plan|program|split)\b/i;
  const CAL_DISAMBIGUATOR = /\b(event|meeting|appointment|block|calendar)\b/i;
  const BARE_GYM_WORD = /\b(workout|gym|training)\b/i;

  function parseCreate(raw, t) {
    const weekdaysFound = allWeekdaysIn(t);

    // Named split template ("push pull legs", "upper lower", "full body")
    // is checked FIRST and wins outright — it's a more specific, deliberate
    // signal than a single incidentally-matched muscle keyword (e.g. "legs"
    // inside "push pull legs" would otherwise look like a bare one-day
    // "Legs" request and silently swallow "push"/"pull"). If explicit
    // weekdays were also named, they're assigned to the template's days in
    // order; otherwise the routines are created unscheduled.
    const split = findSplitTemplate(t);
    if (split) {
      const days = weekdaysFound; // may be empty — unscheduled is fine
      return {
        specs: split.map((d, i) => ({ name: d.label, trainingDays: days[i] ? [days[i]] : [], exerciseQueries: queriesFor(d.groups) })),
        needsClarification: null,
      };
    }

    // Explicit day → focus segments: split on commas/semicolons/" and ",
    // only when 2+ weekdays are actually present (a single-day request like
    // "chest and triceps workout for Monday" must NOT be split on its own
    // "and").
    const segments = weekdaysFound.length >= 2
      ? raw.split(/[,;]|\band\s+(?=\w+day\b)/i).map((s) => s.trim()).filter(Boolean)
      : [raw];

    const specs = [];
    segments.forEach((seg) => {
      const day = weekdayCodeIn(seg);
      const groups = muscleGroupsIn(seg.toLowerCase());
      if (day && groups.length) {
        specs.push({ name: labelFor(groups), trainingDays: [day], exerciseQueries: queriesFor(groups) });
      } else if (!day && groups.length && segments.length === 1) {
        // "Create a chest and triceps workout" with no day at all — build it
        // unscheduled rather than refusing outright.
        specs.push({ name: labelFor(groups), trainingDays: [], exerciseQueries: queriesFor(groups) });
      }
    });
    if (specs.length) return { specs, needsClarification: null };

    // Recognizable as a create request but genuinely underspecified — ask,
    // don't invent a workout the user never described.
    return {
      specs: [],
      needsClarification: 'What should each day focus on? For example: "Monday chest and triceps, Wednesday back and biceps, Friday legs" — or name a split like "push pull legs".',
    };
  }

  function parseAddOrRemove(raw, t, verb) {
    // "add bench press to monday" / "remove squats from friday"
    const prep = verb === 'add' ? 'to' : 'from';
    const re = new RegExp('\\b' + verb + '\\b\\s+(.+?)\\s+' + prep + '\\s+(.+)$', 'i');
    const m = raw.match(re);
    let exercisePhrase, dayPhrase = null;
    if (m) { exercisePhrase = m[1]; dayPhrase = m[2]; }
    else { exercisePhrase = raw.replace(new RegExp('\\b' + verb + '\\b', 'i'), '').trim(); }
    exercisePhrase = exercisePhrase.replace(/\b(the|a|an|my)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const day = dayPhrase ? weekdayCodeIn(dayPhrase) : weekdayCodeIn(t);
    return { exerciseQuery: exercisePhrase, day };
  }

  // "make that four sets" — a Phase 4 pass caught spelled-out numbers not
  // being recognized at all (the regex below requires a literal digit),
  // silently falling through to the generic gym_unsupported decline even
  // though set_sets genuinely supports the request once it has a number.
  const WORD_NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  function wordNumbersToDigits(s) {
    return s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi, (w) => String(WORD_NUMBERS[w.toLowerCase()]));
  }
  function parseSetSets(raw, t) {
    // "change bench press to 4 sets" / "make bench press 4 sets" / "set squats to 3 sets"
    // / "change bench press on Monday to 4 sets" — an optional day narrows
    // which routine gets touched when the exercise appears in more than one.
    let m = wordNumbersToDigits(t).match(/\b(?:change|set|make)\s+(.+?)\s+(?:to\s+)?(\d+)\s*sets?\b/i);
    if (!m) return null;
    let exerciseQuery = m[1].replace(/\b(the|a|an|my)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const day = weekdayCodeIn(t);
    if (day) {
      const stripped = exerciseQuery.replace(/\b(on|in|for)\b/gi, ' ')
        .replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)('s)?\b/gi, ' ')
        .replace(/\s+/g, ' ').trim();
      // A live adversarial pass caught "Change Monday to 4 sets" — the
      // weekday WAS the entire (mistaken) query, so stripping it emptied
      // exerciseQuery to '', which surfaced as a confusing "I couldn't find
      // \"\" in your routines." instead of an honest "which exercise?".
      // Only accept the stripped version when something real is still left.
      if (stripped) exerciseQuery = stripped;
    }
    if (!exerciseQuery) return null; // nothing resolved to an exercise name at all
    return { exerciseQuery, count: +m[2], day };
  }
  // A physically sane upper bound on a single exercise's set count. Without
  // this, a stray extra digit ("999999" instead of "9") silently wrote an
  // array of that many {weight,reps} objects — a live adversarial pass
  // caught this taking 10-25+ seconds to serialize/push and producing a
  // stored routine no UI could reasonably render. Asks for confirmation
  // instead of either silently accepting or silently clamping the number,
  // consistent with this codebase's "ask, don't guess" convention for
  // anything the user probably didn't mean literally.
  const MAX_SANE_SETS = 50;

  function parseDelete(raw, t) {
    const day = weekdayCodeIn(t);
    // "delete my Friday routine" / "delete the push routine" / "delete it"
    const m = t.match(/\bdelete\b\s+(?:my\s+|the\s+)?(.+?)\s*(?:routine|plan|workout)?\s*$/i);
    let namePhrase = m ? m[1].replace(/\b(routine|plan|workout|my|the)\b/gi, ' ').trim() : '';
    // SHENLONG P1 (2026-09-09, live-verified): a bare pronoun ("it"/"that") is
    // not an explicit name — the caller (parseIntentInner:485) already treats
    // it as a request to resolve against context, via the same `/\bit\b|
    // \bthat\b/i` vocabulary. Left as a literal string here, though, it was a
    // truthy `namePhrase` that (a) never matched a real routine via
    // findRoutineByName and (b) defeated applyDeleteRoutine's own
    // `lastRoutineRef` fallback, which only runs when `!op.namePhrase`. This
    // is an exact whole-phrase match — a name merely containing "it"
    // ("legit") is untouched, so an explicit target is never reclassified as
    // a pronoun.
    if (/^(it|that)$/i.test(namePhrase)) namePhrase = '';
    // SHENLONG P9 (2026-09-14, live-verified): namePhrase still contained
    // the weekday word itself whenever one was present — "delete my Friday
    // routine" produced namePhrase='friday' (not ''), which downstream code
    // could mistake for a real routine-NAME signal when it's just the day
    // constraint restated. Strip it here, same "on/in/for + weekday" strip
    // parseSetSets already performs on its own query phrase — but unlike
    // parseSetSets (where an emptied query means "no exercise at all," an
    // invalid state), an emptied namePhrase here is a valid, meaningful
    // result: "no name info beyond the day itself" is exactly what "delete
    // my Friday routine" (with no further name) means. "friday legs" still
    // correctly reduces to "legs" — a real name signal survives untouched.
    if (day) {
      namePhrase = namePhrase.replace(/\b(on|in|for)\b/gi, ' ')
        .replace(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)('s)?\b/gi, ' ')
        .replace(/\s+/g, ' ').trim();
    }
    return { day, namePhrase };
  }

  function parseAssignDay(raw, t) {
    // "make wednesday my back day" / "make wednesday a leg day"
    const m = t.match(/\bmake\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(?:my|a|the)\s+(.+?)\s*day\b/i);
    if (!m) return null;
    const day = WEEKDAY_CODES[WEEKDAY_NAMES.indexOf(m[1].toLowerCase())];
    const groups = muscleGroupsIn(m[2].toLowerCase());
    return { day, groups };
  }

  // Top-level parse — returns a Shenlong intent object or null (not gym).
  // `t` is the already-lowercased/trimmed text; `raw` preserves case for
  // titles. Never called when the utterance carries an explicit clock time
  // (index.js's caller enforces this — "add gym at 5pm" stays calendar).
  // Shared "is this gym-flavored at all" signal — used both to decide the
  // gym_unsupported fallback inside parseIntent AND, from js/index.js, to
  // stop the generic compound-clause splitter (handle()'s parseCompound)
  // from shredding a multi-day routine request on its OWN commas/"and"
  // before this parser ever sees the whole message intact.
  function looksLikeGymRequest(text) {
    const tt = String(text || '').toLowerCase();
    return ROUTINE_WORD.test(tt) ||
      /\b(exercises?|reps?|sets?|bench(\s*press)?|squat|deadlift|leg day|push day|pull day|hypertrophy)\b/i.test(tt) ||
      muscleGroupsIn(tt).length > 0 || findSplitTemplate(tt) !== null;
  }

  // "Create X and add Y, then move it to Z" — a live adversarial pass found
  // that only the FIRST recognized op (here, the create) ever ran; "add Y"
  // and "move it to Z" were silently dropped with no acknowledgment at all,
  // so the confirmation ("✓ Created...") looked like everything succeeded.
  // Full compound-op execution is real future work (see [[ADR-026]]); this
  // is the honesty half — an unmissable ", then"/"and then" after a
  // recognized op means more was asked for than was done, so say so rather
  // than silently under-deliver.
  const COMPOUND_CONTINUATION = /,?\s*\bthen\b|\band\s+then\b/i;
  function parseIntent(raw, t, date) {
    const result = parseIntentInner(raw, t, date);
    if (result && result.action === 'gym_routine_op' && COMPOUND_CONTINUATION.test(raw)) {
      result.op.hasUnexecutedCompoundStep = true;
    }
    return result;
  }

  function parseIntentInner(raw, t, date) {
    const strongSignal = looksLikeGymRequest(t);

    // CREATE
    if (/\b(create|make|build|start|set up|give)\b/i.test(t) && (ROUTINE_WORD.test(t) || findSplitTemplate(t) || (muscleGroupsIn(t).length && /\bworkout\b|\bday\b/i.test(t)))) {
      const parsed = parseCreate(raw, t);
      if (parsed.needsClarification) return { action: 'gym_clarify', question: parsed.needsClarification };
      if (parsed.specs.length) return { action: 'gym_routine_op', op: { kind: 'create_multi', routines: parsed.specs } };
    }
    // ASSIGN DAY ("make Wednesday my back day") — checked before generic ADD.
    {
      const assign = parseAssignDay(raw, t);
      if (assign) {
        if (!assign.groups.length) return { action: 'gym_clarify', question: 'What should ' + dayLabel(assign.day) + ' focus on? e.g. "back", "legs", "chest and triceps".' };
        return { action: 'gym_routine_op', op: { kind: 'assign_day', day: assign.day, name: labelFor(assign.groups), exerciseQueries: queriesFor(assign.groups) } };
      }
    }
    // ADD exercise — "add X to Y" is structurally identical to a plain
    // calendar create ("add dentist to Monday"). A live adversarial pass
    // caught exactly this: with no further check, ANY "add ... to ..."
    // phrase with no parseable time got swallowed into the gym domain,
    // including genuine calendar creates that happen to name a weekday.
    // Required only when the extracted phrase actually resolves against the
    // real exercise catalog (via the eagerly-warmed synchronous cache
    // above) — never on the bare verb+preposition shape alone. A cold
    // cache (the very first command of a session, before the warm-up fetch
    // resolves) intentionally falls through to calendar rather than guess.
    if (/\badd\b/i.test(t) && !/\badd\b.*\b(exercise|reminder|remind)\b.*\bto\b\s*$/i.test(t)) {
      const r = parseAddOrRemove(raw, t, 'add');
      if (r.exerciseQuery && catalogCache && matchExercise(r.exerciseQuery, catalogCache)) {
        return { action: 'gym_routine_op', op: { kind: 'add_exercise', exerciseQuery: r.exerciseQuery, day: r.day } };
      }
    }
    // REMOVE exercise — same false-positive risk and same fix as ADD above
    // ("remove milk from my shopping list" must never reach the gym domain).
    if (/\bremove\b/i.test(t) && !ROUTINE_WORD.test(t)) {
      const r = parseAddOrRemove(raw, t, 'remove');
      if (r.exerciseQuery && catalogCache && matchExercise(r.exerciseQuery, catalogCache)) {
        return { action: 'gym_routine_op', op: { kind: 'remove_exercise', exerciseQuery: r.exerciseQuery, day: r.day } };
      }
    }
    // SET SETS — "N sets" is gym-specific vocabulary no calendar phrase
    // plausibly produces; safe to trigger on the verb+count shape alone.
    {
      const s = parseSetSets(raw, t);
      if (s && s.count > MAX_SANE_SETS) {
        return { action: 'gym_clarify', question: 'That’s ' + s.count + ' sets — more than I’d expect for one exercise. Did you mean a smaller number?' };
      }
      if (s) return { action: 'gym_routine_op', op: { kind: 'set_sets', exerciseQuery: s.exerciseQuery, count: s.count, day: s.day } };
    }
    // DELETE routine — ROUTINE_WORD ("delete my routine"/"delete the plan")
    // is unambiguous and always fires. A bare weekday or pronoun ("delete
    // it", "delete the Monday thing") is NOT enough on its own — a live
    // adversarial pass caught "Delete SHENLONG_AUDIT_TEST meeting on Monday"
    // (an explicit, clearly-calendar delete) being hijacked here purely
    // because it named a weekday, with zero gym signal. Only trusted when
    // Shenlong's own last successful gym action in this session actually
    // WAS a routine (lastRoutineRef) — the same domain-scoped-coreference
    // principle the calendar side already uses for its own pronouns —
    // otherwise this falls through to the calendar's delete_event handling,
    // which has its own (calendar-scoped) pronoun memory.
    if (/\bdelete\b/i.test(t)) {
      if (ROUTINE_WORD.test(t)) {
        const d = parseDelete(raw, t);
        return { action: 'gym_routine_op', op: { kind: 'delete_routine', day: d.day, namePhrase: d.namePhrase } };
      }
      if (lastRoutineRef && (weekdayCodeIn(t) || /\bit\b|\bthat\b/i.test(t))) {
        const d = parseDelete(raw, t);
        return { action: 'gym_routine_op', op: { kind: 'delete_routine', day: d.day, namePhrase: d.namePhrase } };
      }
    }
    // WEEKLY read
    if (/\b(week(ly)?)\b.*\b(routine|schedule|plan|split)\b|\bmy routines\b/i.test(t)) {
      return { action: 'gym_week' };
    }

    // A bare muscle-group word ("back", "core", "legs"...) can appear in an
    // entirely innocent calendar phrase ("welcome back party", "core values
    // meeting") — strongSignal alone isn't enough to decline as gym-
    // unsupported; also require something that actually looks like an
    // attempted action, not just incidental word overlap.
    if (strongSignal && /\b(add|create|make|build|start|set up|remove|delete|change|update|edit|modify)\b/i.test(t)) {
      return { action: 'gym_unsupported' };
    }

    // Bare "workout"/"gym"/"training" with a mutating verb and no domain
    // disambiguator on EITHER side — genuinely ambiguous with a calendar
    // block/event of the same name (Known Issue #22's legitimate use case).
    // Ask, never silently guess in either direction.
    if (BARE_GYM_WORD.test(t) && /\b(move|change|delete|remove|reschedule|cancel)\b/i.test(t) && !CAL_DISAMBIGUATOR.test(t)) {
      const verb = /\b(delete|remove|cancel)\b/i.test(t) ? 'delete' : 'move';
      return {
        action: 'gym_clarify',
        question: verb === 'delete'
          ? 'Delete a calendar event, or delete a gym routine? Try "delete the Workout event" or "delete my Friday routine".'
          : 'Move a calendar event, or reschedule which day a gym routine falls on? Try "move my Workout event to Friday" or "make Friday my routine day".',
      };
    }
    return null;
  }

  // ── APPLY — the deterministic write. Always resolves exercise names
  // against the real catalog; never fabricates one. ─────────────────────
  async function applyCreateMulti(op) {
    const catalog = await loadCatalog();
    if (!catalog.length) return { ok: false, reason: 'catalog_unavailable' };
    const routines = getRoutines();
    const created = [];
    op.routines.forEach((spec) => {
      // A day already claimed by another routine is reassigned here, so two
      // routines never silently compete for the same weekday (todaysScheduledRoutine()
      // only ever returns the first match, which would otherwise be a
      // confusing, order-dependent surprise).
      if (spec.trainingDays.length) {
        routines.forEach((r) => { r.trainingDays = (r.trainingDays || []).filter((d) => !spec.trainingDays.includes(d)); });
      }
      const exercises = spec.exerciseQueries.map((q) => matchExercise(q, catalog)).filter(Boolean).map((e) => toRoutineExercise(e));
      const r = { id: uidRoutine(), name: spec.name, exercises, restEnabled: true, rest: 90, goal: null, trainingDays: spec.trainingDays.slice(), updated_at: new Date().toISOString() };
      routines.push(r);
      created.push(r);
    });
    saveRoutines(routines);
    const pushResults = await Promise.all(created.map((r) => pushRoutineNow(r)));
    if (created.length) remember(created[created.length - 1]);
    return { ok: true, created, cloudSynced: pushResults.every(Boolean) };
  }

  async function applyAssignDay(op) {
    const catalog = await loadCatalog();
    if (!catalog.length) return { ok: false, reason: 'catalog_unavailable' };
    const routines = getRoutines();
    routines.forEach((r) => { r.trainingDays = (r.trainingDays || []).filter((d) => d !== op.day); });
    const exercises = op.exerciseQueries.map((q) => matchExercise(q, catalog)).filter(Boolean).map((e) => toRoutineExercise(e));
    const r = { id: uidRoutine(), name: op.name, exercises, restEnabled: true, rest: 90, goal: null, trainingDays: [op.day], updated_at: new Date().toISOString() };
    routines.push(r);
    saveRoutines(routines);
    const synced = await pushRoutineNow(r);
    remember(r);
    return { ok: true, routine: r, cloudSynced: synced };
  }

  function resolveTargetRoutine(routines, day) {
    if (day) return findRoutineByDay(routines, day);
    if (lastRoutineRef) return routines.find((r) => r.id === lastRoutineRef.id) || null;
    return null;
  }

  async function applyAddExercise(op) {
    const catalog = await loadCatalog();
    if (!catalog.length) return { ok: false, reason: 'catalog_unavailable' };
    const match = matchExercise(op.exerciseQuery, catalog);
    if (!match) return { ok: false, reason: 'exercise_not_found', query: op.exerciseQuery };
    const routines = getRoutines();
    // SHENLONG P10b (2026-09-15, live-verified): an explicit op.day used to
    // resolve via resolveTargetRoutine() → findRoutineByDay() — a bare
    // Array.find() with no candidate-count awareness at all (unlike
    // applySetSets's P10a fix or applyDeleteRoutine's P9 fix, this caller
    // never had ANY ambiguity guard). Proven reachable through the real
    // Gym app UI (its lightweight routine-creation flow has no cross-
    // routine day-uniqueness check): with 2+ routines scheduled for the
    // same day, the exercise was silently added to whichever was first in
    // array order — confirmed order-dependent, and confirmed that a
    // routine NAME mentioned in the phrase ("...to my Push Day routine on
    // friday") is not actually parsed by parseAddOrRemove() (it returns
    // only {exerciseQuery, day}) and so cannot disambiguate this today.
    // Deliberately local to applyAddExercise — resolveTargetRoutine() and
    // applyRemoveExercise() (which shares it) are left untouched; that
    // caller has its own independently-reachable day-ambiguity bug, tracked
    // as a separate follow-up, and must not be affected by this fix. An
    // explicit day is now resolved directly against ALL routines
    // (add_exercise has no exercise-hit set to scope against — it may be
    // adding a genuinely new exercise — so the candidate set is every
    // routine scheduled that day, not P10a's hits-based scoping): exactly
    // one day-matching routine mutates; zero preserves the existing
    // no_routine_for_day failure below unchanged; two or more fails
    // immediately, non-mutating, reusing 'ambiguous_day' — the same reason
    // applyDeleteRoutine already uses for this identical "day matched 2+
    // routines" shape (routine-authoring.js:782) — so no js/index.js
    // change is needed; its existing generic add_exercise fallback message
    // already renders this honestly. lastRoutineRef is never consulted
    // when a day is given (resolveTargetRoutine, the only place it's read,
    // is not called in this branch); the no-day path below is untouched.
    let r;
    if (op.day) {
      const dayCandidates = routines.filter((x) => Array.isArray(x.trainingDays) && x.trainingDays.includes(op.day));
      if (dayCandidates.length > 1) return { ok: false, reason: 'ambiguous_day', candidates: dayCandidates.map((x) => x.name) };
      r = dayCandidates[0] || null;
    } else {
      r = resolveTargetRoutine(routines, op.day);
    }
    if (!r) {
      if (op.day) return { ok: false, reason: 'no_routine_for_day', day: op.day };
      return { ok: false, reason: 'no_target' };
    }
    r.exercises = r.exercises || [];
    if (r.exercises.some((e) => e.exId === match.id)) return { ok: false, reason: 'already_present', routine: r, exerciseName: match.name };
    r.exercises.push(toRoutineExercise(match));
    r.updated_at = new Date().toISOString();
    saveRoutines(routines);
    const synced = await pushRoutineNow(r);
    remember(r);
    return { ok: true, routine: r, exerciseName: match.name, cloudSynced: synced };
  }

  // Safe exercise-in-routine lookup, shared by remove_exercise and
  // set_sets. Deliberately NOT a substring match against the routine's own
  // exercise name — "bench press" must never silently hit "Barbell Incline
  // Bench Press" just because the string contains it (a live adversarial
  // pass found exactly this reachable through the OLD version of this
  // logic: normTokens(e.name).join(' ').indexOf(q), which matches ANY
  // exercise whose name happens to contain the query as a trailing
  // substring). Only two signals are trusted: (1) the query resolves via
  // the SAME deterministic catalog matcher ADD/CREATE already use, and the
  // candidate's own exId equals that resolution; or (2) the candidate's
  // name, once normalized, is EXACTLY the query (no catalog match, but an
  // exact name — still not a substring). A cold/unresolved catalog with no
  // exact-name match returns null rather than guessing.
  function findExerciseByQuery(exercises, query, match) {
    if (match) {
      const byId = (exercises || []).find((e) => e.exId === match.id);
      if (byId) return byId;
    }
    const q = normTokens(query).join(' ');
    if (!q) return null;
    return (exercises || []).find((e) => normTokens(e.name).join(' ') === q) || null;
  }

  async function applyRemoveExercise(op) {
    const catalog = await loadCatalog();
    const match = catalog.length ? matchExercise(op.exerciseQuery, catalog) : null;
    const routines = getRoutines();
    // SHENLONG P10c (2026-09-15, live-verified): an explicit op.day used to
    // resolve via resolveTargetRoutine() → findRoutineByDay() — the same
    // bare first-match Array.find() P10b fixed for applyAddExercise — but
    // this caller compounded it with its OWN extra fallback
    // (`targets = r ? [r] : routines`): when the day match failed
    // (0 candidates), `r` was null and `targets` silently widened to EVERY
    // routine in the app, on every day, not just the ones sharing the
    // named day. Proven live: "Remove bench press from friday" with no
    // Friday routine at all silently removed Bench Press from an unrelated
    // Monday routine, reporting full "✓ Removed" success — the explicit
    // day was dropped with no signal at all. Also proven: 2+ same-day
    // routines picked the array-first one regardless of whether it even
    // had the exercise (a false "not found" was possible when it didn't,
    // and a wrong-routine removal when it did). Deliberately local to
    // applyRemoveExercise, mirroring P10b's applyAddExercise fix exactly —
    // resolveTargetRoutine() (shared with applyAddExercise, already fixed
    // there) was untouched by P10c; its own no-day fallback's separate
    // ambiguity defect was tracked as a follow-up and is fixed by P10d
    // below. Day candidates are computed from trainingDays membership only,
    // BEFORE any exercise lookup — unlike P10a's set_sets fix, this must establish day
    // uniqueness first, or an exercise present in only one of several
    // same-day routines would become an accidental implicit disambiguator
    // (the exact false-"not found"/wrong-routine failure mode above).
    // Exactly one day-matching routine is searched for the exercise
    // (existing exercise_not_found behavior preserved if it's not there);
    // zero day-matching routines fails immediately with the same
    // exercise_not_found reason this function already used for total
    // failure — no widening to all routines, no lastRoutineRef fallback;
    // two or more day-matching routines fails immediately with
    // 'ambiguous_day' (the same reason applyDeleteRoutine and
    // applyAddExercise already use for this identical shape), before any
    // exercise lookup or mutation. js/index.js's remove_exercise handler
    // renders any `!result.ok` with one existing, reason-agnostic honest
    // message — no js/index.js change needed for either new outcome.
    let targets;
    if (op.day) {
      const dayCandidates = routines.filter((x) => Array.isArray(x.trainingDays) && x.trainingDays.includes(op.day));
      if (dayCandidates.length > 1) return { ok: false, reason: 'ambiguous_day', candidates: dayCandidates.map((x) => x.name) };
      targets = dayCandidates.length ? [dayCandidates[0]] : [];
    } else {
      // SHENLONG P10d (2026-09-16, investigated then fixed): the no-day
      // branch used to fall back to `r ? [r] : routines` — a stale or
      // absent lastRoutineRef silently widened `targets` to EVERY routine
      // in the app, and the caller's own for-loop below took whichever one
      // happened to be first in array order and actually contained the
      // exercise, with no ambiguity check at all (unlike applySetSets's
      // equivalent no-day branch, which already collects every hit and
      // requires exactly one before mutating). Proven order-dependent live:
      // reversing two routines' array order flipped which one lost the
      // exercise for the identical command. lastRoutineRef is checked for
      // existence in the CURRENT routine list first — a stale reference
      // (pointing at an id no longer present) is treated as absent rather
      // than silently falling through to the old global-first-match scan.
      // Every routine containing the exercise is collected up front,
      // mirroring applySetSets's `hits` pattern exactly: zero hits preserves
      // the existing exercise_not_found failure below unchanged; exactly
      // one hit targets that routine (existing success behavior,
      // unaffected); two or more hits fails immediately, non-mutating,
      // reusing 'ambiguous_routine' — the same reason applySetSets already
      // uses for this identical shape.
      //
      // SHENLONG P11a (2026-09-18, investigated then fixed): P10d's first
      // version validated lastRoutineRef by routine EXISTENCE only
      // (`routines.find(r => r.id === lastRoutineRef.id)`) — weaker than
      // applySetSets's own reference check, which requires the referenced
      // routine to actually be IN `hits`. Proven live: a lastRoutineRef
      // left over from an unrelated earlier action (pointing at a routine
      // that still exists but does not contain the requested exercise)
      // caused a false exercise_not_found even when exactly one OTHER
      // routine unambiguously had the exercise — applySetSets, given the
      // identical shape, correctly ignored the irrelevant reference and
      // resolved the unique candidate. A reference is now only trusted when
      // it resolves to a routine that is itself one of the hits — an
      // existing-but-irrelevant reference is treated the same as an absent
      // one and falls through to the hits-based resolution below, exactly
      // like a stale (nonexistent-id) reference already did.
      const hits = [];
      routines.forEach((r) => {
        const e = findExerciseByQuery(r.exercises, op.exerciseQuery, match);
        if (e) hits.push({ r, e });
      });
      const refHit = lastRoutineRef ? hits.find((h) => h.r.id === lastRoutineRef.id) : null;
      if (refHit) {
        targets = [refHit.r];
      } else {
        if (hits.length > 1) return { ok: false, reason: 'ambiguous_routine', exerciseName: hits[0].e.name, candidates: hits.map((h) => h.r.name) };
        targets = hits.length ? [hits[0].r] : [];
      }
    }
    let hitRoutine = null, hitExercise = null;
    for (const cand of targets) {
      const found = findExerciseByQuery(cand.exercises, op.exerciseQuery, match);
      if (found) { hitRoutine = cand; hitExercise = found; break; }
    }
    if (!hitRoutine) return { ok: false, reason: 'exercise_not_found', query: op.exerciseQuery };
    hitRoutine.exercises = hitRoutine.exercises.filter((e) => e !== hitExercise);
    hitRoutine.updated_at = new Date().toISOString();
    saveRoutines(routines);
    const synced = await pushRoutineNow(hitRoutine);
    remember(hitRoutine);
    return { ok: true, routine: hitRoutine, exerciseName: hitExercise.name, cloudSynced: synced };
  }

  async function applySetSets(op) {
    const catalog = await loadCatalog();
    const match = catalog.length ? matchExercise(op.exerciseQuery, catalog) : null;
    const routines = getRoutines();
    const hits = [];
    routines.forEach((r) => {
      const e = findExerciseByQuery(r.exercises, op.exerciseQuery, match);
      if (e) hits.push({ r, e });
    });
    if (!hits.length) return { ok: false, reason: 'exercise_not_found', query: op.exerciseQuery };
    // Scope to exactly ONE routine — never mutate every routine that happens
    // to contain this exercise (an earlier version of this function did
    // exactly that; a live adversarial pass caught it silently rewriting two
    // real, unrelated routines from one "change bench press to 4 sets"
    // command — a genuine "acted broadly instead of asking" defect, not a
    // safe default). Prefers the day this command named, then the routine
    // last touched by a gym command in this session, then the ONLY routine
    // that has it; if the exercise is genuinely split across several
    // unrelated routines with no other signal, asks instead of guessing.
    let targetRoutine = null;
    // SHENLONG P10a (2026-09-15, live-verified): an explicit op.day used to
    // resolve via findRoutineByDay(routines, op.day) — the FULL routine
    // list, independent of `hits` (the routines that actually contain the
    // requested exercise). Three proven defects: (1) a day match outside
    // `hits` made `hits.find(h => h.r === targetRoutine)` below return
    // undefined, and the next line's `hit.e.sets` access threw a TypeError;
    // (2) a day matching zero routines left targetRoutine null and fell
    // through to the lastRoutineRef/uniqueRoutines fallbacks below, silently
    // mutating a routine on a DIFFERENT day than the one the user named;
    // (3) a day matching 2+ hit-routines picked the first by array order,
    // bypassing the ambiguity check entirely — the same silent,
    // order-dependent selection P9 already fixed for deletion. An explicit
    // day is now its OWN fully-scoped resolution, built exclusively from
    // `hits` (never the full routine list): any outcome other than "exactly
    // one day-scoped hit routine" returns immediately, non-mutating — this
    // can never fall through to lastRoutineRef or the unscoped
    // uniqueRoutines check below, mirroring applyDeleteRoutine's P9 day
    // handling. No new failure reason is introduced — 'exercise_not_found'
    // and 'ambiguous_routine' already cover these outcomes, and js/index.js
    // (out of this fix's authorized scope) already renders both correctly,
    // 'ambiguous_routine' with its candidate list intact.
    if (op.day) {
      const dayHits = hits.filter((h) => Array.isArray(h.r.trainingDays) && h.r.trainingDays.includes(op.day));
      const dayRoutines = Array.from(new Set(dayHits.map((h) => h.r)));
      if (dayRoutines.length === 1) targetRoutine = dayRoutines[0];
      else if (dayRoutines.length > 1) {
        return { ok: false, reason: 'ambiguous_routine', exerciseName: hits[0].e.name, candidates: dayRoutines.map((r) => r.name) };
      } else {
        return { ok: false, reason: 'exercise_not_found', query: op.exerciseQuery };
      }
    } else {
      if (lastRoutineRef) targetRoutine = hits.find((h) => h.r.id === lastRoutineRef.id) ? routines.find((r) => r.id === lastRoutineRef.id) : null;
      const uniqueRoutines = Array.from(new Set(hits.map((h) => h.r)));
      if (!targetRoutine && uniqueRoutines.length === 1) targetRoutine = uniqueRoutines[0];
      if (!targetRoutine) {
        return { ok: false, reason: 'ambiguous_routine', exerciseName: hits[0].e.name, candidates: uniqueRoutines.map((r) => r.name) };
      }
    }
    const hit = hits.find((h) => h.r === targetRoutine);
    const cur = hit.e.sets && hit.e.sets.length ? hit.e.sets[0] : { weight: 0, reps: DEFAULT_REPS };
    hit.e.sets = Array.from({ length: op.count }, () => ({ weight: cur.weight || 0, reps: cur.reps || DEFAULT_REPS }));
    targetRoutine.updated_at = new Date().toISOString();
    saveRoutines(routines);
    const synced = await pushRoutineNow(targetRoutine);
    remember(targetRoutine);
    return { ok: true, exerciseName: hit.e.name, count: op.count, routine: targetRoutine, cloudSynced: synced };
  }

  async function applyDeleteRoutine(op) {
    const routines = getRoutines();
    let target = null;
    // SHENLONG P9 (2026-09-14, live-verified, revised): an explicit day is
    // its OWN fully-scoped resolution — it never silently degrades into an
    // unscoped name search, and never leaves ambiguity for a later branch
    // to guess at. A meaningful explicit name is now checked EVEN WHEN THE
    // DAY ALONE IS ALREADY UNIQUE — the first version of this fix still let
    // day-uniqueness override a contradictory name ("Delete my Friday Legs
    // routine" against only "Upper Body" on Friday, with the real "Legs"
    // actually on Monday, still deleted "Upper Body"). Narrowing by name
    // (when one is present) always happens WITHIN the day candidate set —
    // never the whole routine list — so a same-named routine on a
    // DIFFERENT day can never satisfy a day+name request either way. Any
    // outcome other than "exactly one candidate survives" returns
    // immediately, non-mutating — this can never fall through to the
    // name-only branch, day dropped, or lastRoutineRef below.
    if (op.day) {
      const dayMatches = findRoutinesByDay(routines, op.day);
      if (dayMatches.length) {
        const candidates = op.namePhrase ? findRoutineByName(dayMatches, op.namePhrase) : dayMatches;
        if (candidates.length === 1) target = candidates[0];
        else return { ok: false, reason: 'ambiguous_day', candidates: dayMatches.map((r) => r.name) };
      }
      // dayMatches.length === 0: target stays null, falls to the ordinary
      // not_found return below — an explicit day that matches nothing must
      // not be quietly dropped in favor of an unscoped name/lastRoutineRef
      // guess.
    } else if (op.namePhrase) {
      const nameMatches = findRoutineByName(routines, op.namePhrase);
      // SHENLONG P8: 2+ exact matches is genuine ambiguity, not a "pick
      // one" situation — return immediately so this can never fall through
      // to lastRoutineRef/day/any other resolver below. Deletion stops here;
      // 0 matches still reaches the ordinary not_found outcome just below.
      if (nameMatches.length > 1) return { ok: false, reason: 'ambiguous_name', candidates: nameMatches.map((r) => r.name) };
      target = nameMatches[0] || null;
    }
    if (!target && !op.day && !op.namePhrase && lastRoutineRef) target = routines.find((r) => r.id === lastRoutineRef.id) || null;
    if (!target) return { ok: false, reason: 'not_found' };
    const remaining = routines.filter((r) => r.id !== target.id);
    saveRoutines(remaining);
    const synced = await deleteRoutineNow(target.id);
    if (lastRoutineRef && lastRoutineRef.id === target.id) lastRoutineRef = null;
    return { ok: true, name: target.name, cloudSynced: synced };
  }

  function applyReadWeek() {
    const routines = getRoutines();
    const scheduled = WEEKDAY_CODES.map((code, i) => ({ code, label: WEEKDAY_NAMES[i], routine: findRoutineByDay(routines, code) }))
      .filter((d) => d.routine);
    return { ok: true, scheduled, totalRoutines: routines.length };
  }

  async function apply(intent) {
    const op = intent.op;
    switch (op.kind) {
      case 'create_multi': return applyCreateMulti(op);
      case 'assign_day': return applyAssignDay(op);
      case 'add_exercise': return applyAddExercise(op);
      case 'remove_exercise': return applyRemoveExercise(op);
      case 'set_sets': return applySetSets(op);
      case 'delete_routine': return applyDeleteRoutine(op);
      default: return { ok: false, reason: 'unknown_op' };
    }
  }

  window.Shelron = window.Shelron || {};
  window.Shelron.Routines = {
    parseIntent, apply, readWeek: applyReadWeek, looksLikeGymRequest,
    matchExercise, loadCatalog, getRoutines, dayLabel, weekdayCodeIn,
    forgetLastRoutine: () => { lastRoutineRef = null; }, // test hook
  };
})();
