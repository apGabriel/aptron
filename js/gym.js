/* ============================================================
   gym.js — logic extracted from gym.html
   Three self-contained IIFEs:
     (1) Progressive Overload Coach  (2) Routine Builder
     (3) Normalized cloud data layer
   Depends on the inline CONFIG object defined in gym.html,
   and on the Supabase UMD bundle loaded in the page head.
   ============================================================ */

/* ===== Progressive Overload Coach ===== */
(function() {
  // ============================================================
  // STATE — all logs + edits live in browser localStorage. Each
  // device has its own copy. Export JSON from settings if you
  // want to back up or move to another device.
  // ============================================================
  const LS_KEY = 'po_coach_v1';

  function buildDefaultExercises() {
    return CONFIG.defaultExercises.map((e, i) => Object.assign({
      id: 'seed_' + i + '_' + Date.now()
    }, e));
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) {}
    return normalize({});
  }
  function normalize(s) {
    s = s || {};
    s.units = s.units || CONFIG.units || 'kg';
    s.gyms  = (Array.isArray(s.gyms)  && s.gyms.length)  ? s.gyms  : CONFIG.gyms.slice();
    s.days  = (Array.isArray(s.days)  && s.days.length)  ? s.days  : CONFIG.days.slice();
    s.exercises = Array.isArray(s.exercises) ? s.exercises : buildDefaultExercises();
    s.logs = (s.logs && typeof s.logs === 'object') ? s.logs : {};
    s.filterGym = s.filterGym || s.gyms[0].id;
    s.filterDay = s.filterDay || s.days[0].id;
    // Selected routine (id from the Routine Builder). Validated at render time.
    if (typeof s.filterRoutine === 'undefined') s.filterRoutine = null;
    // Split rotation lives in state so the user can edit it via the pill modal.
    // Stored as a plain array of names (e.g. ["Push", "Pull", "Legs", "Rest"]).
    if (!Array.isArray(s.splitRotation) || !s.splitRotation.length) {
      s.splitRotation = (CONFIG.splitRotation || ['Push', 'Pull', 'Legs', 'Rest']).map(x =>
        // CONFIG used ids — map id → display name where possible
        (CONFIG.days || []).find(d => d.id === x) ? (CONFIG.days.find(d => d.id === x).name) :
        (x === 'rest' ? 'Rest' : x.charAt(0).toUpperCase() + x.slice(1))
      );
    }
    if (!s.splitAnchor || !s.splitAnchor.date || s.splitAnchor.index == null) {
      // Map old anchor-by-id to new anchor-by-index, or default to today=index 0.
      const oldId = (CONFIG.splitAnchor && CONFIG.splitAnchor.splitId) || null;
      let idx = 0;
      if (oldId) {
        const oldName = (CONFIG.days || []).find(d => d.id === oldId);
        const targetName = oldName ? oldName.name : (oldId === 'rest' ? 'Rest' : oldId);
        const found = s.splitRotation.findIndex(n => n.toLowerCase() === targetName.toLowerCase());
        if (found >= 0) idx = found;
      }
      s.splitAnchor = {
        date: (CONFIG.splitAnchor && CONFIG.splitAnchor.date) || new Date().toISOString().slice(0, 10),
        index: idx
      };
    }
    return s;
  }
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }
  let state = loadState();
  document.getElementById('appTitle').textContent = CONFIG.appTitle || 'Progressive Overload Coach';

  // ============================================================
  // HELPERS
  // ============================================================
  const $ = (id) => document.getElementById(id);
  function unit() { return state.units; }
  function uid() { return 'ex_' + Date.now() + '_' + Math.floor(Math.random() * 9999); }
  function gymName(id) { const g = state.gyms.find(x => x.id === id); return g ? g.name : id; }
  function dayName(id) { const d = state.days.find(x => x.id === id); return d ? d.name : id; }
  function estimate1RM(w, r) { if (r < 2) return w; return w * (1 + r / 30); }
  function roundToStep(v, s) { return Math.round(v / s) * s; }
  // ── Routines bridge ──────────────────────────────────────────
  // The exercise list is now driven by the user's saved routines from
  // the Routine Builder (localStorage 'rb_routines_v1'). Each routine
  // exercise is mirrored into state.exercises (id = 'rt_' + exId) so the
  // whole logging / prescription / stats engine keeps working unchanged.
  // Logs key off that stable id, so the same movement shares one history
  // across every routine it appears in.
  const RB_ROUTINES_KEY = 'rb_routines_v1';
  function getRoutines() {
    try { return JSON.parse(localStorage.getItem(RB_ROUTINES_KEY)) || []; }
    catch (e) { return []; }
  }
  function getCurrentRoutine() {
    const rs = getRoutines();
    if (!rs.length) return null;
    let r = rs.find(x => x.id === state.filterRoutine);
    if (!r) { r = rs[0]; state.filterRoutine = r.id; }
    return r;
  }
  // Make sure every exercise referenced by any routine exists as a coach
  // exercise. Created lazily with sensible defaults derived from the
  // routine's target reps; the user can fine-tune (weight / step / bodyweight)
  // via the edit (pencil) button afterwards.
  function ensureRoutineExercises() {
    const rs = getRoutines();
    const byId = {};
    state.exercises.forEach(e => { byId[e.id] = e; });
    let changed = false;
    rs.forEach(r => (r.exercises || []).forEach(it => {
      const id = 'rt_' + it.exId;
      if (!byId[id]) {
        // Target reps for the coach's range = the highest planned set reps
        // (falls back to the legacy scalar `reps`, then 10).
        let reps = 10;
        if (Array.isArray(it.sets) && it.sets.length) {
          reps = Math.max.apply(null, it.sets.map(s => parseInt(s.reps, 10) || 0)) || 10;
        } else if (it.reps != null) {
          reps = parseInt(it.reps, 10) || 10;
        }
        const ex = {
          id, name: it.name, gym: 'both', day: '__routine__',
          bw: false, startWeight: 0,
          repMin: Math.max(1, reps - 2), repMax: Math.max(reps, 1),
          step: 2.5, gifUrl: it.gifUrl, muscleGroup: it.muscleGroup,
          fromRoutine: true
        };
        state.exercises.push(ex);
        byId[id] = ex;
        changed = true;
      } else if (byId[id].name !== it.name) {
        byId[id].name = it.name;        // keep the label in sync with the builder
        changed = true;
      }
    }));
    if (changed) saveState();
  }
  // Exercises of the currently selected routine, in routine order.
  function getFiltered() {
    const r = getCurrentRoutine();
    if (!r) return [];
    const byId = {};
    state.exercises.forEach(e => { byId[e.id] = e; });
    return (r.exercises || [])
      .map(it => byId['rt_' + it.exId])
      .filter(Boolean)
      .filter(e => e.gym === state.filterGym || e.gym === 'both');
  }
  function getCurrentEx() {
    const f = getFiltered();
    if (!f.length) return null;
    let ex = f.find(e => e.id === state.currentEx);
    if (!ex) { ex = f[0]; state.currentEx = ex.id; saveState(); }
    return ex;
  }
  function getLogs() { return (state.logs[state.currentEx] || []).slice(); }

  // Prescription engine — "what should I do next session?"
  // Upgrade trigger: hits CONFIG.upgradeAtReps (default 8) OR the
  // exercise's repMax, whichever fires first. So a 5-8 lifter hits
  // upgrade at 8; a 6-12 lifter ALSO hits it at 8 instead of grinding
  // out 12 reps before adding weight.
  function getRx(ex, logs) {
    if (!logs.length) return null;
    const last = logs[logs.length - 1];
    const { weight, reps } = last;
    const { repMin, repMax, step, bw } = ex;
    const upgradeAt = Math.min(CONFIG.upgradeAtReps || 8, repMax);
    let stuck = 0;
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].weight === weight) stuck++; else break;
    }
    if (bw) {
      if (reps >= upgradeAt) return { type: 'up', weight: 0, reps: reps + 1, tag: 'Push for more', reason: reps + ' reps — strong. Push for ' + (reps + 1) + ' next time.', bw: true };
      if (reps >= repMin) return { type: 'hold', weight: 0, reps: reps + 1, tag: 'Add a rep', reason: reps + ' reps. Push for ' + (reps + 1) + ' next session.', bw: true };
      return { type: 'hold', weight: 0, reps: repMin, tag: 'Repeat', reason: reps + ' reps fell short. Repeat until you hit ' + repMin + '+.', bw: true };
    }
    if (stuck >= 3 && reps < repMin) {
      const dl = roundToStep(weight * 0.9, step);
      return { type: 'down', weight: dl, reps: repMax, tag: 'Deload', reason: 'Stuck at ' + weight + unit() + ' for ' + stuck + ' sessions. Drop 10%, reset, build back cleaner.' };
    }
    if (reps >= upgradeAt) return { type: 'up', weight: weight + step, reps: repMin, tag: 'Add weight', reason: 'You hit ' + reps + ' reps — time to add ' + step + unit() + '. Expect ' + repMin + '-' + (repMin + 1) + ' next session.' };
    if (reps >= repMin && reps < upgradeAt) return { type: 'hold', weight: weight, reps: reps + 1, tag: 'Add a rep', reason: reps + ' reps in target. Stay at ' + weight + unit() + ', push for ' + (reps + 1) + '.' };
    return { type: 'hold', weight: weight, reps: repMin, tag: 'Repeat', reason: reps + ' reps short of ' + repMin + '-' + upgradeAt + '. Repeat ' + weight + unit() + ' until you hit ' + repMin + '+ clean.' };
  }

  // ============================================================
  // RENDER
  // ============================================================
  function renderFilters() {
    $('gymSeg').innerHTML = state.gyms.map(g =>
      '<button class="po-seg-btn ' + (g.id === state.filterGym ? 'active' : '') + '" data-gym="' + g.id + '">' + escape(g.name) + '</button>'
    ).join('');
    // Routine segment — replaces the old Push/Pull/Legs day filter. Lists
    // the user's saved routines; selecting one drives the exercise flow.
    const routines = getRoutines();
    const daySeg = $('daySeg');
    if (!routines.length) {
      daySeg.innerHTML = '<span class="po-seg-empty">No routines yet — build one in the <strong>Routine Builder</strong> below to start logging.</span>';
    } else {
      const cur = getCurrentRoutine();
      daySeg.innerHTML = routines.map(r =>
        '<button class="po-seg-btn ' + (cur && r.id === cur.id ? 'active' : '') + '" data-routine="' + r.id + '">' + escape(r.name) + '</button>'
      ).join('');
      daySeg.querySelectorAll('.po-seg-btn').forEach(b => {
        b.addEventListener('click', () => {
          state.filterRoutine = b.dataset.routine;
          state.currentEx = null;
          // User has now manually picked a routine — stop auto-overriding to today's split.
          state._userPickedDay = true;
          saveState(); renderAll();
        });
      });
    }
    // Adding bespoke exercises now happens in the Routine Builder, so the
    // inline "+" no longer fits the routine-driven model.
    $('addExBtn').style.display = 'none';
    $('gymSeg').querySelectorAll('.po-seg-btn').forEach(b => {
      b.addEventListener('click', () => { state.filterGym = b.dataset.gym; state.currentEx = null; saveState(); renderAll(); });
    });
  }
  function renderSelect() {
    const sel = $('exSelect');
    const f = getFiltered();
    const noMsg = $('noExMsg');
    const editBtn = $('editExBtn');
    const logBtn = $('logBtn');
    if (!f.length) {
      sel.innerHTML = '<option>—</option>';
      sel.disabled = true; editBtn.disabled = true; logBtn.disabled = true;
      noMsg.innerHTML = getRoutines().length
        ? 'This routine has no exercises yet.'
        : 'No routines yet. Create one in the <strong>Routine Builder</strong> below, then pick it above.';
      noMsg.style.display = 'block'; state.currentEx = null;
      return;
    }
    sel.disabled = false; editBtn.disabled = false; logBtn.disabled = false;
    noMsg.style.display = 'none';
    if (!f.find(e => e.id === state.currentEx)) state.currentEx = f[0].id;
    sel.innerHTML = f.map(e => {
      const wLbl = e.bw ? ' · BW' : (e.startWeight ? ' · ' + e.startWeight + unit() : '');
      const sh = e.gym === 'both' ? ' ★' : '';
      return '<option value="' + e.id + '"' + (e.id === state.currentEx ? ' selected' : '') + '>' + escape(e.name) + wLbl + sh + '</option>';
    }).join('');
  }
  function renderForm() {
    const ex = getCurrentEx();
    const banner = $('bwBanner');
    const wField = $('weightField');
    const oneRmLbl = $('oneRmLabel');
    const grid = $('logGrid');
    $('weightLabel').textContent = 'Weight (' + unit() + ')';
    if (ex && ex.bw) {
      banner.classList.add('show');
      wField.style.display = 'none';
      grid.classList.add('po-bw-mode');
      oneRmLbl.textContent = 'Best reps';
    } else {
      banner.classList.remove('show');
      wField.style.display = '';
      grid.classList.remove('po-bw-mode');
      oneRmLbl.textContent = 'Est. 1RM';
    }
  }
  function renderLastSet() {
    const wrap = $('lastSet');
    const v = $('lastSetValue');
    const m = $('lastSetMeta');
    const ex = getCurrentEx();
    const logs = ex ? getLogs() : [];
    if (!ex || !logs.length) { wrap.classList.remove('show'); return; }
    const last = logs[logs.length - 1];
    const setStr = ex.bw ? (last.reps + ' reps') : (last.weight + unit() + ' × ' + last.reps);
    const d = new Date(last.date);
    const da = Math.floor((Date.now() - d.getTime()) / 86400000);
    const ago = da === 0 ? 'today' : da === 1 ? 'yesterday' : da + ' days ago';
    v.textContent = setStr;
    m.textContent = ago;
    wrap.classList.add('show');
  }
  function renderRx() {
    const wrap = $('rxWrap');
    const ex = getCurrentEx();
    if (!ex) { wrap.innerHTML = '<div class="po-rx-empty">' + (getRoutines().length ? 'Pick a routine above.' : 'Create a routine in the Routine Builder below to get started.') + '</div>'; return; }
    const logs = getLogs();
    const rx = getRx(ex, logs);
    if (!rx) {
      const sw = ex.startWeight, sr = ex.repMin;
      const head = ex.bw
        ? '<span class="po-accent">' + sr + '</span> reps'
        : '<span class="po-accent">' + (sw || 0) + unit() + '</span> × ' + sr + ' reps';
      const reason = ex.bw
        ? 'Aim for ' + ex.repMin + '-' + ex.repMax + ' clean reps. Once you hit ' + ex.repMax + '+, push for more.'
        : 'Hit ' + ex.repMin + '-' + ex.repMax + ' reps. Once logged, the coach will start prescribing.';
      wrap.innerHTML = '<div class="po-rx-card"><div class="po-rx-label">' + escape(ex.name) + ' · starting point</div><div class="po-rx-headline">' + head + '</div><span class="po-rx-tag hold">Start here</span><p class="po-rx-reason">' + reason + '</p></div>';
      return;
    }
    const head = rx.bw
      ? '<span class="po-accent">' + rx.reps + '</span> reps'
      : '<span class="po-accent">' + rx.weight + unit() + '</span> × ' + rx.reps + ' reps';
    wrap.innerHTML = '<div class="po-rx-card po-rx-' + rx.type + '"><div class="po-rx-label">' + escape(ex.name) + '</div><div class="po-rx-headline">' + head + '</div><span class="po-rx-tag ' + rx.type + '">' + rx.tag + '</span><p class="po-rx-reason">' + rx.reason + '</p></div>';
  }
  // PR / Personal Record — heaviest weight ever logged (max reps for
  // bodyweight movements). Reads the same getLogs() history as the stats.
  function renderPr() {
    const el = $('prStat');
    const ex = getCurrentEx();
    const logs = ex ? getLogs() : [];
    const bw = ex && ex.bw;
    const u = bw ? 'reps' : unit();
    const vals = logs
      .map(l => bw ? Number(l.reps) : Number(l.weight))
      .filter(v => Number.isFinite(v) && v > 0);
    const valHtml = vals.length ? String(Math.max.apply(null, vals)) : '--';
    el.classList.toggle('empty', !vals.length);
    el.innerHTML = valHtml + '<span class="po-unit" id="prUnit">' + u + '</span>';
  }
  function renderStats() {
    const ex = getCurrentEx();
    const logs = ex ? getLogs() : [];
    if (!logs.length) {
      $('oneRm').innerHTML = '—<span class="po-unit">' + unit() + '</span>';
      $('bestSet').textContent = '—';
      $('sessionCount').textContent = '—';
      return;
    }
    if (ex.bw) {
      const br = Math.max.apply(null, logs.map(l => l.reps));
      $('oneRm').innerHTML = br + '<span class="po-unit">reps</span>';
    } else {
      const orm = Math.max.apply(null, logs.map(l => estimate1RM(l.weight, l.reps)));
      $('oneRm').innerHTML = Math.round(orm) + '<span class="po-unit">' + unit() + '</span>';
    }
    let best = logs[0];
    logs.forEach(l => {
      const cur = ex.bw ? l.reps : estimate1RM(l.weight, l.reps);
      const bestVal = ex.bw ? best.reps : estimate1RM(best.weight, best.reps);
      if (cur > bestVal) best = l;
    });
    $('bestSet').textContent = ex.bw ? (best.reps + 'r') : (best.weight + '×' + best.reps);
    $('sessionCount').textContent = logs.length;
  }
  function renderSparkline() {
    const svg = $('sparkline');
    const empty = $('sparkEmpty');
    const ex = getCurrentEx();
    const logs = ex ? getLogs().slice(-10) : [];
    if (logs.length < 2) {
      svg.style.display = 'none'; empty.style.display = 'block';
      return;
    }
    svg.style.display = 'block'; empty.style.display = 'none';
    const vals = logs.map(l => ex.bw ? l.reps : estimate1RM(l.weight, l.reps));
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);
    const range = max - min || 1;
    const W = 300, H = 60, pad = 4;
    const pts = vals.map((v, i) => {
      const x = pad + (W - pad * 2) * (i / (vals.length - 1));
      const y = H - pad - (H - pad * 2) * ((v - min) / range);
      return [x, y];
    });
    const linePath = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const fillPath = linePath + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + H + ' L' + pts[0][0].toFixed(1) + ' ' + H + ' Z';
    // Keep <defs> in place; replace any prior paths
    const defsHTML = '<defs><linearGradient id="sparkGrad" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="rgba(255,255,255,0.18)"/><stop offset="100%" stop-color="rgba(255,255,255,0)"/></linearGradient></defs>';
    svg.innerHTML = defsHTML
      + '<path class="po-spark-fill" d="' + fillPath + '"/>'
      + '<path class="po-spark-line" d="' + linePath + '"/>';
  }
  // Visual reference GIF — resolves the active exercise's gifUrl (mirrored
  // from the routine-builder catalog into state.exercises). Hidden when the
  // exercise has no GIF (e.g. legacy seed exercises).
  function renderExGif() {
    const img = $('exGifImg');
    if (!img) return;
    const ex = getCurrentEx();
    const url = ex && ex.gifUrl;
    if (!url) { img.style.display = 'none'; img.removeAttribute('src'); return; }
    img.src = url;
    img.alt = ex.name || '';
    img.style.display = 'block';
    img.onerror = () => { img.style.display = 'none'; };
  }

  // Selected History date filter (YYYY-MM-DD). Empty = default recent 5.
  // Reset whenever the active exercise changes so we never show a date that
  // belongs to a different movement.
  let histDate = '';

  function renderHistory() {
    const wrap = $('historyCard');
    const filter = $('histDateFilter');
    const ex = getCurrentEx();
    const all = ex ? getLogs() : []; // chronological (oldest → newest)

    // Build the date picker from ONLY the dates this exercise was logged.
    const seen = new Set();
    const dates = [];
    all.forEach(l => {
      const key = (l.date || '').slice(0, 10);
      if (key && !seen.has(key)) { seen.add(key); dates.push(key); }
    });
    if (!seen.has(histDate)) histDate = ''; // selected date no longer valid
    if (filter) {
      const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const opts = ['<option value="">Recent 5</option>'].concat(
        dates.slice().reverse().map(key => {
          const [y, m, d] = key.split('-');
          const label = mons[parseInt(m, 10) - 1] + ' ' + parseInt(d, 10) + ', ' + y;
          return '<option value="' + key + '"' + (key === histDate ? ' selected' : '') + '>' + label + '</option>';
        })
      );
      filter.innerHTML = opts.join('');
      filter.disabled = !dates.length;
    }

    if (!all.length) {
      wrap.innerHTML = '<div class="po-empty">No logs yet.</div>';
      return;
    }

    // Pair each log with its real index BEFORE filtering so deletes stay correct,
    // then show newest first. A chosen date shows that whole day's sets;
    // otherwise cap to the most recent 5 to keep the panel compact.
    let rows = all.map((l, idx) => ({ l, idx }));
    rows.reverse();
    if (histDate) rows = rows.filter(r => (r.l.date || '').slice(0, 10) === histDate);
    else rows = rows.slice(0, 5);

    wrap.innerHTML = rows.map(({ l, idx }) => {
      const d = new Date(l.date);
      const dStr = (d.getMonth() + 1) + '/' + d.getDate();
      const setStr = ex.bw ? (l.reps + ' reps') : (l.weight + unit() + ' × ' + l.reps);
      return '<div class="po-hist-row">'
        + '<div class="po-hist-date">' + dStr + '</div>'
        + '<div class="po-hist-set">' + setStr + '</div>'
        + '<button class="po-hist-del" data-idx="' + idx + '" aria-label="Delete">×</button>'
        + '</div>';
    }).join('');

    wrap.querySelectorAll('.po-hist-del').forEach(b => {
      b.addEventListener('click', () => {
        if (!confirm('Delete this log?')) return;
        const exId = state.currentEx;
        const origIdx = parseInt(b.dataset.idx, 10);
        const arr = state.logs[exId] || [];
        const victim = arr[origIdx];
        arr.splice(origIdx, 1);
        if (!arr.length) delete state.logs[exId];
        else state.logs[exId] = arr;
        saveState(); renderAll();
        // Mirror the delete to the normalized cloud store (best-effort / queued).
        try {
          if (victim) window.GymCloud && window.GymCloud.deleteLog({ exId: exId, date: victim.date });
        } catch (e) {}
      });
    });
  }
  // Compute today's split from state.splitRotation + state.splitAnchor.
  // Returns the rotation entry name (e.g. "Push" or "Rest") AND the index.
  function todaySplit() {
    try {
      const rot = state.splitRotation;
      if (!rot || !rot.length) return { name: '—', index: 0 };
      const a = new Date(state.splitAnchor.date);
      const t = new Date();
      a.setHours(0,0,0,0); t.setHours(0,0,0,0);
      const diffDays = Math.round((t - a) / 86400000);
      const idx = ((state.splitAnchor.index + diffDays) % rot.length + rot.length) % rot.length;
      return { name: rot[idx], index: idx };
    } catch (e) {
      return { name: (state.splitRotation && state.splitRotation[0]) || '—', index: 0 };
    }
  }
  function todayDateLabel() {
    const d = new Date();
    const dows = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return dows[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate();
  }
  function isRestName(name) { return /^rest\b/i.test(name || ''); }
  function splitLabel(name) {
    if (!name) return '—';
    return (isRestName(name) ? 'REST DAY' : (name + ' DAY')).toUpperCase();
  }
  function renderDayPill() {
    const split = todaySplit();
    $('dayPillDate').textContent = todayDateLabel();
    const splitEl = $('dayPillSplit');
    splitEl.textContent = splitLabel(split.name);
    splitEl.classList.toggle('is-rest', isRestName(split.name));
  }

  // Reps is now a single free-entry numeric box (1–36). On render we seed it
  // with a useful default — the reps from this exercise's last logged set,
  // else 8 — but keep whatever valid value the user has already typed.
  const REP_MIN = 1, REP_MAX = 36;
  function clampReps(n) { return Math.max(REP_MIN, Math.min(REP_MAX, n)); }
  function renderRepsRow() {
    const input = document.getElementById('repsInput');
    if (!input) return;
    const ex = getCurrentEx();
    let def = 8;
    if (ex) {
      const logs = getLogs();
      if (logs.length) def = logs[logs.length - 1].reps;
    }
    let cur = parseInt(input.value, 10);
    if (isNaN(cur) || cur < REP_MIN || cur > REP_MAX) cur = def;
    input.value = String(clampReps(cur));
  }

  function renderAll() {
    ensureRoutineExercises();
    renderDayPill();
    renderFilters(); renderSelect(); renderForm(); renderLastSet();
    renderExGif();
    renderRepsRow();
    renderRx(); renderStats(); renderPr(); renderSparkline(); renderHistory();
    renderTodaysWorkout();
    renderPastWorkouts();
    // Pre-fill weight input with last logged weight (or starting weight)
    const ex = getCurrentEx();
    if (ex && !ex.bw) {
      const logs = getLogs();
      const w = logs.length ? logs[logs.length - 1].weight : (ex.startWeight || 0);
      $('weightInput').value = w;
    }
  }

  // ============================================================
  // TODAY'S WORKOUT + PAST WORKOUTS
  //
  // Reads state.logs, groups by date, surfaces:
  //  - Today: every set logged today, per exercise, with set count + total
  //    volume (kg lifted = sum of weight × reps across all working sets).
  //  - Past: every previous workout day, sorted newest-first, with the
  //    same summary numbers + a DONE badge if the user marked that day.
  //
  // The total volume here is what the composition-estimate uses (combined
  // with the 1RM trend) — more weekly volume + strength gain = more of
  // recent body-weight delta gets attributed to muscle.
  // ============================================================
  const WORKOUT_DONE_KEY = 'po_coach_workout_done';
  function loadDoneDays() {
    try { const raw = localStorage.getItem(WORKOUT_DONE_KEY); return raw ? JSON.parse(raw) : {}; }
    catch (e) { return {}; }
  }
  function saveDoneDays(d) {
    try { localStorage.setItem(WORKOUT_DONE_KEY, JSON.stringify(d)); } catch (e) {}
  }
  let doneDays = loadDoneDays();

  function logsByDay() {
    const byDay = {};
    state.exercises.forEach(ex => {
      (state.logs[ex.id] || []).forEach(l => {
        const dk = l.date.slice(0, 10);
        if (!byDay[dk]) byDay[dk] = [];
        byDay[dk].push({ ex, log: l });
      });
    });
    return byDay;
  }

  function fmtPastDate(dk) {
    const [y, m, d] = dk.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const dows = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return dows[dt.getDay()] + ' ' + mons[dt.getMonth()] + ' ' + dt.getDate();
  }

  function summarizeDay(daySets) {
    // daySets: [{ex, log}]. Group by exercise, return {sets: N, vol: kg, perEx: [...]}.
    const byEx = {};
    daySets.forEach(({ex, log}) => {
      if (!byEx[ex.id]) byEx[ex.id] = { ex, sets: [], vol: 0 };
      byEx[ex.id].sets.push(log);
      byEx[ex.id].vol += (log.weight || 0) * (log.reps || 0);
    });
    const perEx = Object.values(byEx);
    const totalSets = perEx.reduce((s, e) => s + e.sets.length, 0);
    const totalVol = perEx.reduce((s, e) => s + e.vol, 0);
    return { perEx, totalSets, totalVol };
  }

  function renderTodaysWorkout() {
    const todayKey = wtDateKey(new Date());
    const all = logsByDay();
    const todaySets = all[todayKey] || [];
    const sum = summarizeDay(todaySets);
    const u = state.units;

    const eyebrow = $('poTwDateLabel');
    const dows = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const d = new Date();
    eyebrow.textContent = 'TODAY · ' + dows[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate();

    $('poTwSetCount').textContent = sum.totalSets;
    $('poTwTotalVol').textContent = Math.round(sum.totalVol).toLocaleString() + ' ' + u + ' lifted';

    const list = $('poTwList');
    const empty = $('poTwEmpty');
    if (sum.totalSets === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      list.innerHTML = sum.perEx.map(e => {
        const top = e.ex.bw
          ? 'top ' + Math.max.apply(null, e.sets.map(s => s.reps)) + ' reps'
          : 'top ' + Math.max.apply(null, e.sets.map(s => s.weight)) + u;
        const meta = e.ex.bw
          ? (e.sets.length + ' set' + (e.sets.length === 1 ? '' : 's') + ' · ' + top)
          : (e.sets.length + ' set' + (e.sets.length === 1 ? '' : 's') + ' · ' + top + ' · ' + Math.round(e.vol) + u + ' total');
        return '<li class="po-tw-row">'
          + '<span class="po-tw-row-name">' + escape(e.ex.name) + '</span>'
          + '<span class="po-tw-row-meta">' + meta + '</span>'
          + '</li>';
      }).join('');
    }

    // Done button state
    const btn = $('poTwDoneBtn');
    const isDone = !!doneDays[todayKey];
    btn.textContent = isDone ? '✓ Done' : 'Mark workout done';
    btn.classList.toggle('is-done', isDone);
    btn.disabled = sum.totalSets === 0 && !isDone;
    btn.style.opacity = btn.disabled ? '0.4' : '';
  }

  function renderPastWorkouts() {
    const todayKey = wtDateKey(new Date());
    const all = logsByDay();
    const past = Object.entries(all)
      .filter(([dk]) => dk !== todayKey)
      .sort((a, b) => b[0].localeCompare(a[0]));
    $('poTwPastCount').textContent = past.length;
    const body = $('poTwPastBody');
    if (!past.length) {
      body.innerHTML = '<div class="po-tw-past-empty">No past workouts yet.</div>';
      return;
    }
    const u = state.units;
    body.innerHTML = past.slice(0, 30).map(([dk, sets]) => {
      const sum = summarizeDay(sets);
      const isDone = !!doneDays[dk];
      const exNames = sum.perEx.map(e => e.ex.name).slice(0, 3).join(', ')
        + (sum.perEx.length > 3 ? '…' : '');
      return '<div class="po-tw-past-day">'
        + '<div class="po-tw-past-day-h">'
        +   '<span class="po-tw-past-day-date">' + fmtPastDate(dk) + '</span>'
        +   '<span class="po-tw-past-day-summary">'
        +     sum.totalSets + ' sets · ' + Math.round(sum.totalVol).toLocaleString() + ' ' + u
        +     (isDone ? ' <span class="po-tw-past-day-done">DONE</span>' : '')
        +   '</span>'
        + '</div>'
        + '<div class="po-tw-past-day-summary" style="margin-top:6px; font-size:11px; color:var(--text-3);">'
        +   escape(exNames)
        + '</div>'
        + '</div>';
    }).join('');
  }

  $('poTwDoneBtn').addEventListener('click', () => {
    const todayKey = wtDateKey(new Date());
    if (doneDays[todayKey]) {
      delete doneDays[todayKey];
    } else {
      doneDays[todayKey] = new Date().toISOString();
    }
    saveDoneDays(doneDays);
    renderTodaysWorkout();
    renderPastWorkouts();
  });
  $('poTwPastToggle').addEventListener('click', () => {
    const body = $('poTwPastBody');
    const toggle = $('poTwPastToggle');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'flex';
    body.style.flexDirection = 'column';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
  });

  // ============================================================
  // EVENT WIRING
  // ============================================================
  // Tap the day pill → opens the rotation editor so you can rename /
  // reorder / add / delete entries (e.g. switch Push/Pull/Legs/Rest to
  // Legs/Arms/Back/Chest). Long-press isn't a thing on web reliably so
  // this is the only action — the day filter still auto-snaps on load.
  $('dayPill').addEventListener('click', () => openRotationModal());

  // First-load nicety: if today's split name appears in one of the saved
  // routine names (case-insensitive) and the user hasn't manually picked
  // one, pre-select that routine.
  (function autoSelectTodayRoutine() {
    const s = todaySplit();
    if (!s.name || isRestName(s.name) || state._userPickedDay) return;
    const routines = getRoutines();
    const match = routines.find(r => (r.name || '').toLowerCase().includes(s.name.toLowerCase()));
    if (match) state.filterRoutine = match.id;
  })();

  // Keep the routine selector live: when the Routine Builder saves / edits /
  // deletes a routine, re-render so the segment control reflects it instantly.
  window.addEventListener('rb:routines-changed', () => { saveState(); renderAll(); });

  $('exSelect').addEventListener('change', e => {
    state.currentEx = e.target.value;
    histDate = ''; // new exercise → reset the History date filter
    saveState(); renderAll();
  });

  // History date filter: pick a logged date to see that day's sets; the
  // "Recent 5" option (empty value) resets to the default compact view.
  $('histDateFilter').addEventListener('change', e => {
    histDate = e.target.value || '';
    renderHistory();
  });
  $('weightDownBtn').addEventListener('click', () => {
    const ex = getCurrentEx(); if (!ex || ex.bw) return;
    const w = parseFloat($('weightInput').value) || 0;
    $('weightInput').value = Math.max(0, w - (ex.step || 2.5));
  });
  $('weightUpBtn').addEventListener('click', () => {
    const ex = getCurrentEx(); if (!ex || ex.bw) return;
    const w = parseFloat($('weightInput').value) || 0;
    $('weightInput').value = w + (ex.step || 2.5);
  });
  // Reps box — clamp to 1–36 gracefully: snap back on commit, and stop an
  // over-the-max value from lingering while the user is still typing.
  $('repsInput').addEventListener('change', () => {
    let n = parseInt($('repsInput').value, 10);
    if (isNaN(n)) n = REP_MIN;
    $('repsInput').value = String(clampReps(n));
  });
  $('repsInput').addEventListener('input', () => {
    const v = $('repsInput').value;
    if (v !== '' && parseInt(v, 10) > REP_MAX) $('repsInput').value = String(REP_MAX);
  });
  $('logBtn').addEventListener('click', () => {
    const ex = getCurrentEx();
    if (!ex) return;
    let reps = parseInt($('repsInput').value, 10);
    if (isNaN(reps) || reps < REP_MIN) { alert('Enter reps (1–36).'); return; }
    reps = clampReps(reps);
    const w = ex.bw ? 0 : (parseFloat($('weightInput').value) || 0);
    if (!ex.bw && w <= 0) { alert('Enter a weight.'); return; }
    const arr = state.logs[ex.id] || [];
    const entry = { weight: w, reps: reps, date: new Date().toISOString() };
    arr.push(entry);
    state.logs[ex.id] = arr;
    saveState(); renderAll();
    // Write-through to the normalized cloud store (async; queues if offline).
    try {
      window.GymCloud && window.GymCloud.pushLog({
        exId: ex.id, name: ex.name, weight: w, reps: reps, date: entry.date, unit: unit()
      });
    } catch (e) {}
    // Tiny pulse on the button so the user feels the save
    const btn = $('logBtn');
    btn.style.transition = 'transform 0.15s';
    btn.style.transform = 'scale(0.96)';
    setTimeout(() => { btn.style.transform = ''; }, 160);
  });

  // ============================================================
  // EXERCISE MODAL (add / edit)
  // ============================================================
  let editingExId = null;
  let modalGym = null, modalDay = null;
  function renderModalSegs() {
    $('exGymSeg').innerHTML = state.gyms.map(g =>
      '<button data-gym="' + g.id + '" class="' + (modalGym === g.id ? 'active' : '') + '">' + escape(g.name) + '</button>'
    ).join('') + '<button data-gym="both" class="' + (modalGym === 'both' ? 'active' : '') + '">Both</button>';
    $('exDaySeg').innerHTML = state.days.map(d =>
      '<button data-day="' + d.id + '" class="' + (modalDay === d.id ? 'active' : '') + '">' + escape(d.name) + '</button>'
    ).join('');
    $('exGymSeg').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        modalGym = b.dataset.gym;
        $('exGymSeg').querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
    });
    $('exDaySeg').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        modalDay = b.dataset.day;
        $('exDaySeg').querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
    });
  }
  function openExModal(mode, ex) {
    editingExId = mode === 'edit' ? ex.id : null;
    $('exModalTitle').textContent = mode === 'edit' ? 'Edit exercise' : 'Add exercise';
    $('exDelete').style.display = mode === 'edit' ? 'block' : 'none';
    if (mode === 'edit') {
      $('exName').value = ex.name;
      modalGym = ex.gym;
      modalDay = ex.day;
      $('exBw').checked = !!ex.bw;
      $('exStartWeight').value = ex.startWeight || 0;
      $('exStep').value = ex.step;
      // Routine-backed exercises are gym-agnostic and owned by the Routine
      // Builder — only their coach params (weight / reps / step / bodyweight)
      // are tunable here.
      if (ex.fromRoutine) { modalGym = 'both'; modalDay = ex.day; }
    } else {
      $('exName').value = '';
      modalGym = state.filterGym;
      modalDay = state.filterDay;
      $('exBw').checked = false;
      $('exStartWeight').value = 20;
      $('exStep').value = 2.5;
    }
    const routineEx = mode === 'edit' && ex && ex.fromRoutine;
    $('exGymField').style.display = routineEx ? 'none' : '';
    $('exDayField').style.display = routineEx ? 'none' : '';
    // Removing a routine exercise is done from the Routine Builder, not here.
    $('exDelete').style.display = (mode === 'edit' && !routineEx) ? 'block' : 'none';
    renderModalSegs();
    toggleBwFields();
    $('exModalBg').classList.add('show');
    setTimeout(() => $('exName').focus(), 60);
  }
  function toggleBwFields() {
    const isBw = $('exBw').checked;
    $('exStartWeightField').style.display = isBw ? 'none' : '';
    $('exStepField').style.display = isBw ? 'none' : '';
  }
  $('exBw').addEventListener('change', toggleBwFields);
  $('addExBtn').addEventListener('click', () => openExModal('add'));
  $('editExBtn').addEventListener('click', () => {
    const ex = getCurrentEx();
    if (ex) openExModal('edit', ex);
  });
  $('exModalCancel').addEventListener('click', () => $('exModalBg').classList.remove('show'));
  $('exModalSave').addEventListener('click', () => {
    const name = $('exName').value.trim();
    if (!name) { alert('Name is required.'); return; }
    if (!modalGym) { alert('Pick a gym.'); return; }
    if (!modalDay) { alert('Pick a day.'); return; }
    const isBw = $('exBw').checked;
    // Rep range is no longer user-planned. Editing preserves the exercise's
    // existing repMin/repMax (set when it was created from a routine); new
    // exercises fall back to a sensible default.
    const data = {
      name, gym: modalGym, day: modalDay,
      bw: isBw,
      startWeight: isBw ? 0 : (parseFloat($('exStartWeight').value) || 0),
      step: isBw ? 1 : (parseFloat($('exStep').value) || 2.5)
    };
    if (editingExId) {
      const ex = state.exercises.find(e => e.id === editingExId);
      if (ex) Object.assign(ex, data);
    } else {
      const ex = Object.assign({ id: uid(), repMin: 6, repMax: 8 }, data);
      state.exercises.push(ex);
      state.currentEx = ex.id;
      state.filterGym = (modalGym === 'both') ? state.filterGym : modalGym;
      state.filterDay = modalDay;
    }
    saveState();
    $('exModalBg').classList.remove('show');
    renderAll();
  });
  $('exDelete').addEventListener('click', () => {
    if (!editingExId) return;
    if (!confirm('Delete this exercise and all its logs?')) return;
    state.exercises = state.exercises.filter(e => e.id !== editingExId);
    delete state.logs[editingExId];
    if (state.currentEx === editingExId) state.currentEx = null;
    editingExId = null;
    saveState();
    $('exModalBg').classList.remove('show');
    renderAll();
  });

  // ============================================================
  // ROTATION EDITOR (tap the day pill)
  // Edit the split cycle in place: rename, reorder, add, delete.
  // "Today is →" jumps the cycle anchor to any entry, so you can change
  // both the order AND which day in that order is "today".
  // ============================================================
  let rotDraft = null;          // working copy while modal is open
  let rotDraftTodayIdx = 0;     // which entry IS today in the draft

  function openRotationModal() {
    rotDraft = (state.splitRotation || []).slice();
    if (!rotDraft.length) rotDraft = ['Push', 'Pull', 'Legs', 'Rest'];
    rotDraftTodayIdx = todaySplit().index;
    if (rotDraftTodayIdx >= rotDraft.length) rotDraftTodayIdx = 0;
    renderRotList();
    $('rotModalBg').classList.add('show');
  }

  function renderRotList() {
    const list = $('rotList');
    list.innerHTML = rotDraft.map((name, i) => {
      const isToday = (i === rotDraftTodayIdx);
      return '<div class="rot-row ' + (isToday ? 'is-today' : '') + '" data-i="' + i + '">'
        + '<span class="rot-row-num">' + (i + 1) + '</span>'
        + '<input type="text" value="' + escape(name) + '" placeholder="e.g. Arms" maxlength="30">'
        + (isToday
            ? '<span class="rot-today-tag">TODAY</span>'
            : '<button type="button" class="rot-today-btn" data-action="today">Today is →</button>')
        + '<button type="button" class="rot-mini" data-action="up"   aria-label="Move up">↑</button>'
        + '<button type="button" class="rot-mini" data-action="down" aria-label="Move down">↓</button>'
        + '<button type="button" class="rot-mini rot-mini-del" data-action="del" aria-label="Delete">×</button>'
        + '</div>';
    }).join('');
    list.querySelectorAll('.rot-row').forEach(row => {
      const i = parseInt(row.dataset.i, 10);
      row.querySelector('input').addEventListener('input', e => { rotDraft[i] = e.target.value; });
      const upBtn = row.querySelector('[data-action="up"]');
      const dnBtn = row.querySelector('[data-action="down"]');
      const delBtn = row.querySelector('[data-action="del"]');
      const todayBtn = row.querySelector('[data-action="today"]');
      if (upBtn) upBtn.addEventListener('click', () => {
        if (i === 0) return;
        [rotDraft[i-1], rotDraft[i]] = [rotDraft[i], rotDraft[i-1]];
        if (rotDraftTodayIdx === i)   rotDraftTodayIdx = i - 1;
        else if (rotDraftTodayIdx === i - 1) rotDraftTodayIdx = i;
        renderRotList();
      });
      if (dnBtn) dnBtn.addEventListener('click', () => {
        if (i >= rotDraft.length - 1) return;
        [rotDraft[i+1], rotDraft[i]] = [rotDraft[i], rotDraft[i+1]];
        if (rotDraftTodayIdx === i)   rotDraftTodayIdx = i + 1;
        else if (rotDraftTodayIdx === i + 1) rotDraftTodayIdx = i;
        renderRotList();
      });
      if (delBtn) delBtn.addEventListener('click', () => {
        if (rotDraft.length <= 1) { alert('Need at least one day in the cycle.'); return; }
        rotDraft.splice(i, 1);
        if (rotDraftTodayIdx >= rotDraft.length) rotDraftTodayIdx = rotDraft.length - 1;
        else if (i < rotDraftTodayIdx) rotDraftTodayIdx--;
        renderRotList();
      });
      if (todayBtn) todayBtn.addEventListener('click', () => {
        rotDraftTodayIdx = i;
        renderRotList();
      });
    });
  }

  $('rotAddBtn').addEventListener('click', () => {
    rotDraft.push('New day');
    renderRotList();
    // Focus the newly added input
    setTimeout(() => {
      const inputs = $('rotList').querySelectorAll('input');
      const last = inputs[inputs.length - 1];
      if (last) { last.focus(); last.select(); }
    }, 30);
  });
  $('rotCancel').addEventListener('click', () => {
    $('rotModalBg').classList.remove('show');
    rotDraft = null;
  });
  $('rotSave').addEventListener('click', () => {
    // Trim + drop empty entries
    const cleaned = rotDraft.map(s => (s || '').trim()).filter(Boolean);
    if (!cleaned.length) { alert('Need at least one day in the cycle.'); return; }
    let newTodayIdx = rotDraftTodayIdx;
    if (newTodayIdx >= cleaned.length) newTodayIdx = 0;
    state.splitRotation = cleaned;
    state.splitAnchor = {
      date: new Date().toISOString().slice(0, 10),
      index: newTodayIdx
    };
    saveState();
    $('rotModalBg').classList.remove('show');
    rotDraft = null;
    renderAll();
  });

  // ============================================================
  // SETTINGS MODAL (gyms, days, units, data)
  // ============================================================
  function renderSettings() {
    $('setUnitsSeg').querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b.dataset.u === state.units);
    });
    $('setGyms').innerHTML = state.gyms.map((g, i) =>
      '<div class="po-set-row" data-i="' + i + '">'
      + '<input type="text" value="' + escape(g.name) + '" data-field="name" placeholder="Gym name">'
      + '<button class="po-mini-btn" data-action="del" aria-label="Delete">×</button>'
      + '</div>'
    ).join('');
    $('setDays').innerHTML = state.days.map((d, i) =>
      '<div class="po-set-row" data-i="' + i + '">'
      + '<input type="text" value="' + escape(d.name) + '" data-field="name" placeholder="Day name">'
      + '<button class="po-mini-btn" data-action="del" aria-label="Delete">×</button>'
      + '</div>'
    ).join('');
    $('setGyms').querySelectorAll('.po-set-row').forEach(row => {
      const i = parseInt(row.dataset.i, 10);
      row.querySelector('input').addEventListener('input', e => {
        state.gyms[i].name = e.target.value;
        saveState();
      });
      row.querySelector('[data-action="del"]').addEventListener('click', () => {
        if (state.gyms.length <= 1) { alert('You need at least one gym.'); return; }
        if (!confirm('Remove "' + state.gyms[i].name + '"? Exercises tagged to this gym will become invisible until you reassign them.')) return;
        state.gyms.splice(i, 1);
        if (!state.gyms.find(g => g.id === state.filterGym)) state.filterGym = state.gyms[0].id;
        saveState(); renderSettings(); renderAll();
      });
    });
    $('setDays').querySelectorAll('.po-set-row').forEach(row => {
      const i = parseInt(row.dataset.i, 10);
      row.querySelector('input').addEventListener('input', e => {
        state.days[i].name = e.target.value;
        saveState();
      });
      row.querySelector('[data-action="del"]').addEventListener('click', () => {
        if (state.days.length <= 1) { alert('You need at least one day.'); return; }
        if (!confirm('Remove "' + state.days[i].name + '"?')) return;
        state.days.splice(i, 1);
        if (!state.days.find(d => d.id === state.filterDay)) state.filterDay = state.days[0].id;
        saveState(); renderSettings(); renderAll();
      });
    });
  }
  $('settingsBtn').addEventListener('click', () => {
    renderSettings();
    $('setModalBg').classList.add('show');
  });
  $('setModalClose').addEventListener('click', () => {
    $('setModalBg').classList.remove('show');
    renderAll();
  });
  $('setUnitsSeg').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      state.units = b.dataset.u; saveState();
      $('setUnitsSeg').querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
  });
  $('setAddGym').addEventListener('click', () => {
    const name = (prompt('New gym name:') || '').trim();
    if (!name) return;
    const id = 'g_' + Date.now();
    state.gyms.push({ id, name });
    saveState(); renderSettings(); renderAll();
  });
  $('setAddDay').addEventListener('click', () => {
    const name = (prompt('New day name:') || '').trim();
    if (!name) return;
    const id = 'd_' + Date.now();
    state.days.push({ id, name });
    saveState(); renderSettings(); renderAll();
  });

  // Export / Import / Reset
  $('setExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'po-coach-data-' + new Date().toISOString().slice(0,10) + '.json';
    a.click(); URL.revokeObjectURL(url);
  });
  $('setImport').addEventListener('click', () => $('setImportFile').click());
  $('setImportFile').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!confirm('Replace ALL current data with the imported file? This cannot be undone.')) return;
        state = normalize(parsed);
        saveState(); renderSettings(); renderAll();
      } catch (err) { alert('Import failed: ' + err.message); }
    };
    reader.readAsText(file);
  });
  $('setReset').addEventListener('click', () => {
    if (!confirm('Delete EVERYTHING (logs, edits, gyms, days)? This cannot be undone.')) return;
    localStorage.removeItem(LS_KEY);
    state = loadState();
    $('setModalBg').classList.remove('show');
    renderAll();
  });

  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ============================================================
  // PROGRESS PHOTOS  (persisted to localStorage)
  //   po_coach_photos : [{ id, dataUrl, dateKey }]
  // wtDateKey / wtParseKey are shared date helpers also used by the
  // coach's Today's / Past Workouts grouping.
  // ============================================================
  const PHOTO_KEY = 'po_coach_photos';

  function wtDateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function wtParseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // ============================================================
  // PROGRESS PHOTOS
  // ============================================================
  let photos = [];
  try {
    const raw = localStorage.getItem(PHOTO_KEY);
    if (raw) photos = JSON.parse(raw);
  } catch (e) { photos = []; }

  function photosSave() {
    try {
      localStorage.setItem(PHOTO_KEY, JSON.stringify(photos));
      return true;
    } catch (e) {
      return false;
    }
  }
  // Downscale a dataURL to a max longest-side dimension and re-encode as
  // JPEG. Phone camera photos are often 2–5MB which blows the ~5MB
  // localStorage quota after one or two saves. Compressing to ~1080px /
  // q=0.75 typically drops each photo to <100KB.
  function compressPhotoDataUrl(dataUrl, maxDim, quality) {
    maxDim = maxDim || 1080;
    quality = quality == null ? 0.75 : quality;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (w > maxDim || h > maxDim) {
          if (w >= h) { h = Math.round(h * (maxDim / w)); w = maxDim; }
          else { w = Math.round(w * (maxDim / h)); h = maxDim; }
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        try { resolve(c.toDataURL('image/jpeg', quality)); }
        catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  async function uploadPhotoToStorage(dataUrl) {
    if (!pcSupa) return null;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const filename = 'photo_' + Date.now() + '_' +
        Math.random().toString(36).slice(2, 10) + '.jpg';
      const { error } = await pcSupa.storage
        .from('progress-photos')
        .upload(filename, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) return null;
      const { data } = pcSupa.storage.from('progress-photos').getPublicUrl(filename);
      return data ? data.publicUrl : null;
    } catch (e) { return null; }
  }
  function photoFmtDate(key) {
    const d = wtParseKey(key);
    const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return mons[d.getMonth()] + ' ' + d.getDate();
  }
  function photosRender() {
    const grid = $('wtPhotoGrid');
    if (!photos.length) {
      grid.innerHTML = '<div class="wt-photo-empty">No photos yet · tap Take Photo to start</div>';
    } else {
      grid.innerHTML = photos.map(p =>
        '<button class="wt-photo-card" data-id="' + p.id + '" type="button">' +
          '<img src="' + (p.url || p.dataUrl) + '" alt="">' +
          '<div class="wt-photo-overlay"></div>' +
          '<div class="wt-photo-meta">' +
            '<span class="wt-photo-date">' + photoFmtDate(p.dateKey) + '</span>' +
            '<span class="wt-photo-weight">' + (p.weight || '—') + '</span>' +
          '</div>' +
        '</button>'
      ).join('');
      grid.querySelectorAll('.wt-photo-card').forEach(card => {
        card.addEventListener('click', () => openPhoto(card.dataset.id));
      });
    }
    // Update count on the link
    if (!photos.length) $('wtProgressCount').textContent = '0 photos';
    else if (photos.length === 1) $('wtProgressCount').textContent = '1 photo · latest ' + photoFmtDate(photos[0].dateKey);
    else $('wtProgressCount').textContent = photos.length + ' photos · latest ' + photoFmtDate(photos[0].dateKey);
  }
  async function photosAdd(dataUrl) {
    let compressed = dataUrl;
    try { compressed = await compressPhotoDataUrl(dataUrl); } catch {}
    const id = 'p' + Date.now() + '_' + Math.floor(Math.random() * 999);
    const entry = {
      id,
      dataUrl: compressed,
      dateKey: wtDateKey(new Date())
    };
    photos.unshift(entry);
    if (!photosSave()) {
      // Storage was full even after compression — try once more at lower
      // quality before giving up.
      try {
        entry.dataUrl = await compressPhotoDataUrl(dataUrl, 800, 0.6);
      } catch {}
      if (!photosSave()) {
        photos.shift();
        alert('Phone storage is full — delete some older progress photos before adding a new one.');
        return;
      }
    }
    photosRender();
    uploadPhotoToStorage(entry.dataUrl).then((url) => {
      if (!url) return;
      const e = photos.find(p => p.id === id);
      if (!e) return;
      e.url = url;
      delete e.dataUrl;
      photosSave();
      photosRender();
    });
  }
  function fileToPhoto(file) {
    const r = new FileReader();
    r.onload = (e) => photosAdd(e.target.result);
    r.readAsDataURL(file);
  }

  $('wtProgressLink').addEventListener('click', () => {
    photosRender();
    $('wtOverlay').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  });
  $('wtBack').addEventListener('click', () => {
    $('wtOverlay').classList.remove('is-open');
    document.body.style.overflow = '';
  });

  // Take Photo: try in-browser camera, fall back to file input
  let camStream = null;
  let camFacing = 'environment';
  async function openCam() {
    $('wtCam').classList.add('is-open');
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: camFacing } }, audio: false
      });
      $('wtCamVideo').srcObject = camStream;
    } catch (e) {
      try {
        camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        $('wtCamVideo').srcObject = camStream;
      } catch (e2) {
        closeCam();
        alert('Camera unavailable. Use "From Library" instead.');
        throw e2;
      }
    }
  }
  function closeCam() {
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    $('wtCamVideo').srcObject = null;
    $('wtCam').classList.remove('is-open');
  }
  $('wtTakePhotoBtn').addEventListener('click', async () => {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try { await openCam(); return; } catch (e) {}
    }
    $('wtFileCamera').click();
  });
  $('wtFileCamera').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) fileToPhoto(f);
    e.target.value = '';
  });
  $('wtFromLibraryBtn').addEventListener('click', () => $('wtFileLibrary').click());
  $('wtFileLibrary').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) fileToPhoto(f);
    e.target.value = '';
  });
  $('wtCamCancel').addEventListener('click', closeCam);
  $('wtCamFlip').addEventListener('click', async () => {
    camFacing = camFacing === 'environment' ? 'user' : 'environment';
    if (camStream) camStream.getTracks().forEach(t => t.stop());
    try { await openCam(); } catch (e) {}
  });
  $('wtCamShutter').addEventListener('click', () => {
    const video = $('wtCamVideo'), canvas = $('wtCamCanvas');
    if (!video.videoWidth) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    closeCam();
    photosAdd(dataUrl);
  });

  // Photo viewer
  let activePhotoId = null;
  let comparePhotoId = null;       // the OTHER photo being compared to
  let pvDeleteConfirm = false;
  function openPhoto(id) {
    const p = photos.find(x => x.id === id);
    if (!p) return;
    activePhotoId = id;
    $('wtViewerImg').src = p.url || p.dataUrl;
    $('wtViewerDate').textContent = photoFmtDate(p.dateKey).toUpperCase();
    $('wtViewerWeight').textContent = p.weight || '—';
    $('wtViewer').dataset.mode = 'single';
    $('wtViewer').classList.add('is-open');
    pvDeleteConfirm = false;
    $('wtViewerDelete').textContent = 'Delete';
    $('wtViewerDelete').classList.remove('is-confirm');
    // Disable Compare button if there's no other photo to compare against
    $('wtViewerCompare').disabled = photos.length < 2;
    $('wtViewerCompare').style.opacity = photos.length < 2 ? '0.4' : '';
  }
  function closePhoto() {
    $('wtViewer').classList.remove('is-open');
    $('wtViewer').dataset.mode = 'single';
    activePhotoId = null;
    comparePhotoId = null;
  }

  // Pull a number out of "162.0 lbs" / "73.5 kg" / "—"
  function parseWeightStr(w) {
    if (!w) return null;
    const m = String(w).match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  // Format a delta with arrow + sign
  function fmtDelta(diff, units) {
    if (diff == null) return '';
    if (Math.abs(diff) < 0.05) return '· no change';
    const sign = diff > 0 ? '+' : '−';
    return '· ' + sign + Math.abs(diff).toFixed(1) + ' ' + units;
  }

  // Pick the "compare to" photo for a given active id. Default: the most
  // recent photo BEFORE the active one (older → time-progress comparison).
  // Falls back to the most recent newer photo if active is the oldest.
  function defaultCompareFor(activeId) {
    const idx = photos.findIndex(p => p.id === activeId);
    if (idx === -1) return null;
    if (photos[idx + 1]) return photos[idx + 1].id;        // photos are stored newest-first
    if (photos[idx - 1]) return photos[idx - 1].id;
    return null;
  }

  function openCompare(activeId, otherId) {
    const A = photos.find(p => p.id === activeId);
    const B = photos.find(p => p.id === otherId);
    if (!A || !B) return;
    activePhotoId = activeId;
    comparePhotoId = otherId;
    $('wtCmpImgA').src = A.url || A.dataUrl;
    $('wtCmpImgB').src = B.url || B.dataUrl;
    $('wtCmpMetaA').textContent = photoFmtDate(A.dateKey) + ' · ' + (A.weight || '—');
    $('wtCmpMetaB').textContent = photoFmtDate(B.dateKey) + ' · ' + (B.weight || '—');
    // Headline — date arrow + weight delta
    const wA = parseWeightStr(A.weight);
    const wB = parseWeightStr(B.weight);
    const headEl = $('wtCompareHeadline');
    let cls = 'flat', headline = photoFmtDate(A.dateKey) + ' → ' + photoFmtDate(B.dateKey);
    if (wA != null && wB != null) {
      const diff = wA - wB; // active vs comparison
      headline += ' ' + fmtDelta(diff, state.units);
      if (Math.abs(diff) < 0.05) cls = 'flat';
      else if (diff > 0) cls = 'up';
      else cls = 'down';
    }
    headEl.textContent = headline;
    headEl.className = 'wt-compare-headline ' + cls;
    $('wtViewer').dataset.mode = 'compare';
    $('wtViewer').classList.add('is-open');
    pvDeleteConfirm = false;
    $('wtCompareDelete').textContent = 'Delete';
    $('wtCompareDelete').classList.remove('is-confirm');
  }

  function cycleCompareTarget() {
    if (!activePhotoId) return;
    const others = photos.filter(p => p.id !== activePhotoId);
    if (!others.length) return;
    const curIdx = others.findIndex(p => p.id === comparePhotoId);
    const nextIdx = (curIdx + 1) % others.length;
    openCompare(activePhotoId, others[nextIdx].id);
  }

  function deleteActivePhoto(deleteBtn) {
    if (!activePhotoId) return;
    if (!pvDeleteConfirm) {
      pvDeleteConfirm = true;
      deleteBtn.textContent = 'Confirm delete?';
      deleteBtn.classList.add('is-confirm');
      setTimeout(() => {
        pvDeleteConfirm = false;
        deleteBtn.textContent = 'Delete';
        deleteBtn.classList.remove('is-confirm');
      }, 3000);
      return;
    }
    photos = photos.filter(p => p.id !== activePhotoId);
    photosSave();
    photosRender();
    closePhoto();
  }

  $('wtViewerClose').addEventListener('click', closePhoto);
  $('wtCompareClose').addEventListener('click', closePhoto);
  $('wtViewerDelete').addEventListener('click', () => deleteActivePhoto($('wtViewerDelete')));
  $('wtCompareDelete').addEventListener('click', () => deleteActivePhoto($('wtCompareDelete')));
  $('wtViewerCompare').addEventListener('click', () => {
    if (!activePhotoId) return;
    const otherId = defaultCompareFor(activePhotoId);
    if (!otherId) { alert('Need at least one other photo to compare.'); return; }
    openCompare(activePhotoId, otherId);
  });
  $('wtCompareBack').addEventListener('click', () => {
    if (activePhotoId) {
      $('wtViewer').dataset.mode = 'single';
    } else {
      closePhoto();
    }
  });
  // Tap the right-hand "other" photo to cycle through different comparison targets
  $('wtCmpSideB').addEventListener('click', cycleCompareTarget);

  // ============================================================
  // BOOT
  // ============================================================
  renderAll();
  photosRender();

  // ============================================================
  // CLOUD SYNC via Supabase  (OPTIONAL — leave blank for local-only)
  // ------------------------------------------------------------
  // Stores your gym state as one JSONB row in the public.app_state
  // table, keyed by APP_KEY. Supabase's realtime channel pushes
  // changes to every device the instant they happen.
  //
  // SETUP (5 minutes, all in a browser):
  //   1. Make a free account at https://supabase.com
  //   2. Create a new project
  //   3. In your project: Settings → API → copy your Project URL +
  //      "Publishable" key (the one starting with `sb_publishable_`)
  //   4. Paste them below, replacing the two placeholder strings
  //   5. Open the SQL Editor and run the SQL block from README.md
  //
  // If you leave the placeholders unchanged the app still works,
  // just only on this device (data stays in your browser).
  // ============================================================
  const SUPABASE_URL = 'https://vcuqcjtzdjtonvaqolzm.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_JEudB5hgyn38SkUiO6oWhw_9Qrtr36b';
  const APP_KEY = 'po-coach';
  const PC_SYNCED_KEYS = ['po_coach_v1', 'po_coach_workout_done', 'po_coach_photos'];

  let pcSupa = null;
  let pcPushTimer = null;
  let pcSuppressSync = false;
  let pcPendingRemote = null;
  // JSON of the last state we sent or received — used to ignore
  // realtime echoes of our own pushes so we don't infinite-loop.
  let pcLastSyncedJson = null;

  const _pcOrigSet = localStorage.setItem.bind(localStorage);
  const _pcOrigRemove = localStorage.removeItem.bind(localStorage);
  // Wrap setItem/removeItem so a sync-side error can NEVER prevent the
  // underlying write from happening. The original call always runs;
  // any error in the sync scheduling is swallowed.
  localStorage.setItem = function(k, v) {
    _pcOrigSet(k, v);
    try {
      if (!pcSuppressSync && PC_SYNCED_KEYS.indexOf(k) !== -1) pcSchedulePush();
    } catch (e) {}
  };
  localStorage.removeItem = function(k) {
    _pcOrigRemove(k);
    try {
      if (!pcSuppressSync && PC_SYNCED_KEYS.indexOf(k) !== -1) pcSchedulePush();
    } catch (e) {}
  };

  function pcCollectState() {
    const out = {};
    for (const k of PC_SYNCED_KEYS) {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      let val;
      try { val = JSON.parse(v); } catch { continue; }
      if (k === 'po_coach_photos' && Array.isArray(val)) {
        val = val
          .filter((p) => p && p.url)
          .map((p) => ({ id: p.id, url: p.url, dateKey: p.dateKey, weight: p.weight }));
      }
      out[k] = val;
    }
    return out;
  }

  function pcIsUserEditing() {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (ae.getAttribute && ae.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function pcRerender() {
    // Reload every closure variable that mirrors a synced localStorage
    // key — otherwise renderAll/photosRender would read stale in-memory
    // copies from before the remote pull.
    try { state = loadState(); } catch {}
    try {
      const raw = localStorage.getItem(PHOTO_KEY);
      photos = raw ? JSON.parse(raw) : [];
    } catch { photos = []; }
    try { renderAll(); } catch {}
    try { photosRender(); } catch {}
  }

  function pcApplyRemoteState(remote) {
    if (!remote || typeof remote !== 'object') return false;
    pcSuppressSync = true;
    let changed = false;
    try {
      for (const k of PC_SYNCED_KEYS) {
        if (k === 'po_coach_photos') {
          let localPhotos = [];
          try { localPhotos = JSON.parse(localStorage.getItem(k) || '[]'); } catch {}
          const remotePhotos = Array.isArray(remote[k]) ? remote[k] : [];
          const remoteIds = new Set(remotePhotos.map((p) => p && p.id));
          const localOnly = localPhotos.filter((p) => p && !p.url && !remoteIds.has(p.id));
          const merged = [...remotePhotos, ...localOnly];
          const incoming = JSON.stringify(merged);
          if (localStorage.getItem(k) !== incoming) {
            try { _pcOrigSet(k, incoming); changed = true; } catch {}
          }
          continue;
        }
        if (k in remote) {
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) { try { _pcOrigSet(k, incoming); changed = true; } catch {} }
        } else if (localStorage.getItem(k) != null) {
          try { _pcOrigRemove(k); changed = true; } catch {}
        }
      }
    } finally {
      pcSuppressSync = false;
    }
    if (changed) { try { pcRerender(); } catch (e) {} }
    return changed;
  }

  function pcMaybeApplyRemote(remote) {
    if (pcIsUserEditing()) { pcPendingRemote = remote; return; }
    pcApplyRemoteState(remote);
  }

  function pcApplyPendingIfReady() {
    if (pcPendingRemote && !pcIsUserEditing()) {
      const r = pcPendingRemote;
      pcPendingRemote = null;
      pcApplyRemoteState(r);
    }
  }

  async function pcPushNow() {
    if (!pcSupa) return;
    const state = pcCollectState();
    const json = JSON.stringify(state);
    if (json === pcLastSyncedJson) return;
    try {
      const { error } = await pcSupa
        .from('app_state')
        .upsert(
          { key: APP_KEY, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
      if (!error) pcLastSyncedJson = json;
    } catch (_) {}
  }

  function pcSchedulePush() {
    if (pcSuppressSync) return;
    clearTimeout(pcPushTimer);
    pcPushTimer = setTimeout(pcPushNow, 250);
  }

  // Backup push on unload via fetch keepalive so a fast refresh
  // doesn't lose the latest change before the debounced push fires.
  function pcFlushPushOnUnload() {
    if (!pcSupa) return;
    const state = pcCollectState();
    const json = JSON.stringify(state);
    if (json === pcLastSyncedJson) return;
    try {
      fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ key: APP_KEY, data: state, updated_at: new Date().toISOString() }),
        keepalive: true,
      }).catch(() => {});
      pcLastSyncedJson = json;
    } catch (_) {}
  }

  // Initial sync: connect Supabase, pull current state, subscribe to
  // realtime updates so other devices' changes appear instantly.
  (async function pcInitCloudSync() {
    if (!window.supabase || !SUPABASE_URL || !SUPABASE_KEY) return;
    // Skip if the placeholder values are still in place (local-only mode)
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;
    pcSupa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    try {
      const { data, error } = await pcSupa
        .from('app_state').select('data').eq('key', APP_KEY).maybeSingle();
      if (!error && data && data.data && Object.keys(data.data).length > 0) {
        pcLastSyncedJson = JSON.stringify(data.data);
        pcMaybeApplyRemote(data.data);
      } else if (Object.keys(pcCollectState()).length > 0) {
        pcSchedulePush();
      }
    } catch (_) {}
    pcSupa.channel('app_state_' + APP_KEY)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'app_state',
        filter: 'key=eq.' + APP_KEY,
      }, (payload) => {
        if (!payload.new || !payload.new.data) return;
        const incoming = JSON.stringify(payload.new.data);
        if (incoming === pcLastSyncedJson) return; // echo of our own push
        pcLastSyncedJson = incoming;
        pcMaybeApplyRemote(payload.new.data);
      })
      .subscribe();
  })();

  document.addEventListener('focusout', () => {
    setTimeout(pcApplyPendingIfReady, 0);
  }, true);
  window.addEventListener('pagehide', pcFlushPushOnUnload);
  window.addEventListener('beforeunload', pcFlushPushOnUnload);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pcFlushPushOnUnload();
  });

  // ── Bridge for the normalized cloud layer (GymCloud) ──────────
  // Lets the cloud module hydrate logs pulled from exercise_logs into the
  // coach's in-memory state without coupling the two IIFEs. Merges by date
  // so we never double-count sets the blob cache already restored.
  window.__gymCoachMergeLogs = function (byExId) {
    if (!byExId || typeof byExId !== 'object') return false;
    let changed = false;
    Object.keys(byExId).forEach(exId => {
      const incoming = byExId[exId] || [];
      const arr = state.logs[exId] || [];
      const seen = new Set(arr.map(l => l.date));
      incoming.forEach(l => {
        if (l && l.date && !seen.has(l.date)) { arr.push(l); seen.add(l.date); changed = true; }
      });
      if (arr.length) {
        arr.sort((a, b) => new Date(a.date) - new Date(b.date));
        state.logs[exId] = arr;
      }
    });
    if (changed) { saveState(); renderAll(); }
    return changed;
  };
})();

/* ============================================================
   ROUTINE BUILDER — self-contained. Reads the exercise catalog
   from js/exercises-data.json (generated by scripts/generate-
   exercises.js) and persists routines to localStorage.
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
    current.exercises.push({
      exId, name: e.name, muscleGroup: e.muscleGroup, gifUrl: e.gifUrl,
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

  // Normalize a legacy exercise ({ sets: <number>, reps, rest }) into the new
  // set-array shape, preserving the old set count + rep target where possible.
  function normalizeSets(it) {
    if (Array.isArray(it.sets)) return;
    const count = Math.max(1, parseInt(it.sets, 10) || DEFAULTS.sets);
    const reps  = parseInt(it.reps, 10) || DEFAULTS.reps;
    it.sets = Array.from({ length: count }, () => ({ weight: 0, reps }));
    delete it.reps; delete it.rest;
  }

  function renderRoutine() {
    const list = $('rbRoutineList');
    list.innerHTML = '';
    $('rbRoutineEmpty').style.display = current.exercises.length ? 'none' : 'block';
    current.exercises.forEach((it, idx) => list.appendChild(routineRow(it, idx)));
    if ($('rbRoutineName').value !== current.name) $('rbRoutineName').value = current.name;
  }

  // A single numeric set input (weight or reps) with graceful clamping.
  // opts: { min, max, float } — float allows decimals (weight); integers
  // otherwise (reps). Out-of-range / empty values snap to the nearest bound
  // on commit and the sanitized value is written back into the box.
  function setInput(value, opts, onChange) {
    opts = opts || {};
    const min = (opts.min != null) ? opts.min : 0;
    const max = (opts.max != null) ? opts.max : null;
    const parse = opts.float ? parseFloat : (v => parseInt(v, 10));
    const i = document.createElement('input');
    i.type = 'number'; i.value = value;
    i.min = String(min); if (max != null) i.max = String(max);
    i.inputMode = opts.float ? 'decimal' : 'numeric';
    if (opts.float) i.step = '0.5';
    const clamp = () => {
      let n = parse(i.value);
      if (isNaN(n)) n = min;
      if (n < min) n = min;
      if (max != null && n > max) n = max;
      i.value = String(n);
      onChange(n);
    };
    i.addEventListener('change', clamp);
    // Stop an over-the-max value from lingering while the user is still typing.
    if (max != null) {
      i.addEventListener('input', () => {
        if (i.value !== '' && parse(i.value) > max) i.value = String(max);
      });
    }
    return i;
  }

  function mini(label, fn, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rb-mini' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function move(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= current.exercises.length) return;
    const a = current.exercises;
    [a[idx], a[j]] = [a[j], a[idx]];
    renderRoutine();
  }

  // One set row: [ Set # ] [ Weight ] [ Reps ] [ × ]
  function setRow(it, sIdx) {
    const s = it.sets[sIdx];
    const row = document.createElement('div'); row.className = 'rb-set-row';

    const lbl = document.createElement('div'); lbl.className = 'rb-set-label'; lbl.textContent = String(sIdx + 1);
    const w = setInput(s.weight, { min: 0, float: true }, v => s.weight = v);
    const r = setInput(s.reps,   { min: 1, max: 36 },     v => s.reps = v);

    const del = mini('×', () => {
      it.sets.splice(sIdx, 1);
      renderRoutine();
    }, 'rb-del');
    del.title = 'Remove set';
    del.disabled = it.sets.length <= 1; // keep at least one set; use Remove Exercise to clear

    row.append(lbl, w, r, del);
    return row;
  }

  function routineRow(it, idx) {
    normalizeSets(it); // migrate any legacy single-value exercises in place

    const li = document.createElement('li'); li.className = 'rb-row';

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

    // ── Set table: header + one row per set ──
    const setsWrap = document.createElement('div'); setsWrap.className = 'rb-sets-wrap';
    const colHead = document.createElement('div'); colHead.className = 'rb-set-head';
    ['Set', 'Weight', 'Reps', ''].forEach(t => {
      const sp = document.createElement('span'); sp.textContent = t; colHead.appendChild(sp);
    });
    const setList = document.createElement('div'); setList.className = 'rb-sets';
    it.sets.forEach((s, sIdx) => setList.appendChild(setRow(it, sIdx)));
    setsWrap.append(colHead, setList);

    // ── Manage buttons: add a set / remove the whole exercise ──
    const actions = document.createElement('div'); actions.className = 'rb-ex-actions';
    const addSet = document.createElement('button');
    addSet.type = 'button'; addSet.className = 'rb-add-set'; addSet.textContent = '+ Add Set';
    addSet.addEventListener('click', () => {
      it.sets.push(blankSet(it.sets[it.sets.length - 1]));
      renderRoutine();
    });
    const removeEx = document.createElement('button');
    removeEx.type = 'button'; removeEx.className = 'rb-remove-ex'; removeEx.textContent = 'Remove Exercise';
    removeEx.addEventListener('click', () => {
      current.exercises.splice(idx, 1);
      renderRoutine(); renderGrid();
    });
    actions.append(addSet, removeEx);

    li.append(head, setsWrap, actions);
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
        if (!confirm('Delete routine "' + r.name + '"?')) return;
        saveRoutines(loadRoutines().filter(x => x.id !== r.id));
        if (current.id === r.id) { current = { id: null, name: '', exercises: [] }; renderRoutine(); renderGrid(); }
        renderSaved();
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

/* ============================================================
   NORMALIZED CLOUD DATA LAYER (offline-first, write-through)
   Coexists with the app_state blob sync. Adds two tables:
     routines, exercise_logs. Failed pushes queue in localStorage
     ('local_sync_queue') and replay on the next 'online' event.
   ============================================================ */
(function () {
  // Same Supabase project + publishable (anon) key as the blob sync.
  const SUPABASE_URL = 'https://vcuqcjtzdjtonvaqolzm.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_JEudB5hgyn38SkUiO6oWhw_9Qrtr36b';
  const RB_KEY        = 'rb_routines_v1';
  const COACH_KEY     = 'po_coach_v1';
  const QUEUE_KEY     = 'local_sync_queue';        // pending ops, keyed for idempotency
  const BACKFILL_FLAG = 'po_cloud_backfilled_v1';  // seed-cloud-once guard

  const ready = !!(window.supabase && SUPABASE_URL && SUPABASE_KEY &&
                   SUPABASE_URL.indexOf('PASTE-') !== 0 && SUPABASE_KEY.indexOf('PASTE-') !== 0);
  const supa = ready ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

  // ── Offline queue (a map keyed by op-key so retries collapse) ──
  function loadQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || {}; } catch { return {}; } }
  function saveQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {} }
  function enqueue(op)  { const q = loadQueue(); q[op.key] = op; saveQueue(q); }
  function dequeue(key) { const q = loadQueue(); delete q[key]; saveQueue(q); }

  // Run one op against Supabase → true on success.
  async function runOp(op) {
    if (!supa) return false;
    try {
      if (op.kind === 'routines') {
        const rows = (op.payload || []).map(toRoutineRow);
        if (!rows.length) return true;
        const { error } = await supa.from('routines').upsert(rows, { onConflict: 'client_id' });
        return !error;
      }
      if (op.kind === 'log') {
        const { error } = await supa.from('exercise_logs').upsert(op.payload, { onConflict: 'client_id' });
        return !error;
      }
      if (op.kind === 'logs') {
        if (!op.payload || !op.payload.length) return true;
        const { error } = await supa.from('exercise_logs').upsert(op.payload, { onConflict: 'client_id' });
        return !error;
      }
      if (op.kind === 'logDelete') {
        const { error } = await supa.from('exercise_logs').delete().eq('client_id', op.payload.client_id);
        return !error;
      }
    } catch (e) { return false; }
    return false;
  }

  // Try immediately; stash for retry on failure / no connectivity.
  async function attempt(op) {
    if (!ready || !navigator.onLine) { enqueue(op); return; }
    const ok = await runOp(op);
    if (ok) dequeue(op.key); else enqueue(op);
  }
  async function flushQueue() {
    if (!ready || !navigator.onLine) return;
    const q = loadQueue();
    for (const k of Object.keys(q)) {
      const ok = await runOp(q[k]);
      if (ok) dequeue(k);
    }
  }

  // ── Mappers ───────────────────────────────────────────────────
  function toRoutineRow(r) {
    return {
      client_id: r.id,
      name: r.name || 'Untitled routine',
      exercises: r.exercises || [],
      updated_at: r.updated_at || new Date().toISOString()
    };
  }
  const logClientId = (exId, date) => exId + '|' + date;
  function toLogRow(l) {
    return {
      client_id: logClientId(l.exId, l.date),
      exercise_name: l.name || l.exId,
      weight: (l.weight != null ? l.weight : null),
      reps:   (l.reps   != null ? l.reps   : null),
      timestamp: l.date,
      metadata: { exId: l.exId, unit: l.unit || null }
    };
  }

  // ── Public push API (called from the coach + routine builder) ──
  function pushRoutines(arr) {
    attempt({ kind: 'routines', key: 'routines:all', payload: arr });
  }
  function pushLog(l) {
    if (!l || !l.exId || !l.date) return;
    const row = toLogRow(l);
    attempt({ kind: 'log', key: 'log:' + row.client_id, payload: row });
  }
  function deleteLog(l) {
    if (!l || !l.exId || !l.date) return;
    const cid = logClientId(l.exId, l.date);
    attempt({ kind: 'logDelete', key: 'logdel:' + cid, payload: { client_id: cid } });
  }

  // ── Pulls / hydration ─────────────────────────────────────────
  async function pullRoutines() {
    if (!supa) return;
    try {
      const { data, error } = await supa.from('routines').select('*');
      if (error || !Array.isArray(data)) return;
      const mapped = data.map(row => ({
        id: row.client_id || row.id,
        name: row.name,
        exercises: row.exercises || [],
        updated_at: row.updated_at || row.created_at
      }));
      if (window.__gymRBMergeRoutines) window.__gymRBMergeRoutines(mapped);
    } catch (e) {}
  }
  async function pullLogs() {
    if (!supa) return;
    try {
      const { data, error } = await supa.from('exercise_logs')
        .select('*').order('timestamp', { ascending: true });
      if (error || !Array.isArray(data)) return;
      const byExId = {};
      data.forEach(row => {
        const exId = row.metadata && row.metadata.exId;
        if (!exId) return;
        (byExId[exId] = byExId[exId] || []).push({
          weight: row.weight != null ? Number(row.weight) : 0,
          reps:   row.reps   != null ? Number(row.reps)   : 0,
          date:   row.timestamp
        });
      });
      if (window.__gymCoachMergeLogs) window.__gymCoachMergeLogs(byExId);
    } catch (e) {}
  }

  // ── Backfill (first run only): seed the cloud from this device ──
  function backfillOnce() {
    if (localStorage.getItem(BACKFILL_FLAG)) return;
    try {
      const routines = JSON.parse(localStorage.getItem(RB_KEY) || '[]');
      if (Array.isArray(routines) && routines.length) pushRoutines(routines);

      const coach = JSON.parse(localStorage.getItem(COACH_KEY) || '{}');
      const logs  = (coach && coach.logs) || {};
      const exs   = (coach && coach.exercises) || [];
      const nameById = {};
      exs.forEach(e => { if (e && e.id) nameById[e.id] = e.name; });

      const rows = [];
      Object.keys(logs).forEach(exId => {
        (logs[exId] || []).forEach(l => {
          if (l && l.date) rows.push(toLogRow({
            exId, name: nameById[exId] || exId, weight: l.weight, reps: l.reps, date: l.date, unit: coach.units
          }));
        });
      });
      if (rows.length) attempt({ kind: 'logs', key: 'logs:backfill', payload: rows });
    } catch (e) {}
    try { localStorage.setItem(BACKFILL_FLAG, '1'); } catch (e) {}
  }

  async function init() {
    if (!ready) return;     // no client → app stays local-only (writes still queue)
    await flushQueue();     // retry anything stranded from a past offline session
    backfillOnce();         // one-time seed of existing local data
    await pullRoutines();   // bring in routines from other devices
    await pullLogs();       // hydrate logs missing locally (fills gaps, deduped)
  }

  // Expose for the rest of the app + manual refresh.
  window.GymCloud = { pushRoutines, pushLog, deleteLog, flushQueue,
                      pull: () => { pullRoutines(); pullLogs(); } };

  // Retry the queue the moment connectivity returns; refresh on tab focus.
  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { flushQueue(); pullRoutines(); pullLogs(); }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
