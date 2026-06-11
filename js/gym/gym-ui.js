/* ============================================================
   gym-ui.js — Progressive Overload Coach: rendering pipeline.
   All pure DOM rendering: the coach panels (prescription, stats,
   PR, sparkline, history), the current/past session cards, the
   settings render, and the whole Progress Photos subsystem (kept
   together — it's a cohesive media/render unit).
   Loads 4th (after sync, before actions). Shares state via G.state.
   ============================================================ */
(function () {
  'use strict';
  const G = window.GymApp;
  // Core leaf helpers + storage API (all defined earlier → alias at load).
  const { $, escape, unit, fmtSetValue, setMarkersHtml, workingSets,
          estimate1RM, roundToStep, clampReps, REP_MIN, REP_MAX,
          isTimeMetric, fmtDuration, metricVal, clampDur, DUR_MIN, DUR_MAX } = G;
  const { ensureRoutineExercises, getRoutines, getCurrentRoutine, getFiltered,
          getCurrentEx, getLogs, getRx, getActiveSession, summarizeSession,
          saveState, rebuildLogIndex } = G;
  void roundToStep; // (kept in alias set for parity; not used directly here)

  // ============================================================
  // RENDER
  // ============================================================
  function renderFilters() {
    $('gymSeg').innerHTML = G.state.gyms.map(g =>
      '<button class="po-seg-btn ' + (g.id === G.state.filterGym ? 'active' : '') + '" data-gym="' + g.id + '">' + escape(g.name) + '</button>'
    ).join('');
    // Routine segment — replaces the old Push/Pull/Legs day filter. Lists the
    // user's saved routines; selecting one drives the exercise flow.
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
          G.state.filterRoutine = b.dataset.routine;
          G.state.currentEx = null;
          saveState(); renderAll();
        });
      });
    }
    // Adding bespoke exercises now happens in the Routine Builder, so the
    // inline "+" no longer fits the routine-driven model.
    $('addExBtn').style.display = 'none';
    $('gymSeg').querySelectorAll('.po-seg-btn').forEach(b => {
      b.addEventListener('click', () => { G.state.filterGym = b.dataset.gym; G.state.currentEx = null; saveState(); renderAll(); });
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
      noMsg.style.display = 'block'; G.state.currentEx = null;
      return;
    }
    sel.disabled = false; editBtn.disabled = false; logBtn.disabled = false;
    noMsg.style.display = 'none';
    if (!f.find(e => e.id === G.state.currentEx)) G.state.currentEx = f[0].id;
    sel.innerHTML = f.map(e => {
      const wLbl = e.bw ? ' · BW' : (e.startWeight ? ' · ' + e.startWeight + unit() : '');
      const sh = e.gym === 'both' ? ' ★' : '';
      return '<option value="' + e.id + '"' + (e.id === G.state.currentEx ? ' selected' : '') + '>' + escape(e.name) + wLbl + sh + '</option>';
    }).join('');
  }
  function renderForm() {
    const ex = getCurrentEx();
    const banner = $('bwBanner');
    const wField = $('weightField');
    const oneRmLbl = $('oneRmLabel');
    const grid = $('logGrid');
    const time = isTimeMetric(ex);
    $('weightLabel').textContent = 'Weight (' + unit() + ')';
    if (ex && ex.bw) {
      banner.classList.add('show');
      wField.style.display = 'none';
      grid.classList.add('po-bw-mode');
      oneRmLbl.textContent = time ? 'Best time' : 'Best reps';
    } else {
      banner.classList.remove('show');
      wField.style.display = '';
      grid.classList.remove('po-bw-mode');
      oneRmLbl.textContent = time ? 'Best time' : 'Est. 1RM';
    }
    // Adapt the reps/time field: same input, swapped label, bounds and hint.
    const input = $('repsInput');
    $('repsLabel').textContent = time ? 'Time (sec)' : 'Reps';
    input.min = time ? DUR_MIN : REP_MIN;
    input.max = time ? DUR_MAX : REP_MAX;
    input.placeholder = time ? '30' : '8';
    // Reflect the active metric on the toggle.
    $('metricSeg').querySelectorAll('button').forEach(b => {
      const on = (b.dataset.metric === 'time') === time;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function renderLastSet() {
    const wrap = $('lastSet');
    const v = $('lastSetValue');
    const m = $('lastSetMeta');
    const ex = getCurrentEx();
    const logs = ex ? getLogs() : [];
    if (!ex || !logs.length) { wrap.classList.remove('show'); return; }
    const last = logs[logs.length - 1];
    const setStr = fmtSetValue(last, ex);
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
    const time = isTimeMetric(ex);
    const rx = getRx(ex, logs);
    if (!rx) {
      const sw = ex.startWeight, sr = ex.repMin;
      const head = time
        ? '<span class="po-accent">Timed</span> hold'
        : ex.bw
          ? '<span class="po-accent">' + sr + '</span> reps'
          : '<span class="po-accent">' + (sw || 0) + unit() + '</span> × ' + sr + ' reps';
      const reason = time
        ? 'Log your first hold — the coach starts prescribing longer times once it has history.'
        : ex.bw
          ? 'Aim for ' + ex.repMin + '-' + ex.repMax + ' clean reps. Once you hit ' + ex.repMax + '+, push for more.'
          : 'Hit ' + ex.repMin + '-' + ex.repMax + ' reps. Once logged, the coach will start prescribing.';
      wrap.innerHTML = '<div class="po-rx-card"><div class="po-rx-label">' + escape(ex.name) + ' · starting point</div><div class="po-rx-headline">' + head + '</div><span class="po-rx-tag hold">Start here</span><p class="po-rx-reason">' + reason + '</p></div>';
      return;
    }
    const head = rx.time
      ? '<span class="po-accent">' + fmtDuration(rx.duration) + '</span>' + (rx.bw ? '' : ' · ' + rx.weight + unit())
      : rx.bw
        ? '<span class="po-accent">' + rx.reps + '</span> reps'
        : '<span class="po-accent">' + rx.weight + unit() + '</span> × ' + rx.reps + ' reps';
    wrap.innerHTML = '<div class="po-rx-card po-rx-' + rx.type + '"><div class="po-rx-label">' + escape(ex.name) + '</div><div class="po-rx-headline">' + head + '</div><span class="po-rx-tag ' + rx.type + '">' + rx.tag + '</span><p class="po-rx-reason">' + rx.reason + '</p></div>';
  }
  // PR / Personal Record — heaviest weight ever logged (max reps for bodyweight
  // movements). Reads the same getLogs() history as the stats.
  function renderPr() {
    const el = $('prStat');
    const ex = getCurrentEx();
    const logs = ex ? getLogs() : [];
    const time = isTimeMetric(ex);
    const bw = ex && ex.bw;
    // Time PR = longest hold (shown formatted, no unit suffix); otherwise
    // heaviest weight (or best reps for bodyweight).
    const u = time ? '' : (bw ? 'reps' : unit());
    // A PR is a peak — dropsets (lighter, fatigued) are excluded.
    const vals = workingSets(logs)
      .map(l => time ? Number(l.duration) : (bw ? Number(l.reps) : Number(l.weight)))
      .filter(v => Number.isFinite(v) && v > 0);
    const peak = vals.length ? Math.max.apply(null, vals) : null;
    const valHtml = peak == null ? '--' : (time ? fmtDuration(peak) : String(peak));
    el.classList.toggle('empty', !vals.length);
    el.innerHTML = valHtml + '<span class="po-unit" id="prUnit">' + u + '</span>';
  }
  function renderStats() {
    const ex = getCurrentEx();
    const logs = ex ? getLogs() : [];
    const time = isTimeMetric(ex);
    if (!logs.length) {
      $('oneRm').innerHTML = '—<span class="po-unit">' + (time ? 's' : unit()) + '</span>';
      $('bestSet').textContent = '—';
      $('sessionCount').textContent = '—';
      return;
    }
    // Peak metrics (1RM + best set) ignore dropsets; the set count is total.
    const peak = workingSets(logs);
    if (time) {
      // Time movements have no 1RM — the peak is the longest hold.
      const bd = Math.max.apply(null, peak.map(l => Number(l.duration) || 0));
      $('oneRm').innerHTML = fmtDuration(bd);
    } else if (ex.bw) {
      const br = Math.max.apply(null, peak.map(l => l.reps));
      $('oneRm').innerHTML = br + '<span class="po-unit">reps</span>';
    } else {
      const orm = Math.max.apply(null, peak.map(l => estimate1RM(l.weight, l.reps)));
      $('oneRm').innerHTML = Math.round(orm) + '<span class="po-unit">' + unit() + '</span>';
    }
    let best = peak[0];
    peak.forEach(l => {
      const cur = time ? (Number(l.duration) || 0) : ex.bw ? l.reps : estimate1RM(l.weight, l.reps);
      const bestVal = time ? (Number(best.duration) || 0) : ex.bw ? best.reps : estimate1RM(best.weight, best.reps);
      if (cur > bestVal) best = l;
    });
    $('bestSet').textContent = time ? fmtDuration(best.duration) : ex.bw ? (best.reps + 'r') : (best.weight + '×' + best.reps);
    $('sessionCount').textContent = logs.length;
  }
  function renderSparkline() {
    const svg = $('sparkline');
    const empty = $('sparkEmpty');
    const ex = getCurrentEx();
    // Strength trend tracks working sets only, so a dropset chain doesn't
    // sawtooth the line downward.
    const logs = ex ? workingSets(getLogs()).slice(-10) : [];
    if (logs.length < 2) {
      svg.style.display = 'none'; empty.style.display = 'block';
      return;
    }
    svg.style.display = 'block'; empty.style.display = 'none';
    const vals = logs.map(l => isTimeMetric(ex) ? (Number(l.duration) || 0) : ex.bw ? l.reps : estimate1RM(l.weight, l.reps));
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
  // Visual reference GIF — resolves the active exercise's gifUrl (mirrored from
  // the routine-builder catalog into G.state.exercises). Hidden when the
  // exercise has no GIF.
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

  // Selected History date filter (YYYY-MM-DD). Empty = default recent 5. Reset
  // whenever the active exercise changes (gym-actions.js) so we never show a
  // date that belongs to a different movement. Shared via G so the actions
  // handlers can clear/set it.
  G.histDate = '';

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
    if (!seen.has(G.histDate)) G.histDate = ''; // selected date no longer valid
    if (filter) {
      const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const opts = ['<option value="">Recent 5</option>'].concat(
        dates.slice().reverse().map(key => {
          const [y, m, d] = key.split('-');
          const label = mons[parseInt(m, 10) - 1] + ' ' + parseInt(d, 10) + ', ' + y;
          return '<option value="' + key + '"' + (key === G.histDate ? ' selected' : '') + '>' + label + '</option>';
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
    if (G.histDate) rows = rows.filter(r => (r.l.date || '').slice(0, 10) === G.histDate);
    else rows = rows.slice(0, 5);

    wrap.innerHTML = rows.map(({ l, idx }) => {
      const d = new Date(l.date);
      const dStr = (d.getMonth() + 1) + '/' + d.getDate();
      const setStr = fmtSetValue(l, ex);
      // Dropsets chain off the working set above: drop the date column and
      // prefix a ↳ DS tag so the row reads as a continuation, not a fresh set.
      const ds = !!l.is_dropset;
      return '<div class="po-hist-row' + (ds ? ' is-dropset' : '') + '">'
        + '<div class="po-hist-date">' + (ds ? '' : dStr) + '</div>'
        + '<div class="po-hist-set">' + setMarkersHtml(l) + setStr + '</div>'
        + '<button class="po-hist-del" data-idx="' + idx + '" aria-label="Delete">×</button>'
        + '</div>';
    }).join('');

    wrap.querySelectorAll('.po-hist-del').forEach(b => {
      b.addEventListener('click', () => {
        if (!confirm('Delete this log?')) return;
        const exId = G.state.currentEx;
        const origIdx = parseInt(b.dataset.idx, 10);
        const arr = G.state.logs[exId] || [];
        const victim = arr[origIdx];
        if (victim) {
          // Remove the set from its owning session, then rebuild the index.
          const sess = (G.state.sessions || []).find((s) => s.id === victim.session);
          if (sess) sess.sets = sess.sets.filter((st) => !(st.exId === exId && st.date === victim.date));
          rebuildLogIndex();
        }
        saveState(); renderAll();
        // Mirror the delete to the normalized cloud store (best-effort / queued).
        try {
          if (victim) window.GymCloud && window.GymCloud.deleteLog({ exId: exId, date: victim.date });
        } catch (e) {}
      });
    });
  }
  // Reps box default seed — the reps from this exercise's last logged set, else
  // 8 — but keep whatever valid value the user has already typed.
  function renderRepsRow() {
    const input = document.getElementById('repsInput');
    if (!input) return;
    const ex = getCurrentEx();
    const time = isTimeMetric(ex);
    const min = time ? DUR_MIN : REP_MIN;
    const max = time ? DUR_MAX : REP_MAX;
    let def = time ? 30 : 8;
    if (ex) {
      const logs = getLogs();
      if (logs.length) {
        const last = logs[logs.length - 1];
        def = time ? (Number(last.duration) || def) : last.reps;
      }
    }
    let cur = parseInt(input.value, 10);
    if (isNaN(cur) || cur < min || cur > max) cur = def;
    input.value = String(time ? clampDur(cur) : clampReps(cur));
  }

  function renderAll() {
    ensureRoutineExercises();
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
  // CURRENT SESSION + PAST WORKOUTS  (render from G.state.sessions)
  // ============================================================
  function fmtPastDate(dk) {
    const [y, m, d] = dk.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const dows = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return dows[dt.getDay()] + ' ' + mons[dt.getMonth()] + ' ' + dt.getDate();
  }

  // Per-set breakdown for one exercise. Working sets get a "Set N" label;
  // dropsets render indented beneath the preceding set with a ↳ DS tag, so a
  // heavy→light chain (e.g. 75 → 60 → 42 kg) reads as one fatigue block.
  function setLinesHtml(e) {
    let n = 0;
    const lines = e.sets.map(s => {
      const val = fmtSetValue(s, e.ex);
      // A dropset only renders as a ↳ DS child once a baseline set anchors it.
      // A leading dropset (no parent yet — only possible from legacy data) is
      // promoted to a numbered baseline set so the chain always has an anchor.
      if (s.is_dropset && n > 0) {
        return '<li class="po-tw-set is-drop">' + setMarkersHtml(s)
          + '<span class="po-tw-set-val">' + val + '</span></li>';
      }
      n++;
      return '<li class="po-tw-set"><span class="po-set-n">Set ' + n + '</span>'
        + '<span class="po-tw-set-val">' + val + '</span></li>';
    });
    return '<ul class="po-tw-sets">' + lines.join('') + '</ul>';
  }
  function twRowHtml(e, u) {
    const top = isTimeMetric(e.ex)
      ? 'top ' + fmtDuration(Math.max.apply(null, e.sets.map(s => Number(s.duration) || 0)))
      : e.ex.bw
        ? 'top ' + Math.max.apply(null, e.sets.map(s => s.reps)) + ' reps'
        : 'top ' + Math.max.apply(null, e.sets.map(s => s.weight)) + u;
    const meta = e.sets.length + ' set' + (e.sets.length === 1 ? '' : 's') + ' · ' + top;
    return '<li class="po-tw-row">'
      + '<div class="po-tw-row-head">'
      +   '<span class="po-tw-row-name">' + escape(e.ex.name) + '</span>'
      +   '<span class="po-tw-row-meta">' + meta + '</span>'
      + '</div>'
      + setLinesHtml(e)
      + '</li>';
  }

  // Renders the ACTIVE session (the workout in progress) — not "everything
  // logged today". Closing a session moves it to Past workouts.
  function renderTodaysWorkout() {
    const u = G.state.units;
    const sess = getActiveSession();
    const eyebrow = $('poTwDateLabel');
    const list = $('poTwList');
    const empty = $('poTwEmpty');
    const btn = $('poTwDoneBtn');
    const dows = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

    if (!sess) {
      eyebrow.textContent = 'NO ACTIVE SESSION';
      $('poTwSetCount').textContent = '0';
      list.innerHTML = '';
      empty.classList.remove('hidden');
      empty.textContent = 'No active session — log a set to start one, or tap “New session”.';
      btn.textContent = 'Mark done';
      btn.classList.remove('is-done');
      btn.disabled = true; btn.style.opacity = '0.4';
      return;
    }

    const sum = summarizeSession(sess);
    const d = new Date(sess.startedAt);
    eyebrow.textContent = (sess.label ? escape(sess.label.toUpperCase()) + ' · ' : '')
      + 'IN PROGRESS · ' + dows[d.getDay()] + ' ' + mons[d.getMonth()] + ' ' + d.getDate();
    $('poTwSetCount').textContent = sum.totalSets;

    if (sum.totalSets === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      empty.textContent = 'Session started — log a set above and it’ll appear here.';
    } else {
      empty.classList.add('hidden');
      list.innerHTML = sum.perEx.map(e => twRowHtml(e, u)).join('');
    }

    btn.textContent = '✓ Mark done';
    btn.classList.remove('is-done');
    btn.disabled = sum.totalSets === 0;
    btn.style.opacity = btn.disabled ? '0.4' : '';
  }

  function renderPastWorkouts() {
    // Only CLOSED sessions that actually hold ≥1 set — empty "ghost" sessions
    // are filtered out so the list stays meaningful. (normalize() also prunes
    // them from state on load.)
    const past = (G.state.sessions || [])
      .filter(s => s.endedAt && (s.sets || []).length > 0)
      .slice()
      .sort((a, b) => (b.endedAt || b.startedAt || '').localeCompare(a.endedAt || a.startedAt || ''));
    $('poTwPastCount').textContent = past.length;
    const body = $('poTwPastBody');
    if (!past.length) {
      body.innerHTML = '<div class="po-tw-past-empty">No past sessions yet.</div>';
      return;
    }
    body.innerHTML = past.slice(0, 40).map(sess => {
      const sum = summarizeSession(sess);
      const dk = (sess.endedAt || sess.startedAt || '').slice(0, 10);
      return '<div class="po-tw-past-day" data-session="' + escape(sess.id) + '">'
        + '<div class="po-tw-past-day-h">'
        +   '<span class="po-tw-past-day-date">' + escape(sess.label || 'Workout') + ' · ' + fmtPastDate(dk) + '</span>'
        +   '<span class="po-tw-past-day-right">'
        +     '<span class="po-tw-past-day-summary">'
        +       sum.totalSets + ' sets'
        +       ' <span class="po-tw-past-day-done">DONE</span>'
        +     '</span>'
        +     '<button class="po-hist-del po-tw-past-del" type="button" data-del="' + escape(sess.id) + '" aria-label="Delete session" title="Delete this session">×</button>'
        +   '</span>'
        + '</div>'
        + '</div>';
    }).join('');

    body.querySelectorAll('.po-tw-past-del').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = b.dataset.del;
        const sess = (G.state.sessions || []).find(s => s.id === id);
        const n = sess ? (sess.sets || []).length : 0;
        if (!confirm('Delete this session' + (n ? ' and its ' + n + ' set' + (n === 1 ? '' : 's') : '')
          + '? This removes it from all your devices.')) return;
        G.deleteSession(id);   // defined in gym-actions.js
      });
    });
  }

  // ============================================================
  // SETTINGS MODAL render (gyms, units, data)
  // ============================================================
  function renderSettings() {
    $('setUnitsSeg').querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b.dataset.u === G.state.units);
    });
    $('setGyms').innerHTML = G.state.gyms.map((g, i) =>
      '<div class="po-set-row" data-i="' + i + '">'
      + '<input type="text" value="' + escape(g.name) + '" data-field="name" placeholder="Gym name">'
      + '<button class="po-mini-btn" data-action="del" aria-label="Delete">×</button>'
      + '</div>'
    ).join('');
    $('setGyms').querySelectorAll('.po-set-row').forEach(row => {
      const i = parseInt(row.dataset.i, 10);
      row.querySelector('input').addEventListener('input', e => {
        G.state.gyms[i].name = e.target.value;
        saveState();
      });
      row.querySelector('[data-action="del"]').addEventListener('click', () => {
        if (G.state.gyms.length <= 1) { alert('You need at least one gym.'); return; }
        if (!confirm('Remove "' + G.state.gyms[i].name + '"? Exercises tagged to this gym will become invisible until you reassign them.')) return;
        G.state.gyms.splice(i, 1);
        if (!G.state.gyms.find(g => g.id === G.state.filterGym)) G.state.filterGym = G.state.gyms[0].id;
        saveState(); renderSettings(); renderAll();
      });
    });
  }

  // ============================================================
  // PROGRESS PHOTOS  (persisted to localStorage 'po_coach_photos')
  // Kept whole — a cohesive media + render subsystem.
  // ============================================================
  const PHOTO_KEY = 'po_coach_photos';

  function wtDateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function wtParseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  let photos = [];
  try {
    const raw = localStorage.getItem(PHOTO_KEY);
    if (raw) photos = JSON.parse(raw);
  } catch (e) { photos = []; }

  // Reload the in-memory photos array from localStorage after a remote pull
  // (called by gym-sync.js pcRerender via G.pcReloadPhotos).
  function pcReloadPhotos() {
    try {
      const raw = localStorage.getItem(PHOTO_KEY);
      photos = raw ? JSON.parse(raw) : [];
    } catch { photos = []; }
  }

  function photosSave() {
    try {
      localStorage.setItem(PHOTO_KEY, JSON.stringify(photos));
      return true;
    } catch (e) {
      return false;
    }
  }
  // Downscale a dataURL to a max longest-side dimension and re-encode as JPEG.
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
    if (!G.pcSupa) return null;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const filename = 'photo_' + Date.now() + '_' +
        Math.random().toString(36).slice(2, 10) + '.jpg';
      const { error } = await G.pcSupa.storage
        .from('progress-photos')
        .upload(filename, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) return null;
      const { data } = G.pcSupa.storage.from('progress-photos').getPublicUrl(filename);
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

  // Pick the "compare to" photo for a given active id. Default: the most recent
  // photo BEFORE the active one (older → time-progress comparison). Falls back
  // to the most recent newer photo if active is the oldest.
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
      headline += ' ' + fmtDelta(diff, G.state.units);
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
  // Tap the right-hand "other" photo to cycle through comparison targets
  $('wtCmpSideB').addEventListener('click', cycleCompareTarget);

  // Expose the render entry points + photo reload/render the other modules call.
  Object.assign(G, {
    renderAll, renderHistory, renderSettings,
    renderTodaysWorkout, renderPastWorkouts,
    photosRender, pcReloadPhotos
  });
})();
