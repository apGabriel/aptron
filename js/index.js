// =============================================================================
// Calendar-first AI dashboard.
//   • The Google Calendar (via the proxy) is the single source of truth for the
//     day's blocks. The engine below is refactored to expose a small window.AptCal
//     API so the assistant can read + mutate the schedule.
//   • The Assistant is HYBRID: a synchronous local intent parser handles the
//     common tactical commands instantly/offline (and is fully previewable);
//     anything it can't match is forwarded to the Gemini proxy route
//     (/api/gemini/assistant) for free-form understanding when deployed.
//   • A tiny synced Quick-Notes inbox replaces the old to-do lists.
// No framework, no build step.
// =============================================================================
'use strict';

// ── Shared date helpers ──────────────────────────────────────────────────────
function padZ(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + padZ(d.getMonth() + 1) + '-' + padZ(d.getDate());
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// =============================================================================
// DAY HEADER — greeting + slim awake-day progress (ambient, replaces the ring).
// =============================================================================
(function () {
  const WAKE = 6.5, SLEEP = 24;
  const hello = document.getElementById('aiosHello');
  const dateEl = document.getElementById('aiosDate');
  const fill = document.getElementById('aiosDayFill');
  const label = document.getElementById('aiosDayLabel');
  if (!hello) return;

  function fmtDateLabel() {
    const d = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
  }
  function greeting(h) {
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }
  function update() {
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    hello.textContent = greeting(now.getHours());
    dateEl.textContent = fmtDateLabel();
    let pct, txt;
    if (h < WAKE) { pct = 0; txt = 'before wake-up'; }
    else if (h >= SLEEP) { pct = 100; txt = 'past bedtime'; }
    else {
      pct = (h - WAKE) / (SLEEP - WAKE) * 100;
      const left = SLEEP - h;
      txt = Math.floor(left) + 'h ' + Math.round((left % 1) * 60) + 'm awake left';
    }
    fill.style.width = pct.toFixed(1) + '%';
    label.textContent = Math.round(pct) + '% of day · ' + txt;
  }
  update();
  setInterval(update, 60 * 1000);
  // Greeting word can change as the day rolls; expose the current one for the bot.
  window.__aiosGreeting = () => greeting(new Date().getHours());
})();

// =============================================================================
// QUICK NOTES — minimalist synced inbox (key 'quicknotes_v1', in syncedPrefixes).
// =============================================================================
window.QuickNotes = (function () {
  const KEY = 'quicknotes_v1';
  const listEl = document.getElementById('notesList');
  const countEl = document.getElementById('notesCount');
  const form = document.getElementById('notesForm');
  const input = document.getElementById('notesInput');

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function persist(arr) {
    localStorage.setItem(KEY, JSON.stringify(arr));
    if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    render();
  }
  function add(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const arr = load(); arr.unshift({ text: t, ts: Date.now() }); persist(arr);
    return true;
  }
  function del(ts) { persist(load().filter(n => n.ts !== ts)); }

  function render() {
    if (!listEl) return;
    const arr = load();
    if (countEl) countEl.textContent = arr.length ? arr.length + (arr.length === 1 ? ' note' : ' notes') : '';
    listEl.innerHTML = arr.map(n =>
      '<li class="aios-note" data-ts="' + n.ts + '">'
      + '<span class="aios-note-dot"></span>'
      + '<span class="aios-note-text">' + esc(n.text) + '</span>'
      + '<button class="aios-note-del" data-del="' + n.ts + '" aria-label="Delete note" title="Delete">×</button>'
      + '</li>').join('');
  }

  if (form) {
    form.addEventListener('submit', e => { e.preventDefault(); if (add(input.value)) input.value = ''; });
  }
  if (listEl) {
    listEl.addEventListener('click', e => {
      const b = e.target.closest('[data-del]');
      if (b) del(Number(b.dataset.del));
    });
  }
  window.addEventListener('notes-changed', render);
  window.addEventListener('storage', render);
  render();
  return { add, render };
})();

// =============================================================================
// GOOGLE CALENDAR ENGINE — fetch/render/inline-edit, plus a window.AptCal API so
// the assistant can read + mutate the schedule with the same code paths.
// =============================================================================
(function () {
  const PROXY = '';
  let currentEvents = [];

  // ── multi-day state ──────────────────────────────────────────────────────
  //   selectedDate — the day the schedule list + completion state reflect.
  //   viewY/viewM   — the month the grid is showing (may differ from selected).
  //   eventsByDate  — keyed cache "YYYY-MM-DD" → [events]; Google Calendar stays
  //                   the source of truth, this just lets the grid show dots and
  //                   switch days instantly. One range fetch fills a whole month.
  let selectedDate = todayStr();
  const now0 = new Date();
  let viewY = now0.getFullYear(), viewM = now0.getMonth();
  const eventsByDate = Object.create(null);

  function ymd(y, m, d) { return y + '-' + padZ(m + 1) + '-' + padZ(d); }
  function partsOf(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return { y, m: m - 1, d }; }
  function dateObj(dateStr) { const p = partsOf(dateStr); return new Date(p.y, p.m, p.d); }
  // A local Date on the selected day at h:m — so the assistant/create paths
  // schedule onto whatever day is in view, not always today.
  function dtOnSelected(h, m) { const p = partsOf(selectedDate); return new Date(p.y, p.m, p.d, h, m, 0, 0); }
  // The local calendar day an event belongs to (handles all-day + timed).
  function eventDateKey(ev) {
    const s = ev.start || '';
    if (ev.allDay) return s.slice(0, 10);
    const d = new Date(s);
    return ymd(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // ── formatting ──────────────────────────────────────────────────────────
  function fmtRange(startIso, endIso) {
    const s = new Date(startIso), e = new Date(endIso);
    function fmt(d, showAmpm) {
      let h = d.getHours() % 12 || 12;
      const m = d.getMinutes();
      return h + (m ? ':' + padZ(m) : '') + (showAmpm ? ' ' + (d.getHours() >= 12 ? 'PM' : 'AM') : '');
    }
    const sAmpm = s.getHours() >= 12 ? 'PM' : 'AM';
    const eAmpm = e.getHours() >= 12 ? 'PM' : 'AM';
    return fmt(s, sAmpm !== eAmpm) + ' – ' + fmt(e, true);
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    let h = d.getHours() % 12 || 12;
    const m = d.getMinutes();
    return h + (m ? ':' + padZ(m) : '') + ' ' + (d.getHours() >= 12 ? 'PM' : 'AM');
  }
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDateLabel(d) {
    d = d || new Date();
    return DAY_NAMES[d.getDay()] + ', ' + MONTH_ABBR[d.getMonth()] + ' ' + d.getDate();
  }
  function eventClass(ev) {
    if (ev.allDay) return '';
    const now = new Date(), start = new Date(ev.start), end = new Date(ev.end);
    if (end < now) return 'is-past';
    if (start <= now) return 'is-now';
    return '';
  }
  function toLocalISO(dt) {
    const p = n => String(n).padStart(2, '0');
    const off = -dt.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) +
      'T' + p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':00' +
      sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60);
  }

  // ── completion state (Google Calendar has no "done" flag) ─────────────────
  function doneKey() { return 'cal_done:' + selectedDate; }
  function manualKey() { return 'cal_manual:' + selectedDate; }
  function getDoneSet() {
    try { return new Set(JSON.parse(localStorage.getItem(doneKey())) || []); } catch (e) { return new Set(); }
  }
  function setDone(id, done) {
    const s = getDoneSet(); if (done) s.add(id); else s.delete(id);
    localStorage.setItem(doneKey(), JSON.stringify([...s]));
  }
  function getManualMap() {
    try { return JSON.parse(localStorage.getItem(manualKey())) || {}; } catch (e) { return {}; }
  }
  function setManual(id, done) {
    const m = getManualMap(); m[id] = !!done;
    localStorage.setItem(manualKey(), JSON.stringify(m));
  }
  function autoCheckPastEvents(events) {
    const now = new Date(), manual = getManualMap(), s = getDoneSet();
    let changed = false;
    events.forEach(ev => {
      if (ev.allDay || !ev.end) return;
      if (Object.prototype.hasOwnProperty.call(manual, ev.id)) return;
      if (new Date(ev.end) < now && !s.has(ev.id)) { s.add(ev.id); changed = true; }
    });
    if (changed) localStorage.setItem(doneKey(), JSON.stringify([...s]));
  }
  function applyDoneStateToDOM() {
    try {
      const doneSet = getDoneSet();
      document.querySelectorAll('#calEventList .cal-event-item').forEach(li => {
        const done = doneSet.has(li.dataset.id);
        const cb = li.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = done;
        li.classList.toggle('is-done', done);
      });
    } catch (e) {}
    updateCount();
  }

  // ── status helpers ────────────────────────────────────────────────────────
  function showCalStatus(msg, isError) {
    const el = document.getElementById('calStatus');
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    setTimeout(() => { el.textContent = ''; el.classList.remove('is-error'); }, 4000);
  }
  function flashSaved(el) {
    if (!el) return;
    el.classList.add('cal-saved-flash');
    setTimeout(() => el.classList.remove('cal-saved-flash'), 600);
  }

  // ── PATCH through the proxy, optimistic ──────────────────────────────────
  async function patchEvent(ev, body, el) {
    if (el) el.classList.add('cal-saving');
    try {
      const res = await fetch(PROXY + '/api/events/' + encodeURIComponent(ev.id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      Object.assign(ev, await res.json());
      flashSaved(el);
    } catch {
      showCalStatus('Update failed — is the proxy running?', true);
      loadEvents();
    } finally {
      if (el) el.classList.remove('cal-saving');
    }
  }

  // Sentence case for display only (stored title is left untouched so edits see
  // the real value): first letter upper, the rest lower.
  function formatEventTitle(title) {
    if (!title) return '';
    const trimmed = title.trim();
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  }

  // ── inline text edit (title / notes) ──────────────────────────────────────
  function restoreField(el, ev, field) {
    if (field === 'notes') el.textContent = ev.notes ? ev.notes.split('\n')[0] : '';
    else el.textContent = formatEventTitle(ev.title);
  }
  function makeFieldEdit(el, ev, field) {
    el.classList.add('cal-editable');
    el.addEventListener('click', () => {
      if (el.querySelector('input')) return;
      const current = (field === 'notes' ? ev.notes : ev.title) || '';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'cal-edit-input'; input.value = current;
      el.textContent = ''; el.appendChild(input); input.focus(); input.select();
      let done = false;
      const commit = (save) => {
        if (done) return; done = true;
        const val = input.value.trim();
        if (save && val !== current.trim()) {
          ev[field] = val; restoreField(el, ev, field);
          patchEvent(ev, field === 'title' ? { title: val } : { notes: val }, el);
        } else { restoreField(el, ev, field); }
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      input.addEventListener('blur', () => commit(true));
    });
  }

  // ── inline duration edit ──────────────────────────────────────────────────
  function isoWithTime(originalIso, hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(originalIso); d.setHours(h, m, 0, 0);
    return toLocalISO(d);
  }
  function timeInput(d) {
    const i = document.createElement('input');
    i.type = 'time'; i.className = 'cal-edit-time';
    i.value = padZ(d.getHours()) + ':' + padZ(d.getMinutes());
    return i;
  }
  function microBtn(label, cls) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cal-mini-btn ' + cls; b.textContent = label;
    return b;
  }
  function makeDurationEdit(el, ev, li) {
    el.classList.add('cal-editable');
    el.addEventListener('click', () => {
      if (li.classList.contains('is-editing')) return;
      li.classList.add('is-editing');
      const startIn = timeInput(new Date(ev.start));
      const endIn = timeInput(new Date(ev.end));
      const wrap = document.createElement('span');
      wrap.className = 'cal-dur-edit';
      wrap.append(startIn, document.createTextNode('–'), endIn);
      el.textContent = ''; el.appendChild(wrap);
      const ok = microBtn('✓', 'cal-mini-save');
      const cancel = microBtn('×', 'cal-mini-cancel');
      const actions = document.createElement('span');
      actions.className = 'cal-row-actions';
      actions.append(ok, cancel); li.appendChild(actions);
      startIn.focus();
      const cleanup = () => {
        li.classList.remove('is-editing');
        if (actions.parentNode) actions.parentNode.removeChild(actions);
      };
      const close = () => { cleanup(); el.textContent = fmtRange(ev.start, ev.end); };
      ok.addEventListener('click', e => {
        e.stopPropagation();
        ev.start = isoWithTime(ev.start, startIn.value);
        ev.end = isoWithTime(ev.end, endIn.value);
        cleanup(); sortEvents(); renderEvents(currentEvents);
        patchEvent(ev, { startTime: ev.start, endTime: ev.end }, null);
      });
      cancel.addEventListener('click', e => { e.stopPropagation(); close(); });
      wrap.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
        if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
    });
  }

  // ── build one interactive event row ───────────────────────────────────────
  function buildEventRow(ev) {
    const isDone = getDoneSet().has(ev.id);
    const li = document.createElement('li');
    li.className = 'cal-event-item ' + eventClass(ev) + (isDone ? ' is-done' : '');
    li.dataset.id = ev.id;

    const dur = document.createElement('div');
    dur.className = 'cal-event-time';
    dur.textContent = ev.allDay ? 'all day' : fmtRange(ev.start, ev.end);
    if (!ev.allDay) makeDurationEdit(dur, ev, li);
    li.appendChild(dur);

    const title = document.createElement('div');
    title.className = 'cal-event-title'; title.textContent = formatEventTitle(ev.title);
    makeFieldEdit(title, ev, 'title'); li.appendChild(title);

    const notes = document.createElement('div');
    notes.className = 'cal-event-notes';
    notes.dataset.placeholder = 'Add note…';
    notes.textContent = ev.notes ? ev.notes.split('\n')[0] : '';
    makeFieldEdit(notes, ev, 'notes'); li.appendChild(notes);

    const cbWrap = document.createElement('label');
    cbWrap.className = 'cal-event-check'; cbWrap.title = 'Mark complete';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = isDone;
    const cbCustom = document.createElement('span');
    cbCustom.className = 'cal-check-custom';
    cb.addEventListener('change', () => {
      setManual(ev.id, cb.checked); setDone(ev.id, cb.checked);
      li.classList.toggle('is-done', cb.checked);
      updateCount();
      if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    });
    cbWrap.appendChild(cb); cbWrap.appendChild(cbCustom); li.appendChild(cbWrap);
    return li;
  }

  function updateCount() {
    const count = document.getElementById('calEventCount');
    const total = currentEvents.length;
    if (!total) { count.textContent = 'Nothing scheduled'; return; }
    const doneSet = getDoneSet();
    const doneCount = currentEvents.filter(ev => doneSet.has(ev.id)).length;
    count.textContent = doneCount + '/' + total + ' done';
  }
  function sortEvents() { currentEvents.sort((a, b) => new Date(a.start) - new Date(b.start)); }

  function renderEvents(events) {
    currentEvents = events;
    autoCheckPastEvents(events);
    const list = document.getElementById('calEventList');
    list.innerHTML = '';
    if (!events.length) {
      const when = selectedDate === todayStr() ? 'today' : 'this day';
      list.innerHTML = '<li class="cal-empty">No blocks scheduled ' + when + '</li>';
      updateCount();
    } else {
      events.forEach(ev => list.appendChild(buildEventRow(ev)));
      updateCount();
    }
    window.dispatchEvent(new CustomEvent('apt:calendar-loaded'));
  }

  // Refresh the schedule list for whichever day is selected. Caches the result
  // in eventsByDate and re-syncs that day's dot on the grid.
  async function loadEvents() {
    const offlineEl = document.getElementById('calOfflineMsg');
    const countEl = document.getElementById('calEventCount');
    const refreshBtn = document.getElementById('calRefreshBtn');
    refreshBtn.classList.add('spinning');
    setTimeout(() => refreshBtn.classList.remove('spinning'), 700);
    try {
      const res = await fetch(PROXY + '/api/events?date=' + selectedDate, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        let authExpired = false;
        try { const body = await res.json(); authExpired = /invalid_grant/i.test((body && body.error) || ''); } catch (e) {}
        throw Object.assign(new Error('HTTP ' + res.status), { authExpired });
      }
      offlineEl.style.display = 'none';
      const events = await res.json();
      eventsByDate[selectedDate] = events;
      renderEvents(events);
      markGridDot(selectedDate, events.length > 0);
    } catch (err) {
      offlineEl.style.display = 'block';
      if (err && err.authExpired) {
        offlineEl.innerHTML = '⚠ Google session expired — <strong>re-authenticate</strong>';
        countEl.textContent = 'session expired';
      } else {
        offlineEl.innerHTML = '⚠ Proxy offline — run <code>npm start</code> in the proxy folder to show events.';
        countEl.textContent = 'proxy offline';
      }
      document.getElementById('calEventList').innerHTML = '';
      currentEvents = [];
      window.dispatchEvent(new CustomEvent('apt:calendar-loaded'));
    }
  }

  // Bulk-fetch the visible month in one range call, group events into the
  // per-date cache, and (re)paint the grid so days with blocks show a dot.
  async function loadMonth() {
    const start = ymd(viewY, viewM, 1);
    const last = new Date(viewY, viewM + 1, 0).getDate();
    const end = ymd(viewY, viewM, last);
    try {
      const res = await fetch(PROXY + '/api/events/range?start=' + start + '&end=' + end,
        { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const all = await res.json();
      // Clear this month's cache buckets, then refill from the range payload.
      for (let d = 1; d <= last; d++) eventsByDate[ymd(viewY, viewM, d)] = [];
      all.forEach(ev => {
        const k = eventDateKey(ev);
        (eventsByDate[k] = eventsByDate[k] || []).push(ev);
      });
    } catch (e) {
      // Offline/range failure: leave the grid dot-less, day fetch handles errors.
    }
    renderGrid();
  }

  // ── create (used by the assistant) ────────────────────────────────────────
  async function createEvent({ title, notes, startDt, endDt }) {
    const res = await fetch(PROXY + '/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, notes: notes || undefined, date: selectedDate,
        startTime: toLocalISO(startDt), endTime: toLocalISO(endDt),
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ── month grid ────────────────────────────────────────────────────────────
  function hasEvents(dateStr) {
    const arr = eventsByDate[dateStr];
    return Array.isArray(arr) && arr.length > 0;
  }
  function markGridDot(dateStr, on) {
    const cell = document.querySelector('#dcwGrid .dcw-day[data-date="' + dateStr + '"]');
    if (cell) cell.classList.toggle('has-events', !!on);
  }
  function renderGrid() {
    const grid = document.getElementById('dcwGrid');
    const titleEl = document.getElementById('dcwTitle');
    if (!grid || !titleEl) return;
    titleEl.textContent = MONTH_NAMES[viewM] + ' ' + viewY;
    const firstDow = new Date(viewY, viewM, 1).getDay();
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const today = todayStr();
    let html = '';
    for (let i = 0; i < firstDow; i++) html += '<span class="dcw-day is-pad" aria-hidden="true"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = ymd(viewY, viewM, d);
      const cls = ['dcw-day'];
      if (ds === today) cls.push('is-today');
      if (ds === selectedDate) cls.push('is-selected');
      if (hasEvents(ds)) cls.push('has-events');
      html += '<button type="button" class="' + cls.join(' ') + '" role="gridcell"'
        + ' data-date="' + ds + '"' + (ds === selectedDate ? ' aria-current="date"' : '')
        + '><span class="dcw-num">' + d + '</span><span class="dcw-dot" aria-hidden="true"></span></button>';
    }
    grid.innerHTML = html;
  }
  // Switch the schedule to a given day: repaint the grid highlight, refresh the
  // header, show cached events instantly, then re-fetch that day to stay live.
  function selectDay(dateStr) {
    selectedDate = dateStr;
    const p = partsOf(dateStr);
    if (p.y !== viewY || p.m !== viewM) { viewY = p.y; viewM = p.m; loadMonth(); }
    document.getElementById('calDateLabel').textContent = fmtDateLabel(dateObj(dateStr));
    renderGrid();
    if (eventsByDate[dateStr]) renderEvents(eventsByDate[dateStr]);
    loadEvents();
  }
  function shiftMonth(delta) {
    const d = new Date(viewY, viewM + delta, 1);
    viewY = d.getFullYear(); viewM = d.getMonth();
    renderGrid();
    loadMonth();
  }

  // ── assistant-facing helpers ──────────────────────────────────────────────
  // Score how well a query matches an event title. A contiguous substring wins;
  // otherwise we accept a token-subset match so filler-stripped phrases like
  // "read book" still find "Read a book". Returns 0 when there's no real match.
  function scoreMatch(title, q) {
    const tl = title.toLowerCase();
    if (tl.includes(q)) return 100 + q.length;
    const tokens = q.split(/\s+/).filter(Boolean);
    if (!tokens.length) return 0;
    const hit = tokens.filter(w => w.length > 1 && tl.includes(w)).length;
    if (hit === tokens.length) return 50 + hit;   // every word present
    return hit;                                    // partial (weak)
  }
  // Pick the event that best matches a keyword. `prefer` biases ties: 'done' for
  // unchecking (target the completed slot), 'undone' for completing, else the
  // upcoming/active one so "move my workout" hits the right block.
  function findEvent(match, prefer) {
    const q = String(match || '').toLowerCase().trim();
    if (!q) return null;
    const scored = currentEvents.map(ev => ({ ev, s: scoreMatch(ev.title, q) })).filter(x => x.s > 0);
    if (!scored.length) return null;
    scored.sort((a, b) => b.s - a.s);
    const best = scored[0].s;
    const top = scored.filter(x => x.s === best).map(x => x.ev);
    const now = new Date(), doneSet = getDoneSet();
    if (prefer === 'done')   return top.find(ev => doneSet.has(ev.id))  || top[0];
    if (prefer === 'undone') return top.find(ev => !doneSet.has(ev.id)) || top[0];
    return top.find(ev => new Date(ev.end) >= now) || top[0];
  }
  // Resolve a phrase to a real event title (or null) — lets the parser decide
  // between mutating an existing block and creating a new one.
  function matchTitle(q) { const ev = findEvent(q); return ev ? ev.title : null; }
  async function apiAddEvent(title, hm, durationMin, notes) {
    const startDt = dtOnSelected(hm.h, hm.m);
    const endDt = new Date(startDt.getTime() + (durationMin || 30) * 60000);
    const made = await createEvent({ title, notes, startDt, endDt });
    await loadEvents();
    return { title, when: fmtTime(made.start || startDt.toISOString()) };
  }
  // Re-time a block. opts: { start:{h,m}?, end:{h,m}?, durationMin?, deltaMin? }
  //   • start only          → shift, keep duration
  //   • start + end (range) → set both (end wraps past midnight, e.g. 10pm→12am)
  //   • durationMin         → absolute length from the (new or current) start
  //   • deltaMin            → grow/shrink by N minutes (reduce/extend)
  async function apiRetimeEvent(match, opts) {
    const ev = findEvent(match);
    if (!ev) return { ok: false };
    const origMs = new Date(ev.end) - new Date(ev.start);
    let start = new Date(ev.start);
    if (opts.start) start.setHours(opts.start.h, opts.start.m, 0, 0);
    let end = new Date(start.getTime() + origMs);
    if (opts.end) {
      end = new Date(start); end.setHours(opts.end.h, opts.end.m, 0, 0);
      if (end <= start) end.setDate(end.getDate() + 1);     // crosses midnight
    }
    if (opts.durationMin != null) end = new Date(start.getTime() + opts.durationMin * 60000);
    if (opts.deltaMin != null) end = new Date(end.getTime() + opts.deltaMin * 60000);
    if (end <= start) end = new Date(start.getTime() + 5 * 60000);  // never zero/negative
    ev.start = toLocalISO(start); ev.end = toLocalISO(end);
    sortEvents(); renderEvents(currentEvents);
    await patchEvent(ev, { startTime: ev.start, endTime: ev.end }, null);
    return {
      ok: true, title: ev.title, when: fmtTime(ev.start), end: fmtTime(ev.end),
      durationMin: Math.round((end - start) / 60000),
    };
  }
  function apiCompleteEvent(match) {
    const ev = findEvent(match, 'undone');
    if (!ev) return { ok: false };
    setManual(ev.id, true); setDone(ev.id, true);
    applyDoneStateToDOM();
    if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    return { ok: true, title: ev.title };
  }
  function apiUncheckEvent(match) {
    const ev = findEvent(match, 'done');
    if (!ev) return { ok: false };
    // Record an explicit "not done" so autoCheckPastEvents won't re-tick a past slot.
    setManual(ev.id, false); setDone(ev.id, false);
    applyDoneStateToDOM();
    if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    return { ok: true, title: ev.title };
  }
  async function apiDeleteEvent(match) {
    const ev = findEvent(match);
    if (!ev) return { ok: false };
    try {
      const res = await fetch(PROXY + '/api/events/' + encodeURIComponent(ev.id), { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await loadEvents();
      return { ok: true, title: ev.title };
    } catch { return { ok: false, error: true }; }
  }
  function summarize() {
    if (!currentEvents.length) {
      const offline = document.getElementById('calOfflineMsg');
      if (offline && offline.style.display !== 'none') {
        return "I can't see your calendar right now — the proxy looks offline. Once it's up I'll read your blocks.";
      }
      const where = selectedDate === todayStr() ? 'today' : 'on ' + fmtDateLabel(dateObj(selectedDate));
      return 'Nothing on the calendar ' + where + ' — a clean slate. Want me to add something?';
    }
    const isToday = selectedDate === todayStr();
    const now = new Date();
    // "Upcoming" only filters by clock-time on today; on other days show all.
    const upcoming = isToday ? currentEvents.filter(ev => ev.allDay || new Date(ev.end) >= now) : currentEvents;
    const lines = (upcoming.length ? upcoming : currentEvents)
      .map(ev => '• ' + ev.title + (ev.allDay ? ' (all day)' : ' at ' + fmtTime(ev.start)));
    const n = currentEvents.length;
    const when = isToday ? 'today' : fmtDateLabel(dateObj(selectedDate));
    const head = (window.__aiosGreeting ? window.__aiosGreeting() : 'Hi') +
      '! You have ' + n + ' block' + (n === 1 ? '' : 's') + ' scheduled ' + when + ':';
    return head + '\n' + lines.join('\n');
  }

  // ── wire up ───────────────────────────────────────────────────────────────
  window.addEventListener('calendar-synced', applyDoneStateToDOM);
  window.addEventListener('storage', applyDoneStateToDOM);
  document.getElementById('calDateLabel').textContent = fmtDateLabel(dateObj(selectedDate));
  document.getElementById('calRefreshBtn').addEventListener('click', () => { loadEvents(); loadMonth(); });

  // Month-calendar widget: prev/next month + click-to-select a day.
  const gridEl = document.getElementById('dcwGrid');
  document.getElementById('dcwPrev').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('dcwNext').addEventListener('click', () => shiftMonth(1));
  if (gridEl) {
    gridEl.addEventListener('click', e => {
      const cell = e.target.closest('.dcw-day[data-date]');
      if (cell && cell.dataset.date !== selectedDate) selectDay(cell.dataset.date);
    });
  }
  renderGrid();
  loadMonth();
  loadEvents();
  // Keep TODAY's view live; other days refresh on demand when selected.
  setInterval(() => { if (selectedDate === todayStr()) loadEvents(); }, 5 * 60 * 1000);

  // Public API the assistant drives.
  window.AptCal = {
    reload: loadEvents,
    selectDay,
    getEvents: () => currentEvents.map(ev => ({ title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, done: getDoneSet().has(ev.id) })),
    isOffline: () => { const o = document.getElementById('calOfflineMsg'); return !!o && o.style.display !== 'none'; },
    summarize, addEvent: apiAddEvent, retimeEvent: apiRetimeEvent,
    moveEvent: (m, hm) => apiRetimeEvent(m, { start: hm }),   // back-compat alias
    completeEvent: apiCompleteEvent, uncheckEvent: apiUncheckEvent, deleteEvent: apiDeleteEvent,
    matchTitle, fmtTime,
  };
})();

// =============================================================================
// AI ASSISTANT — hybrid. Local synchronous parser first (instant, offline),
// Gemini proxy fallback for free-form. Applies intents to AptCal + bridges.
// =============================================================================
(function () {
  const GEMINI_ENDPOINT = '/api/gemini/assistant';
  const log = document.getElementById('aiLog');
  const form = document.getElementById('aiForm');
  const input = document.getElementById('aiInput');
  const chipsWrap = document.getElementById('aiChips');
  if (!log || !form) return;

  // ── message UI ─────────────────────────────────────────────────────────────
  const chatEl = document.querySelector('.aios-chat');
  function scroll() { log.scrollTop = log.scrollHeight; }
  // Reveal/spin the Dragon-Balls processing loader while Shenlong is working;
  // it stays hidden the rest of the time so the chat reads clean. Local
  // commands resolve in a single microtask, so without a floor the class is
  // added and removed before the browser ever paints the spin — keep it up for
  // at least MIN_SPIN_MS so the rotation is always actually visible.
  const MIN_SPIN_MS = 900;
  let processingSince = 0, hideTimer = 0;
  function setSummoning(on) {
    if (!chatEl) return;
    if (on) {
      clearTimeout(hideTimer);
      processingSince = Date.now();
      chatEl.classList.add('is-processing');
    } else {
      const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - processingSince));
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => chatEl.classList.remove('is-processing'), wait);
    }
  }
  // ── coreference memory ───────────────────────────────────────────────────────
  // The last event the user successfully acted on, so a follow-up pronoun
  // ("move it to 4pm", "delete that") can be resolved to a real title.
  let lastMentionedEventTaskName = null;
  function remember(name) { if (name) lastMentionedEventTaskName = name; }

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'aios-msg aios-msg-' + role;
    // Shenlong's replies get the jade outline; granted (✓) commands an amber accent.
    if (role === 'ai') {
      div.classList.add('shenlong-reply');
      if (/^\s*✓/.test(text)) div.classList.add('is-granted');
    }
    div.textContent = text;
    log.appendChild(div); scroll();
    return div;
  }
  function addThinking() {
    const div = document.createElement('div');
    div.className = 'aios-msg aios-msg-ai aios-msg-think';
    div.innerHTML = '<span class="aios-typing"><span></span><span></span><span></span></span>';
    log.appendChild(div); scroll();
    return div;
  }

  // ── time parsing ─────────────────────────────────────────────────────────────
  // Accepts "4pm", "4:30 pm", "16:00", "noon", "midnight". Returns {h,m} | null.
  function parseTime(text) {
    const t = text.toLowerCase();
    if (/\bnoon\b/.test(t)) return { h: 12, m: 0 };
    if (/\bmidnight\b/.test(t)) return { h: 0, m: 0 };
    let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (m) {
      let h = +m[1] % 12; if (m[3] === 'pm') h += 12;
      return { h, m: m[2] ? +m[2] : 0 };
    }
    m = t.match(/\b(\d{1,2}):(\d{2})\b/);
    if (m) return { h: Math.min(23, +m[1]), m: Math.min(59, +m[2]) };
    return null;
  }
  // Every time token in a string, in order — for ranges like "10pm to 12am".
  function parseTimes(text) {
    const out = [];
    const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b|\b(noon|midnight)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      if (m[6]) out.push(/noon/i.test(m[6]) ? { h: 12, m: 0 } : { h: 0, m: 0 });
      else if (m[3]) { let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; out.push({ h, m: m[2] ? +m[2] : 0 }); }
      else if (m[4]) out.push({ h: Math.min(23, +m[4]), m: Math.min(59, +m[5]) });
    }
    return out;
  }
  // Strip every time/duration token so what's left is the task phrase.
  const TIME_TOKENS = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b|\b\d+\s*(?:min|minute|hour|hr)s?\b/gi;
  function fmtHm(hm) {
    let h = hm.h % 12 || 12;
    return h + (hm.m ? ':' + padZ(hm.m) : '') + ' ' + (hm.h >= 12 ? 'PM' : 'AM');
  }
  function cleanTitle(s) {
    return s.replace(/\s+/g, ' ').trim().replace(/^(to|a|an|the|my|me|that|some)\s+/i, '').trim()
      .replace(/^./, c => c.toUpperCase());
  }

  // ── local intent parser ─────────────────────────────────────────────────────
  // Order matters: more specific bridges (water/food/notes) before the generic
  // calendar verbs so "log water" never reads as "complete an event".
  function parseLocal(raw) {
    const t = raw.toLowerCase().trim();

    // summarize / greeting
    if (/^(summari[sz]e|recap|overview|brief)\b/.test(t) ||
        /\b(what('?s| is)?|show|how('?s| is)?).*(today|schedule|day|plan|on|calendar|left)\b/.test(t) ||
        /^(good\s+(morning|afternoon|evening)|hi|hey|hello)\b/.test(t)) {
      return { action: 'summarize' };
    }
    // water
    if (/\b(water|hydrat)/.test(t) || /\b(drank|drink|had)\b.*\b(glass|bottle|cup)\b/.test(t) ||
        /^log\s+(a\s+|one\s+)?(glass|bottle|cup)\b/.test(t)) {
      const n = (t.match(/\b(\d+)\b/) || [])[1];
      const unit = /bottle/.test(t) ? 'bottle' : /glass|cup/.test(t) ? 'glass' : null;
      return { action: 'log_water', servings: n ? +n : 1, unit };
    }
    // food
    if (/\b(ate|eaten|eating)\b/.test(t) || (/\bfood|meal|kcal|calorie/.test(t) && /\b(log|add|track|had)\b/.test(t))) {
      const cal = (t.match(/(\d+)\s*(kcal|cal|calorie)/) || [])[1];
      let name = raw.replace(/\b(log|add|track)\b/gi, '').replace(/\b(that\s+)?i\s+(just\s+)?(ate|had|eaten)\b/gi, '')
        .replace(/[~]?\d+\s*(kcal|cal|calories?)/gi, '').replace(/\bfor\b\s*$/i, '').trim();
      return { action: 'log_food', name: cleanTitle(name) || 'Meal', calories: cal ? +cal : null };
    }
    // explicit note
    if (/^note[:\-]/i.test(raw) || /\b(jot|remember to|note that|add a note)\b/.test(t)) {
      let text = raw.replace(/^note[:\-]\s*/i, '').replace(/\b(jot down|jot|note that|add a note( to)?|remember to)\b/gi, '').trim();
      return { action: 'note', text: text || raw };
    }
    // ── STATE MUTATIONS — consult the live calendar so an EXISTING block always
    // wins over the broad "create" logic. This is the fix for "unmark read a
    // book" being mis-read as scheduling "Unmark read a": we strip the action
    // word, resolve the remaining phrase against today's blocks, and only fall
    // back to creation when no block matches.
    const A = window.AptCal;
    // Words that aren't part of a block title — dropped before fuzzy matching.
    const FILLER = /\b(the|my|a|an|that|this|please|it|i|just|to|item|entry|event|block|task|as|off|for|on|today|tonight|already|done|complete[d]?|finished?)\b/gi;
    const phraseFrom = (re) => raw.replace(re, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
    const resolve = (phrase) => (A && A.matchTitle ? A.matchTitle(phrase) : null);
    // Coreference: a phrase that is empty or just a pronoun ("it", "that",
    // "this task", "the event") refers back to the last event acted on.
    const PRONOUN_ONLY = /^(it|that|this|this (task|event|one)|the (task|event|one))$/i;
    const coref = (phrase) => {
      const p = (phrase || '').trim();
      return ((!p || PRONOUN_ONLY.test(p)) && lastMentionedEventTaskName) ? lastMentionedEventTaskName : p;
    };

    // UNCHECK / unmark / undo / incomplete  → toggle done:false
    if (/\b(uncheck|unmark|un-?mark|undo|incomplete|untick|unticked)\b/.test(t) || /\bnot\s+done\b/.test(t)) {
      const phrase = coref(phraseFrom(/\b(uncheck|unmark|un-?mark|undo|incomplete|untick(ed)?|not\s+done)\b/gi));
      const title = resolve(phrase);
      if (title) return { action: 'uncheck_event', match: title };
      if (phrase) return { action: 'add_event', title: cleanTitle(phrase), time: parseTime(t), durationMin: null };
    }
    // CHECK / complete / finish / done / tick / "log that I…"  → toggle done:true
    if (/\b(check(\s*off)?|complete[d]?|finish(ed)?|done|tick(ed)?)\b/.test(t) ||
        /\bmark\b[\s\S]*\b(done|complete[d]?)\b/.test(t) || /^log\s+(that\s+)?i\b/.test(t)) {
      const phrase = coref(phraseFrom(/\b(log|check(\s*off)?|checkoff|complete[d]?|finish(ed)?|done|tick(ed)?|mark|did)\b/gi));
      const title = resolve(phrase);
      if (title) return { action: 'complete_event', match: title };
      if (phrase) return { action: 'add_event', title: cleanTitle(phrase), time: parseTime(t), durationMin: null };
    }
    // DELETE / remove / cancel  → remove the block entirely
    if (/\b(delete|remove|cancel|clear|drop)\b/.test(t)) {
      const phrase = coref(phraseFrom(/\b(delete|remove|cancel|clear|drop)\b/gi));
      return { action: 'delete_event', match: resolve(phrase) || phrase };
    }
    // RE-TIME — move / reschedule / shift / reduce / extend / shorten / lengthen.
    // Pulls the task name + any time(s) or duration so it can recompute start AND
    // end of the block. A range ("10pm to 12am") sets both; a single time shifts;
    // "by/to N min|hr" resizes. "set"/"make" are excluded (they collide with the
    // "set up" create verb). The branch only fires when a time/duration is given.
    if (/\b(move|reschedule|resched|shift|push|change|reduce|extend|shorten|lengthen|resize)\b/.test(t)) {
      const times = parseTimes(t);
      const byMatch = t.match(/\bby\s+(\d+)\s*(min|minute|hour|hr)s?\b/);
      const toDur = t.match(/\bto\s+(\d+)\s*(min|minute|hour|hr)s?\b/);
      const conv = (mm) => (/hour|hr/.test(mm[2]) ? +mm[1] * 60 : +mm[1]);
      if (times.length || byMatch || toDur) {
        const phrase = coref(raw
          .replace(/\b(move|reschedule|resched|shift|push|change|reduce|extend|shorten|lengthen|resize)\b/gi, ' ')
          .replace(/\bfrom\b|\bto\b|\bat\b|\bby\b/gi, ' ')
          .replace(TIME_TOKENS, ' ')
          .replace(/\b(my|the|a|an)\b/gi, ' ')
          .replace(/\s+/g, ' ').trim());
        const out = { action: 'retime_event', match: resolve(phrase) || phrase };
        if (times.length >= 2) { out.time = times[0]; out.endTime = times[1]; }
        else if (times.length === 1) { out.time = times[0]; }
        if (times.length < 2) {
          if (byMatch) out.deltaMin = (/extend|lengthen/.test(t) ? 1 : -1) * conv(byMatch);
          else if (toDur) out.durationMin = conv(toDur);
        }
        return out;
      }
    }
    // ADD / schedule / remind (broad — LAST). "book" is intentionally NOT a
    // trigger: it collides with real titles like "read a book".
    if (/\b(add|schedule|create|new|remind(er)?|set up|block)\b/.test(t)) {
      const time = parseTime(t);
      const durM = (t.match(/(\d+)\s*(min|minute|hour|hr)/) || []);
      let durationMin = null;
      if (durM[1]) durationMin = /hour|hr/.test(durM[2]) ? +durM[1] * 60 : +durM[1];
      let title = raw
        .replace(/\b(add|schedule|create|new|set up|block|a reminder to|reminder to|remind me to|reminder|remind)\b/gi, '')
        .replace(/\bat\b\s*[\d:apm\s]+/i, '')
        .replace(/\bfor\b\s*\d+\s*(min|minute|hour|hr)s?/i, '')
        .replace(/\b(today|tomorrow|tonight|this (morning|afternoon|evening))\b/gi, '')
        .trim();
      return { action: 'add_event', title: cleanTitle(title), time, durationMin };
    }
    // Bare "TASK from X to Y" (no verb) — re-time, but ONLY when the phrase maps
    // to an existing block, so it never hijacks creation of a brand-new entry.
    {
      const times = parseTimes(t);
      if (times.length >= 2) {
        const phrase = coref(raw.replace(/\bfrom\b|\bto\b|\bat\b/gi, ' ').replace(TIME_TOKENS, ' ')
          .replace(/\b(my|the|a|an)\b/gi, ' ').replace(/\s+/g, ' ').trim());
        const title = resolve(phrase);
        if (title) return { action: 'retime_event', match: title, time: times[0], endTime: times[1] };
      }
    }
    return null; // unknown → Gemini fallback
  }

  // ── water bridge — reuse the topbar's tested add pipeline (handles ml + sync) ─
  function logWater(servings) {
    const btn = document.getElementById('topbarWaterAdd');
    if (!btn) return false;
    for (let i = 0; i < Math.max(1, servings || 1); i++) btn.click();
    return true;
  }
  // ── food bridge — append to po_food_v1 (6AM-anchored day key, as health.js) ──
  function logFood(name, calories) {
    const KEY = 'po_food_v1';
    function dayKey() {
      const n = new Date(); if (n.getHours() < 6) n.setDate(n.getDate() - 1);
      return n.getFullYear() + '-' + padZ(n.getMonth() + 1) + '-' + padZ(n.getDate());
    }
    let all = {}; try { all = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
    const k = dayKey();
    (all[k] = all[k] || []).push({
      id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      ts: Date.now(), meal_name: name, calories: calories || 0,
      protein: 0, carbs: 0, fats: 0, source: 'assistant',
    });
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {}
    if (typeof window.cloudSyncFlush === 'function') { try { window.cloudSyncFlush(); } catch (e) {} }
    return true;
  }

  // ── apply a structured intent (from local parser OR Gemini) ──────────────────
  async function applyIntent(intent) {
    const A = window.AptCal;
    // Accept times as {h,m} (local parser) or "HH:MM"/"4pm" strings (Gemini).
    const asTime = (v) => !v ? null
      : (typeof v === 'string'
          ? (parseTime(v) || (function () { const m = v.match(/(\d{1,2}):(\d{2})/); return m ? { h: +m[1], m: +m[2] } : null; })())
          : v);
    const time = asTime(intent.time);

    switch (intent.action) {
      case 'summarize':
        addMsg('ai', A.summarize());
        return;

      case 'add_event': {
        if (!intent.title) { addMsg('ai', 'What should I call that block?'); return; }
        if (!time) { addMsg('ai', 'When should I schedule “' + intent.title + '”? Try “at 4pm”.'); return; }
        if (A.isOffline()) { addMsg('ai', "I can't reach the calendar (proxy offline), so I couldn't add “" + intent.title + '”.'); return; }
        try {
          const r = await A.addEvent(intent.title, time, intent.durationMin, intent.notes);
          remember(r.title);
          addMsg('ai', '✓ Scheduled “' + r.title + '” at ' + r.when + '.');
        } catch { addMsg('ai', 'Adding that failed — is the proxy running?'); }
        return;
      }
      case 'move_event':
      case 'retime_event': {
        const opts = {};
        if (time) opts.start = time;
        if (intent.endTime) opts.end = asTime(intent.endTime);
        if (intent.durationMin != null) opts.durationMin = intent.durationMin;
        if (intent.deltaMin != null) opts.deltaMin = intent.deltaMin;
        if (!opts.start && !opts.end && opts.durationMin == null && opts.deltaMin == null) {
          addMsg('ai', 'Re-time it to when? Try “move workout to 4pm” or “reduce film 10pm to 12am”.');
          return;
        }
        if (A.isOffline()) { addMsg('ai', "I can't reach the calendar (proxy offline) to re-time that."); return; }
        const r = await A.retimeEvent(intent.match, opts);
        if (r.ok) remember(r.title);
        addMsg('ai', r.ok
          ? '✓ Updated “' + r.title + '” → ' + r.when + '–' + r.end + ' (' + r.durationMin + ' min).'
          : "I couldn't find an event matching “" + (intent.match || '') + '”.');
        return;
      }
      case 'complete_event': {
        const r = A.completeEvent(intent.match);
        if (r.ok) remember(r.title);
        addMsg('ai', r.ok ? '✓ Awesome — marked “' + r.title + '” as completed.'
          : (A.isOffline() ? "I can't see your events (proxy offline) to check that off."
            : "I couldn't find an event matching “" + (intent.match || '') + '”.'));
        return;
      }
      case 'uncheck_event': {
        const r = A.uncheckEvent(intent.match);
        if (r.ok) remember(r.title);
        addMsg('ai', r.ok ? "✓ I've unchecked “" + r.title + '” — back on your list.'
          : (A.isOffline() ? "I can't see your events (proxy offline) to uncheck that."
            : "I couldn't find an event matching “" + (intent.match || '') + '”.'));
        return;
      }
      case 'delete_event': {
        if (A.isOffline()) { addMsg('ai', "I can't reach the calendar (proxy offline) to delete that."); return; }
        const r = await A.deleteEvent(intent.match);
        addMsg('ai', r.ok ? '✓ Deleted “' + r.title + '”.'
          : r.error ? 'Deleting that failed — is the proxy running?'
            : "I couldn't find an event matching “" + (intent.match || '') + '”.');
        return;
      }
      case 'log_water': {
        const n = intent.servings || 1;
        const ok = logWater(n);
        addMsg('ai', ok ? '✓ Logged ' + n + ' ' + (n === 1 ? 'serving' : 'servings') + ' of water. 💧'
          : "I couldn't reach the water tracker from here.");
        return;
      }
      case 'log_food': {
        logFood(intent.name || 'Meal', intent.calories);
        addMsg('ai', '✓ Logged “' + (intent.name || 'Meal') + '”'
          + (intent.calories ? ' · ' + intent.calories + ' kcal' : '') + ' to your nutrition log.');
        return;
      }
      case 'note': {
        window.QuickNotes.add(intent.text);
        addMsg('ai', '✓ Noted: “' + intent.text + '”.');
        return;
      }
      case 'chat':
      default:
        addMsg('ai', intent.reply || "I'm not sure how to act on that yet.");
        return;
    }
  }

  // ── Gemini fallback ──────────────────────────────────────────────────────────
  async function askGemini(message) {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, context: { date: todayStr(), events: window.AptCal.getEvents() } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ── submit flow ──────────────────────────────────────────────────────────────
  let busy = false;
  async function handle(text) {
    const msg = text.trim();
    if (!msg || busy) return;
    busy = true; setSummoning(true);
    addMsg('user', msg);
    const local = parseLocal(msg);
    if (local) {
      try { await applyIntent(local); } catch (e) { addMsg('ai', 'Something went wrong handling that.'); }
      busy = false; setSummoning(false); return;
    }
    // free-form → Gemini (only reachable on the deployed proxy)
    const thinking = addThinking();
    try {
      const intent = await askGemini(msg);
      thinking.remove();
      if (intent && intent.reply && (!intent.action || intent.action === 'chat')) addMsg('ai', intent.reply);
      else await applyIntent(intent);
    } catch (e) {
      thinking.remove();
      addMsg('ai', "I couldn't parse that locally, and the Gemini service isn't reachable here "
        + '(it runs on the deployed proxy). Try a direct command — e.g. “add gym at 5pm”, '
        + '“move workout to 4pm”, “log water”, or “what’s on today?”.');
    }
    busy = false; setSummoning(false);
  }

  // ── quick chips ──────────────────────────────────────────────────────────────
  const CHIPS = ["What's on today?", 'Log water', 'Add lunch at 1pm', 'Move workout to 4pm'];
  if (chipsWrap) {
    CHIPS.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'aios-chip'; b.textContent = c;
      b.addEventListener('click', () => { handle(c); });
      chipsWrap.appendChild(b);
    });
  }

  form.addEventListener('submit', e => { e.preventDefault(); const v = input.value; input.value = ''; handle(v); });

  // ── opening greeting — once the first calendar load resolves ─────────────────
  let greeted = false;
  function greet() {
    if (greeted) return; greeted = true;
    addMsg('ai', window.AptCal.summarize());
    addMsg('ai', 'Tell me what to change — e.g. “move my workout to 4pm”, “add a reminder to drink water at 6pm”, or “log that I finished my plank”.');
  }
  window.addEventListener('apt:calendar-loaded', greet, { once: true });
  // Safety net if the calendar event never fires (e.g. very slow proxy timeout).
  setTimeout(greet, 6000);

  // Exposed for debugging / tests — inspect how a phrase is parsed locally.
  window.Assistant = { parse: parseLocal, handle };
})();
