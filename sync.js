// =============================================================
// Shared cloud-sync helper. Each page calls initCloudSync({...}).
// =============================================================
(function () {
  'use strict';
  const SUPABASE_URL = 'https://vcuqcjtzdjtonvaqolzm.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_JEudB5hgyn38SkUiO6oWhw_9Qrtr36b';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const onApplied = config && config.onApplied;
    // Optional field-level merge: (key, localVal, remoteVal) => mergedVal.
    // Lets a page reconcile a key instead of taking remote wholesale. Absent →
    // pure last-write-wins (unchanged behavior for every other app).
    const mergeRemote = config && config.mergeRemote;
    if (!appKey || !window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null, pushTimer = null, suppressSync = false, lastSyncedJson = null, lastUpdatedAt = null;

    function matches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    function listAllKeys() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matches(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listAllKeys()) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }
    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && matches(k)) schedulePush(); } catch (e) {}
    };
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      suppressSync = true;
      let changed = false;
      let mergedDiverged = false;   // a merge kept MORE than remote → push it back
      try {
        for (const k of Object.keys(remote)) {
          if (!matches(k)) continue;
          let value = remote[k];
          if (typeof mergeRemote === 'function') {
            let localVal = null;
            const raw = localStorage.getItem(k);
            if (raw != null) { try { localVal = JSON.parse(raw); } catch (e) { localVal = null; } }
            try {
              const merged = mergeRemote(k, localVal, remote[k]);
              if (merged !== undefined) {
                value = merged;
                if (JSON.stringify(merged) !== JSON.stringify(remote[k])) mergedDiverged = true;
              }
            } catch (e) {}
          }
          const incoming = JSON.stringify(value);
          const local = localStorage.getItem(k);
          if (local !== incoming) { try { origSet(k, incoming); changed = true; } catch (e) {} }
        }
        for (const k of listAllKeys()) {
          if (!(k in remote)) { try { origRemove(k); changed = true; } catch (e) {} }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') { try { onApplied(); } catch (e) {} }
      // We merged in values the cloud doesn't have yet (lastSyncedJson was set to
      // the bare remote upstream) — push so the other device converges too.
      if (mergedDiverged) schedulePush();
      return changed;
    }
    async function pushNow() {
      if (!supa) return;
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      const stamp = new Date().toISOString();
      try {
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: stamp },
          { onConflict: 'key' }
        );
        // Remember our own timestamp so the fallback poll doesn't treat our push
        // as a remote change and re-download it.
        if (!error) { lastSyncedJson = json; lastUpdatedAt = stamp; }
      } catch (e) {}
    }
    // Pull the full row and apply it if the payload differs from what we have.
    async function pullRemote() {
      if (!supa) return;
      try {
        const { data, error } = await supa.from('app_state').select('data,updated_at').eq('key', appKey).maybeSingle();
        if (error || !data || !data.data) return;
        if (data.updated_at) lastUpdatedAt = data.updated_at;
        const incoming = JSON.stringify(data.data);
        if (incoming === lastSyncedJson) return;
        lastSyncedJson = incoming;
        applyRemote(data.data);
      } catch (e) {}
    }
    // Cheap fallback poll: fetch only `updated_at`; download the heavy `data`
    // (which on the wardrobe page holds base64 images) only when it changed.
    async function pollRemote() {
      if (!supa) return;
      try {
        const { data, error } = await supa.from('app_state').select('updated_at').eq('key', appKey).maybeSingle();
        if (error || !data) return;
        if (lastUpdatedAt && data.updated_at && data.updated_at === lastUpdatedAt) return;
        await pullRemote();
      } catch (e) {}
    }
    window.cloudSyncPull = pullRemote;
    function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 250); }
    // Force an immediate upstream push, bypassing the 250ms debounce. Pages call
    // this right after a critical write (e.g. a fresh wardrobe photo) so the data
    // is durably in Supabase before a quick refresh or a mobile tab backgrounding
    // can wipe the not-yet-synced local value. Concurrent calls coalesce onto the
    // same in-flight push, and pushNow() dedups identical payloads.
    let flushPromise = null;
    window.cloudSyncFlush = function () {
      clearTimeout(pushTimer);
      if (flushPromise) return flushPromise;
      flushPromise = Promise.resolve(pushNow()).finally(() => { flushPromise = null; });
      return flushPromise;
    };
    function flushOnUnload() {
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        lastSyncedJson = json;
      } catch (e) {}
    }
    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const { data, error } = await supa.from('app_state').select('data,updated_at').eq('key', appKey).maybeSingle();
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          lastSyncedJson = JSON.stringify(data.data);
          if (data.updated_at) lastUpdatedAt = data.updated_at;
          applyRemote(data.data);
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {}
      // Fast path: realtime websocket. Can silently drop on mobile network
      // transitions / backgrounded tabs, or never fire if the table isn't in the
      // realtime publication — hence the polling fallback below.
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          if (payload.new.updated_at) lastUpdatedAt = payload.new.updated_at;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
      // Bulletproof fallback: even if the socket is silent, a light 5s poll keeps
      // every device eventually consistent. Also pull on the moments most likely
      // to follow a missed update — tab refocus, regained network, page show.
      setInterval(pollRemote, 5000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRemote(); });
      window.addEventListener('focus', pollRemote);
      window.addEventListener('online', pollRemote);
      window.addEventListener('pageshow', pollRemote);
    })();
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => { if (e.key && matches(e.key)) schedulePush(); });
  };
})();
