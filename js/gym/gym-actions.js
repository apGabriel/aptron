/* ============================================================
   gym-actions.js — Progressive Overload Coach: interaction layer.
   Static event wiring (log, weight/reps, dropset arming, session
   buttons, settings, export/import/reset/dedup), the exercise
   add/edit modal, and deleteSession. Invokes G.boot() at the very
   end — the LAST Coach module to load, so every G.* member is
   populated before first render.
   Loads 5th (after ui). Shares state via G.state.
   ============================================================ */
(function () {
  'use strict';
  const G = window.GymApp;
  const { $, escape, unit, uid, clampReps, REP_MIN, REP_MAX,
          isTimeMetric, clampDur, DUR_MIN } = G;
  const { getCurrentEx, getActiveSession, ensureActiveSession, closeActiveSession,
          startNewSession, dedupSessionSets, rebuildLogIndex, saveState, loadState,
          normalize, LS_KEY } = G;
  const { renderAll, renderHistory, renderSettings, renderTodaysWorkout, renderPastWorkouts } = G;

  // ============================================================
  // CURRENT SESSION + PAST WORKOUTS — interaction
  // ============================================================
  // Permanently remove a session: drop its sets from the normalized cloud store,
  // delete the session locally, rebuild the derived index, persist + re-render.
  // The session removal also syncs via the app_state blob on saveState().
  function deleteSession(id) {
    const sess = (G.state.sessions || []).find(s => s.id === id);
    if (!sess) return;
    try {
      (sess.sets || []).forEach(st => {
        if (window.GymCloud) window.GymCloud.deleteLog({ exId: st.exId, date: st.date });
      });
    } catch (e) {}
    G.state.sessions = (G.state.sessions || []).filter(s => s.id !== id);
    if (G.state.activeSessionId === id) G.state.activeSessionId = null;
    rebuildLogIndex();
    saveState();
    renderAll();
  }

  // Done = close (lock) the active session → it moves to Past workouts and no
  // further sets can be appended to it.
  $('poTwDoneBtn').addEventListener('click', () => {
    if (!getActiveSession()) return;
    closeActiveSession();
    saveState();
    renderTodaysWorkout();
    renderPastWorkouts();
  });
  // New session = close any open session and start a fresh, empty one, so a
  // second workout the same day is isolated from the first.
  $('poTwNewBtn').addEventListener('click', () => {
    startNewSession();
    saveState();
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
  // Keep the routine selector live: when the Routine Builder saves / edits /
  // deletes a routine, re-render so the segment control reflects it instantly.
  window.addEventListener('rb:routines-changed', () => { saveState(); renderAll(); });

  $('exSelect').addEventListener('change', e => {
    G.state.currentEx = e.target.value;
    G.histDate = ''; // new exercise → reset the History date filter
    saveState(); renderAll();
  });

  // History date filter: pick a logged date to see that day's sets; the
  // "Recent 5" option (empty value) resets to the default compact view.
  $('histDateFilter').addEventListener('change', e => {
    G.histDate = e.target.value || '';
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
  // Reps/time box — clamp gracefully against the ACTIVE metric's bounds (reps
  // 1–36, time 1–3600s): snap back on commit, and stop an over-the-max value
  // from lingering while the user is still typing.
  function metricBounds() {
    const ex = getCurrentEx();
    return isTimeMetric(ex) ? { min: DUR_MIN, clamp: clampDur } : { min: REP_MIN, clamp: clampReps };
  }
  $('repsInput').addEventListener('change', () => {
    const { min, clamp } = metricBounds();
    let n = parseInt($('repsInput').value, 10);
    if (isNaN(n)) n = min;
    $('repsInput').value = String(clamp(n));
  });
  $('repsInput').addEventListener('input', () => {
    const v = $('repsInput').value;
    const { clamp } = metricBounds();
    // Re-clamp only when the typed value already exceeds the max (clamp is a
    // no-op below it), so mid-typing digits aren't fought.
    if (v !== '' && clamp(parseInt(v, 10)) < parseInt(v, 10)) $('repsInput').value = String(clamp(parseInt(v, 10)));
  });
  // Metric toggle: flip the current exercise between reps and time. Sticky per
  // exercise (stored like `bw`) and synced via the app_state blob.
  $('metricSeg').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      const ex = getCurrentEx();
      if (!ex) return;
      const next = b.dataset.metric === 'time' ? 'time' : 'reps';
      if ((ex.metric || 'reps') === next) return;
      ex.metric = next;
      // Reset the input so a stale reps value isn't read as seconds (or vice
      // versa) — renderAll reseeds it from this metric's last set / default.
      $('repsInput').value = '';
      saveState();
      renderAll();
    });
  });
  // Dropset arming: when ON, the NEXT logged set is tagged is_dropset and chains
  // onto the working set above it. Auto-disarms after each log. A dropset can
  // only ever attach to a baseline set, so arming it before this exercise has
  // one is ignored (see the parent-anchor guard in the log handler).
  let dsArmed = false;
  // True once the exercise already owns a baseline (non-dropset) set in the
  // active session — the anchor a dropset chains onto.
  function exerciseHasBaseline(sess, exId) {
    return !!(sess && (sess.sets || []).some(st => st.exId === exId && !st.is_dropset));
  }
  function setDropArmed(on) {
    dsArmed = !!on;
    const t = $('dsToggle');
    if (!t) return;
    t.classList.toggle('active', dsArmed);
    t.setAttribute('aria-pressed', dsArmed ? 'true' : 'false');
  }
  if ($('dsToggle')) $('dsToggle').addEventListener('click', () => setDropArmed(!dsArmed));

  // Shared commit path for BOTH Reps ("Log set") and a completed Time hold.
  // The caller passes `reps` xor `duration` (already validated); weight and the
  // dropset state are read here, at commit time. This is the ORIGINAL logging
  // flow verbatim — extracted so the in-set timer can reuse it without forking
  // session/history/cloud persistence.
  function commitSet(payload) {
    const ex = getCurrentEx();
    if (!ex) return;
    const isTime = payload.duration != null;
    // Weight: bodyweight exercises log 0. Otherwise 0 is a VALID added load
    // (pull-ups, dips, push-ups) — only reject a negative or non-numeric value.
    let w;
    if (ex.bw) {
      w = 0;
    } else {
      w = parseFloat($('weightInput').value);
      if (isNaN(w) || w < 0) { alert('Enter a valid weight (0 or more).'); return; }
    }
    // Log into the ACTIVE session (auto-opening one if none is in progress),
    // then rebuild the derived per-exercise index. Sets never land in a closed
    // session, so a finished routine can't be appended to.
    const iso = new Date().toISOString();
    const sess = ensureActiveSession();
    // A dropset only counts if a baseline set already anchors it. Arming DS on
    // the first set of an exercise falls back to a normal baseline (Set 1).
    const isDrop = dsArmed && exerciseHasBaseline(sess, ex.id);
    // Mutually exclusive: a time set carries `duration` (+ metric flag) and no
    // `reps`; a rep set carries `reps` only. The set row structure is otherwise
    // unchanged, so sessions/history stay intact.
    const setObj = { exId: ex.id, name: ex.name, weight: w, date: iso };
    if (isTime) { setObj.metric = 'time'; setObj.duration = payload.duration; }
    else { setObj.reps = payload.reps; }
    if (isDrop) setObj.is_dropset = true;
    sess.sets.push(setObj);
    rebuildLogIndex();
    // Disarm before re-render so the toggle never carries into the next set.
    setDropArmed(false);
    saveState(); renderAll();
    // Write-through to the normalized cloud store (async; queues if offline).
    // session id rides in metadata so the row carries its session attribution.
    try {
      window.GymCloud && window.GymCloud.pushLog({
        exId: ex.id, name: ex.name, weight: w,
        reps: isTime ? null : payload.reps,
        duration: isTime ? payload.duration : null,
        metric: isTime ? 'time' : 'reps', date: iso, unit: unit(), session: sess.id, is_dropset: isDrop
      });
    } catch (e) {}
    // Tiny pulse on the button so the user feels the save
    const btn = $('logBtn');
    if (btn) {
      btn.style.transition = 'transform 0.15s';
      btn.style.transform = 'scale(0.96)';
      setTimeout(() => { btn.style.transform = ''; }, 160);
    }
    // Kick off the between-sets rest countdown for this exercise. The duration
    // is the rest planned for this movement in the ACTIVE routine (0 = off).
    // The timer is a self-contained overlay (window.GymRestTimer) that holds no
    // session state, so it never disturbs the logging flow it sits on top of.
    try {
      const rest = G.getRestSeconds(ex.id);
      if (rest > 0 && window.GymRestTimer) window.GymRestTimer.start(rest, ex.name);
    } catch (e) {}
  }

  // ============================================================
  // TIME-SET HOLD COUNTDOWN — reuses the Rest Timer overlay
  // ============================================================
  // The log button's label is metric-driven: "Start set" for a Time exercise,
  // "Log set" for Reps. renderForm() calls this, so a re-render (e.g. an 8s
  // cloud poll) re-derives it instead of leaving a stale label behind.
  function refreshLogBtn() {
    const btn = $('logBtn');
    if (!btn) return;
    btn.textContent = isTimeMetric(getCurrentEx()) ? 'Start set' : 'Log set';
  }
  G.refreshLogBtn = refreshLogBtn;

  // Log button:
  //   • Reps → commit immediately (unchanged).
  //   • Time → run the hold as a live countdown in the SHARED Rest Timer overlay
  //     (same ring, animation and chrome, captioned "KEEP HOLDING"). Reaching 0
  //     logs the completed hold via commitSet — which in turn starts the
  //     between-sets rest in that very same overlay (a seamless hold→rest
  //     hand-off). Skipping the overlay early logs nothing.
  $('logBtn').addEventListener('click', () => {
    const ex = getCurrentEx();
    if (!ex) return;
    const raw = parseInt($('repsInput').value, 10);
    if (isTimeMetric(ex)) {
      if (isNaN(raw) || raw < DUR_MIN) { alert('Enter a duration in seconds.'); return; }
      const dur = clampDur(raw);
      if (window.GymRestTimer && window.GymRestTimer.start) {
        window.GymRestTimer.start(dur, ex.name, {
          mode: 'hold',
          onFinish: (held) => commitSet({ duration: clampDur(Math.round(held) || dur) })
        });
      } else {
        commitSet({ duration: dur });   // overlay module absent → log straight away
      }
      return;
    }
    if (isNaN(raw) || raw < REP_MIN) { alert('Enter reps (1–36).'); return; }
    commitSet({ reps: clampReps(raw) });
  });

  // ============================================================
  // EXERCISE MODAL (add / edit)
  // ============================================================
  let editingExId = null;
  let modalGym = null;
  function renderModalSegs() {
    $('exGymSeg').innerHTML = G.state.gyms.map(g =>
      '<button data-gym="' + g.id + '" class="' + (modalGym === g.id ? 'active' : '') + '">' + escape(g.name) + '</button>'
    ).join('') + '<button data-gym="both" class="' + (modalGym === 'both' ? 'active' : '') + '">Both</button>';
    $('exGymSeg').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        modalGym = b.dataset.gym;
        $('exGymSeg').querySelectorAll('button').forEach(x => x.classList.remove('active'));
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
      $('exBw').checked = !!ex.bw;
      $('exStartWeight').value = ex.startWeight || 0;
      $('exStep').value = ex.step;
      // Routine-backed exercises are gym-agnostic and owned by the Routine
      // Builder — only their coach params (weight / reps / step / bodyweight)
      // are tunable here.
      if (ex.fromRoutine) modalGym = 'both';
    } else {
      $('exName').value = '';
      modalGym = G.state.filterGym;
      $('exBw').checked = false;
      $('exStartWeight').value = 20;
      $('exStep').value = 2.5;
    }
    const routineEx = mode === 'edit' && ex && ex.fromRoutine;
    $('exGymField').style.display = routineEx ? 'none' : '';
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
    const isBw = $('exBw').checked;
    // Rep range is no longer user-planned. Editing preserves the exercise's
    // existing repMin/repMax (set when it was created from a routine); new
    // exercises fall back to a sensible default.
    const data = {
      name, gym: modalGym,
      bw: isBw,
      startWeight: isBw ? 0 : (parseFloat($('exStartWeight').value) || 0),
      step: isBw ? 1 : (parseFloat($('exStep').value) || 2.5)
    };
    if (editingExId) {
      const ex = G.state.exercises.find(e => e.id === editingExId);
      if (ex) Object.assign(ex, data);
    } else {
      const ex = Object.assign({ id: uid(), repMin: 6, repMax: 8 }, data);
      G.state.exercises.push(ex);
      G.state.currentEx = ex.id;
      G.state.filterGym = (modalGym === 'both') ? G.state.filterGym : modalGym;
    }
    saveState();
    $('exModalBg').classList.remove('show');
    renderAll();
  });
  $('exDelete').addEventListener('click', () => {
    if (!editingExId) return;
    if (!confirm('Delete this exercise and all its logs?')) return;
    G.state.exercises = G.state.exercises.filter(e => e.id !== editingExId);
    delete G.state.logs[editingExId];
    if (G.state.currentEx === editingExId) G.state.currentEx = null;
    editingExId = null;
    saveState();
    $('exModalBg').classList.remove('show');
    renderAll();
  });

  // ============================================================
  // SETTINGS MODAL (gyms, units, data)
  // ============================================================
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
      G.state.units = b.dataset.u; saveState();
      $('setUnitsSeg').querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    });
  });
  $('setAddGym').addEventListener('click', () => {
    const name = (prompt('New gym name:') || '').trim();
    if (!name) return;
    const id = 'g_' + Date.now();
    G.state.gyms.push({ id, name });
    saveState(); renderSettings(); renderAll();
  });

  // Deduplicate History — one-time scrub of the ghost-duplicate sets left by the
  // old tab-hydration bug. Walks every session's sets, collapses any that share
  // an (exId | epoch-ms) key down to a single instance, rebuilds the derived
  // index, persists, and re-renders. Idempotent. Same engine as
  // window.__gymPurgeGhosts.
  $('setDedup').addEventListener('click', () => {
    const removed = dedupSessionSets(G.state);
    rebuildLogIndex();
    saveState();
    renderAll();
    alert(removed
      ? 'Removed ' + removed + ' duplicate set' + (removed === 1 ? '' : 's') + ' from your history.'
      : 'No duplicate sets found — your history is already clean.');
  });

  // Export / Import / Reset
  $('setExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(G.state, null, 2)], { type: 'application/json' });
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
        G.state = normalize(parsed);
        saveState(); renderSettings(); renderAll();
      } catch (err) { alert('Import failed: ' + err.message); }
    };
    reader.readAsText(file);
  });
  $('setReset').addEventListener('click', () => {
    if (!confirm('Delete EVERYTHING (logs, edits, gyms)? This cannot be undone.')) return;
    localStorage.removeItem(LS_KEY);
    G.state = loadState();
    $('setModalBg').classList.remove('show');
    renderAll();
  });

  // deleteSession is called from gym-ui.js (the Past-workouts delete button).
  G.deleteSession = deleteSession;

  // ============================================================
  // BOOT — every G.* member is now populated; start the app.
  // ============================================================
  G.boot();
})();
