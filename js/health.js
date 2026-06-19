/* =============================================================
   health.js — all logic for health.html (Daily Stack + Water).
   Loaded with `defer`, so the DOM is parsed before this runs.
   Three sections: CONFIG (water defaults), the Daily Stack IIFE,
   the Water Tracker IIFE, and the unified cloud-sync wiring.
   ============================================================= */

// ===================== Water Tracker config (edit to taste) =====================
const CONFIG = {
  appTitle: "Water Coach",

  // Default unit. Options: "bottle" | "glass" | "oz" | "ml"
  unit: "bottle",

  // Volume per "bottle" / "glass" in ml. 500 = standard water bottle,
  // 250 = a typical drinking glass.
  bottleMl: 500,
  glassMl: 250,

  // Default user profile (gets overwritten by what you save in Settings).
  profile: {
    weightKg: 75,
    age: 25,
    sex: "m",            // "m" | "f" | "o"
    activityHrsPerWeek: 5
  },

  // Default daily caffeine in mg (200 mg ≈ two cups of coffee).
  caffeineMgPerDay: 200,

  // Pre-loaded substances. The Settings → Stimulants & meds search uses
  // this list; users can add custom entries with `extraWaterMl` each.
  // Numbers are conservative additions to daily water needs based on
  // peer-reviewed effects (diuresis, dry-mouth, reduced thirst signal,
  // narrow-therapeutic-window safety bumps).
  defaultSubstances: []
};

// ===================== Daily Stack =====================
(() => {
  'use strict';

  const storeGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const storeSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  function getActiveDate() {
    const now = new Date();
    if (now.getHours() < 6) now.setDate(now.getDate() - 1);
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const TEMPLATE_VERSION = 5;

  const STACK_DEFAULTS = [
    { id: 'm1', name: 'XXXXX - Supplement of choice', dose: '', window: 'morning', note: 'how much MG, meal times, any data below', tag: null,    ordered: true  },
    { id: 'm2', name: 'XXXXX - Supplement of choice', dose: '', window: 'morning', note: 'how much MG, meal times, any data below', tag: 'stack', ordered: true  },
    { id: 'm3', name: 'XXXXX - Supplement of choice', dose: '', window: 'morning', note: 'how much MG, meal times, any data below', tag: null,    ordered: true  },
    { id: 'l1', name: 'XXXXX - Supplement of choice', dose: '', window: 'lunch',   note: 'how much MG, meal times, any data below', tag: null,    ordered: true  },
    { id: 'l2', name: 'XXXXX - Supplement of choice', dose: '', window: 'lunch',   note: 'how much MG, meal times, any data below', tag: null,    ordered: true  },
    { id: 'e1', name: 'XXXXX - Supplement of choice', dose: '', window: 'evening', note: 'how much MG, meal times, any data below', tag: null,    ordered: true  },
    { id: 'e2', name: 'XXXXX - Supplement of choice', dose: '', window: 'evening', note: 'how much MG, meal times, any data below', tag: 'not-ordered', ordered: false },
    { id: 'e3', name: 'XXXXX - Supplement of choice', dose: '', window: 'evening', note: 'how much MG, meal times, any data below', tag: null,    ordered: true  },
  ];

  const STACK_WINDOWS = [
    { key: 'morning', icon: '🌅', title: 'Morning', time: '7–10 AM', cutoffHour: 10 },
    { key: 'lunch',   icon: '🍽️', title: 'Lunch',   time: '12–2 PM', cutoffHour: 14 },
    { key: 'evening', icon: '🌙', title: 'Evening', time: '9–11 PM', cutoffHour: 23 },
    { key: 'anytime', icon: '⏱️', title: 'Anytime', time: 'No fixed window', cutoffHour: null },
  ];

  // ====== SUPPLEMENT DATABASE — researched defaults ======
  const SUPPLEMENT_DB = [
    { name: 'Creatine monohydrate', dose: '5g', window: 'anytime', note: 'Daily — consistency matters more than timing', icon: '🏋️', aliases: ['creatine'] },
    { name: 'Beta-alanine', dose: '2–5g', window: 'morning', note: 'Pre-workout — split doses to avoid tingles', icon: '🏋️', aliases: ['beta alanine'] },
    { name: 'L-citrulline', dose: '6–8g', window: 'morning', note: '~30 min pre-workout for pump', icon: '🏋️', aliases: ['citrulline'] },
    { name: 'BCAAs', dose: '5–10g', window: 'anytime', note: 'Around workout window', icon: '🏋️', aliases: ['bcaa'] },
    { name: 'Whey protein', dose: '25–40g', window: 'anytime', note: 'Post-workout or to hit daily target', icon: '🥤', aliases: ['whey'] },
    { name: 'Casein protein', dose: '25–40g', window: 'evening', note: 'Before bed for slow overnight aminos', icon: '🥤', aliases: ['casein'] },
    { name: 'L-carnitine', dose: '1–2g', window: 'morning', note: 'With carbs for best uptake', icon: '🏋️', aliases: ['carnitine'] },
    { name: 'Acetyl-L-carnitine', dose: '500mg–2g', window: 'morning', note: 'Cognitive variant — crosses BBB', icon: '🧠', aliases: ['alcar'] },
    { name: 'HMB', dose: '3g', window: 'anytime', note: 'Split 3x daily — muscle preservation', icon: '🏋️', aliases: ['hmb'] },
    { name: 'Glutamine', dose: '5g', window: 'anytime', note: 'Recovery — post-workout or before bed', icon: '🏋️', aliases: ['l-glutamine'] },
    { name: 'Vitamin D3', dose: '2000–5000 IU', window: 'lunch', note: 'Fat-soluble — take with biggest meal', icon: '☀️', aliases: ['vit d', 'vitamin d', 'd3', 'cholecalciferol'] },
    { name: 'Vitamin K2 (MK-7)', dose: '100–200 mcg', window: 'lunch', note: 'Pairs with D3 — same meal', icon: '💊', aliases: ['vit k', 'vitamin k', 'k2', 'mk7'] },
    { name: 'Vitamin C', dose: '500–1000mg', window: 'morning', note: 'Water-soluble — split if over 500mg', icon: '🍊', aliases: ['vit c', 'ascorbic acid'] },
    { name: 'Vitamin B12', dose: '500–1000mcg', window: 'morning', note: 'Methylcobalamin form preferred', icon: '⚡', aliases: ['b12', 'methylcobalamin'] },
    { name: 'B-complex', dose: '1 cap', window: 'morning', note: 'All B vitamins — energy', icon: '⚡', aliases: ['b complex', 'b vitamins'] },
    { name: 'Vitamin A', dose: '5000 IU', window: 'lunch', note: 'Fat-soluble — with fat', icon: '💊', aliases: ['vit a', 'retinol'] },
    { name: 'Vitamin E', dose: '400 IU', window: 'lunch', note: 'Fat-soluble — with fat', icon: '💊', aliases: ['vit e', 'tocopherol'] },
    { name: 'Folate', dose: '400–800mcg', window: 'morning', note: 'Methylfolate preferred', icon: '💊', aliases: ['folic acid', 'b9', 'methylfolate'] },
    { name: 'Biotin', dose: '30mcg–5mg', window: 'anytime', note: 'Hair, skin, nails', icon: '💅', aliases: ['biotin', 'b7'] },
    { name: 'Multivitamin', dose: '1 serving', window: 'lunch', note: 'Take with food', icon: '💊', aliases: ['multi', 'multivitamin'] },
    { name: 'Magnesium glycinate', dose: '200–400mg', window: 'evening', note: '30–60 min before bed — sleep helper', icon: '🌙', aliases: ['magnesium', 'mag glycinate', 'bisglycinate'] },
    { name: 'Magnesium L-threonate', dose: '144mg elemental', window: 'evening', note: 'Cognitive variant — crosses BBB', icon: '🧠', aliases: ['magtein', 'threonate'] },
    { name: 'Magnesium citrate', dose: '200–400mg', window: 'evening', note: 'Also supports digestion', icon: '🌙', aliases: ['mag citrate'] },
    { name: 'Zinc', dose: '15–30mg', window: 'evening', note: 'With food — not with calcium or iron', icon: '💊', aliases: ['zinc'] },
    { name: 'Iron', dose: '18–65mg', window: 'morning', note: 'Empty stomach with vit C', icon: '💊', aliases: ['iron'] },
    { name: 'Calcium', dose: '500mg', window: 'evening', note: 'With food — not with iron', icon: '🦴', aliases: ['calcium'] },
    { name: 'Selenium', dose: '100–200mcg', window: 'anytime', note: 'Thyroid + antioxidant', icon: '💊', aliases: ['selenium'] },
    { name: 'Iodine', dose: '150mcg', window: 'morning', note: 'Thyroid support', icon: '💊', aliases: ['iodine'] },
    { name: 'Omega-3 (Fish oil)', dose: '2–3g EPA+DHA', window: 'lunch', note: 'With biggest fatty meal', icon: '🐟', aliases: ['omega 3', 'omega3', 'fish oil', 'epa', 'dha'] },
    { name: 'Krill oil', dose: '500–1000mg', window: 'lunch', note: 'More absorbable than fish oil', icon: '🐟', aliases: ['krill'] },
    { name: 'MCT oil', dose: '1–2 tbsp', window: 'morning', note: 'Fast energy — start low', icon: '🥥', aliases: ['mct'] },
    { name: 'Flaxseed oil', dose: '1–2g', window: 'lunch', note: 'Plant omega-3 — with food', icon: '🌱', aliases: ['flax', 'flaxseed'] },
    { name: 'L-theanine', dose: '100–200mg', window: 'morning', note: 'Stacks with caffeine 2:1', icon: '🧠', aliases: ['theanine'] },
    { name: 'Caffeine', dose: '100–200mg', window: 'morning', note: 'Stack with L-theanine for cleaner focus', icon: '☕', aliases: ['caffeine'] },
    { name: 'Rhodiola rosea', dose: '200–400mg', window: 'morning', note: 'Adaptogen — energy and stress', icon: '🌿', aliases: ['rhodiola'] },
    { name: 'Lion\'s mane', dose: '500–1000mg', window: 'morning', note: 'Cognitive support — daily', icon: '🍄', aliases: ['lions mane', 'hericium'] },
    { name: 'Bacopa monnieri', dose: '300–600mg', window: 'morning', note: 'With fat — long-term memory', icon: '🌿', aliases: ['bacopa'] },
    { name: 'Ginkgo biloba', dose: '120–240mg', window: 'morning', note: 'Circulation and cognition', icon: '🌿', aliases: ['ginkgo'] },
    { name: 'Alpha-GPC', dose: '300–600mg', window: 'morning', note: 'Choline — focus and learning', icon: '🧠', aliases: ['alpha gpc'] },
    { name: 'Phosphatidylserine', dose: '100–300mg', window: 'evening', note: 'Cortisol regulation', icon: '🧠', aliases: ['ps'] },
    { name: 'NAC', dose: '600–1800mg', window: 'morning', note: 'Glutathione precursor — split doses', icon: '💊', aliases: ['nac', 'n-acetyl cysteine'] },
    { name: 'Melatonin', dose: '0.3–3mg', window: 'evening', note: '30–60 min before bed — start low', icon: '🌙', aliases: ['melatonin'] },
    { name: 'Glycine', dose: '3g', window: 'evening', note: 'Body temp drop = better sleep onset', icon: '🌙', aliases: ['glycine'] },
    { name: 'Apigenin', dose: '50mg', window: 'evening', note: 'From chamomile — before bed', icon: '🌙', aliases: ['apigenin'] },
    { name: 'Ashwagandha', dose: '300–600mg', window: 'evening', note: 'KSM-66 form — stress and cortisol', icon: '🌿', aliases: ['ashwagandha', 'ksm-66'] },
    { name: 'L-tryptophan', dose: '500mg–1g', window: 'evening', note: 'Serotonin precursor — sleep onset', icon: '🌙', aliases: ['tryptophan'] },
    { name: 'GABA', dose: '500–750mg', window: 'evening', note: 'Calming — before bed', icon: '🌙', aliases: ['gaba'] },
    { name: 'Valerian root', dose: '300–600mg', window: 'evening', note: 'Sleep onset support', icon: '🌙', aliases: ['valerian'] },
    { name: 'Probiotics', dose: '10–50 billion CFU', window: 'morning', note: 'Empty stomach or with food', icon: '🦠', aliases: ['probiotic'] },
    { name: 'Quercetin', dose: '500–1000mg', window: 'anytime', note: 'Pairs well with vitamin C', icon: '🌿', aliases: ['quercetin'] },
    { name: 'Curcumin', dose: '500–1000mg', window: 'lunch', note: 'With black pepper + fat', icon: '🌿', aliases: ['curcumin', 'turmeric'] },
    { name: 'Resveratrol', dose: '250–500mg', window: 'morning', note: 'With fat for absorption', icon: '🍇', aliases: ['resveratrol'] },
    { name: 'CoQ10 / Ubiquinol', dose: '100–200mg', window: 'lunch', note: 'Fat-soluble — with biggest meal', icon: '💊', aliases: ['coq10', 'ubiquinol'] },
    { name: 'Alpha lipoic acid', dose: '300–600mg', window: 'morning', note: 'Empty stomach for absorption', icon: '💊', aliases: ['ala', 'alpha lipoic'] },
    { name: 'Glutathione', dose: '250–1000mg', window: 'morning', note: 'Liposomal form for absorption', icon: '💊', aliases: ['glutathione'] },
    { name: 'Astaxanthin', dose: '4–12mg', window: 'lunch', note: 'Fat-soluble — with fatty meal', icon: '💊', aliases: ['astaxanthin'] },
    { name: 'Berberine', dose: '500mg', window: 'lunch', note: 'Before meals — glucose support', icon: '💊', aliases: ['berberine'] },
    { name: 'Milk thistle', dose: '200–400mg', window: 'anytime', note: 'Silymarin — liver support', icon: '🌿', aliases: ['milk thistle', 'silymarin'] },
    { name: 'Spirulina', dose: '3–5g', window: 'morning', note: 'Algae — protein and antioxidants', icon: '🌱', aliases: ['spirulina'] },
    { name: 'Chlorella', dose: '2–4g', window: 'morning', note: 'Algae — detox support', icon: '🌱', aliases: ['chlorella'] },
    { name: 'Tongkat ali', dose: '200–400mg', window: 'morning', note: 'Cycle 8 weeks on/off', icon: '🌿', aliases: ['tongkat', 'longjack'] },
    { name: 'Fadogia agrestis', dose: '600mg', window: 'morning', note: 'Cycle 8 weeks on/off', icon: '🌿', aliases: ['fadogia'] },
    { name: 'DHEA', dose: '25–50mg', window: 'morning', note: 'Hormonal — consult doctor', icon: '💊', aliases: ['dhea'] },
    { name: 'Pregnenolone', dose: '10–50mg', window: 'morning', note: 'Hormonal — consult doctor', icon: '💊', aliases: ['pregnenolone'] },
    { name: 'Tribulus terrestris', dose: '250–750mg', window: 'morning', note: 'Libido and energy', icon: '🌿', aliases: ['tribulus'] },
    { name: 'Maca root', dose: '1.5–3g', window: 'morning', note: 'Adaptogen — energy and libido', icon: '🌿', aliases: ['maca'] },
    { name: 'Collagen peptides', dose: '10–20g', window: 'anytime', note: 'With vitamin C for synthesis', icon: '💅', aliases: ['collagen'] },
    { name: 'Glucosamine', dose: '1500mg', window: 'lunch', note: 'With food', icon: '🦴', aliases: ['glucosamine'] },
    { name: 'Chondroitin', dose: '1200mg', window: 'lunch', note: 'Often paired with glucosamine', icon: '🦴', aliases: ['chondroitin'] },
    { name: 'MSM', dose: '1–3g', window: 'anytime', note: 'Joint support', icon: '🦴', aliases: ['msm'] },
    { name: 'Hyaluronic acid', dose: '120–200mg', window: 'anytime', note: 'Skin and joint hydration', icon: '💅', aliases: ['hyaluronic', 'ha'] },
    { name: 'Cordyceps', dose: '1–3g', window: 'morning', note: 'Energy and endurance', icon: '🍄', aliases: ['cordyceps'] },
    { name: 'Reishi', dose: '1–2g', window: 'evening', note: 'Calming adaptogen', icon: '🍄', aliases: ['reishi', 'ganoderma'] },
    { name: 'Chaga', dose: '1–2g', window: 'morning', note: 'Antioxidant and immune', icon: '🍄', aliases: ['chaga'] },
  ];

  let todayKey = `stack:taken:${getActiveDate()}`;

  function getItems() {
    const storedVersion = storeGet('stack:version');
    const stored = storeGet('stack:items');
    if (!stored || !Array.isArray(stored) || !stored.length || storedVersion !== TEMPLATE_VERSION) {
      const fresh = JSON.parse(JSON.stringify(STACK_DEFAULTS));
      storeSet('stack:items', fresh);
      storeSet('stack:version', TEMPLATE_VERSION);
      return fresh;
    }
    return stored;
  }
  function setItems(items) { storeSet('stack:items', items); }
  function getTaken() { return storeGet(todayKey) || {}; }
  function setTaken(map) { storeSet(todayKey, map); }
  function getLow() { return storeGet('stack:low') || []; }
  function setLow(arr) { storeSet('stack:low', arr); }

  function toggleTaken(id) {
    const taken = getTaken();
    if (taken[id]) delete taken[id]; else taken[id] = Date.now();
    setTaken(taken); render();
  }
  function toggleLow(id) {
    const low = getLow();
    if (low.includes(id)) setLow(low.filter(x => x !== id));
    else { low.push(id); setLow(low); }
    render();
  }
  function deleteItem(id) {
    setItems(getItems().filter(i => i.id !== id));
    const taken = getTaken();
    delete taken[id];
    setTaken(taken);
    setLow(getLow().filter(x => x !== id));
    render();
  }
  function addItem(name, dose, windowKey, note = '') {
    const v = String(name || '').trim();
    if (!v) return;
    const items = getItems();
    const id = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    items.push({
      id, name: v,
      dose: String(dose || '').trim(),
      window: ['morning','lunch','evening','anytime'].includes(windowKey) ? windowKey : 'anytime',
      note: String(note || '').trim(),
      tag: null, ordered: true
    });
    setItems(items);
    render();
  }
  function updateItem(id, field, value) {
    const items = getItems();
    const item = items.find(i => i.id === id);
    if (!item) return;
    item[field] = value;
    setItems(items);
  }

  function render() {
    const items = getItems();
    const taken = getTaken();
    const low = getLow();
    const totalCount = items.length;
    const takenCount = items.filter(i => taken[i.id]).length;
    document.getElementById('stackProgressText').textContent =
      `${takenCount} / ${totalCount} taken today · resets at 6 AM`;
    const pct = totalCount === 0 ? 0 : (takenCount / totalCount) * 100;
    document.getElementById('stackProgressBar').style.width = pct + '%';

    const groupsEl = document.getElementById('stackGroups');
    groupsEl.innerHTML = '';

    const now = new Date();
    const nowHour = now.getHours() + (now.getMinutes() / 60);

    STACK_WINDOWS.forEach(win => {
      const winItems = items.filter(i => (i.window || 'anytime') === win.key);
      if (winItems.length === 0) return;

      const group = document.createElement('div');
      group.className = 'stack-window';
      group.innerHTML = `
        <div class="stack-window-header">
          <span class="stack-window-icon">${win.icon}</span>
          <span class="stack-window-title">${win.title}</span>
          <span class="stack-window-time">${win.time}</span>
        </div>`;

      const isPastCutoff = win.cutoffHour !== null && nowHour > win.cutoffHour;

      winItems.forEach(item => {
        const isTaken = !!taken[item.id];
        const isLow = low.includes(item.id);
        const isMissed = !isTaken && isPastCutoff;

        const row = document.createElement('div');
        row.className = 'stack-item' + (isTaken ? ' taken' : '') + (isMissed ? ' missed' : '');

        let tagHtml = '';
        if (item.tag === 'stack') tagHtml = '<span class="stack-item-tag tag-stack">stack</span>';
        else if (item.tag === 'not-ordered') tagHtml = '<span class="stack-item-tag tag-not-ordered">not ordered</span>';

        row.innerHTML = `
          <button class="stack-check ${isTaken ? 'checked' : ''}" data-action="toggle" data-id="${item.id}" aria-label="Mark taken">${isTaken ? '✓' : ''}</button>
          <div class="stack-item-body">
            <div class="stack-item-name" data-edit="name" data-id="${item.id}">
              <span class="stack-item-name-text">${escapeHtml(item.name)}</span>${tagHtml}
            </div>
            <div class="stack-item-meta" data-edit="meta" data-id="${item.id}">${escapeHtml(metaText(item))}</div>
          </div>
          <button class="stack-low-btn ${isLow ? 'is-low' : ''}" data-action="low" data-id="${item.id}">↓ Running low</button>
          <button class="stack-item-del" data-action="del" data-id="${item.id}" aria-label="Delete">×</button>`;

        group.appendChild(row);
      });

      groupsEl.appendChild(group);
    });

    if (groupsEl.children.length === 0) {
      groupsEl.innerHTML = `<div class="stack-window-empty">No items yet — add one below to start your stack.</div>`;
    }

    // Sync ticker after every render
    renderTicker();
  }

  // ====== TICKER ======
  let tickerIndex = 0;
  let tickerInterval = null;
  let cachedIssues = [];

  function getStackIssues() {
    const items = getItems();
    const taken = getTaken();
    const low = getLow();
    const now = new Date();
    const nowHour = now.getHours() + (now.getMinutes() / 60);

    const missed = [];
    const lowList = [];

    items.forEach(item => {
      const win = STACK_WINDOWS.find(w => w.key === (item.window || 'anytime'));
      const isPastCutoff = win && win.cutoffHour !== null && nowHour > win.cutoffHour;
      const isTaken = !!taken[item.id];
      if (isPastCutoff && !isTaken) {
        missed.push({
          type: 'missed',
          text: `${item.name} — missed ${win.title.toLowerCase()} dose`
        });
      }
      if (low.includes(item.id)) {
        lowList.push({
          type: 'low',
          text: `${item.name} — running low, reorder soon`
        });
      }
    });

    return [...missed, ...lowList];
  }

  function renderTicker() {
    const issues = getStackIssues();
    const tickerEl = document.getElementById('stackTicker');
    const msgEl = document.getElementById('stackTickerMsg');
    const countEl = document.getElementById('stackTickerCount');
    const totalItems = getItems().length;

    cachedIssues = issues;

    if (issues.length === 0) {
      msgEl.textContent = 'All caught up — keep it rolling';
      tickerEl.classList.remove('status-low', 'status-missed');
      countEl.textContent = `0/${totalItems}`;
      tickerIndex = 0;
      return;
    }

    const hasMissed = issues.some(i => i.type === 'missed');
    tickerEl.classList.remove('status-low', 'status-missed');
    tickerEl.classList.add(hasMissed ? 'status-missed' : 'status-low');

    if (tickerIndex >= issues.length) tickerIndex = 0;
    msgEl.textContent = issues[tickerIndex].text;
    countEl.textContent = `${issues.length}/${totalItems}`;
  }

  function cycleTicker() {
    if (cachedIssues.length <= 1) {
      renderTicker();
      return;
    }
    const msgEl = document.getElementById('stackTickerMsg');
    msgEl.classList.add('is-fading');
    setTimeout(() => {
      tickerIndex++;
      renderTicker();
      msgEl.classList.remove('is-fading');
    }, 280);
  }

  function startTicker() {
    if (tickerInterval) clearInterval(tickerInterval);
    tickerInterval = setInterval(cycleTicker, 5000);
  }

  function metaText(item) {
    const parts = [];
    if (item.dose) parts.push(item.dose);
    if (item.note) parts.push(item.note);
    return parts.join(' · ');
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  document.getElementById('stackGroups').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const id = btn.dataset.id;
    if (btn.dataset.action === 'toggle') toggleTaken(id);
    else if (btn.dataset.action === 'low') toggleLow(id);
    else if (btn.dataset.action === 'del') deleteItem(id);
  });
  document.getElementById('stackGroups').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-action="del"]');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    deleteItem(btn.dataset.id);
  });
  document.getElementById('stackGroups').addEventListener('click', (e) => {
    const editEl = e.target.closest('[data-edit]');
    if (!editEl) return;
    if (e.target.closest('[data-action]')) return;
    if (editEl.getAttribute('contenteditable') === 'true') return;
    startEdit(editEl);
  });

  function startEdit(el) {
    const id = el.dataset.id;
    const field = el.dataset.edit;
    if (field === 'name') {
      const textSpan = el.querySelector('.stack-item-name-text');
      if (!textSpan) return;
      textSpan.setAttribute('contenteditable', 'true');
      textSpan.style.outline = '1px solid rgba(255,255,255,0.25)';
      textSpan.style.outlineOffset = '4px';
      textSpan.style.borderRadius = '4px';
      textSpan.focus();
      placeCaretAtEnd(textSpan);
      const finish = (commit) => {
        textSpan.removeAttribute('contenteditable');
        textSpan.style.outline = ''; textSpan.style.outlineOffset = '';
        if (commit) {
          const newVal = textSpan.textContent.trim();
          if (newVal) updateItem(id, 'name', newVal); else render();
        } else render();
      };
      textSpan.addEventListener('blur', () => finish(true), { once: true });
      textSpan.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); textSpan.blur(); }
        if (e.key === 'Escape') { textSpan.blur(); render(); }
      });
    }
    if (field === 'meta') {
      el.setAttribute('contenteditable', 'true');
      el.focus(); placeCaretAtEnd(el);
      const finish = (commit) => {
        el.removeAttribute('contenteditable');
        if (commit) {
          const text = el.textContent.trim();
          const parts = text.split(/\s*·\s*/);
          updateItem(id, 'dose', parts[0] || '');
          updateItem(id, 'note', parts.slice(1).join(' · '));
        }
        render();
      };
      el.addEventListener('blur', () => finish(true), { once: true });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') { el.blur(); render(); }
      });
    }
  }

  function placeCaretAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ====== ADD FORM + SEARCH AUTOCOMPLETE ======
  const nameInput = document.getElementById('stackAddName');
  const doseInput = document.getElementById('stackAddDose');
  const winSelect = document.getElementById('stackAddWindow');
  const addBtn = document.getElementById('stackAddBtn');
  const resultsEl = document.getElementById('stackSearchResults');

  let pendingNote = ''; // hidden note auto-filled when a DB result is selected

  function searchSupplements(q) {
    const query = q.toLowerCase().trim();
    if (!query) return [];
    const starts = [];
    const contains = [];
    SUPPLEMENT_DB.forEach(s => {
      const nameLC = s.name.toLowerCase();
      const aliases = (s.aliases || []).map(a => a.toLowerCase());
      const allNames = [nameLC, ...aliases];
      if (allNames.some(n => n.startsWith(query))) starts.push(s);
      else if (allNames.some(n => n.includes(query))) contains.push(s);
    });
    return [...starts, ...contains].slice(0, 6);
  }

  function renderSearchResults(q) {
    const matches = searchSupplements(q);
    if (!q.trim() || matches.length === 0) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      return;
    }
    resultsEl.hidden = false;
    resultsEl.innerHTML = matches.map(s => {
      const winMeta = STACK_WINDOWS.find(w => w.key === s.window) || STACK_WINDOWS[3];
      return `
        <button class="stack-result" data-name="${escapeHtml(s.name)}" data-dose="${escapeHtml(s.dose)}" data-window="${s.window}" data-note="${escapeHtml(s.note)}">
          <div class="stack-result-icon">${s.icon || '💊'}</div>
          <div class="stack-result-body">
            <div class="stack-result-name">${escapeHtml(s.name)}</div>
            <div class="stack-result-meta">${escapeHtml(s.dose)} · ${winMeta.icon} ${winMeta.title.toLowerCase()} · ${escapeHtml(s.note)}</div>
          </div>
        </button>`;
    }).join('');
  }

  nameInput.addEventListener('input', () => {
    renderSearchResults(nameInput.value);
    pendingNote = ''; // reset note if user is typing manually
  });
  nameInput.addEventListener('focus', () => {
    if (nameInput.value.trim()) renderSearchResults(nameInput.value);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.stack-name-wrap')) resultsEl.hidden = true;
  });

  resultsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.stack-result');
    if (!btn) return;
    nameInput.value = btn.dataset.name;
    doseInput.value = btn.dataset.dose;
    winSelect.value = btn.dataset.window;
    pendingNote = btn.dataset.note;
    resultsEl.hidden = true;
    addBtn.focus();
  });

  addBtn.addEventListener('click', () => {
    addItem(nameInput.value, doseInput.value, winSelect.value, pendingNote);
    nameInput.value = '';
    doseInput.value = '';
    pendingNote = '';
    resultsEl.hidden = true;
    nameInput.focus();
  });

  [nameInput, doseInput].forEach(i => {
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // If search dropdown is open with matches, pick the first one
        if (!resultsEl.hidden && i === nameInput) {
          const firstResult = resultsEl.querySelector('.stack-result');
          if (firstResult) { e.preventDefault(); firstResult.click(); return; }
        }
        addBtn.click();
      }
      if (e.key === 'Escape') resultsEl.hidden = true;
    });
  });

  setInterval(() => {
    const newKey = `stack:taken:${getActiveDate()}`;
    if (newKey !== todayKey) todayKey = newKey;
    render();
  }, 60 * 1000);

  render();
  startTicker();
})();

// ===================== Water Tracker =====================
(function() {
  const $ = (id) => document.getElementById(id);

  // ============================================================
  // SUBSTANCE DATABASE — daily water bumps scale with YOUR dose.
  //
  // Each entry has:
  //   unit         — what you measure the dose in (mg, pouches/day, drinks/day…)
  //   defaultDose  — typical adult therapeutic dose (just a starting value)
  //   mlPerUnit    — extra ml of water needed per 1 unit of dose
  //
  // Final water bump for a substance you've added = dose × mlPerUnit.
  // So 36mg Concerta → 36 × 13.9 ≈ 500ml. 18mg Concerta → ≈ 250ml.
  //
  // Numbers based on conservative reads of:
  //   - ADHD stim diuresis + reduced thirst signal (Adler/Wilens reviews)
  //   - Lithium narrow therapeutic window (Cooper 2014, NICE guidelines)
  //   - Thiazide / loop diuretic SE profiles
  //   - Alcohol diuresis (Hobson 2010 — ~10ml urine per gram ethanol)
  // ============================================================
  const SUBSTANCE_DB = [
    { id: 'adderall',    name: 'Adderall (mixed amphetamine salts)', cat: 'ADHD stim',    unit: 'mg',           defaultDose: 20,   mlPerUnit: 25,    note: 'Stim · reduces thirst signal · dries you out' },
    { id: 'concerta',    name: 'Concerta (methylphenidate ER)',      cat: 'ADHD stim',    unit: 'mg',           defaultDose: 36,   mlPerUnit: 13.9,  note: 'Stim · reduces thirst signal' },
    { id: 'vyvanse',     name: 'Vyvanse (lisdexamfetamine)',         cat: 'ADHD stim',    unit: 'mg',           defaultDose: 50,   mlPerUnit: 10,    note: 'Stim prodrug · long acting' },
    { id: 'ritalin',     name: 'Ritalin IR (methylphenidate)',       cat: 'ADHD stim',    unit: 'mg',           defaultDose: 20,   mlPerUnit: 20,    note: 'Short-acting stim' },
    { id: 'focalin',     name: 'Focalin / Focalin XR',               cat: 'ADHD stim',    unit: 'mg',           defaultDose: 20,   mlPerUnit: 20,    note: 'Methylphenidate isomer' },
    { id: 'modafinil',   name: 'Modafinil',                          cat: 'Wakefulness',  unit: 'mg',           defaultDose: 200,  mlPerUnit: 1.75,  note: 'Mild dehydrating effect' },
    { id: 'lithium',     name: 'Lithium',                            cat: 'Mood',         unit: 'mg',           defaultDose: 600,  mlPerUnit: 1.67,  note: 'Critical — narrow therapeutic window, dehydration → toxicity' },
    { id: 'hctz',        name: 'Hydrochlorothiazide (HCTZ)',         cat: 'Diuretic',     unit: 'mg',           defaultDose: 25,   mlPerUnit: 40,    note: 'Direct diuretic — drink to compensate' },
    { id: 'lasix',       name: 'Furosemide (Lasix)',                 cat: 'Diuretic',     unit: 'mg',           defaultDose: 40,   mlPerUnit: 30,    note: 'Loop diuretic · talk to your doctor about target' },
    { id: 'spironol',    name: 'Spironolactone',                     cat: 'Diuretic',     unit: 'mg',           defaultDose: 50,   mlPerUnit: 12,    note: 'K-sparing diuretic' },
    { id: 'sudafed',     name: 'Pseudoephedrine (Sudafed)',          cat: 'Decongestant', unit: 'mg',           defaultDose: 60,   mlPerUnit: 4.17,  note: 'Sympathomimetic · dries mucous membranes' },
    { id: 'phenyl',      name: 'Phenylephrine',                      cat: 'Decongestant', unit: 'mg',           defaultDose: 10,   mlPerUnit: 20,    note: 'Vasoconstrictor — mild' },
    { id: 'nicotine',    name: 'Nicotine pouch (Velo / Zyn)',        cat: 'Stim',         unit: 'pouches/day',  defaultDose: 4,    mlPerUnit: 62.5,  note: 'Vasoconstriction + dry mouth' },
    { id: 'nicpatch',    name: 'Nicotine patch',                     cat: 'Stim',         unit: 'mg',           defaultDose: 14,   mlPerUnit: 18,    note: '24-h transdermal · sustained release' },
    { id: 'alcohol',     name: 'Alcohol',                            cat: 'Depressant',   unit: 'drinks/day',   defaultDose: 1,    mlPerUnit: 400,   note: '~10ml urine per gram ethanol — adds up fast' },
    { id: 'cannabis',    name: 'Cannabis / THC',                     cat: 'Other',        unit: 'sessions/day', defaultDose: 1,    mlPerUnit: 250,   note: 'Cottonmouth — saliva gland inhibition' },
    { id: 'creatine',    name: 'Creatine monohydrate',               cat: 'Supplement',   unit: 'g/day',        defaultDose: 5,    mlPerUnit: 80,    note: 'Pulls water into muscle cells — drink more' },
    { id: 'preworkout',  name: 'Pre-workout (caffeine + others)',    cat: 'Stim',         unit: 'servings/day', defaultDose: 1,    mlPerUnit: 300,   note: 'High-stim formula on top of caffeine' },
    { id: 'metformin',   name: 'Metformin',                          cat: 'Glucose',      unit: 'mg',           defaultDose: 1000, mlPerUnit: 0.3,   note: 'Mild GI fluid loss' },
    { id: 'sertraline',  name: 'SSRI (sertraline / escitalopram / fluoxetine)', cat: 'SSRI', unit: 'mg',         defaultDose: 50,   mlPerUnit: 4,     note: 'Mild dry mouth in some users' },
    { id: 'wellbutrin',  name: 'Bupropion (Wellbutrin)',             cat: 'NDRI',         unit: 'mg',           defaultDose: 300,  mlPerUnit: 1.17,  note: 'Stim-like profile' }
  ];

  // Compute the actual ml/day a saved substance contributes given the user's dose.
  function subExtraMl(s) {
    const dose = (s.dose != null ? s.dose : s.defaultDose) || 0;
    return Math.max(0, dose * (s.mlPerUnit || 0));
  }
  function subDoseLabel(s) {
    const dose = (s.dose != null ? s.dose : s.defaultDose);
    return dose + ' ' + (s.unit || '');
  }

  // ============================================================
  // STATE
  // ============================================================
  const LS_KEY = 'po_water_v1';
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return normalize(JSON.parse(raw));
    } catch (e) {}
    return normalize({});
  }
  function normalize(s) {
    s = s || {};
    // The main view now shows ONLY bottles or glasses (raw ml was removed as a
    // display option — it's tedious to track). Coerce any legacy value such as
    // 'ml' or 'oz' to bottles. Storage stays in ml regardless; this is display.
    s.bottleMl = s.bottleMl || CONFIG.bottleMl || 500;
    s.glassMl  = s.glassMl  || CONFIG.glassMl  || 250;
    // Optional third container the user defines (label + ml). customMl <= 0 means
    // "not configured": it's then excluded from the display/input cycles and any
    // saved 'custom' unit falls back to bottles.
    s.customMl = Math.max(0, Number(s.customMl) || Number(CONFIG.customMl) || 0);
    s.customLabel = String(s.customLabel || CONFIG.customLabel || 'Custom').slice(0, 16);
    // 'custom' is only a valid unit once a size is set; otherwise coerce to bottle
    // (this also folds any legacy 'ml'/'oz' display unit → bottle).
    const validUnit = (u) => u === 'glass' || u === 'bottle' || (u === 'custom' && s.customMl > 0);
    const prevUnit = s.unit;
    s.unit = validUnit(s.unit) ? s.unit : 'bottle';
    // Persist the coercion at boot (reusing the migration flag) so the stored
    // blob/sync stop carrying a dead/invalid display unit. Skips fresh state.
    if (prevUnit !== undefined && prevUnit !== s.unit) s.__migrated = true;
    // What each tap logs RIGHT NOW (independent of the display unit).
    s.inputMode = validUnit(s.inputMode) ? s.inputMode : 'bottle';
    s.weightUnit = s.weightUnit || 'kg';
    s.profile = Object.assign({}, CONFIG.profile, s.profile || {});
    // The "Other" sex option was removed. It contributed +0 ml (same as female),
    // so fold any saved 'o' into 'f' to preserve the computed target exactly.
    if (s.profile.sex === 'o') s.profile.sex = 'f';
    s.caffeineMgPerDay = (s.caffeineMgPerDay != null) ? s.caffeineMgPerDay : (CONFIG.caffeineMgPerDay || 200);
    s.substances = Array.isArray(s.substances) ? s.substances : (CONFIG.defaultSubstances || []);
    s.logs = (s.logs && typeof s.logs === 'object') ? s.logs : {};
    // ── v1 → v2 migration ──────────────────────────────────────────────
    // v1 stored logs as a COUNT of servings (bottles); v2 stores the absolute
    // daily total in ml so bottle/glass logging can be mixed freely. Convert
    // once using the saved bottle size — the only faithful conversion the old
    // count-based model allows — then stamp the version so it never re-runs.
    if (s.v !== 2) {
      const bMl = s.bottleMl || 500;
      const out = {};
      for (const k in s.logs) {
        const n = Number(s.logs[k]) || 0;
        if (n > 0) out[k] = Math.round(n * bMl);
      }
      s.logs = out;   // logs are now {YYYY-MM-DD: total_ml}
      s.v = 2;
      s.__migrated = true;   // transient — tells boot to persist the new shape
    }
    return s;
  }
  function saveState() {
    try {
      // Never persist the transient migration marker into storage/sync.
      const { __migrated, ...clean } = state;
      localStorage.setItem(LS_KEY, JSON.stringify(clean));
      // Notify the shared topbar (js/topbar.js) so its bubble re-renders in the
      // active unit immediately. A dedicated event (not 'storage') so the page
      // doesn't reload its own freshly-saved state. The embedded case also
      // reaches the parent topbar via the native cross-frame storage event.
      window.dispatchEvent(new CustomEvent('water:changed'));
    } catch (e) {}
  }
  let state = loadState();
  $('appTitle').textContent = CONFIG.appTitle || 'Water Coach';

  // Helpers
  function dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function todayKey() { return dateKey(new Date()); }
  // Source of truth for "today" is absolute ml. Servings are only ever a
  // display/input convenience derived from this number.
  function todayMl() { return state.logs[todayKey()] || 0; }
  function setTodayMl(ml) {
    const k = todayKey();
    ml = Math.max(0, Math.round(ml));
    if (ml <= 0) delete state.logs[k];
    else state.logs[k] = ml;
    saveState();
  }
  function addMl(delta) { setTodayMl(todayMl() + delta); }

  // ============================================================
  // CALCULATOR — daily water target in ml
  //
  //   base_ml    = weight_kg × 35 ml      (NAM/IOM standard)
  //   exercise   = activity_hrs/wk ÷ 7 × 500 ml/day   (≈500 ml/hr training)
  //   caffeine   = max(0, caffeineMg − 200) × 1.5 ml  (mild diuresis)
  //   substances = sum of extraMl for each added med/stim
  //   adjustments: +200 ml male, +100 ml age 50+
  // ============================================================
  function computeTargetMl() {
    const p = state.profile;
    const wKg = state.weightUnit === 'lb' ? p.weightKg / 2.20462 : p.weightKg;
    const base = wKg * 35;
    const exercise = (p.activityHrsPerWeek || 0) / 7 * 500;
    const caffeine = Math.max(0, (state.caffeineMgPerDay || 0) - 200) * 1.5;
    const subs = (state.substances || []).reduce((s, x) => s + subExtraMl(x), 0);
    let adjust = 0;
    if (p.sex === 'm') adjust += 200;
    if ((p.age || 0) >= 50) adjust += 100;
    return {
      base, exercise, caffeine, subs, adjust,
      total: base + exercise + caffeine + subs + adjust
    };
  }

  // DISPLAY unit (how the big total/target reads) — bottles or glasses only.
  // The volume of ONE display unit, in ml. The absolute total is always stored
  // in ml; this only changes how that total is divided up for display.
  // Per-unit primitives — one place each that knows how a unit reads/measures.
  function volMlFor(u) {
    if (u === 'glass')  return state.glassMl  || 250;
    if (u === 'custom') return state.customMl || 500;
    return state.bottleMl || 500;
  }
  function titleFor(u) {
    if (u === 'glass')  return 'Glasses';
    if (u === 'custom') return state.customLabel || 'Custom';
    return 'Bottles';
  }
  function pluralFor(u) {
    if (u === 'glass')  return 'glasses';
    if (u === 'custom') return (state.customLabel || 'Custom').toLowerCase();
    return 'bottles';
  }
  function singularFor(u) {
    if (u === 'glass')  return 'glass';
    if (u === 'custom') return (state.customLabel || 'Custom').toLowerCase();
    return 'bottle';
  }
  // Serving icon per unit — identical set to js/topbar.js so the bubble, the
  // + button and this panel all read as one design.
  function emojiFor(u) {
    if (u === 'glass')  return '🥛';
    if (u === 'custom') return '🍶';
    return '🍼';
  }
  function unitVolMl()       { return volMlFor(state.unit); }
  function unitLabelPlural() { return pluralFor(state.unit); }
  function unitLabelTitle()  { return titleFor(state.unit); }
  function unitEmoji()       { return emojiFor(state.unit); }

  // Display-unit rotation order. 'custom' only joins the cycle once it has a
  // size, so an unconfigured container never appears as a toggle destination.
  function displayCycle() {
    const cyc = ['bottle', 'glass'];
    if ((state.customMl || 0) > 0) cyc.push('custom');
    return cyc;
  }
  function nextDisplayUnit() {
    const cyc = displayCycle();
    const i = cyc.indexOf(state.unit);
    return cyc[(i + 1) % cyc.length];
  }
  // The chip invites the DESTINATION state: it names the next unit in the cycle
  // (bottles → glasses → Termo → bottles), so the tap is self-describing.
  function altUnitLabelTitle() { return titleFor(nextDisplayUnit()); }

  // INPUT mode (what one tap adds) — bottle, glass, or custom volume, in ml.
  function inputModeMl()       { return volMlFor(state.inputMode); }
  function inputModeSingular() { return singularFor(state.inputMode); }
  // Serving count, always to ONE decimal so it reads cleanly during rotation
  // ("2.0", "1.5", "12.0"). Fractions are intentional — half a bottle / half a
  // glass stays visible so tracking is accurate but still easy to read.
  function fmtUnits(n) { return (Number(n) || 0).toFixed(1); }
  function fmtMl(ml) {
    if (ml >= 1000) return (ml / 1000).toFixed(1) + ' L';
    return Math.round(ml) + ' ml';
  }

  // ============================================================
  // RENDER
  // ============================================================
  function renderDayPill() {
    const d = new Date();
    const dows = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    $('dayPillLabel').textContent = dows[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate();
  }

  function renderWater() {
    const calc = computeTargetMl();
    const targetMl = calc.total;
    const ml = todayMl();
    // Convert the absolute ml total into the chosen DISPLAY unit. Bottles can be
    // fractional now (e.g. 3 bottles + 1 glass → 3.5 bottles); ml stays whole.
    const display = ml / unitVolMl();
    // Target in the SAME unit, kept fractional (e.g. 2.5 bottles / 10.0 glasses).
    // Both numbers are just the stored ml re-divided by the current unit volume,
    // so rotating units never changes the amount — only how it reads.
    const targetUnits = targetMl / unitVolMl();

    renderInputMode();
    $('waterUnitLabel').textContent = unitEmoji() + ' ' + unitLabelPlural().toUpperCase() + ' DRANK TODAY';
    $('waterUnitChipLabel').textContent = altUnitLabelTitle();
    $('waterNumEmoji').textContent = unitEmoji();
    $('waterNum').textContent = fmtUnits(display);
    // e.g. "/ 2.5 Bottles" — no raw ml anywhere in the main readout.
    $('waterTarget').textContent = '/ ' + fmtUnits(targetUnits) + ' ' + unitLabelTitle();

    // Progress bar runs on the ml ratio directly, so it's identical regardless
    // of display unit. Three zones: low (0-65%), healthy (65-100%), over (100%+).
    const pctRaw = targetMl > 0 ? (ml / targetMl) * 100 : 0;
    const fillPct = Math.min(150, pctRaw) / 1.5;   // bar represents 0-150%
    const fill = $('waterBarFill');
    fill.style.width = fillPct + '%';
    fill.classList.toggle('over', pctRaw > 100);
    $('waterBarMin').textContent = '0';
    $('waterBarMax').textContent = (Math.ceil(targetUnits * 1.5)) + '+';
    // Healthy zone bands at 65% and 100%
    $('waterBarZoneStart').style.left = (65 / 1.5) + '%';
    $('waterBarZoneEnd').style.left   = (100 / 1.5) + '%';

    // Helper text — remaining shown in the display unit.
    const helper = $('waterHelper');
    const remaining = fmtUnits(Math.max(0, targetUnits - display));
    if (ml === 0) { helper.textContent = 'Start the day — first one in.'; helper.classList.remove('good'); }
    else if (pctRaw < 50) { helper.textContent = 'Behind pace — drink one in the next hour.'; helper.classList.remove('good'); }
    else if (pctRaw < 100) { helper.textContent = remaining + ' to go. Pacing well.'; helper.classList.remove('good'); }
    else if (pctRaw < 130) { helper.textContent = '✓ Target hit — top up if you train this evening.'; helper.classList.add('good'); }
    else { helper.textContent = 'Strong — way past target.'; helper.classList.add('good'); }

    // Disable minus when at zero
    $('waterMinusBtn').disabled = ml <= 0;

    renderWhy(calc, targetUnits);
    renderHistory();
    renderSparkline(targetMl);
  }

  // Reflect the current input mode on the toggle + the big plus button. Each
  // button shows its configured volume so the user sees exactly what a tap adds.
  function renderInputMode() {
    const seg = $('waterModeSeg');
    const bBtn = seg.querySelector('[data-m="bottle"]');
    const gBtn = seg.querySelector('[data-m="glass"]');
    const cBtn = seg.querySelector('[data-m="custom"]');
    bBtn.textContent = emojiFor('bottle') + ' Bottle · ' + (state.bottleMl || 500) + 'ml';
    gBtn.textContent = emojiFor('glass') + ' Glass · ' + (state.glassMl || 250) + 'ml';
    // The custom input button only exists once a size is configured.
    const hasCustom = (state.customMl || 0) > 0;
    cBtn.style.display = hasCustom ? '' : 'none';
    if (hasCustom) cBtn.textContent = emojiFor('custom') + ' ' + (state.customLabel || 'Custom') + ' · ' + state.customMl + 'ml';
    bBtn.classList.toggle('active', state.inputMode === 'bottle');
    gBtn.classList.toggle('active', state.inputMode === 'glass');
    cBtn.classList.toggle('active', state.inputMode === 'custom');
    $('waterPlusLabel').textContent = emojiFor(state.inputMode) + ' Drank a ' + inputModeSingular();
  }

  function renderWhy(calc, targetUnits) {
    const wrap = $('whyBody');
    const u = state.weightUnit;
    const wDisp = u === 'lb' ? (state.profile.weightKg).toFixed(0) : state.profile.weightKg.toFixed(0);
    let html = '';
    html += '<div class="why-row"><span class="why-label">Base (' + wDisp + ' ' + u + ' × 35 ml)</span><span class="why-val">' + fmtMl(calc.base) + '</span></div>';
    if (calc.exercise > 0)
      html += '<div class="why-row"><span class="why-label">+ Exercise (' + state.profile.activityHrsPerWeek + ' h/wk)</span><span class="why-val">+ ' + fmtMl(calc.exercise) + '</span></div>';
    if (calc.caffeine > 0)
      html += '<div class="why-row"><span class="why-label">+ Caffeine (' + state.caffeineMgPerDay + ' mg/day)</span><span class="why-val">+ ' + fmtMl(calc.caffeine) + '</span></div>';
    (state.substances || []).forEach(s => {
      html += '<div class="why-row"><span class="why-label">+ ' + escape(s.name) + ' (' + escape(subDoseLabel(s)) + ')</span><span class="why-val">+ ' + fmtMl(subExtraMl(s)) + '</span></div>';
    });
    if (calc.adjust > 0)
      html += '<div class="why-row"><span class="why-label">+ Sex / age adjustment</span><span class="why-val">+ ' + fmtMl(calc.adjust) + '</span></div>';
    html += '<div class="why-row total"><span class="why-label">Daily target</span><span class="why-val">' + fmtMl(calc.total) + ' ≈ ' + targetUnits + ' ' + unitLabelPlural() + '</span></div>';
    wrap.innerHTML = html;
  }

  function renderHistory() {
    const list = $('histList');
    const targetMl = computeTargetMl().total;
    const targetUnits = targetMl / unitVolMl();   // fractional, in display unit
    // Last 7 days — logs hold ml; the displayed count tracks the display unit.
    const days = [];
    for (let i = 6; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = dateKey(d);
      days.push({ date: d, key: k, ml: state.logs[k] || 0 });
    }
    const emoji = unitEmoji();   // history reads in the active display unit
    list.innerHTML = days.map(({date, ml}) => {
      const dows = ['Sun','Mon','Tue','Wed','THU','Fri','Sat'];
      const lbl = dows[date.getDay()] + ' ' + (date.getMonth()+1) + '/' + date.getDate();
      const pct = targetMl > 0 ? Math.min(100, (ml / targetMl) * 100) : 0;
      const cls = (ml >= targetMl) ? '' : 'miss';
      return '<div class="hist-row">'
        + '<span class="hist-date">' + lbl + '</span>'
        + '<div class="hist-bar-wrap"><div class="hist-bar-fill ' + cls + '" style="width:' + pct + '%"></div></div>'
        + '<span class="hist-count">' + emoji + ' ' + fmtUnits(ml / unitVolMl()) + '/' + fmtUnits(targetUnits) + '</span>'
        + '</div>';
    }).join('') || '<div style="text-align:center;font-size:12px;color:var(--text-3);padding:12px 0">No logs yet.</div>';
  }

  function renderSparkline(target) {
    // `target` is in ml; `data` is each day's ml total — the whole chart lives
    // in ml space so it's unaffected by the display unit.
    const svg = $('sparkSvg');
    const W = 280, H = 70, pad = 4;
    const days = 14;
    const data = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = dateKey(d);
      data.push(state.logs[k] || 0);
    }
    const maxVal = Math.max(target, Math.max.apply(null, data)) || 1;
    const colW = (W - pad * 2) / data.length;
    const barW = colW * 0.7;
    let html = '';
    // Target line
    const targetY = H - pad - (target / maxVal) * (H - pad * 2);
    html += '<line class="spark-target" x1="0" x2="' + W + '" y1="' + targetY.toFixed(1) + '" y2="' + targetY.toFixed(1) + '"/>';
    data.forEach((v, i) => {
      const x = pad + i * colW + (colW - barW) / 2;
      const h = (v / maxVal) * (H - pad * 2);
      const y = H - pad - h;
      const cls = (v >= target) ? 'spark-bar' : 'spark-bar miss';
      html += '<rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '" rx="2"/>';
    });
    svg.innerHTML = html;
  }

  function renderAll() { renderDayPill(); renderWater(); }

  // ============================================================
  // EVENT WIRING
  // ============================================================
  $('waterPlusBtn').addEventListener('click', () => {
    addMl(inputModeMl());          // +bottle or +glass, in absolute ml
    renderWater();
    const btn = $('waterPlusBtn');
    btn.style.transform = 'scale(0.97)';
    setTimeout(() => { btn.style.transform = ''; }, 120);
  });
  $('waterMinusBtn').addEventListener('click', () => {
    addMl(-inputModeMl());         // undo one of whatever mode is selected
    renderWater();
  });

  // Input-mode rotation (Bottle ⇄ Glass). Changes only what a tap adds — it
  // never touches today's stored ml, so progress is preserved across switches.
  $('waterModeSeg').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      state.inputMode = b.dataset.m;   // 'bottle' | 'glass' | 'custom'
      saveState();
      renderInputMode();
    });
  });

  // DISPLAY rotation — tapping the counter flips the whole view bottles ⇄
  // glasses. This is strictly a unit-of-measure switch: the absolute ml total is
  // never read or rewritten here, so nothing is converted in storage and sync
  // stays byte-identical. The next renderWater() just re-divides the same ml by
  // the new unit volume.
  function rotateDisplayUnit() {
    state.unit = nextDisplayUnit();   // bottle → glass → custom (if set) → bottle
    saveState();         // persists ONLY the chosen unit; logs are unchanged
    renderWater();       // re-derives the chosen unit from the stored ml
    setSegActive('setUnit', state.unit);   // keep the settings seg in lockstep
  }
  $('waterDisplayToggle').addEventListener('click', rotateDisplayUnit);
  // Keyboard access (the toggle is a role="button" div, not a native button).
  $('waterDisplayToggle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rotateDisplayUnit(); }
  });

  $('whyToggle').addEventListener('click', () => {
    const body = $('whyBody');
    const open = body.classList.contains('show');
    body.classList.toggle('show');
    $('whyToggle').setAttribute('aria-expanded', open ? 'false' : 'true');
  });

  // ============================================================
  // SETTINGS
  // ============================================================
  function renderSettings() {
    $('setWeight').value = state.profile.weightKg;
    $('setAge').value = state.profile.age;
    $('setActivity').value = state.profile.activityHrsPerWeek;
    $('setCaffeine').value = state.caffeineMgPerDay;
    $('setBottleMl').value = state.bottleMl;
    $('setGlassMl').value = state.glassMl;
    $('setCustomLabel').value = state.customLabel;
    $('setCustomMl').value = state.customMl || '';
    $('setUnitCustomBtn').textContent = state.customLabel || 'Custom';

    setSegActive('setUnit', state.unit);
    setSegActive('setWeightUnit', state.weightUnit);
    setSegActive('setSex', state.profile.sex);

    renderSubsList();
  }
  function setSegActive(segId, value) {
    $(segId).querySelectorAll('button').forEach(b => {
      const v = b.dataset.u || b.dataset.s;
      b.classList.toggle('active', v === value);
    });
  }
  function bindSeg(segId, attr, onPick) {
    $(segId).querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        const v = b.dataset[attr];
        $(segId).querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        onPick(v);
      });
    });
  }
  bindSeg('setUnit', 'u', (v) => {
    if (v === 'custom' && (state.customMl || 0) <= 0) {
      // No size yet — bounce the highlight back and point at the size field.
      setSegActive('setUnit', state.unit);
      $('setCustomMl').focus();
      return;
    }
    state.unit = v; saveState(); renderWater();
  });
  bindSeg('setWeightUnit', 'u', (v) => { state.weightUnit = v; saveState(); renderWater(); });
  bindSeg('setSex', 's', (v) => { state.profile.sex = v; saveState(); renderWater(); });

  ['setWeight','setAge','setActivity','setCaffeine','setBottleMl','setGlassMl','setCustomMl'].forEach(id => {
    $(id).addEventListener('input', () => {
      const v = parseFloat($(id).value);
      if (id === 'setWeight') state.profile.weightKg = v || 0;
      else if (id === 'setAge') state.profile.age = v || 0;
      else if (id === 'setActivity') state.profile.activityHrsPerWeek = v || 0;
      else if (id === 'setCaffeine') state.caffeineMgPerDay = v || 0;
      else if (id === 'setBottleMl') state.bottleMl = v || 500;
      else if (id === 'setGlassMl') state.glassMl = v || 250;
      else if (id === 'setCustomMl') {
        state.customMl = Math.max(0, v || 0);
        // Turning the custom container off can't leave it selected anywhere.
        if (state.customMl <= 0) {
          if (state.unit === 'custom') state.unit = 'bottle';
          if (state.inputMode === 'custom') state.inputMode = 'bottle';
        }
        setSegActive('setUnit', state.unit);
      }
      saveState(); renderWater();
    });
  });

  // Custom container label is free text — keep it short and re-render so the new
  // name shows on the chip, the input seg, and the plus button immediately.
  $('setCustomLabel').addEventListener('input', () => {
    state.customLabel = String($('setCustomLabel').value || '').slice(0, 16) || 'Custom';
    $('setUnitCustomBtn').textContent = state.customLabel;
    saveState(); renderWater();
  });

  function renderSubsList() {
    const list = $('subsList');
    if (!state.substances || !state.substances.length) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-3);text-align:center;padding:14px 0;font-style:italic;">No substances added.</div>';
      return;
    }
    list.innerHTML = state.substances.map((s, i) =>
      '<div class="sub-row" data-i="' + i + '">'
      + '<div class="sub-row-info">'
      +   '<div class="sub-row-name">' + escape(s.name) + '</div>'
      +   '<div class="sub-row-meta">+ ' + fmtMl(subExtraMl(s)) + ' / day · ' + escape(s.cat || '') + '</div>'
      + '</div>'
      + '<div class="sub-row-dose">'
      +   '<input type="number" class="sub-dose-input" data-i="' + i + '" min="0" step="0.5" value="' + (s.dose != null ? s.dose : s.defaultDose) + '">'
      +   '<span class="sub-dose-unit">' + escape(s.unit || '') + '</span>'
      + '</div>'
      + '<button class="sub-row-del" data-i="' + i + '" aria-label="Remove">×</button>'
      + '</div>'
    ).join('');
    list.querySelectorAll('.sub-dose-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const i = parseInt(inp.dataset.i, 10);
        state.substances[i].dose = parseFloat(inp.value) || 0;
        saveState();
        // Re-render the meta line for this row + the why card
        const row = inp.closest('.sub-row');
        const meta = row.querySelector('.sub-row-meta');
        meta.textContent = '+ ' + fmtMl(subExtraMl(state.substances[i])) + ' / day · ' + (state.substances[i].cat || '');
        renderWater();
      });
    });
    list.querySelectorAll('.sub-row-del').forEach(b => {
      b.addEventListener('click', () => {
        state.substances.splice(parseInt(b.dataset.i, 10), 1);
        saveState(); renderSubsList(); renderWater();
      });
    });
  }

  // Substance search
  $('subSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const results = $('subResults');
    if (!q) { results.classList.remove('show'); results.innerHTML = ''; return; }
    const matches = SUBSTANCE_DB.filter(s =>
      s.name.toLowerCase().includes(q) || s.cat.toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) {
      results.innerHTML = '<div class="search-result"><span class="search-result-name">No matches</span><span class="search-result-meta">Try a different name or category</span></div>';
      results.classList.add('show');
      return;
    }
    results.innerHTML = matches.map(s => {
      const defaultExtra = (s.defaultDose || 0) * (s.mlPerUnit || 0);
      return '<div class="search-result" data-id="' + s.id + '">'
        + '<span class="search-result-name">' + escape(s.name) + ' <span class="search-result-add">+</span></span>'
        + '<span class="search-result-meta">' + escape(s.cat) + ' · ' + s.defaultDose + ' ' + escape(s.unit) + ' default → adds ~' + fmtMl(defaultExtra) + '/day · ' + escape(s.note) + '</span>'
        + '</div>';
    }).join('');
    results.classList.add('show');
    results.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const sub = SUBSTANCE_DB.find(x => x.id === id);
        if (!sub) return;
        if ((state.substances || []).find(x => x.id === id)) { alert('Already added — edit the dose below.'); return; }
        state.substances.push({
          id: sub.id, name: sub.name, cat: sub.cat,
          unit: sub.unit, mlPerUnit: sub.mlPerUnit,
          defaultDose: sub.defaultDose,
          dose: sub.defaultDose
        });
        saveState();
        $('subSearch').value = '';
        results.classList.remove('show');
        renderSubsList(); renderWater();
      });
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) $('subResults').classList.remove('show');
  });

  $('settingsBtn').addEventListener('click', () => {
    renderSettings();
    $('setModalBg').classList.add('show');
  });
  $('setClose').addEventListener('click', () => $('setModalBg').classList.remove('show'));

  // Export / import / reset
  $('setExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'water-coach-data-' + new Date().toISOString().slice(0,10) + '.json';
    a.click(); URL.revokeObjectURL(url);
  });
  $('setImport').addEventListener('click', () => $('setImportFile').click());
  $('setImportFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(r.result);
        if (!confirm('Replace ALL current data with the imported file?')) return;
        state = normalize(parsed);
        saveState(); renderSettings(); renderAll();
      } catch (err) { alert('Import failed: ' + err.message); }
    };
    r.readAsText(f);
  });
  $('setReset').addEventListener('click', () => {
    if (!confirm('Wipe ALL water logs and settings? This cannot be undone.')) return;
    localStorage.removeItem(LS_KEY);
    state = loadState();
    $('setModalBg').classList.remove('show');
    renderAll();
  });

  function escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Absorb EXTERNAL writes to our key — the shared topbar's "+" button, the
  // cloud-sync apply, or another tab/frame — by reloading state and re-rendering
  // so the page never clobbers a change it didn't make. Guarded to our own key
  // (manual same-document dispatches carry a null key and still pass). Our own
  // saveState fires 'water:changed' instead, so this never self-triggers.
  window.addEventListener('storage', (e) => {
    if (e.key && e.key !== LS_KEY) return;
    state = loadState();
    renderAll();
  });

  // BOOT — if loadState migrated v1→v2 in memory, persist the new ml-based
  // shape once now so localStorage (and therefore cloud sync) carries it even
  // if the user never taps anything this session.
  if (state.__migrated) { delete state.__migrated; saveState(); }
  renderAll();
})();

// ===================== AI Snapshot Calorie & Macro Tracker =====================
// Snap/upload a meal photo → Gemini Vision returns strict JSON
// {meal_name,calories,protein,carbs,fats} → logged to po_food_v1 under the 6 AM
// day key and synced via the 'health' app-state blob (po_food_v1 is in
// syncedKeys below). Self-contained IIFE, same shape as the Stack/Water modules.
(() => {
  'use strict';

  // ── Meal-scan config ─────────────────────────────────────────────────────
  // No API key in the browser: the image is POSTed to the proxy, which holds
  // GEMINI_API_KEY server-side (Vercel env var) and calls Gemini. Same-origin
  // routing as the calendar — '/api/*' is rewritten to proxy/server.js by
  // vercel.json. Leave PROXY '' in production; point it at the local proxy
  // (e.g. 'http://localhost:3001') only for local dev.
  const PROXY = '';

  const FOOD_KEY = 'po_food_v1';
  const $ = id => document.getElementById(id);

  // 6 AM-anchored day key — mirrors the Daily Stack / Water reset exactly.
  function dayKey() {
    const now = new Date();
    if (now.getHours() < 6) now.setDate(now.getDate() - 1);
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  }
  function load() { try { return JSON.parse(localStorage.getItem(FOOD_KEY)) || {}; } catch (e) { return {}; } }
  function save(obj) {
    try { localStorage.setItem(FOOD_KEY, JSON.stringify(obj)); } catch (e) {}
    // Push immediately so a freshly logged meal survives a quick refresh.
    try { if (typeof window.cloudSyncFlush === 'function') window.cloudSyncFlush(); } catch (e) {}
  }
  function todayMeals() { return load()[dayKey()] || []; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setStatus(msg, kind) {
    const el = $('aiStatus'); if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; el.className = 'food-status'; return; }
    el.hidden = false; el.textContent = msg;
    el.className = 'food-status' + (kind ? ' is-' + kind : '');
  }

  // ── Image encoding — downscale on a canvas to keep the upload small/fast ──
  function fileToScaledBase64(file, maxPx) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read failed'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode failed'));
        img.onload = () => {
          const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve({ mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.82).split(',')[1] });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Meal analysis (via proxy) ─────────────────────────────────────────────
  // POST the downscaled image to the proxy; it calls Gemini with the
  // server-side key and returns normalized { meal_name, calories, ... }.
  async function analyzeMealImage(base64Image, mime) {
    const r = await fetch(PROXY + '/api/gemini/meal-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64Image, mime: mime || 'image/jpeg' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); if (j && j.error) detail = ' — ' + j.error; } catch (e) {}
      throw new Error('HTTP ' + r.status + detail);
    }
    return await r.json();
  }

  // ── Persistence ops ──────────────────────────────────────────────────────
  function addMeal(m) {
    const all = load(), k = dayKey();
    const id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    (all[k] = all[k] || []).push(Object.assign({ id: id, ts: Date.now() }, m));
    save(all); render();
  }
  function deleteMeal(id) {
    const all = load(), k = dayKey();
    all[k] = (all[k] || []).filter(x => x.id !== id);
    if (!all[k].length) delete all[k];
    save(all); render();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const meals = todayMeals();
    const t = meals.reduce((a, m) => ({
      c: a.c + (+m.calories || 0), p: a.p + (+m.protein || 0),
      cb: a.cb + (+m.carbs || 0), f: a.f + (+m.fats || 0),
    }), { c: 0, p: 0, cb: 0, f: 0 });
    if ($('foodKcal'))    $('foodKcal').textContent = t.c;
    if ($('foodProtein')) $('foodProtein').textContent = t.p;
    if ($('foodCarbs'))   $('foodCarbs').textContent = t.cb;
    if ($('foodFats'))    $('foodFats').textContent = t.f;
    const list = $('foodLog'); if (!list) return;
    list.innerHTML = meals.map(m =>
      '<li class="food-item" data-id="' + esc(m.id) + '">'
      + '<div class="food-item-main">'
      +   '<div class="food-item-name">' + esc(m.meal_name) + '</div>'
      +   '<div class="food-item-macros">' + (+m.calories || 0) + ' kcal · P ' + (+m.protein || 0)
      +     ' · C ' + (+m.carbs || 0) + ' · F ' + (+m.fats || 0) + '</div>'
      + '</div>'
      + '<button class="food-item-del" data-del="' + esc(m.id) + '" aria-label="Delete meal" title="Delete">×</button>'
      + '</li>').join('');
    const empty = $('foodEmpty'); if (empty) empty.hidden = meals.length > 0;
  }

  // ── Wire up ─────────────────────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file || !/^image\//.test(file.type)) { setStatus('Please choose an image file.', 'err'); return; }
    setStatus('🔮 Analyzing ingredients...', 'loading');
    try {
      const enc = await fileToScaledBase64(file, 1024);
      const meal = await analyzeMealImage(enc.data, enc.mime);
      addMeal(meal);
      setStatus('✓ Logged ' + meal.meal_name + ' · ' + meal.calories + ' kcal', 'ok');
      setTimeout(() => setStatus(''), 2600);
    } catch (e) {
      setStatus('Could not analyze that image' + (e && e.message ? ' — ' + e.message : '') + '.', 'err');
    }
  }

  function init() {
    const fileEl = $('foodFile'), drop = $('foodDrop');
    if (!fileEl || !drop) return;     // not on this page
    fileEl.addEventListener('change', () => { if (fileEl.files[0]) handleFile(fileEl.files[0]); fileEl.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('is-drag'); }));
    ['dragleave', 'dragend'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('is-drag'); }));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('is-drag');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    const list = $('foodLog');
    if (list) list.addEventListener('click', e => { const b = e.target.closest('[data-del]'); if (b) deleteMeal(b.dataset.del); });
    // re-render when cloud sync applies remote changes (storage event)
    window.addEventListener('storage', render);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  // expose for debugging / future proxy wiring
  window.FoodAI = { analyzeMealImage: analyzeMealImage, addMeal: addMeal };
})();

// ===================== Unified Supabase 'health' app-state sync =====================
// One initCloudSync for the whole page: it mirrors the Daily Stack keys AND the
// water blob. The water key gets a per-day field-level merge so two devices
// logging on the same day can't overwrite each other (daily ml is monotonic →
// keep the higher value per date). Stack keys keep plain last-write-wins.
document.addEventListener('DOMContentLoaded', function () {
  if (typeof initCloudSync !== 'function') return;
  initCloudSync({
    appKey: 'health',
    syncedKeys: ['stack:items', 'stack:version', 'stack:low', 'po_water_v1', 'po_food_v1'],
    syncedPrefixes: ['stack:taken:'],
    mergeRemote: function (key, local, remote) {
      if (key === 'po_water_v1') {
        if (!remote || typeof remote !== 'object') return undefined;
        if (!local || typeof local !== 'object') return remote;
        const merged = Object.assign({}, remote);             // settings: remote wins
        const logs = Object.assign({}, remote.logs || {});
        const localLogs = (local.logs && typeof local.logs === 'object') ? local.logs : {};
        for (const day in localLogs) {
          logs[day] = Math.max(Number(logs[day]) || 0, Number(localLogs[day]) || 0);
        }
        merged.logs = logs;
        return merged;
      }
      if (key === 'po_food_v1') {
        // Meal diary: union each day's entries by id so two devices logging the
        // same day don't overwrite each other (offline-first safe).
        if (!remote || typeof remote !== 'object') return undefined;
        if (!local || typeof local !== 'object') return remote;
        const out = {};
        const days = new Set(Object.keys(local).concat(Object.keys(remote)));
        days.forEach(day => {
          const byId = {};
          (remote[day] || []).concat(local[day] || []).forEach(m => { if (m && m.id) byId[m.id] = m; });
          out[day] = Object.values(byId).sort((a, b) => (a.ts || 0) - (b.ts || 0));
        });
        return out;
      }
      return undefined;
    },
    onApplied: function () { window.dispatchEvent(new Event('storage')); }
  });
});
