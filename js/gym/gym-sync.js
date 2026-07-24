/* ============================================================
   gym-sync.js — Progressive Overload Coach: app_state blob sync.
   Mirrors the synced localStorage keys into one JSONB row in the
   public.app_state table and subscribes to realtime updates.
   Wraps localStorage.setItem/removeItem to auto-push on change.
   Also hosts window.__gymCoachMergeLogs (the bridge the normalized
   cloud layer calls to hydrate logs into the session model).
   Loads 3rd (after storage, before ui). Shares state via G.state.
   ============================================================ */
(function () {
  'use strict';
  const G = window.GymApp;
  // Storage API (defined earlier → safe to alias at load).
  const { loadState, saveState, rebuildLogIndex, logSetKey } = G;

  // ============================================================
  // CLOUD SYNC via Supabase  (OPTIONAL — leave blank for local-only)
  // Stores gym state as one JSONB row in public.app_state, keyed by
  // APP_KEY. Supabase's realtime channel pushes changes to every device.
  // ============================================================
  const SUPABASE_URL = (window.APP_CONFIG || {}).SUPABASE_URL || '';
  const SUPABASE_KEY = (window.APP_CONFIG || {}).SUPABASE_KEY || '';
  const APP_KEY = 'po-coach';
  const PC_SYNCED_KEYS = ['po_coach_v1', 'po_coach_workout_done', 'po_coach_photos'];

  let pcSupa = null;
  let pcPushTimer = null;
  let pcSuppressSync = false;
  let pcPendingRemote = null;
  // JSON of the last state we sent or received — used to ignore realtime echoes
  // of our own pushes so we don't infinite-loop.
  let pcLastSyncedJson = null;

  const _pcOrigSet = localStorage.setItem.bind(localStorage);
  const _pcOrigRemove = localStorage.removeItem.bind(localStorage);
  // Wrap setItem/removeItem so a sync-side error can NEVER prevent the
  // underlying write from happening. The original call always runs; any error
  // in the sync scheduling is swallowed.
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
    // Reload every closure variable that mirrors a synced localStorage key —
    // otherwise renderAll/photosRender would read stale in-memory copies from
    // before the remote pull. (Photos live in gym-ui.js; reloaded via G.)
    try { G.state = loadState(); } catch {}
    try { G.pcReloadPhotos(); } catch {}
    try { G.renderAll(); } catch {}
    try { G.photosRender(); } catch {}
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
    const snapshot = pcCollectState();
    const json = JSON.stringify(snapshot);
    if (json === pcLastSyncedJson) return;
    try {
      const { error } = await pcSupa
        .from('app_state')
        .upsert(
          { key: APP_KEY, data: snapshot, updated_at: new Date().toISOString() },
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

  // Backup push on unload via fetch keepalive so a fast refresh doesn't lose
  // the latest change before the debounced push fires.
  function pcFlushPushOnUnload() {
    if (!pcSupa) return;
    const snapshot = pcCollectState();
    const json = JSON.stringify(snapshot);
    if (json === pcLastSyncedJson) return;
    try {
      fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + (window.__appAccessToken || SUPABASE_KEY),
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({ key: APP_KEY, data: snapshot, updated_at: new Date().toISOString() }),
        keepalive: true,
      }).catch(() => {});
      pcLastSyncedJson = json;
    } catch (_) {}
  }

  // Initial sync: connect Supabase, pull current state, subscribe to realtime
  // updates so other devices' changes appear instantly.
  (async function pcInitCloudSync() {
    if (!window.supabase || !SUPABASE_URL || !SUPABASE_KEY) return;
    // Skip if the placeholder values are still in place (local-only mode)
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;
    // Wait for the login gate, then reuse the one authed client (js/auth/main.js) so
    // the JWT rides along for RLS. A fresh createClient() would carry only the
    // anon key and be denied.
    await (window.APP_AUTH_READY || Promise.resolve());
    pcSupa = window.APP_SUPABASE;
    if (!pcSupa) return;
    G.pcSupa = pcSupa;   // shared so the photo uploader (gym-ui.js) can use it
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

  // ── Bridge for the normalized cloud layer (gym-cloud.js / GymCloud) ──
  // Merge logs pulled from the normalized cloud table into the SESSION model.
  // The app_state blob already carries sessions canonically across devices, so
  // this is a gap-filler: any (exId|date) not already present in a session is
  // attached to its named session (from metadata.session) when known, else to a
  // per-day import session. Dedup by (exId|epoch-ms) — via the shared logSetKey
  // identity — prevents double-counting across the Postgres date round-trip.
  window.__gymCoachMergeLogs = function (byExId) {
    if (!byExId || typeof byExId !== 'object') return false;
    const present = new Set();
    (G.state.sessions || []).forEach(s => (s.sets || []).forEach(st => present.add(logSetKey(st.exId, st.date))));
    const nameById = {};
    (G.state.exercises || []).forEach(e => { if (e && e.id) nameById[e.id] = e.name; });
    let changed = false;
    Object.keys(byExId).forEach(exId => {
      (byExId[exId] || []).forEach(l => {
        if (!l || !l.date) return;
        const key = logSetKey(exId, l.date);
        if (present.has(key)) return;        // already have it locally
        present.add(key);
        let sid = l.session;
        let sess = sid ? (G.state.sessions || []).find(s => s.id === sid) : null;
        if (!sess) {
          const day = l.date.slice(0, 10);
          sid = sid || ('sess_legacy_' + day);
          sess = (G.state.sessions || []).find(s => s.id === sid);
          if (!sess) {
            sess = { id: sid, label: 'Workout', startedAt: l.date, endedAt: l.date, sets: [] };
            (G.state.sessions = G.state.sessions || []).push(sess);
          }
        }
        const set = { exId, name: nameById[exId] || exId, weight: l.weight, reps: l.reps, date: l.date, is_dropset: !!l.is_dropset };
        // Preserve the time metric coming back from the normalized store.
        if (l.metric === 'time') { set.metric = 'time'; set.duration = l.duration; set.reps = null; }
        sess.sets.push(set);
        changed = true;
      });
    });
    if (changed) { rebuildLogIndex(); saveState(); G.renderAll(); }
    return changed;
  };
})();
