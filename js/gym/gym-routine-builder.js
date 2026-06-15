/* ============================================================
   gym-routine-builder.js — Routine Builder module.
   Self-contained IIFE (own closure). Talks to the Coach + Cloud
   only via window bridges (rb:routines-changed event,
   window.GymCloud, window.__gymRBMergeRoutines) and localStorage.
   Reads the exercise catalog from js/exercises-data.json.
   Split verbatim out of the former monolithic js/gym.js.
   ============================================================ */
(function () {
  const $ = id => document.getElementById(id);
  const RB_KEY = 'rb_routines_v1';
  const PAGE   = 24;                 // exercises rendered per "page"
  const DEFAULTS = { sets: 3, reps: 10, rest: 90 };

  let catalog      = [];             // full library from JSON
  let filtered     = [];             // after muscle + search filter
  let visible      = PAGE;
  let activeMuscle = 'All';          // coarse pill filter ('All' or a muscleGroup)
  let activeSub    = null;           // precise sub-muscle from the body map (e.g. 'Calves')
  let search       = '';
  let current      = { id: null, name: '', exercises: [] }; // routine being built

  // ── Persistence ───────────────────────────────────────────────
  function loadRoutines() {
    try { return JSON.parse(localStorage.getItem(RB_KEY)) || []; } catch { return []; }
  }
  function saveRoutines(arr) {
    try { localStorage.setItem(RB_KEY, JSON.stringify(arr)); } catch (e) {}
    // Let the coach (separate script) refresh its routine selector live.
    try { window.dispatchEvent(new CustomEvent('rb:routines-changed')); } catch (e) {}
    // Write-through to the cloud routines table (async; queues if offline).
    try { window.GymCloud && window.GymCloud.pushRoutines(arr); } catch (e) {}
  }
  const clone = obj => JSON.parse(JSON.stringify(obj));

  // ── Library filtering ─────────────────────────────────────────
  // Multi-level pill bar. At the root it shows the coarse groups; once an
  // area with sub-muscles is in focus (via a pill OR a body-map click) it
  // drills into that area's sub-categories. Sub pills run the exact same
  // surgical matchesSub() filter as clicking the muscle on the body, and both
  // stay visually in sync through currentArea()/activeSub.
  function chip(label, isActive, onClick, extraClass) {
    const b = document.createElement('button');
    b.className = 'rb-chip' + (isActive ? ' active' : '') + (extraClass ? ' ' + extraClass : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
  function setRoot() { activeMuscle = 'All'; activeSub = null; visible = PAGE; buildFilters(); applyFilter(); }
  function setGroup(g) { activeMuscle = g; activeSub = null; visible = PAGE; buildFilters(); applyFilter(); }

  function buildFilters() {
    const wrap = $('rbFilters');
    wrap.innerHTML = '';
    const area = currentArea();

    if (area && hasSubs(area)) {
      // Drilled-in view: « back, the whole-area "All", then each sub-muscle.
      wrap.appendChild(chip('‹ All', false, setRoot, 'rb-chip-back'));
      wrap.appendChild(chip(area, !activeSub, () => setGroup(area)));
      GROUP_SUBS[area].forEach(sub => {
        wrap.appendChild(chip(sub, activeSub === sub, () => pickMuscle(sub)));
      });
    } else {
      // Root view: All + the coarse groups. Clicking a group with sub-muscles
      // drills in; a flat group (Cardio) just filters.
      wrap.appendChild(chip('All', activeMuscle === 'All' && !activeSub, setRoot));
      rootGroups().forEach(g => {
        wrap.appendChild(chip(g, area === g, () => setGroup(g)));
      });
    }
    syncMuscleMap(); // keep the anatomical map in lockstep with the pills
  }

  // ── Interactive muscle map ────────────────────────────────────
  // Each anatomical region carries a fine-grained data-muscle (e.g. "Biceps").
  // MUSCLE_MAP gives the coarse catalog muscleGroup it lives in (used to bound
  // the search and to light up the matching pill for context). SUB_KEYWORDS
  // gives the specific terms we match against an exercise's name + gifUrl so a
  // click filters surgically down to that one muscle, not the whole group.
  const MUSCLE_MAP = {
    'Chest': 'Chest',
    'Traps': 'Back', 'Traps Middle': 'Back', 'Lats': 'Back', 'Lower Back': 'Back',
    'Front Shoulders': 'Shoulders', 'Rear Shoulders': 'Shoulders',
    'Biceps': 'Arms', 'Triceps': 'Arms', 'Forearms': 'Arms',
    'Abdominals': 'Core/Abs', 'Obliques': 'Core/Abs',
    'Quads': 'Legs', 'Hamstrings': 'Legs', 'Glutes': 'Legs', 'Calves': 'Legs'
  };
  // Reverse index: catalog group → its sub-muscles (drives the drill-down pills).
  // Insertion order of MUSCLE_MAP defines the pill order within each group.
  const GROUP_SUBS = {};
  Object.keys(MUSCLE_MAP).forEach(sub => {
    const g = MUSCLE_MAP[sub];
    (GROUP_SUBS[g] = GROUP_SUBS[g] || []).push(sub);
  });
  // A group "drills" into sub-pills only when it has 2+ meaningful sub-muscles.
  const hasSubs = g => (GROUP_SUBS[g] || []).length >= 2;
  // The area currently in focus: from a precise pick, else the active group pill.
  function currentArea() {
    if (activeSub) return MUSCLE_MAP[activeSub];
    if (activeMuscle !== 'All') return activeMuscle;
    return null;
  }
  // Root groups for the top-level pills (Neck is intentionally excluded — no
  // neck training in this app). 'Other' stays out too; it isn't a real target.
  function rootGroups() {
    return Array.from(new Set(catalog.map(e => e.muscleGroup)))
      .filter(g => g !== 'Neck' && g !== 'Other')
      .sort();
  }
  const SUB_KEYWORDS = {
    'Chest': ['chest', 'pec', 'bench press', 'fly', 'push-up', 'push up', 'dip'],
    'Traps': ['trap', 'shrug'],
    'Traps Middle': ['rhomboid', 'row', 'mid back', 'middle back'],
    'Lats': ['lat', 'pulldown', 'pull-up', 'pull up', 'pullup', 'chin'],
    'Lower Back': ['lower back', 'back extension', 'hyperextension', 'good morning', 'deadlift'],
    'Front Shoulders': ['shoulder', 'deltoid', 'delt', 'overhead press', 'military'],
    'Rear Shoulders': ['rear delt', 'reverse fly', 'rear-delt', 'face pull', 'reverse pec'],
    'Biceps': ['bicep'],
    'Triceps': ['tricep'],
    'Forearms': ['forearm', 'wrist'],
    'Abdominals': ['abdominal', 'crunch', 'sit-up', 'sit up', 'plank', 'leg raise'],
    'Obliques': ['oblique', 'twist', 'side bend', 'woodchop'],
    'Quads': ['quad', 'squat', 'leg press', 'lunge', 'leg extension'],
    'Hamstrings': ['hamstring', 'leg curl', 'romanian', 'stiff-leg', 'stiff leg'],
    'Glutes': ['glute', 'hip thrust', 'kickback', 'bridge'],
    'Calves': ['calf', 'calves']
  };
  // Does an exercise belong to a precise sub-muscle? Stay inside the mapped
  // group (disambiguates shared movement words like "kickback") AND require a
  // sub-muscle keyword in the name/gifUrl.
  function matchesSub(e, sub) {
    const group = MUSCLE_MAP[sub];
    if (group && e.muscleGroup !== group) return false;
    const kws = SUB_KEYWORDS[sub] || [sub.toLowerCase()];
    const hay = ((e.name || '') + ' ' + (e.gifUrl || '')).toLowerCase();
    return kws.some(t => hay.includes(t));
  }
  // Isolate the glow: a precise pick lights ONLY that region; a broad pill
  // lights every region in that group; "All" lights nothing.
  function syncMuscleMap() {
    document.querySelectorAll('#rbMuscleMap [data-muscle]').forEach(p => {
      const dm = p.getAttribute('data-muscle');
      let on;
      if (activeSub) on = (dm === activeSub);
      else if (activeMuscle === 'All') on = false;
      else on = (MUSCLE_MAP[dm] === activeMuscle);
      p.classList.toggle('active', on);
    });
  }
  // Click a body region (or a sub pill) → surgical sub-muscle filter. The
  // exercise stays "in" its area so the drill-down pills remain visible;
  // re-clicking the same muscle steps back out to the whole area.
  function pickMuscle(sub) {
    if (!sub) return;
    const group = MUSCLE_MAP[sub] || 'All';
    activeMuscle = group;
    activeSub = (activeSub === sub) ? null : sub;
    visible = PAGE;
    buildFilters(); applyFilter(); // buildFilters() re-runs syncMuscleMap()
  }
  function initMuscleMap() {
    document.querySelectorAll('#rbMuscleMap [data-muscle]').forEach(p => {
      p.addEventListener('click', () => pickMuscle(p.getAttribute('data-muscle')));
    });
    const toggle = $('mmToggle');
    if (toggle) {
      toggle.addEventListener('click', e => {
        const btn = e.target.closest('.mm-toggle-btn');
        if (!btn) return;
        const view = btn.dataset.view;
        toggle.querySelectorAll('.mm-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('#rbMuscleMap .mm-view').forEach(v => { v.hidden = (v.dataset.view !== view); });
      });
    }
  }

  function applyFilter() {
    const q = search.trim().toLowerCase();
    filtered = catalog.filter(e => {
      if (q && !e.name.toLowerCase().includes(q)) return false;
      // Precise body-map pick: surgical sub-muscle match (name/gifUrl substring).
      if (activeSub) return matchesSub(e, activeSub);
      // Otherwise the coarse pill filter.
      return activeMuscle === 'All' || e.muscleGroup === activeMuscle;
    });
    renderGrid();
  }

  function renderGrid() {
    const grid = $('rbGrid');
    grid.innerHTML = '';
    const inRoutine = new Set(current.exercises.map(x => x.exId));
    filtered.slice(0, visible).forEach(e => grid.appendChild(exCard(e, inRoutine.has(e.id))));

    const empty = $('rbLibEmpty');
    if (!catalog.length) {
      empty.style.display = 'block';
      empty.textContent = 'Exercise catalog not found. Run scripts/generate-exercises.js and commit js/exercises-data.json, then refresh.';
    } else if (!filtered.length) {
      empty.style.display = 'block';
      empty.textContent = 'No exercises match your search.';
    } else {
      empty.style.display = 'none';
    }

    const more = $('rbMore');
    if (filtered.length > visible) {
      more.style.display = 'block';
      more.textContent = 'Show more (' + (filtered.length - visible) + ')';
    } else {
      more.style.display = 'none';
    }
  }

  function exCard(e, added) {
    const card = document.createElement('div'); card.className = 'rb-ex-card';

    const tw = document.createElement('div'); tw.className = 'rb-ex-thumb-wrap';
    const img = document.createElement('img');
    img.className = 'rb-ex-thumb'; img.loading = 'lazy'; img.src = e.gifUrl;
    img.alt = e.name; img.title = 'Preview';
    img.addEventListener('click', () => openGif(e));
    const tag = document.createElement('span'); tag.className = 'rb-ex-muscle-tag'; tag.textContent = e.muscleGroup;
    tw.append(img, tag);

    const body = document.createElement('div'); body.className = 'rb-ex-body';
    const nm = document.createElement('div'); nm.className = 'rb-ex-name'; nm.textContent = e.name;
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'rb-ex-add' + (added ? ' added' : '');
    add.textContent = added ? '✓ Added' : '+ Add';
    add.addEventListener('click', () => addToRoutine(e));
    body.append(nm, add);

    card.append(tw, body);
    return card;
  }

  // ── Current routine ───────────────────────────────────────────
  function addToRoutine(e) {
    const exId = e.exId || e.id;
    if (current.exercises.some(x => x.exId === exId)) return; // no duplicates
    if (dupGuard('addex_' + exId)) return;                    // swallow double-tap
    current.exercises.push({
      exId, name: e.name, muscleGroup: e.muscleGroup, gifUrl: e.gifUrl,
      // Rest between sets (seconds) — surfaced as the live countdown after each
      // logged set. 0 = no timer. Per-routine: the same movement can rest
      // differently in a strength routine vs. a hypertrophy one.
      rest: DEFAULTS.rest,
      // Set-by-set log: seed with a few blank sets the user can fill in.
      sets: Array.from({ length: DEFAULTS.sets }, () => blankSet()),
    });
    renderRoutine();
    renderGrid();
  }

  // A fresh set row. New sets copy the previous set's weight/reps (the Hevy/
  // Strong convention) so the user only tweaks what changed; the very first
  // set falls back to the default rep target.
  function blankSet(prev) {
    return prev
      ? { weight: prev.weight, reps: prev.reps }
      : { weight: 0, reps: DEFAULTS.reps };
  }

  function renderRoutine() {
    const list = $('rbRoutineList');
    list.innerHTML = '';
    $('rbRoutineEmpty').style.display = current.exercises.length ? 'none' : 'block';
    current.exercises.forEach((it, idx) => list.appendChild(routineRow(it, idx)));
    if ($('rbRoutineName').value !== current.name) $('rbRoutineName').value = current.name;
  }

  function mini(label, fn, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rb-mini' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  // Debounce guard against double-fires inserting the same item twice — covers
  // rapid double-taps and any synthesized touch+click pair on mobile. Keyed per
  // action so unrelated taps are never blocked. Returns true → ignore this call.
  const _dupTimes = {};
  function dupGuard(key, ms) {
    const now = Date.now();
    if (now - (_dupTimes[key] || 0) < (ms || 350)) return true;
    _dupTimes[key] = now;
    return false;
  }

  // Rest seconds → compact label: "45s" under a minute, "1:30" / "2 min" above.
  function fmtRest(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    return r ? (m + ':' + String(r).padStart(2, '0')) : (m + ' min');
  }

  // Per-exercise rest stepper (−/+ in 15s steps, 0–600s). Mutates it.rest in
  // place; the value is deep-cloned into the saved routine on Save. Legacy rows
  // saved before this field existed are backfilled to the default on render.
  function restControl(it) {
    if (typeof it.rest !== 'number' || isNaN(it.rest) || it.rest < 0) it.rest = DEFAULTS.rest;
    const wrap = document.createElement('div'); wrap.className = 'rb-rest';
    const lbl = document.createElement('span'); lbl.className = 'rb-rest-label'; lbl.textContent = 'Rest between sets';
    const ctr = document.createElement('div'); ctr.className = 'rb-rest-ctr';
    const val = document.createElement('span'); val.className = 'rb-rest-val';
    const paint = () => { val.textContent = it.rest === 0 ? 'Off' : fmtRest(it.rest); };
    const dec = mini('−', () => { it.rest = Math.max(0,   it.rest - 15); paint(); }, 'rb-rest-btn');
    const inc = mini('+', () => { it.rest = Math.min(600, it.rest + 15); paint(); }, 'rb-rest-btn');
    paint();
    ctr.append(dec, val, inc);
    wrap.append(lbl, ctr);
    return wrap;
  }

  function move(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= current.exercises.length) return;
    const a = current.exercises;
    [a[idx], a[j]] = [a[j], a[idx]];
    renderRoutine();
  }

  // A routine row is now template-only: it identifies the exercise and lets the
  // user reorder or remove it. Per-set weight/reps/bodyweight live in the live
  // logging terminal, not here — the builder just owns the exercise lineup.
  function routineRow(it, idx) {
    const li = document.createElement('li');
    li.className = 'rb-row';

    // ── Header: thumbnail, name/muscle, reorder controls ──
    const head = document.createElement('div'); head.className = 'rb-row-head';

    const thumb = document.createElement('img');
    thumb.className = 'rb-row-thumb'; thumb.loading = 'lazy'; thumb.src = it.gifUrl;
    thumb.alt = it.name; thumb.title = 'Preview';
    thumb.addEventListener('click', () => openGif(it));

    const main = document.createElement('div'); main.className = 'rb-row-main';
    const nm = document.createElement('div'); nm.className = 'rb-row-name'; nm.textContent = it.name;
    const mus = document.createElement('div'); mus.className = 'rb-row-muscle'; mus.textContent = it.muscleGroup;
    main.append(nm, mus);

    const ctr = document.createElement('div'); ctr.className = 'rb-row-controls';
    const up   = mini('↑', () => move(idx, -1));
    const down = mini('↓', () => move(idx,  1));
    up.disabled   = idx === 0;
    down.disabled = idx === current.exercises.length - 1;
    ctr.append(up, down);

    head.append(thumb, main, ctr);

    // ── Manage: remove the whole exercise from the template ──
    const actions = document.createElement('div'); actions.className = 'rb-ex-actions';
    const removeEx = document.createElement('button');
    removeEx.type = 'button'; removeEx.className = 'rb-remove-ex'; removeEx.textContent = 'Remove Exercise';
    removeEx.addEventListener('click', () => {
      current.exercises.splice(idx, 1);
      renderRoutine(); renderGrid();
    });
    actions.append(removeEx);

    li.append(head, restControl(it), actions);
    return li;
  }

  // ── Saved routines ────────────────────────────────────────────
  function renderSaved() {
    const routines = loadRoutines();
    const list = $('rbSavedList');
    list.innerHTML = '';
    $('rbSavedEmpty').style.display = routines.length ? 'none' : 'block';

    routines.forEach(r => {
      const li = document.createElement('li'); li.className = 'rb-saved-row';

      const info = document.createElement('div'); info.className = 'rb-saved-info';
      const nm = document.createElement('div'); nm.className = 'rb-saved-name'; nm.textContent = r.name;
      const meta = document.createElement('div'); meta.className = 'rb-saved-meta';
      const totalSets = r.exercises.reduce((s, e) => s + (Array.isArray(e.sets) ? e.sets.length : (Number(e.sets) || 0)), 0);
      meta.textContent = r.exercises.length + ' exercise' + (r.exercises.length !== 1 ? 's' : '') + ' · ' + totalSets + ' sets';
      info.append(nm, meta);

      const editBtn = document.createElement('button');
      editBtn.type = 'button'; editBtn.className = 'po-btn-secondary rb-saved-edit'; editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        current = clone(r);
        renderRoutine(); renderGrid();
        $('rbCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      const delBtn = mini('×', () => {
        if (!confirm('¿Estás seguro de que quieres eliminar esta rutina? Se borrará de todos tus dispositivos.')) return;
        // Immediate local update — drop it from rb_routines_v1. saveRoutines()
        // also fires the 'rb:routines-changed' event so the coach refreshes.
        saveRoutines(loadRoutines().filter(x => x.id !== r.id));
        if (current.id === r.id) { current = { id: null, name: '', exercises: [] }; renderRoutine(); renderGrid(); }
        renderSaved();
        // Background cloud delete — removes the routine from every other device.
        try { window.GymCloud && window.GymCloud.deleteRoutine(r.id); } catch (e) {}
      }, 'rb-del');

      li.append(info, editBtn, delBtn);
      list.appendChild(li);
    });
  }

  // ── Coach history bridge ──────────────────────────────────────
  // The coach engine (separate IIFE) saves every logged set to
  // localStorage under 'po_coach_v1'. Logs are keyed by 'rt_' + exId so
  // a movement shares one history across every routine it appears in.
  // We read it here (read-only) to surface the PR and recent sets.
  const COACH_KEY = 'po_coach_v1';
  function coachState() {
    try { return JSON.parse(localStorage.getItem(COACH_KEY)) || {}; }
    catch { return {}; }
  }
  function exerciseLogs(exId) {
    const s = coachState();
    const logs = (s.logs && s.logs['rt_' + exId]) || [];
    return Array.isArray(logs) ? logs : [];
  }
  function coachUnit() {
    const u = coachState().units;
    return (u === 'kg' || u === 'lb') ? u : 'kg';
  }

  // PR / Personal Record badge — highest weight ever logged.
  function renderPr(exId, unit) {
    const el = $('rbGifPr');
    const weights = exerciseLogs(exId)
      .map(l => Number(l.weight))
      .filter(w => Number.isFinite(w) && w > 0);
    if (!weights.length) {
      el.classList.add('empty');
      el.innerHTML = '--<span class="rb-pr-unit">' + unit + '</span>';
      return;
    }
    const pr = Math.max.apply(null, weights);
    el.classList.remove('empty');
    el.innerHTML = pr + '<span class="rb-pr-unit">' + unit + '</span>';
  }

  // Recent history — last 5 logged sets, newest first.
  function renderHist(exId, unit) {
    const list = $('rbGifHist');
    list.innerHTML = '';
    const logs = exerciseLogs(exId);
    if (!logs.length) {
      const li = document.createElement('li');
      li.className = 'rb-hist-empty';
      li.textContent = 'No sets logged yet — log this exercise from the Coach tab.';
      list.appendChild(li);
      return;
    }
    const best = Math.max.apply(null, logs.map(l => Number(l.weight) || 0));
    const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    logs.slice(-5).reverse().forEach(l => {
      const li = document.createElement('li'); li.className = 'rb-hist-row';

      const date = document.createElement('span'); date.className = 'rb-hist-date';
      const d = new Date(l.date);
      date.textContent = isNaN(d) ? '' : (mons[d.getMonth()] + ' ' + d.getDate());

      const tag = document.createElement('span'); tag.className = 'rb-hist-best';
      const w = Number(l.weight) || 0;
      tag.textContent = (w > 0 && w === best) ? '★ PR' : '';

      const set = document.createElement('span'); set.className = 'rb-hist-set';
      set.textContent = (w > 0) ? (w + unit + ' × ' + l.reps) : (l.reps + ' reps');

      li.append(date, tag, set);
      list.appendChild(li);
    });
  }

  // ── GIF preview modal ─────────────────────────────────────────
  function openGif(e) {
    const exId = e.exId || e.id;
    $('rbGifTitle').textContent = e.name;
    $('rbGifMuscle').textContent = e.muscleGroup;
    const img = $('rbGifImg'); img.src = e.gifUrl; img.alt = e.name;
    const u = coachUnit();
    renderPr(exId, u);
    renderHist(exId, u);
    const addBtn = $('rbGifAdd');
    const inRoutine = current.exercises.some(x => x.exId === exId);
    addBtn.textContent = inRoutine ? '✓ In routine' : 'Add to routine';
    addBtn.disabled = inRoutine;
    addBtn.onclick = () => {
      addToRoutine({ id: exId, name: e.name, muscleGroup: e.muscleGroup, gifUrl: e.gifUrl });
      $('rbGifModalBg').classList.remove('show');
    };
    $('rbGifModalBg').classList.add('show');
  }

  // ── Wire up controls ──────────────────────────────────────────
  $('rbSearch').addEventListener('input', () => { search = $('rbSearch').value; visible = PAGE; applyFilter(); });
  $('rbMore').addEventListener('click', () => { visible += PAGE; renderGrid(); });
  $('rbRoutineName').addEventListener('input', () => { current.name = $('rbRoutineName').value; });

  $('rbClearBtn').addEventListener('click', () => {
    if (current.exercises.length && !confirm('Clear the current routine?')) return;
    current = { id: null, name: '', exercises: [] };
    renderRoutine(); renderGrid();
  });

  $('rbSaveBtn').addEventListener('click', () => {
    if (!current.exercises.length) { alert('Add at least one exercise before saving.'); return; }
    current.name = ($('rbRoutineName').value || '').trim() || 'Routine ' + new Date().toLocaleDateString();
    current.updated_at = new Date().toISOString(); // stamp for cross-device last-write-wins
    const routines = loadRoutines();
    if (current.id) {
      const i = routines.findIndex(r => r.id === current.id);
      if (i >= 0) routines[i] = clone(current); else routines.push(clone(current));
    } else {
      current.id = 'r_' + Date.now();
      routines.push(clone(current));
    }
    saveRoutines(routines);
    // clone() above deep-copies each exercise's `sets` array (weight + reps
    // per set) into the saved routine. Now wipe the workspace to free it up.
    current = { id: null, name: '', exercises: [] };
    renderRoutine(); renderGrid(); renderSaved();
  });

  $('rbGifClose').addEventListener('click', () => $('rbGifModalBg').classList.remove('show'));
  $('rbGifModalBg').addEventListener('click', e => { if (e.target === $('rbGifModalBg')) $('rbGifModalBg').classList.remove('show'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('rbGifModalBg').classList.remove('show'); });

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    try {
      const res = await fetch('js/exercises-data.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      catalog = await res.json();
    } catch {
      catalog = [];
    }
    initMuscleMap();
    buildFilters();
    applyFilter();
    renderRoutine();
    renderSaved();
  }
  init();

  // ── Bridge for the normalized cloud layer (GymCloud) ──────────
  // Merges routines pulled from the cloud into local storage. Union by id,
  // last-write-wins by updated_at, and never clobbers a newer local edit.
  window.__gymRBMergeRoutines = function (cloudArr) {
    if (!Array.isArray(cloudArr) || !cloudArr.length) return false;
    const byId = {};
    loadRoutines().forEach(r => { if (r && r.id) byId[r.id] = r; });
    let changed = false;
    cloudArr.forEach(r => {
      if (!r || !r.id) return;
      const local = byId[r.id];
      if (!local) { byId[r.id] = r; changed = true; return; }
      const lt = Date.parse(local.updated_at || local.created_at || '') || 0;
      const rt = Date.parse(r.updated_at || r.created_at || '') || 0;
      if (rt > lt) { byId[r.id] = r; changed = true; }
    });
    if (changed) {
      const merged = Object.keys(byId).map(k => byId[k]);
      // Write directly (not via saveRoutines) so we don't echo a push back up.
      try { localStorage.setItem(RB_KEY, JSON.stringify(merged)); } catch (e) {}
      try { window.dispatchEvent(new CustomEvent('rb:routines-changed')); } catch (e) {}
      try { renderSaved(); } catch (e) {}
    }
    return changed;
  };
})();
