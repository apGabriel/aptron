// ── CONFIG ──────────────────────────────────────────────────────────────────
const WAKE_HOUR  = 6.5;
const SLEEP_HOUR = 24;

// ── STORAGE HELPERS ─────────────────────────────────────────────────────────
function storeGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storeSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  if (key.startsWith('goals:')) {
    window.dispatchEvent(new CustomEvent('goals-changed'));
  }
}
function storeDelete(key) { localStorage.removeItem(key); }
function storeListKeys(prefix) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
  }
  return keys;
}

// ── DATE HELPERS ─────────────────────────────────────────────────────────────
function padZ(n) { return String(n).padStart(2, '0'); }

function dateToStr(d) {
  return `${d.getFullYear()}-${padZ(d.getMonth()+1)}-${padZ(d.getDate())}`;
}

function isBeforeWake() {
  const now = new Date();
  return (now.getHours() + now.getMinutes() / 60) < WAKE_HOUR;
}

function getActiveDateString() {
  const now = new Date();
  if (isBeforeWake()) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return dateToStr(yesterday);
  }
  return dateToStr(now);
}

function getTomorrowDateString() {
  const now = new Date();
  if (isBeforeWake()) {
    return dateToStr(now); // active day is yesterday, so "tomorrow" is today
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return dateToStr(tomorrow);
}

function formatDate(str) {
  // str: YYYY-MM-DD
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
}

// ── ROLLOVER ─────────────────────────────────────────────────────────────────
function runRollover() {
  const activeDate = getActiveDateString();
  const allKeys = storeListKeys('goals:');
  allKeys.forEach(key => {
    const keyDate = key.slice(6); // strip "goals:"
    if (keyDate >= activeDate) return;
    const goals = storeGet(key) || [];
    const undone = goals.filter(g => !g.done);
    if (undone.length === 0) { storeDelete(key); return; }
    const todayGoals = storeGet('goals:' + activeDate) || [];
    const existingTexts = new Set(todayGoals.map(g => g.text));
    undone.forEach(g => { if (!existingTexts.has(g.text)) todayGoals.push({ text: g.text, done: false }); });
    storeSet('goals:' + activeDate, todayGoals);
    storeDelete(key);
  });
}

// ── STREAK ──────────────────────────────────────────────────────────────────
function runStreakCheck() {
  const activeDate = getActiveDateString();
  const streakData = storeGet('goal_streak_v1') || { count: 0, lastProcessedDate: null };
  const allKeys = storeListKeys('goals:').sort();
  let { count, lastProcessedDate } = streakData;

  allKeys.forEach(key => {
    const keyDate = key.slice(6);
    if (keyDate >= activeDate) return;
    if (lastProcessedDate && keyDate <= lastProcessedDate) return;
    const goals = storeGet(key) || [];
    if (goals.length === 0) { lastProcessedDate = keyDate; return; }
    const allDone = goals.every(g => g.done);
    count = allDone ? count + 1 : 0;
    lastProcessedDate = keyDate;
  });

  storeSet('goal_streak_v1', { count, lastProcessedDate });
  return count;
}

// ── RENDER STREAK ────────────────────────────────────────────────────────────
function renderStreak() {
  const data = storeGet('goal_streak_v1') || { count: 0 };
  const count = data.count || 0;
  const el = document.getElementById('gmStreak');
  document.getElementById('gmStreakNum').textContent = count;
  if (count > 0) el.classList.add('gm-streak-active');
  else           el.classList.remove('gm-streak-active');
}

// ── RENDER TODAY HEADER ──────────────────────────────────────────────────────
function renderTodayHeader() {
  const activeDate = getActiveDateString();
  const goals = storeGet('goals:' + activeDate) || [];
  const done  = goals.filter(g => g.done).length;
  const total = goals.length;

  document.getElementById('todayLabel').textContent = 'Today — ' + formatDate(activeDate);
  document.getElementById('gmProgressNum').textContent = done;
  document.getElementById('gmProgressTotal').textContent = '/ ' + total;

  let label = 'no goals yet';
  if (total > 0 && done === total) label = 'all done — solid day';
  else if (total > 0) label = 'complete';
  document.getElementById('gmProgressLabel').textContent = label;

  // Segmented bar
  const bar = document.getElementById('gmBar');
  bar.innerHTML = '';
  goals.forEach(g => {
    const seg = document.createElement('div');
    seg.className = 'gm-bar-seg' + (g.done ? ' gm-bar-seg-done' : '');
    bar.appendChild(seg);
  });

  // All-done class
  const card = document.getElementById('todayCard');
  if (total > 0 && done === total) card.classList.add('gm-all-done');
  else                             card.classList.remove('gm-all-done');

  // Push button
  const pushBtn = document.getElementById('gmPushBtn');
  const hasUnchecked = goals.some(g => !g.done);
  pushBtn.style.display = hasUnchecked ? 'block' : 'none';
}

// ── RENDER TOMORROW COUNT ─────────────────────────────────────────────────────
function renderTomorrowCount() {
  const tomorrowDate = getTomorrowDateString();
  const goals = storeGet('goals:' + tomorrowDate) || [];
  document.getElementById('gmTomorrowCount').textContent = goals.length + ' planned';
  document.getElementById('tomorrowLabel').textContent = 'Plan tomorrow — ' + formatDate(tomorrowDate);
}

// ── BUILD GOAL ROW ────────────────────────────────────────────────────────────
function buildGoalRow(g, idx, goals, key, readOnly, reload) {
  const li = document.createElement('li');
  li.className = 'goal-row' + (g.done ? ' is-done' : '') + (g.queued ? ' is-queued' : '');
  li.draggable = !readOnly;
  li.dataset.idx = idx;

  // Drag handle
  const handle = document.createElement('span');
  handle.className = 'goal-drag-handle';
  handle.textContent = '⋮⋮';
  if (!readOnly) li.appendChild(handle);

  // Checkbox
  const cbWrap = document.createElement('label');
  cbWrap.className = 'goal-cb-wrap';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = g.done;
  if (readOnly) { cb.disabled = true; cb.title = 'Activates at 6 AM tomorrow'; }
  const cbCustom = document.createElement('span');
  cbCustom.className = 'goal-cb-custom';
  cbWrap.appendChild(cb);
  cbWrap.appendChild(cbCustom);
  li.appendChild(cbWrap);

  cb.addEventListener('change', () => {
    goals[idx].done = cb.checked;
    if (cb.checked) goals[idx].doneAt = Date.now();
    else            delete goals[idx].doneAt;
    storeSet(key, goals);
    reload();
  });

  // Text
  const textEl = document.createElement('span');
  textEl.className = 'goal-text';
  textEl.textContent = g.text;
  makeInlineEdit(textEl, goals, idx, key, reload);
  li.appendChild(textEl);

  // Queue btn
  const qBtn = document.createElement('button');
  qBtn.className = 'gm-queue-btn' + (g.queued ? ' is-queued' : '');
  qBtn.textContent = '⚡';
  qBtn.title = 'Queue for productivity window';
  if (readOnly) qBtn.disabled = true;
  qBtn.addEventListener('click', () => {
    goals[idx].queued = !goals[idx].queued;
    const rank = g => g.done ? 2 : (g.queued ? 0 : 1);
    goals.sort((a, b) => rank(a) - rank(b));
    storeSet(key, goals);
    li.classList.add('is-queue-flashing');
    setTimeout(() => reload(), 480);
  });
  li.appendChild(qBtn);

  // Delete btn
  const delBtn = document.createElement('button');
  delBtn.className = 'goal-delete';
  delBtn.textContent = '×';
  delBtn.title = 'Delete goal';
  delBtn.addEventListener('click', () => {
    goals.splice(idx, 1);
    storeSet(key, goals);
    reload();
  });
  li.appendChild(delBtn);

  // Drag-and-drop
  if (!readOnly) wireDragReorder(li, goals, key, reload);

  return li;
}

// ── INLINE EDIT ──────────────────────────────────────────────────────────────
function makeInlineEdit(textEl, goals, idx, key, reload) {
  textEl.addEventListener('click', () => {
    textEl.contentEditable = 'true';
    textEl.focus();
    const range = document.createRange();
    range.selectNodeContents(textEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  textEl.addEventListener('blur', () => {
    const newText = textEl.textContent.trim();
    textEl.contentEditable = 'false';
    if (newText && newText !== goals[idx].text) {
      goals[idx].text = newText;
      storeSet(key, goals);
      reload();
    } else {
      textEl.textContent = goals[idx].text;
    }
  });

  textEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
    if (e.key === 'Escape') {
      textEl.textContent = goals[idx].text;
      textEl.contentEditable = 'false';
    }
  });
}

// ── DRAG REORDER ─────────────────────────────────────────────────────────────
let dragFromIdx = null;

function wireDragReorder(li, goals, key, reload) {
  li.addEventListener('dragstart', e => {
    dragFromIdx = parseInt(li.dataset.idx);
    e.dataTransfer.effectAllowed = 'move';
  });

  li.addEventListener('dragover', e => {
    e.preventDefault();
    li.classList.add('drag-over-top');
  });

  li.addEventListener('dragleave', () => {
    li.classList.remove('drag-over-top');
    li.classList.remove('drag-over-bottom');
  });

  li.addEventListener('drop', e => {
    e.preventDefault();
    li.classList.remove('drag-over-top');
    const toIdx = parseInt(li.dataset.idx);
    if (dragFromIdx === null || dragFromIdx === toIdx) return;
    const [moved] = goals.splice(dragFromIdx, 1);
    goals.splice(toIdx, 0, moved);
    storeSet(key, goals);
    reload();
    dragFromIdx = null;
  });
}

// ── RENDER LIST ───────────────────────────────────────────────────────────────
const SHOW_MAX = 5;

function renderListInto(goals, listEl, emptyEl, key, readOnly, reload) {
  listEl.innerHTML = '';

  if (goals.length === 0) {
    emptyEl.style.display = 'block';
  } else {
    emptyEl.style.display = 'none';
    const showAll = listEl.dataset.expanded === 'true';
    const visible = (goals.length > SHOW_MAX && !showAll) ? goals.slice(0, SHOW_MAX) : goals;

    visible.forEach((g, i) => {
      listEl.appendChild(buildGoalRow(g, i, goals, key, readOnly, reload));
    });

    if (goals.length > SHOW_MAX) {
      const hidden = goals.length - SHOW_MAX;
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'gm-show-more';
      if (showAll) {
        toggleBtn.textContent = 'Show less ▴';
        toggleBtn.addEventListener('click', () => { listEl.dataset.expanded = 'false'; reload(); });
      } else {
        toggleBtn.textContent = `Show ${hidden} more ▾`;
        toggleBtn.addEventListener('click', () => { listEl.dataset.expanded = 'true'; reload(); });
      }
      listEl.appendChild(toggleBtn);
    }
  }

  if (key.startsWith('goals:') && !readOnly) {
    renderTodayHeader();
  } else if (readOnly) {
    renderTomorrowCount();
  }
}

// ── LOAD TODAY / TOMORROW ─────────────────────────────────────────────────────
function loadToday() {
  const key   = 'goals:' + getActiveDateString();
  const goals = storeGet(key) || [];
  const listEl  = document.getElementById('goalList');
  const emptyEl = document.getElementById('emptyState');
  renderListInto(goals, listEl, emptyEl, key, false, loadToday);
}

function loadTomorrow() {
  const key   = 'goals:' + getTomorrowDateString();
  const goals = storeGet(key) || [];
  const listEl  = document.getElementById('tomorrowList');
  const emptyEl = document.getElementById('tomorrowEmptyState');
  renderListInto(goals, listEl, emptyEl, key, true, loadTomorrow);
}

// ── ADD HANDLERS ──────────────────────────────────────────────────────────────
function makeAddHandlers(input, addBtn, key, reload) {
  function doAdd() {
    const text = input.value.trim();
    if (!text) return;
    const goals = storeGet(key) || [];
    goals.push({ text, done: false });
    storeSet(key, goals);
    input.value = '';
    reload();
  }

  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
}

// ── PUSH REMAINING ────────────────────────────────────────────────────────────
document.getElementById('gmPushBtn').addEventListener('click', () => {
  if (!confirm('Move all unchecked goals to tomorrow?')) return;
  const todayKey    = 'goals:' + getActiveDateString();
  const tomorrowKey = 'goals:' + getTomorrowDateString();
  const todayGoals    = storeGet(todayKey) || [];
  const tomorrowGoals = storeGet(tomorrowKey) || [];
  const existing = new Set(tomorrowGoals.map(g => g.text));
  const unchecked = todayGoals.filter(g => !g.done);
  unchecked.forEach(g => { if (!existing.has(g.text)) tomorrowGoals.push({ text: g.text, done: false }); });
  const remaining = todayGoals.filter(g => g.done);
  storeSet(todayKey, remaining);
  storeSet(tomorrowKey, tomorrowGoals);
  loadToday();
  loadTomorrow();
});

// ── DAY RING ──────────────────────────────────────────────────────────────────
const C = 2 * Math.PI * 52;
const ringFill  = document.getElementById('ringFill');
const ringTrack = document.getElementById('ringTrack');
ringFill.style.strokeDasharray = C;

const SUN_PALETTE = [
  [255,216,158],[255,205,121],[255,227,143],[255,183,106],
  [255,149, 89],[243,111, 79],[226, 93,122],[123, 91,176],[47, 58,102]
];

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0]-a[0])*t),
    Math.round(a[1] + (b[1]-a[1])*t),
    Math.round(a[2] + (b[2]-a[2])*t)
  ];
}

function getSunColor(pct) {
  const stops = SUN_PALETTE;
  const n = stops.length - 1;
  const pos = (pct / 100) * n;
  const lo  = Math.floor(pos);
  const hi  = Math.min(lo + 1, n);
  const t   = pos - lo;
  const [r,g,b] = lerpColor(stops[lo], stops[hi], t);
  return `rgb(${r},${g},${b})`;
}

function fmtHm(totalHours) {
  const h = Math.floor(totalHours);
  const m = Math.round((totalHours - h) * 60);
  return `${h}h ${m}m`;
}

function fmtClock(now) {
  let h = now.getHours();
  const m = padZ(now.getMinutes());
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function updateDayRing() {
  const now = new Date();
  const hours = now.getHours() + now.getMinutes()/60 + now.getSeconds()/3600;

  document.getElementById('ringClock').textContent = fmtClock(now);

  if (hours < WAKE_HOUR) {
    ringFill.setAttribute('stroke', '#4D4B47');
    ringFill.style.strokeDashoffset = C;
    document.getElementById('ringPercent').textContent   = '—';
    document.getElementById('ringPhase').textContent     = 'SLEEPING';
    document.getElementById('ringStatus').textContent    = '😴 Still sleeping';
    const hoursUntil = WAKE_HOUR - hours;
    document.getElementById('ringRemaining').textContent = fmtHm(hoursUntil) + ' until wake-up';
  } else if (hours >= SLEEP_HOUR) {
    ringFill.setAttribute('stroke', '#E25D7A');
    ringFill.style.strokeDashoffset = 0;
    document.getElementById('ringPercent').textContent   = '100%';
    document.getElementById('ringPhase').textContent     = 'PAST BEDTIME';
    document.getElementById('ringStatus').textContent    = '⚠️ Past bedtime';
    document.getElementById('ringRemaining').textContent = 'Sleep!';
  } else {
    const pct = (hours - WAKE_HOUR) / (SLEEP_HOUR - WAKE_HOUR) * 100;
    const offset = C * (1 - pct/100);
    ringFill.style.strokeDashoffset = offset;
    ringFill.setAttribute('stroke', getSunColor(pct));
    document.getElementById('ringPercent').textContent = Math.round(pct) + '%';

    let phase, status;
    if      (pct < 25) { phase = 'MORNING';   status = '☀️ Morning — fresh start'; }
    else if (pct < 50) { phase = 'MIDDAY';    status = '⚡ Midday — keep moving'; }
    else if (pct < 75) { phase = 'AFTERNOON'; status = '🔥 Afternoon — push it'; }
    else if (pct < 90) { phase = 'EVENING';   status = '⏳ Evening — wrap up'; }
    else               { phase = 'BEDTIME';   status = '🌙 Bedtime soon'; }

    document.getElementById('ringPhase').textContent    = phase;
    document.getElementById('ringStatus').textContent   = status;
    const remaining = SLEEP_HOUR - hours;
    document.getElementById('ringRemaining').textContent = fmtHm(remaining) + ' awake time left';
  }
}

// ── GOAL TICKER ───────────────────────────────────────────────────────────────
let tickerCycleIdx = 0;
let tickerInterval = null;

function getTickerItems() {
  const key   = 'goals:' + getActiveDateString();
  const goals = storeGet(key) || [];
  const total = goals.length;
  const done  = goals.filter(g => g.done).length;

  if (total === 0) return { items: [{ status: 'empty', text: 'No goals set for today — add one to get rolling.' }], done: 0, total: 0 };
  if (done === total) return { items: [{ status: 'done', text: '✓ All goals done — solid day.' }], done, total };

  const pending = goals.filter(g => !g.done).map(g => ({ status: 'pending', text: g.text }));
  return { items: pending, done, total };
}

function tick(isFirst) {
  const { items, done, total } = getTickerItems();
  const stage = document.getElementById('goalTickerStage');
  const meta  = document.getElementById('goalTickerMeta');

  if (tickerCycleIdx >= items.length) tickerCycleIdx = 0;
  const item = items[tickerCycleIdx];
  tickerCycleIdx = (tickerCycleIdx + 1) % items.length;

  meta.textContent = `${done}/${total}`;

  const newRow = document.createElement('div');
  newRow.className = 'goal-ticker-row';

  const statusEl = document.createElement('span');
  statusEl.className = 'goal-ticker-status';
  statusEl.dataset.status = item.status;
  statusEl.textContent = item.status === 'done' ? '✓' : item.status === 'pending' ? '○' : '·';

  const textEl = document.createElement('span');
  textEl.className = 'goal-ticker-text';
  textEl.textContent = item.text;

  newRow.appendChild(statusEl);
  newRow.appendChild(textEl);

  if (isFirst) {
    stage.innerHTML = '';
    stage.appendChild(newRow);
    return;
  }

  const oldRow = stage.querySelector('.goal-ticker-row');
  if (oldRow) {
    oldRow.classList.add('is-leaving');
    setTimeout(() => { if (oldRow.parentNode) oldRow.parentNode.removeChild(oldRow); }, 460);
  }

  newRow.classList.add('is-entering');
  stage.appendChild(newRow);
}

function startTicker() {
  tick(true);
  tickerInterval = setInterval(() => tick(false), 5000);
}

window.addEventListener('goals-changed', () => {
  tickerCycleIdx = 0;
  tick(false);
});

// ── GOOGLE CALENDAR INTEGRATION ───────────────────────────────────────────────
(function () {
  const PROXY = '';
  let currentEvents = [];

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function fmtRange(startIso, endIso) {
    const s = new Date(startIso), e = new Date(endIso);
    const sAmpm = s.getHours() >= 12 ? 'PM' : 'AM';
    const eAmpm = e.getHours() >= 12 ? 'PM' : 'AM';
    function fmt(d, showAmpm) {
      let h = d.getHours() % 12 || 12;
      const m = d.getMinutes();
      return h + (m ? ':' + String(m).padStart(2, '0') : '') + (showAmpm ? ' ' + (d.getHours() >= 12 ? 'PM' : 'AM') : '');
    }
    return fmt(s, sAmpm !== eAmpm) + ' – ' + fmt(e, true);
  }

  function fmtDateLabel() {
    const d = new Date();
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
  }

  function eventClass(ev) {
    if (ev.allDay) return '';
    const now = new Date();
    const start = new Date(ev.start);
    const end   = new Date(ev.end);
    if (end   < now) return 'is-past';
    if (start <= now) return 'is-now';
    return '';
  }

  // ── Completion state (stored locally — Google Calendar has no "done" flag) ────
  function doneKey() { return 'cal_done:' + todayStr(); }
  function getDoneSet() {
    try { return new Set(JSON.parse(localStorage.getItem(doneKey())) || []); }
    catch { return new Set(); }
  }
  function setDone(id, done) {
    const s = getDoneSet();
    if (done) s.add(id); else s.delete(id);
    localStorage.setItem(doneKey(), JSON.stringify([...s]));
  }

  // ── Status line helper ────────────────────────────────────────────────────────
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

  // ── PATCH an event through the proxy, with optimistic local update ────────────
  async function patchEvent(ev, body, el) {
    if (el) el.classList.add('cal-saving');
    try {
      const res = await fetch(PROXY + '/api/events/' + encodeURIComponent(ev.id), {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const updated = await res.json();
      Object.assign(ev, updated);
      flashSaved(el);
    } catch {
      showCalStatus('Update failed — is the proxy running?', true);
      loadEvents(); // fall back to server truth
    } finally {
      if (el) el.classList.remove('cal-saving');
    }
  }

  // ── Inline text edit (title / notes) ──────────────────────────────────────────
  function restoreField(el, ev, field) {
    if (field === 'notes') el.textContent = ev.notes ? ev.notes.split('\n')[0] : '';
    else                   el.textContent = ev.title;
  }

  function makeFieldEdit(el, ev, field) {
    el.classList.add('cal-editable');
    el.addEventListener('click', () => {
      if (el.querySelector('input')) return;
      const current = (field === 'notes' ? ev.notes : ev.title) || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cal-edit-input';
      input.value = current;
      el.textContent = '';
      el.appendChild(input);
      input.focus();
      input.select();

      let done = false;
      const commit = (save) => {
        if (done) return;
        done = true;
        const val = input.value.trim();
        if (save && val !== current.trim()) {
          ev[field] = val;
          restoreField(el, ev, field);
          patchEvent(ev, field === 'title' ? { title: val } : { notes: val }, el);
        } else {
          restoreField(el, ev, field);
        }
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      input.addEventListener('blur', () => commit(true));
    });
  }

  // ── Inline duration edit (start / end time inputs) ────────────────────────────
  function isoWithTime(originalIso, hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(originalIso);
    d.setHours(h, m, 0, 0);
    return toLocalISO(d);
  }

  function timeInput(d) {
    const i = document.createElement('input');
    i.type  = 'time';
    i.className = 'cal-edit-time';
    i.value = padZ(d.getHours()) + ':' + padZ(d.getMinutes());
    return i;
  }

  function microBtn(label, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cal-mini-btn ' + cls;
    b.textContent = label;
    return b;
  }

  function makeDurationEdit(el, ev) {
    el.classList.add('cal-editable');
    el.addEventListener('click', () => {
      if (el.querySelector('.cal-dur-edit')) return;
      const startIn = timeInput(new Date(ev.start));
      const endIn   = timeInput(new Date(ev.end));
      const ok      = microBtn('✓', 'cal-mini-save');
      const cancel  = microBtn('×', 'cal-mini-cancel');
      const wrap = document.createElement('span');
      wrap.className = 'cal-dur-edit';
      wrap.append(startIn, document.createTextNode('–'), endIn, ok, cancel);
      el.textContent = '';
      el.appendChild(wrap);
      startIn.focus();

      const close = () => { el.textContent = fmtRange(ev.start, ev.end); };
      ok.addEventListener('click', e => {
        e.stopPropagation();
        const newStart = isoWithTime(ev.start, startIn.value);
        const newEnd   = isoWithTime(ev.end,   endIn.value);
        ev.start = newStart; ev.end = newEnd;
        // Re-sort + re-render instantly so the row jumps to its new slot.
        sortEvents();
        renderEvents(currentEvents);
        patchEvent(ev, { startTime: newStart, endTime: newEnd }, null);
      });
      cancel.addEventListener('click', e => { e.stopPropagation(); close(); });
      wrap.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); ok.click(); }
        if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
    });
  }

  // ── Build one interactive event row (4 columns) ───────────────────────────────
  function buildEventRow(ev) {
    const isDone = getDoneSet().has(ev.id);
    const li = document.createElement('li');
    li.className = 'cal-event-item ' + eventClass(ev) + (isDone ? ' is-done' : '');
    li.dataset.id = ev.id;

    // Column 1 — Duration
    const dur = document.createElement('div');
    dur.className = 'cal-event-time';
    dur.textContent = ev.allDay ? 'all day' : fmtRange(ev.start, ev.end);
    if (!ev.allDay) makeDurationEdit(dur, ev);
    li.appendChild(dur);

    // Column 2 — Event name
    const title = document.createElement('div');
    title.className = 'cal-event-title';
    title.textContent = ev.title;
    makeFieldEdit(title, ev, 'title');
    li.appendChild(title);

    // Column 3 — Description
    const notes = document.createElement('div');
    notes.className = 'cal-event-notes';
    notes.dataset.placeholder = 'Add note…';
    notes.textContent = ev.notes ? ev.notes.split('\n')[0] : '';
    makeFieldEdit(notes, ev, 'notes');
    li.appendChild(notes);

    // Column 4 — Completion check
    const cbWrap = document.createElement('label');
    cbWrap.className = 'cal-event-check';
    cbWrap.title = 'Mark complete';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isDone;
    const cbCustom = document.createElement('span');
    cbCustom.className = 'cal-check-custom';
    cb.addEventListener('change', () => {
      setDone(ev.id, cb.checked);
      li.classList.toggle('is-done', cb.checked);
      updateCount();
    });
    cbWrap.appendChild(cb);
    cbWrap.appendChild(cbCustom);
    li.appendChild(cbWrap);

    return li;
  }

  function updateCount() {
    const count = document.getElementById('calEventCount');
    if (!currentEvents.length) { count.textContent = 'nothing scheduled'; return; }
    const doneSet = getDoneSet();
    const doneCount = currentEvents.filter(ev => doneSet.has(ev.id)).length;
    count.textContent = currentEvents.length + ' event' + (currentEvents.length !== 1 ? 's' : '') +
      (doneCount ? ' · ' + doneCount + ' done' : '');
  }

  function sortEvents() {
    currentEvents.sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  function renderEvents(events) {
    currentEvents = events;
    const list = document.getElementById('calEventList');
    list.innerHTML = '';
    if (!events.length) {
      list.innerHTML = '<li class="cal-empty">No events today</li>';
      updateCount();
      return;
    }
    events.forEach(ev => list.appendChild(buildEventRow(ev)));
    updateCount();
  }

  async function loadEvents() {
    const offlineEl  = document.getElementById('calOfflineMsg');
    const countEl    = document.getElementById('calEventCount');
    const refreshBtn = document.getElementById('calRefreshBtn');
    refreshBtn.classList.add('spinning');
    setTimeout(() => refreshBtn.classList.remove('spinning'), 700);
    try {
      const res = await fetch(PROXY + '/api/events?date=' + todayStr(), { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const events = await res.json();
      offlineEl.style.display = 'none';
      renderEvents(events);
    } catch {
      offlineEl.style.display = 'block';
      countEl.textContent = 'proxy offline';
      document.getElementById('calEventList').innerHTML = '';
    }
  }

  function toLocalISO(dt) {
    const p = n => String(n).padStart(2, '0');
    const off = -dt.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs  = Math.abs(off);
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) +
      'T' + p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':00' +
      sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60);
  }

  async function addEvent() {
    const titleEl  = document.getElementById('calTaskInput');
    const descEl   = document.getElementById('calDescInput');
    const timeEl   = document.getElementById('calTimeInput');
    const statusEl = document.getElementById('calStatus');
    const addBtn   = document.getElementById('calAddBtn');
    const title    = titleEl.value.trim();
    if (!title) { titleEl.focus(); return; }

    const durEl   = document.getElementById('calDurInput');
    const dur     = Math.max(1, parseInt(durEl.value) || 15);
    const [h, m]  = timeEl.value.split(':').map(Number);
    const startDt = new Date();
    startDt.setHours(h, m, 0, 0);
    const endDt = new Date(startDt.getTime() + dur * 60 * 1000);

    addBtn.disabled = true;
    statusEl.textContent = 'Scheduling…';
    statusEl.classList.remove('is-error');

    try {
      const res = await fetch(PROXY + '/api/events', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          notes:     descEl.value.trim() || undefined,
          date:      todayStr(),
          startTime: toLocalISO(startDt),
          endTime:   toLocalISO(endDt),
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      titleEl.value = '';
      descEl.value  = '';
      statusEl.textContent = '✓ Added to Google Calendar';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
      loadEvents();
    } catch {
      statusEl.textContent = 'Failed — is the proxy running?';
      statusEl.classList.add('is-error');
      setTimeout(() => { statusEl.textContent = ''; statusEl.classList.remove('is-error'); }, 4000);
    }
    addBtn.disabled = false;
  }

  document.getElementById('calDateLabel').textContent = fmtDateLabel();
  document.getElementById('calRefreshBtn').addEventListener('click', loadEvents);
  document.getElementById('calAddBtn').addEventListener('click', addEvent);
  document.getElementById('calTaskInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addEvent();
  });
  loadEvents();
  setInterval(loadEvents, 5 * 60 * 1000);
})();

// ── INIT ──────────────────────────────────────────────────────────────────────
runRollover();
runStreakCheck();

makeAddHandlers(
  document.getElementById('goalInput'),
  document.getElementById('goalAddBtn'),
  'goals:' + getActiveDateString(),
  loadToday
);

makeAddHandlers(
  document.getElementById('tomorrowInput'),
  document.getElementById('tomorrowAddBtn'),
  'goals:' + getTomorrowDateString(),
  loadTomorrow
);

loadToday();
loadTomorrow();
renderStreak();
updateDayRing();
setInterval(updateDayRing, 60 * 1000);
startTicker();
