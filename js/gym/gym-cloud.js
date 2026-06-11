/* ============================================================
   gym-cloud.js — Normalized cloud data layer (GymCloud).
   Self-contained IIFE (own closure). Coexists with the app_state
   blob sync; adds routines + exercise_logs tables. Failed pushes
   queue in localStorage ('local_sync_queue') and replay on 'online'.
   Exposes window.GymCloud; consumes window.__gymCoachMergeLogs /
   window.__gymRBMergeRoutines. Split verbatim out of js/gym.js.
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
      if (op.kind === 'routineDelete') {
        const { error } = await supa.from('routines').delete().eq('client_id', op.payload.client_id);
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
    const isTime = l.metric === 'time';
    return {
      client_id: logClientId(l.exId, l.date),
      exercise_name: l.name || l.exId,
      weight: (l.weight != null ? l.weight : null),
      // Time sets leave the typed `reps` column NULL so it never holds seconds —
      // the duration lives in metadata.duration_s instead (kept clean & queryable
      // separately). Rep sets are unchanged.
      reps:   isTime ? null : (l.reps != null ? l.reps : null),
      timestamp: l.date,
      // session id + metric + duration ride in metadata (jsonb) so no schema
      // migration is required; a dedicated column can be added later if wanted.
      metadata: {
        exId: l.exId, unit: l.unit || null, session: l.session || null,
        is_dropset: !!l.is_dropset,
        metric: isTime ? 'time' : 'reps',
        duration_s: isTime ? (l.duration != null ? l.duration : null) : null
      }
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
  function deleteRoutine(routineId) {
    if (!routineId) return;
    attempt({ kind: 'routineDelete', key: 'routinedel:' + routineId, payload: { client_id: routineId } });
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
        const md = row.metadata || {};
        const exId = md.exId;
        if (!exId) return;
        const isTime = md.metric === 'time';
        (byExId[exId] = byExId[exId] || []).push({
          weight: row.weight != null ? Number(row.weight) : 0,
          reps:   isTime ? null : (row.reps != null ? Number(row.reps) : 0),
          metric: isTime ? 'time' : 'reps',
          duration: isTime ? (md.duration_s != null ? Number(md.duration_s) : 0) : null,
          date:   row.timestamp,
          session: md.session || null,
          is_dropset: !!md.is_dropset
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
            exId, name: nameById[exId] || exId, weight: l.weight, reps: l.reps,
            metric: l.metric, duration: l.duration, date: l.date, unit: coach.units
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
  window.GymCloud = { pushRoutines, pushLog, deleteLog, deleteRoutine, flushQueue,
                      pull: () => { pullRoutines(); pullLogs(); } };

  // Retry the queue the moment connectivity returns; refresh on tab focus.
  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { flushQueue(); pullRoutines(); pullLogs(); }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
