// Regression coverage for the full-baseline reconciliation pass in
// proxy/server.js (computeStaleRowIds / isReconciliationEligible /
// listGoogleDelta / pullSync, exposed read-only via app._internal for
// exactly this file).
//
// Full syncs (showDeleted:false, no syncToken) structurally can't receive
// cancellations from Google, so previously-mirrored rows that quietly
// disappear from a fresh Google baseline were never getting soft-deleted —
// see "aptron Brain/07 Development Journal" for the 2026-09-21 investigation
// that found this and shaped these fixtures (Watch Film's cross-midnight
// span, the levantarse/Watch Serie duplicate pairs, etc). The fixture DATES
// below are synthetic (a fixed 2030-01-15 reference day, via a monkey-patched
// Date.now() — see FIXED_NOW_MS) so this file's pass/fail never depends on
// the machine's real current date; only the relative shapes (same day,
// crosses-midnight, weeks-outside-window, etc) are preserved from the real
// investigation.
//
// Two layers of coverage:
//   1. Pure-function tests against computeStaleRowIds/isReconciliationEligible
//      and the real listGoogleDelta pagination loop (fake `cal` only).
//   2. Integration-shaped tests calling the REAL pullSync() end to end, with a
//      fake `cal` AND a monkey-patched global fetch standing in for every
//      Supabase REST call sbFetch() makes underneath it. This is the layer
//      that catches wiring corruption (duplicated returns/destructuring,
//      stale windows, reconciliation firing on the wrong path) that pure
//      unit tests of computeStaleRowIds() alone cannot see, since that
//      function never touches listGoogleDelta/pullSync's plumbing.
//
// No live Google or Supabase call is ever made — both are fully faked.
// Usage: node tools/smoke/calendar-reconciliation-smoke.mjs
import app from '../../proxy/server.js';

const { computeStaleRowIds, isReconciliationEligible, listGoogleDelta, pullSync } = app._internal;

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || !detail ? '' : '  — ' + detail));
  if (!cond) failures++;
}
function sameSet(actual, expectedIds) {
  const a = [...actual].sort();
  const e = [...expectedIds].sort();
  return a.length === e.length && a.every((v, i) => v === e[i]);
}

// Fixed test clock — every fixture below is anchored to this instant instead
// of the machine's real current date, so the full-sync window listGoogleDelta
// computes internally (Date.now() ± FULL_SYNC_WINDOW_DAYS/FUTURE_SYNC_WINDOW_
// DAYS) is deterministic run to run. Restored just before exit.
const FIXED_NOW_MS = Date.parse('2030-01-15T12:00:00.000Z');
const realDateNow = Date.now;
Date.now = () => FIXED_NOW_MS;

// ═════════════════════════════════════════════════════════════════════════
// Layer 1 — pure predicate + real pagination loop
// ═════════════════════════════════════════════════════════════════════════

// Shared fixture window: same day-shaped, timezone-boundary-crossing range
// the real investigation used (Europe/Madrid local day → UTC), just moved to
// the fixed reference date above instead of the real 2026-09-21.
const TIME_MIN = '2030-01-14T22:00:00.000Z';
const TIME_MAX = '2030-01-15T22:00:00.000Z';

const row = (id, google_event_id, starts_at, ends_at, extra) => ({
  id, google_event_id, starts_at, ends_at,
  sync_state: 'synced', deleted_at: null,
  ...(extra || {}),
});

// A — recurring occurrence, in-window, absent from a fresh baseline (shape
//     of the real "levantarse" old-generation row from the investigation).
const A_staleRecurringOld = row('row-A', 'ge-old-levantarse_20300115T043000Z', '2030-01-15T04:30:00Z', '2030-01-15T04:45:00Z');
// B — recurring occurrence, in-window, present in the baseline (the
//     replacement occurrence that IS still live).
const B_currentRecurringNew = row('row-B', 'ge-new-levantarse_20300115T050000Z', '2030-01-15T05:00:00Z', '2030-01-15T05:15:00Z');
// C — Aptron-only local row (never pushed), no google_event_id at all.
const C_localOnly = row('row-C', null, '2030-01-15T15:00:00Z', '2030-01-15T15:30:00Z', { sync_state: 'local' });
// C2 — pending-local: HAS a leftover google_event_id from a previous sync,
//      but is currently mid-edit (sync_state='local'), pending a push. Must
//      stay untouched even though its old id isn't in confirmedIds.
const C2_pendingLocal = row('row-C2', 'ge-leftover-from-prior-sync', '2030-01-15T16:00:00Z', '2030-01-15T16:30:00Z', { sync_state: 'local' });
// D — already soft-deleted; absent from baseline too (idempotency check).
const D_alreadyDeleted = row('row-D', 'ge-old-deleted', '2030-01-15T09:00:00Z', '2030-01-15T09:30:00Z', { deleted_at: '2029-12-20T00:00:00.000Z' });
// E — real event, but weeks outside the queried window entirely.
const E_outOfWindow = row('row-E', 'ge-outside', '2029-12-01T00:00:00Z', '2029-12-01T01:00:00Z');
// F — Watch-Film-shaped: starts BEFORE timeMin, ends just after it. Present
//     in the baseline (exactly what the live probe actually returned for the
//     real Watch Film event).
const F_crossBoundaryPresent = row('row-F', 'ge-watchfilm_20300114T200000Z', '2030-01-14T20:00:00Z', '2030-01-14T22:30:00Z');
// G — same cross-midnight shape as F, but this one Google no longer returns —
//     proves crossing a boundary doesn't exempt a row from cleanup.
const G_crossBoundaryStale = row('row-G', 'ge-crossboundary-ghost', '2030-01-14T20:00:00Z', '2030-01-14T22:30:00Z');
// H — entirely before the window AND ends before it too (no overlap at all,
//     the "not even touching the boundary" negative control for F/G).
const H_crossBoundaryNoOverlap = row('row-H', 'ge-no-overlap', '2030-01-14T10:00:00Z', '2030-01-14T18:00:00Z');
// I/J — same title ("Watch Serie"-shaped), two distinct stale google_event_ids.
const I_sameTitleStaleA = row('row-I', 'ge-watchserie-a_20300115T123000Z', '2030-01-15T12:30:00Z', '2030-01-15T13:00:00Z');
const J_sameTitleStaleB = row('row-J', 'ge-watchserie-b_20300115T123000Z', '2030-01-15T12:30:00Z', '2030-01-15T13:00:00Z');
// K — same title, different time slot, still live.
const K_sameTitleCurrent = row('row-K', 'ge-watchserie-current_20300115T203000Z', '2030-01-15T20:30:00Z', '2030-01-15T21:00:00Z');

const CONFIRMED = new Set([B_currentRecurringNew.google_event_id, F_crossBoundaryPresent.google_event_id, K_sameTitleCurrent.google_event_id]);

check('1/10: stale recurring-old row (levantarse) → flagged',
  sameSet(computeStaleRowIds([A_staleRecurringOld], TIME_MIN, TIME_MAX, CONFIRMED), ['row-A']));
check('2/11: current recurring row (levantarse) → preserved',
  sameSet(computeStaleRowIds([B_currentRecurringNew], TIME_MIN, TIME_MAX, CONFIRMED), []));
check('3: local-only row (no google_event_id) → preserved',
  sameSet(computeStaleRowIds([C_localOnly], TIME_MIN, TIME_MAX, CONFIRMED), []));
check('3b: pending-local row (has a leftover google_event_id) → preserved',
  sameSet(computeStaleRowIds([C2_pendingLocal], TIME_MIN, TIME_MAX, CONFIRMED), []));
check('4: already-deleted row → untouched (idempotent)',
  sameSet(computeStaleRowIds([D_alreadyDeleted], TIME_MIN, TIME_MAX, CONFIRMED), []));
check('5: out-of-window row → untouched even though absent from baseline',
  sameSet(computeStaleRowIds([E_outOfWindow], TIME_MIN, TIME_MAX, CONFIRMED), []));
check('6: Watch-Film-shaped row (crosses boundary, present in baseline) → preserved',
  sameSet(computeStaleRowIds([F_crossBoundaryPresent], TIME_MIN, TIME_MAX, CONFIRMED), []));
check('6b: cross-boundary row absent from baseline → flagged (boundary-crossing ≠ exempt)',
  sameSet(computeStaleRowIds([G_crossBoundaryStale], TIME_MIN, TIME_MAX, CONFIRMED), ['row-G']));
check('6c: no-overlap row absent from baseline → still untouched (never claimed by this window)',
  sameSet(computeStaleRowIds([H_crossBoundaryNoOverlap], TIME_MIN, TIME_MAX, CONFIRMED), []));
check('12/16: multiple stale rows (same title, different ids) → all independently flagged',
  sameSet(computeStaleRowIds([I_sameTitleStaleA, J_sameTitleStaleB], TIME_MIN, TIME_MAX, CONFIRMED), ['row-I', 'row-J']));
check('17: current confirmed occurrence + stale occurrence from the same title/series in one call',
  sameSet(computeStaleRowIds([I_sameTitleStaleA, K_sameTitleCurrent], TIME_MIN, TIME_MAX, CONFIRMED), ['row-I']));
check('9: empty valid baseline → all in-window synced rows flagged (no arbitrary threshold)',
  sameSet(computeStaleRowIds([A_staleRecurringOld, B_currentRecurringNew], TIME_MIN, TIME_MAX, new Set()), ['row-A', 'row-B']));
check('zero stale rows: everything confirmed/local/deleted → empty result',
  sameSet(computeStaleRowIds([B_currentRecurringNew, C_localOnly, D_alreadyDeleted], TIME_MIN, TIME_MAX, CONFIRMED), []));
{
  const mixed = [A_staleRecurringOld, B_currentRecurringNew, C_localOnly, C2_pendingLocal, D_alreadyDeleted,
    E_outOfWindow, F_crossBoundaryPresent, G_crossBoundaryStale, H_crossBoundaryNoOverlap,
    I_sameTitleStaleA, J_sameTitleStaleB, K_sameTitleCurrent];
  check('14: mixed production-like dataset → exactly the expected subset flagged',
    sameSet(computeStaleRowIds(mixed, TIME_MIN, TIME_MAX, CONFIRMED), ['row-A', 'row-G', 'row-I', 'row-J']));
}

check('13: delta (full=false) → not eligible even with a token', isReconciliationEligible(false, 'tok') === false);
check('13b: full baseline without a token → not eligible (incomplete signal)', isReconciliationEligible(true, null) === false);
check('13c: full baseline WITH a token → eligible', isReconciliationEligible(true, 'tok') === true);

function fakeCal(pages) {
  let i = 0;
  return { events: { list: async () => {
    const page = pages[i++];
    if (page instanceof Error) throw page;
    return { data: page };
  } } };
}
{
  const cal = fakeCal([
    { items: [{ id: 'ev-1' }, { id: 'ev-2' }], nextPageToken: 'p2' },
    { items: [{ id: 'ev-3' }], nextPageToken: null, nextSyncToken: 'sync-final' },
  ]);
  const { items, nextSyncToken, windowTimeMin, windowTimeMax } = await listGoogleDelta(cal, null, true);
  check('7: multi-page baseline accumulates all pages', items.length === 3, 'got ' + items.length);
  check('7: nextSyncToken only reflects the final page', nextSyncToken === 'sync-final', nextSyncToken);
  check('7: baseline window is reported back for a full pull', !!windowTimeMin && !!windowTimeMax);
  check('7: baseline window is derived from the fixed test clock',
    windowTimeMin === new Date(FIXED_NOW_MS - 30 * 864e5).toISOString(), windowTimeMin);
}
{
  const cal = fakeCal([
    { items: [{ id: 'ev-1' }], nextPageToken: 'p2' },
    new Error('simulated network failure on page 2'),
  ]);
  let threw = false;
  try { await listGoogleDelta(cal, null, true); }
  catch (e) { threw = /simulated network failure/.test(e.message); }
  check('8: pagination failure rejects (no partial result reaches reconciliation)', threw);
}
{
  const cal = fakeCal([{ items: [], nextPageToken: null, nextSyncToken: 'delta-tok' }]);
  const { windowTimeMin, windowTimeMax } = await listGoogleDelta(cal, 'existing-tok', false);
  check('delta pull never reports a baseline window', windowTimeMin === null && windowTimeMax === null);
}

// ═════════════════════════════════════════════════════════════════════════
// Layer 2 — integration-shaped: the REAL pullSync(), fake cal + faked fetch
// ═════════════════════════════════════════════════════════════════════════
// Monkey-patches global fetch (the one boundary sbFetch() actually calls) so
// every Supabase REST call pullSync triggers underneath is intercepted here,
// while pullSync/listGoogleDelta/applyItemsToSupabase/reconcileFullBaseline
// all run as the REAL, unmodified production code. This is what catches
// wiring corruption pure-function tests can't: whether the window values
// listGoogleDelta returns actually reach reconcileFullBaseline, whether
// reconciliation fires exactly once (not zero, not twice), and whether it's
// correctly skipped for delta / after a pagination failure.
//
// This harness treats the PATCH as unconditionally successful against
// whatever ids were requested — adequate for the tests that only care about
// wiring (counts, exactly-once, window propagation), but NOT a faithful model
// of PostgREST's conditional matching. The dedicated race test below (which
// specifically needs that fidelity) uses its own small mock instead of this
// one — see the comment there for why.
function withFakeFetch(candidateRows, run, opts) {
  const uid = (opts && opts.uid) || 'uid-1';
  const calls = { candidateGet: 0, reconcilePatch: 0, upsertPost: 0, cancelPatch: 0, connectionPatch: 0, patchedIds: null, reconcilePatchUrl: null, reconcilePatchBody: null };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, fetchOpts) => {
    const method = (fetchOpts && fetchOpts.method) || 'GET';
    const u = String(url);
    if (u.includes('/calendar_connections')) {
      calls.connectionPatch++;
      return { ok: true, status: 200, json: async () => [{}] };
    }
    if (u.includes('/events') && method === 'GET') {
      calls.candidateGet++;
      return { ok: true, status: 200, json: async () => candidateRows };
    }
    if (u.includes('/events') && method === 'POST') {
      calls.upsertPost++;
      return { ok: true, status: 200, json: async () => [] };
    }
    if (u.includes('/events') && method === 'PATCH' && u.includes('id=in.(')) {
      calls.reconcilePatch++;
      calls.reconcilePatchUrl = u;
      calls.reconcilePatchBody = JSON.parse(fetchOpts.body);
      const m = u.match(/id=in\.\(([^)]*)\)/);
      calls.patchedIds = m ? decodeURIComponent(m[1]).split(',') : [];
      return { ok: true, status: 200, json: async () => calls.patchedIds.map((id) => ({ id })) };
    }
    if (u.includes('/events') && method === 'PATCH') {
      calls.cancelPatch++;
      return { ok: true, status: 200, json: async () => [] };
    }
    throw new Error('unexpected fetch in test: ' + method + ' ' + u);
  };
  return run(calls).finally(() => { globalThis.fetch = realFetch; });
}

// 9(int)/multiple-stale/window-flows-through — full baseline, one stale row
// absent from Google, one current row present. Proves the exact window
// listGoogleDelta computed is what reconcileFullBaseline actually queries
// against (the candidate rows here use the SAME shape as the pure-layer
// fixtures), and that reconciliation runs exactly once.
await withFakeFetch(
  [A_staleRecurringOld, B_currentRecurringNew],
  async (calls) => {
    const cal = fakeCal([{
      items: [{ id: B_currentRecurringNew.google_event_id, status: 'confirmed', summary: 'levantarse', start: {}, end: {} }],
      nextPageToken: null, nextSyncToken: 'fresh-token-1',
    }]);
    const result = await pullSync('uid-1', { sync_token: null }, cal);
    check('int: full sync with no prior token reports full=true', result.full === true);
    check('int: reconciliation runs exactly once (candidate GET)', calls.candidateGet === 1, calls.candidateGet);
    check('int: reconciliation writes exactly once', calls.reconcilePatch === 1, calls.reconcilePatch);
    check('int: window flowed through — only the stale row (row-A) was patched',
      calls.patchedIds && calls.patchedIds.length === 1 && calls.patchedIds[0] === 'row-A',
      JSON.stringify(calls.patchedIds));
    check('int: reported reconciled count matches', result.reconciled === 1, result.reconciled);
    // Ownership/state predicates on the write, not just id — see the
    // dedicated race test below for whether they actually PROTECT a row,
    // which this assertion alone cannot show.
    check('int: PATCH URL is scoped to the same uid', calls.reconcilePatchUrl.includes('user_id=eq.uid-1'), calls.reconcilePatchUrl);
    check('int: PATCH URL is conditional on sync_state=synced', calls.reconcilePatchUrl.includes('sync_state=eq.synced'), calls.reconcilePatchUrl);
    check('int: PATCH URL is conditional on deleted_at IS NULL', calls.reconcilePatchUrl.includes('deleted_at=is.null'), calls.reconcilePatchUrl);
    check('int: PATCH body only ever touches deleted_at/sync_state/updated_at',
      sameSet(Object.keys(calls.reconcilePatchBody), ['deleted_at', 'sync_state', 'updated_at']),
      JSON.stringify(calls.reconcilePatchBody));
  }
);

// race(int) — models actual PostgREST conditional-UPDATE semantics with a
// small mutable "table" (a Map keyed by row id) that both the GET and the
// PATCH read the CURRENT state of. Unlike withFakeFetch (which just echoes
// back whatever ids were requested), the PATCH handler here evaluates its own
// URL predicates — id IN (...), user_id=eq, sync_state=eq.synced,
// deleted_at=is.null — against each row's live state in the table at match
// time, and only mutates + returns rows that actually satisfy all of them.
// The race is modeled by flipping row-raced's sync_state to 'local' in the
// table right after the GET is served (i.e. "between" the GET and the PATCH
// from production code's point of view — the mutation happens inside this
// mock's own GET handler, which runs to completion, including that flip,
// before reconcileFullBaseline's subsequent `await` for the PATCH is even
// issued).
{
  const uid = 'uid-raced';
  const table = new Map([
    ['row-A', { ...A_staleRecurringOld, user_id: uid }],
    ['row-raced', { ...I_sameTitleStaleA, id: 'row-raced', user_id: uid }],
  ]);
  const calls = { candidateGet: 0, reconcilePatch: 0, connectionPatch: 0, requestedIds: null, matchedIds: null };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, fetchOpts) => {
    const method = (fetchOpts && fetchOpts.method) || 'GET';
    const u = String(url);
    if (u.includes('/calendar_connections')) {
      calls.connectionPatch++;
      return { ok: true, status: 200, json: async () => [{}] };
    }
    if (u.includes('/events') && method === 'GET') {
      calls.candidateGet++;
      // 1. Candidate GET returns the two currently-eligible rows. Cloned, not
      //    referenced — a real HTTP response is a snapshot in time; mutating
      //    the table afterward must not retroactively change what was
      //    already returned (that reference-aliasing bug was caught by this
      //    very test failing when first written: row-raced was being
      //    silently excluded from staleIds before the PATCH stage was ever
      //    reached, because the snapshot pointed at the live, later-mutated
      //    row object instead of a copy of it at GET-time).
      const snapshot = [...table.values()]
        .filter((r) => r.user_id === uid && r.sync_state === 'synced' && r.google_event_id != null && !r.deleted_at)
        .map((r) => ({ ...r }));
      // 2. Simulate a concurrent local edit landing on row-raced right after
      //    this read — production code has no way to see this happen.
      table.get('row-raced').sync_state = 'local';
      return { ok: true, status: 200, json: async () => snapshot };
    }
    if (u.includes('/events') && method === 'PATCH' && u.includes('id=in.(')) {
      calls.reconcilePatch++;
      const m = u.match(/id=in\.\(([^)]*)\)/);
      const requestedIds = m ? decodeURIComponent(m[1]).split(',') : [];
      calls.requestedIds = requestedIds;
      // 3/4. Evaluate this PATCH's own URL predicates against each row's
      //      CURRENT state, exactly as PostgREST would, and only apply the
      //      write to rows that still satisfy every one of them.
      const hasUidFilter = u.includes('user_id=eq.' + uid);
      const hasStateFilter = u.includes('sync_state=eq.synced');
      const hasDeletedFilter = u.includes('deleted_at=is.null');
      const body = JSON.parse(fetchOpts.body);
      const matched = [];
      for (const id of requestedIds) {
        const current = table.get(id);
        if (!current) continue;
        const rowSatisfiesPredicates = hasUidFilter && hasStateFilter && hasDeletedFilter &&
          current.user_id === uid && current.sync_state === 'synced' && !current.deleted_at;
        if (rowSatisfiesPredicates) {
          Object.assign(current, body);   // the write actually applies
          matched.push({ id });
        }
      }
      calls.matchedIds = matched.map((m2) => m2.id);
      // 5. Return only the rows actually matched, as return=representation would.
      return { ok: true, status: 200, json: async () => matched };
    }
    throw new Error('unexpected fetch in race test: ' + method + ' ' + u);
  };
  try {
    const cal = fakeCal([{ items: [], nextPageToken: null, nextSyncToken: 'race-token' }]);
    const result = await pullSync(uid, { sync_token: null }, cal);
    // 6. Assertions.
    check('race: both ids were requested in the PATCH', sameSet(calls.requestedIds, ['row-A', 'row-raced']), JSON.stringify(calls.requestedIds));
    check('race: only the still-eligible row was actually mutated', sameSet(calls.matchedIds, ['row-A']), JSON.stringify(calls.matchedIds));
    check('race: the raced row retained its changed state and was NOT tombstoned',
      table.get('row-raced').sync_state === 'local' && !table.get('row-raced').deleted_at,
      JSON.stringify(table.get('row-raced')));
    check('race: row-A (the genuinely stale, unraced row) WAS tombstoned', !!table.get('row-A').deleted_at);
    check('race: reconciled count is 1, not 2', result.reconciled === 1, result.reconciled);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 13(int) — delta sync (existing sync_token) must never call reconciliation.
await withFakeFetch(
  [A_staleRecurringOld, B_currentRecurringNew],
  async (calls) => {
    const cal = fakeCal([{
      items: [{ id: 'some-changed-event', status: 'confirmed', summary: 'x', start: {}, end: {} }],
      nextPageToken: null, nextSyncToken: 'delta-token-2',
    }]);
    const result = await pullSync('uid-1', { sync_token: 'existing-token' }, cal);
    check('int: delta sync reports full=false', result.full === false);
    check('int: delta sync never reads reconciliation candidates', calls.candidateGet === 0, calls.candidateGet);
    check('int: delta sync never writes a reconciliation patch', calls.reconcilePatch === 0, calls.reconcilePatch);
    check('int: delta sync reports reconciled=0', result.reconciled === 0, result.reconciled);
  }
);

// 8(int) — pagination failure (non-410) on the normal path must reject
// pullSync itself and never reach reconciliation.
await withFakeFetch(
  [A_staleRecurringOld],
  async (calls) => {
    const cal = fakeCal([
      { items: [{ id: 'ev-1', status: 'confirmed', summary: 'x', start: {}, end: {} }], nextPageToken: 'p2' },
      new Error('simulated mid-pagination failure'),
    ]);
    let threw = false;
    try { await pullSync('uid-1', { sync_token: null }, cal); }
    catch (e) { threw = /simulated mid-pagination failure/.test(e.message); }
    check('int: pullSync rejects on a non-410 pagination failure', threw);
    check('int: no reconciliation candidate read after a pagination failure', calls.candidateGet === 0, calls.candidateGet);
    check('int: no reconciliation write after a pagination failure', calls.reconcilePatch === 0, calls.reconcilePatch);
  }
);

// 410(int) — syncToken gone → pullSync retries with a FRESH full baseline,
// and reconciliation uses that fresh retry's window/results, not the failed
// first attempt's (which never produced any window at all).
await withFakeFetch(
  [A_staleRecurringOld, B_currentRecurringNew],
  async (calls) => {
    let call = 0;
    const cal = {
      events: {
        list: async () => {
          call++;
          if (call === 1) { const err = new Error('token gone'); err.code = 410; throw err; }
          return { data: { items: [{ id: B_currentRecurringNew.google_event_id, status: 'confirmed', summary: 'x', start: {}, end: {} }], nextPageToken: null, nextSyncToken: 'post-410-token' } };
        },
      },
    };
    const result = await pullSync('uid-1', { sync_token: 'stale-token' }, cal);
    check('int: 410 path resyncs and reports full=true', result.full === true);
    check('int: 410 path\'s retry reconciles using the fresh window (row-A flagged)',
      calls.reconcilePatch === 1 && calls.patchedIds && calls.patchedIds[0] === 'row-A',
      JSON.stringify(calls.patchedIds));
  }
);

// zero-stale(int) — full baseline, candidates all still confirmed → the
// candidate read still happens (evidence-based completeness check), but no
// PATCH is sent since there's nothing to reconcile.
await withFakeFetch(
  [B_currentRecurringNew],
  async (calls) => {
    const cal = fakeCal([{
      items: [{ id: B_currentRecurringNew.google_event_id, status: 'confirmed', summary: 'x', start: {}, end: {} }],
      nextPageToken: null, nextSyncToken: 'tok-3',
    }]);
    const result = await pullSync('uid-1', { sync_token: null }, cal);
    check('int: zero-stale full sync still reads candidates', calls.candidateGet === 1);
    check('int: zero-stale full sync sends no patch', calls.reconcilePatch === 0, calls.reconcilePatch);
    check('int: zero-stale reports reconciled=0', result.reconciled === 0, result.reconciled);
  }
);

Date.now = realDateNow;
console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
