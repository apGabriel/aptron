/* =============================================================
   Smart AI Wardrobe — "Armario Inteligente"
   Modular front-end architecture (vanilla JS, no build step).

   Layers
   ──────
   Store      localStorage persistence (synced to Supabase via sync.js
              under appKey 'wardrobe', prefix 'wardrobe:').
   Img        Image ingestion — camera / file input → downscaled base64.
   Color      Dominant-color extraction + harmony math (the "Color Scale
              & Harmony" analytical vector).
   Weather    Temperature & seasonality vector (season filter + weather
              placeholder).
   Closet     CRUD + rendering of the digital closet grid.
   Profile    Facial & style analysis sub-section (undertone, face shape,
              portrait).
   AIEngine   Builds the payload of analytical vectors and produces outfit
              + garment recommendations. Real model call is a clearly
              marked placeholder seam (callAIModel); a local SIMULATION
              backs it so the UI is fully functional offline.
   UI         Render outfits, recommendation feed, wire events.
   App        Boot.
   ============================================================= */
(function () {
  'use strict';

  // ----------------------------------------------------------------
  // Constants
  // ----------------------------------------------------------------
  const CATEGORIES = [
    { id: 'tops',      label: 'Tops',      icon: '👕' },
    { id: 'bottoms',   label: 'Bottoms',   icon: '👖' },
    { id: 'outerwear', label: 'Outerwear', icon: '🧥' },
    { id: 'footwear',  label: 'Footwear',  icon: '👟' },
    { id: 'accessories', label: 'Accessories', icon: '👜' },
  ];
  // Which categories carry "warmth" — used by the seasonality vector.
  const WARMTH = { tops: 1, bottoms: 1, outerwear: 3, footwear: 1, accessories: 0.5 };

  const KEYS = {
    items:    'wardrobe:items',
    profile:  'wardrobe:profile',
    settings: 'wardrobe:settings',
    outfits:  'wardrobe:outfits',
  };

  // ----------------------------------------------------------------
  // Store — persistence + change events
  // ----------------------------------------------------------------
  const Store = (function () {
    const listeners = [];
    function read(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); }
      catch (e) { return fallback; }
    }
    function write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { Toast.show('Storage full — try fewer / smaller photos'); }
      emit();
    }
    function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); }

    return {
      onChange(fn) { listeners.push(fn); },
      emit,
      // items
      items() { return read(KEYS.items, []); },
      setItems(arr) { write(KEYS.items, arr); },
      // profile
      profile() { return read(KEYS.profile, { portrait: '', undertone: '', faceShape: '', style: '' }); },
      setProfile(p) { write(KEYS.profile, p); },
      // settings
      settings() { return read(KEYS.settings, { season: 'auto', tempC: null, location: '' }); },
      setSettings(s) { write(KEYS.settings, s); },
      // cached outfits
      outfits() { return read(KEYS.outfits, []); },
      setOutfits(o) { write(KEYS.outfits, o); },
    };
  })();

  // ----------------------------------------------------------------
  // Img — ingestion: file/camera → downscaled base64 data URL
  // Keeps the synced blob small by capping the long edge.
  // ----------------------------------------------------------------
  const Img = (function () {
    const MAX_EDGE = 520;   // px — long edge after downscale
    const QUALITY  = 0.78;  // JPEG quality

    function fromFile(file) {
      return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) { reject(new Error('Not an image')); return; }
        const reader = new FileReader();
        reader.onload = () => downscale(reader.result).then(resolve, reject);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function downscale(dataUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          let { width: w, height: h } = img;
          const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
          w = Math.round(w * scale); h = Math.round(h * scale);
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          try { resolve(c.toDataURL('image/jpeg', QUALITY)); }
          catch (e) { resolve(dataUrl); }
        };
        img.onerror = reject;
        img.src = dataUrl;
      });
    }

    return { fromFile, downscale };
  })();

  // ----------------------------------------------------------------
  // Color — dominant color + harmony analysis
  // ("Color Scale & Harmony" analytical vector)
  // ----------------------------------------------------------------
  const Color = (function () {
    // Sample a small canvas and average non-extreme pixels → dominant hex.
    function dominant(dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const S = 24;
          const c = document.createElement('canvas');
          c.width = S; c.height = S;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, S, S);
          let data;
          try { data = ctx.getImageData(0, 0, S, S).data; }
          catch (e) { resolve('#8a8a8a'); return; }
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) {
            const R = data[i], G = data[i + 1], B = data[i + 2];
            const max = Math.max(R, G, B), min = Math.min(R, G, B);
            // skip near-white / near-black background pixels
            if (max > 244 && min > 232) continue;
            if (max < 18) continue;
            r += R; g += G; b += B; n++;
          }
          if (!n) { resolve('#8a8a8a'); return; }
          resolve(rgbToHex(r / n, g / n, b / n));
        };
        img.onerror = () => resolve('#8a8a8a');
        img.src = dataUrl;
      });
    }

    function rgbToHex(r, g, b) {
      const h = (v) => Math.round(v).toString(16).padStart(2, '0');
      return '#' + h(r) + h(g) + h(b);
    }
    function hexToRgb(hex) {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      if (!m) return { r: 138, g: 138, b: 138 };
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    function rgbToHsl({ r, g, b }) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h = 0, s = 0; const l = (max + min) / 2;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
      }
      return { h: h * 360, s, l };
    }
    function hslToHex({ h, s, l }) {
      h /= 360;
      const hue = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      let r, g, b;
      if (s === 0) { r = g = b = l; }
      else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
      }
      return rgbToHex(r * 255, g * 255, b * 255);
    }

    // Classify the harmony relationship between a set of hex colors.
    function classifyHarmony(hexes) {
      if (hexes.length < 2) return 'solo';
      const hsl = hexes.map((x) => rgbToHsl(hexToRgb(x)));
      const hues = hsl.map((x) => x.h);
      const sats = hsl.map((x) => x.s);
      const avgSat = sats.reduce((a, b) => a + b, 0) / sats.length;
      const spread = hueSpread(hues);
      if (avgSat < 0.12) return 'neutral';
      if (spread < 30) return 'monochromatic';
      if (spread < 65) return 'analogous';
      if (spread > 130 && spread < 230) return 'complementary';
      return 'eclectic';
    }
    function hueSpread(hues) {
      let max = 0;
      for (let i = 0; i < hues.length; i++)
        for (let j = i + 1; j < hues.length; j++) {
          const d = Math.abs(hues[i] - hues[j]);
          max = Math.max(max, Math.min(d, 360 - d));
        }
      return max;
    }
    // Suggest a bridging color that would harmonize a palette (for gap rec).
    function complementOf(hex) {
      const hsl = rgbToHsl(hexToRgb(hex));
      return hslToHex({ h: (hsl.h + 180) % 360, s: Math.min(0.6, hsl.s + 0.1), l: 0.5 });
    }
    // Harmony score 0..1 between two items (higher = pairs well).
    function pairScore(a, b) {
      const A = rgbToHsl(hexToRgb(a)), B = rgbToHsl(hexToRgb(b));
      const d = Math.min(Math.abs(A.h - B.h), 360 - Math.abs(A.h - B.h));
      const neutral = A.s < 0.15 || B.s < 0.15;
      if (neutral) return 0.9;                       // neutrals go with anything
      if (d < 30) return 0.85;                        // monochromatic / analogous
      if (d > 150 && d < 210) return 0.8;             // complementary
      if (d < 60) return 0.7;                         // analogous-ish
      return 0.4;
    }

    return { dominant, classifyHarmony, complementOf, pairScore, rgbToHsl, hexToRgb };
  })();

  // ----------------------------------------------------------------
  // Weather — temperature & seasonality vector
  // ----------------------------------------------------------------
  const Weather = (function () {
    const ORDER = ['spring', 'summer', 'autumn', 'winter'];
    const ICON  = { spring: '🌸', summer: '☀️', autumn: '🍂', winter: '❄️', auto: '📍' };

    function autoSeason(date) {
      const m = (date || new Date()).getMonth(); // 0..11, northern hemisphere
      if (m <= 1 || m === 11) return 'winter';
      if (m <= 4) return 'spring';
      if (m <= 7) return 'summer';
      return 'autumn';
    }
    function activeSeason() {
      const s = Store.settings().season;
      return s && s !== 'auto' ? s : autoSeason();
    }
    // Target garment warmth for the active season (drives layer-stacking).
    function targetWarmth(season) {
      return { summer: 1.5, spring: 3, autumn: 4, winter: 6 }[season] || 3;
    }
    // Does an item suit the season? Outerwear is summer-inappropriate, etc.
    function suitsSeason(item, season) {
      const w = WARMTH[item.category] || 1;
      if (season === 'summer' && item.category === 'outerwear') return false;
      if (season === 'winter' && item.category === 'outerwear') return true;
      // honor explicit season tag if present
      const tag = (item.tags || []).find((t) => ORDER.indexOf(t.toLowerCase()) !== -1);
      if (tag && tag.toLowerCase() !== season) return false;
      return true;
    }

    /* PLACEHOLDER SEAM — live weather.
       Wire a real endpoint (Open-Meteo, OpenWeather, or the project's
       proxy) here; returns { tempC, condition }. Falls back to season. */
    async function fetchLive(/* lat, lon */) {
      // const r = await fetch(`https://api.open-meteo.com/v1/forecast?...`);
      // return (await r.json()).current;
      return { tempC: null, condition: activeSeason() };
    }

    return { ORDER, ICON, autoSeason, activeSeason, targetWarmth, suitsSeason, fetchLive };
  })();

  // ----------------------------------------------------------------
  // AIEngine — payload assembly + outfit / garment recommendations
  // ----------------------------------------------------------------
  const AIEngine = (function () {

    // Assemble the structured payload of analytical vectors that a real
    // model (Claude / OpenAI) would receive. Pure data — no side effects.
    function buildPayload() {
      const items = Store.items();
      const profile = Store.profile();
      const season = Weather.activeSeason();
      return {
        season,
        targetWarmth: Weather.targetWarmth(season),
        // Color Scale & Harmony vector
        palette: items.map((i) => ({ id: i.id, category: i.category, color: i.color })),
        // Temperature & Seasonality vector
        inventoryBySeasonFit: items.reduce((acc, i) => {
          const fit = Weather.suitsSeason(i, season);
          (acc[fit ? 'inSeason' : 'offSeason'] ||= []).push(i.id);
          return acc;
        }, {}),
        // Facial & Style Analysis vector
        profile: {
          undertone: profile.undertone || null,
          faceShape: profile.faceShape || null,
          stylePreference: profile.style || null,
          hasPortrait: !!profile.portrait,
        },
        catalog: items.map((i) => ({
          id: i.id, category: i.category, color: i.color, tags: i.tags || [],
        })),
        instruction:
          'Compose balanced outfits (one per top/bottom pairing, layered for ' +
          season + '), honoring color harmony and the user\'s undertone, then ' +
          'list wardrobe gaps to recommend.',
      };
    }

    /* PLACEHOLDER SEAM — real model call.
       Swap this body for a fetch to Claude / OpenAI (or the project proxy)
       passing buildPayload(). Must resolve to { outfits, recommendations }
       in the same shape as the local simulation below. */
    async function callAIModel(payload) {
      // Example wiring (left commented on purpose):
      // const r = await fetch('/api/wardrobe/style', {
      //   method: 'POST', headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({ model: 'claude-opus-4-8', payload }),
      // });
      // return await r.json();
      await new Promise((res) => setTimeout(res, 450)); // feel of a round-trip
      return simulate(payload);
    }

    // Local, deterministic simulation so the feature works fully offline.
    function simulate(payload) {
      const items = Store.items();
      const byCat = (c) => items.filter((i) => i.category === c && Weather.suitsSeason(i, payload.season));
      const tops = byCat('tops'), bottoms = byCat('bottoms');
      const outer = byCat('outerwear'), shoes = byCat('footwear'), acc = byCat('accessories');

      const outfits = [];
      const needLayer = payload.targetWarmth >= 4 && outer.length;

      for (const top of tops) {
        // pick the bottom that harmonizes best with this top
        let best = null, bestScore = -1;
        for (const bot of bottoms) {
          const s = Color.pairScore(top.color, bot.color);
          if (s > bestScore) { bestScore = s; best = bot; }
        }
        if (!best) continue;
        const layer = needLayer
          ? outer.slice().sort((a, b) => Color.pairScore(b.color, top.color) - Color.pairScore(a.color, top.color))[0]
          : null;
        const shoe = shoes.length
          ? shoes.slice().sort((a, b) => Color.pairScore(b.color, best.color) - Color.pairScore(a.color, best.color))[0]
          : null;
        const accessory = acc[0] || null;

        const pieces = [layer, top, best, shoe, accessory].filter(Boolean);
        const palette = pieces.map((p) => p.color);
        const harmony = Color.classifyHarmony(palette);
        outfits.push({
          id: 'of_' + top.id + '_' + best.id,
          name: outfitName(harmony, payload.season),
          harmony,
          season: payload.season,
          warmth: pieces.reduce((s, p) => s + (WARMTH[p.category] || 0), 0),
          pieces: pieces.map((p) => ({ id: p.id, image: p.image_url, color: p.color, category: p.category })),
          why: rationale(harmony, payload.profile.undertone, payload.season, !!layer),
        });
        if (outfits.length >= 4) break;
      }

      // key sets by category id so gapAnalysis lookups (need('footwear')) resolve
      return { outfits, recommendations: gapAnalysis(payload, { tops, bottoms, outerwear: outer, footwear: shoes, accessories: acc }) };
    }

    // Wardrobe-gap recommendations ("Garment Recommendations" vector).
    function gapAnalysis(payload, sets) {
      const recs = [];
      const season = payload.season;
      const need = (cat) => sets[catKey(cat)].length;

      if (!need('bottoms')) recs.push(rec('👖', 'Add a versatile bottom',
        'You have tops but nothing to pair below. A neutral straight-leg trouser unlocks most outfits.'));
      if (!need('footwear')) recs.push(rec('👟', 'Footwear is missing',
        'A clean white sneaker is the highest-leverage piece to complete these looks.'));
      if ((season === 'winter' || season === 'autumn') && !sets.outerwear.length)
        recs.push(rec('🧥', 'No layer for ' + season,
          'Your inventory skews light. A mid-weight overshirt or coat would make these outfits season-appropriate.'));

      // color-gap: if palette is all warm or all cool, suggest a bridge
      const items = Store.items();
      if (items.length >= 3) {
        const harmony = Color.classifyHarmony(items.map((i) => i.color));
        if (harmony === 'monochromatic' || harmony === 'neutral') {
          const bridge = Color.complementOf(items[0].color);
          recs.push(rec('🎨', 'Introduce an accent color',
            'Your closet is tonally flat (' + harmony + '). One accent piece near ' + bridge +
            ' would create contrast and pull outfits together.', bridge));
        }
      }
      // style/undertone-aware suggestion
      if (payload.profile.undertone === 'warm')
        recs.push(rec('🧣', 'Lean into earth tones',
          'Your warm undertone flatters camel, olive and rust — prioritize these when adding pieces.'));
      else if (payload.profile.undertone === 'cool')
        recs.push(rec('🧣', 'Cool jewel tones suit you',
          'Your cool undertone pops with navy, emerald and cool grey — favor these over yellow-based hues.'));

      return recs.slice(0, 4);
    }

    function catKey(c) { return c; }
    function rec(icon, title, desc, swatch) { return { icon, title, desc, swatch: swatch || null }; }
    function outfitName(harmony, season) {
      const adj = { monochromatic: 'Tonal', analogous: 'Harmonized', complementary: 'Contrast',
        neutral: 'Quiet', eclectic: 'Eclectic', solo: 'Minimal' }[harmony] || 'Curated';
      const noun = { summer: 'Daytime', winter: 'Layered', autumn: 'Transitional', spring: 'Fresh' }[season] || 'Look';
      return adj + ' ' + noun;
    }
    function rationale(harmony, undertone, season, layered) {
      const bits = [];
      bits.push({ monochromatic: 'A tonal palette keeps this look sleek and intentional.',
        analogous: 'Neighboring hues give an easy, harmonized feel.',
        complementary: 'Opposing colors create deliberate, balanced contrast.',
        neutral: 'Neutrals make this endlessly versatile.',
        eclectic: 'A bolder mix — anchor it with neutral shoes.' }[harmony]
        || 'Balanced color pairing.');
      if (layered) bits.push('Layered for ' + season + ' warmth.');
      if (undertone === 'warm') bits.push('Earthy tones flatter your warm undertone.');
      if (undertone === 'cool') bits.push('Cooler shades suit your undertone.');
      return bits.join(' ');
    }

    return { buildPayload, callAIModel, simulate };
  })();

  // ----------------------------------------------------------------
  // Toast
  // ----------------------------------------------------------------
  const Toast = (function () {
    let el, t;
    function show(msg) {
      if (!el) { el = document.createElement('div'); el.className = 'wr-toast'; document.body.appendChild(el); }
      el.textContent = msg; el.classList.add('show');
      clearTimeout(t); t = setTimeout(() => el.classList.remove('show'), 2200);
    }
    return { show };
  })();

  // ----------------------------------------------------------------
  // Closet — CRUD + closet grid rendering
  // ----------------------------------------------------------------
  const Closet = (function () {
    let activeCat = 'all';

    function uid() { return 'it_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    async function addFromFile(file, category) {
      try {
        const image_url = await Img.fromFile(file);
        const color = await Color.dominant(image_url);
        const items = Store.items();
        items.unshift({
          id: uid(), image_url, category: category || 'tops',
          color, tags: [], createdAt: Date.now(),
        });
        Store.setItems(items);
        Toast.show('Added to closet');
      } catch (e) { Toast.show('Could not read that image'); }
    }

    function update(id, patch) {
      const items = Store.items();
      const it = items.find((x) => x.id === id);
      if (!it) return;
      Object.assign(it, patch);
      Store.setItems(items);
    }
    function remove(id) {
      Store.setItems(Store.items().filter((x) => x.id !== id));
      Toast.show('Removed');
    }
    function setCat(c) { activeCat = c; render(); }
    function visible() {
      const items = Store.items();
      return activeCat === 'all' ? items : items.filter((i) => i.category === activeCat);
    }

    function renderChips() {
      const wrap = document.getElementById('wrCats');
      if (!wrap) return;
      const items = Store.items();
      const count = (c) => items.filter((i) => i.category === c).length;
      const chip = (id, label, n) =>
        '<button class="wr-cat-chip' + (activeCat === id ? ' active' : '') + '" data-cat="' + id + '">' +
        label + ' <span class="wr-cat-count">' + n + '</span></button>';
      let html = chip('all', 'All', items.length);
      CATEGORIES.forEach((c) => { html += chip(c.id, c.icon + ' ' + c.label, count(c.id)); });
      wrap.innerHTML = html;
      wrap.querySelectorAll('.wr-cat-chip').forEach((b) =>
        b.addEventListener('click', () => setCat(b.dataset.cat)));
    }

    function render() {
      renderChips();
      const grid = document.getElementById('wrCloset');
      if (!grid) return;
      const items = visible();
      let html = '';
      items.forEach((i) => {
        const cat = CATEGORIES.find((c) => c.id === i.category);
        html +=
          '<div class="wr-item" data-id="' + i.id + '" tabindex="0">' +
            '<img src="' + i.image_url + '" alt="' + (cat ? cat.label : '') + '" loading="lazy">' +
            '<button class="wr-item-del" data-del="' + i.id + '" aria-label="Remove">✕</button>' +
            '<div class="wr-item-meta">' +
              '<span class="wr-item-swatch" style="background:' + i.color + '"></span>' +
              '<span class="wr-item-cat">' + (cat ? cat.label : i.category) + '</span>' +
            '</div>' +
          '</div>';
      });
      // upload tile always last
      html +=
        '<button class="wr-item wr-item-add" id="wrAddTile" type="button">' +
          '<span class="wr-item-add-icon">＋</span>' +
          '<span class="wr-item-add-label">Add item</span>' +
        '</button>';
      if (!items.length && activeCat !== 'all') {
        html = '<div class="wr-empty">No ' + activeCat + ' yet.</div>' + html;
      }
      grid.innerHTML = html;

      grid.querySelector('#wrAddTile').addEventListener('click', () => UI.openUpload(activeCat === 'all' ? 'tops' : activeCat));
      grid.querySelectorAll('.wr-item-del').forEach((b) =>
        b.addEventListener('click', (e) => { e.stopPropagation(); remove(b.dataset.del); }));
      grid.querySelectorAll('.wr-item[data-id]').forEach((el) =>
        el.addEventListener('click', () => UI.openItem(el.dataset.id)));
    }

    return { addFromFile, update, remove, render, setCat, uid };
  })();

  // ----------------------------------------------------------------
  // Profile — facial & style analysis sub-section
  // ----------------------------------------------------------------
  const Profile = (function () {
    function render() {
      const p = Store.profile();
      const portrait = document.getElementById('wrPortrait');
      if (portrait) {
        portrait.innerHTML = p.portrait
          ? '<img src="' + p.portrait + '" alt="portrait">' : '👤';
      }
      syncSeg('wrUndertone', 'undertone', p.undertone);
      syncSeg('wrFaceShape', 'faceShape', p.faceShape);
      syncSeg('wrStyle', 'style', p.style);
    }
    function syncSeg(wrapId, field, val) {
      const wrap = document.getElementById(wrapId);
      if (!wrap) return;
      wrap.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('active', b.dataset[seg(field)] === val));
    }
    function seg(field) { return field === 'undertone' ? 'undertone' : field === 'faceShape' ? 'face' : 'style'; }

    async function setPortrait(file) {
      try {
        const url = await Img.fromFile(file);
        const p = Store.profile(); p.portrait = url; Store.setProfile(p);
        Toast.show('Portrait saved — style guidance updated');
      } catch (e) { Toast.show('Could not read that image'); }
    }
    function set(field, value) {
      const p = Store.profile();
      p[field] = (p[field] === value) ? '' : value; // toggle off if same
      Store.setProfile(p);
    }
    return { render, setPortrait, set };
  })();

  // ----------------------------------------------------------------
  // UI — outfit generator, recommendation feed, modals, wiring
  // ----------------------------------------------------------------
  const UI = (function () {
    let uploadTargetCat = 'tops';
    let openItemId = null;

    // ---- file inputs (one for items, one for portrait) ----
    function fileInput(onPick, capture) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      if (capture) inp.capture = 'environment';
      inp.style.display = 'none';
      inp.addEventListener('change', () => { if (inp.files && inp.files[0]) onPick(inp.files[0]); inp.remove(); });
      document.body.appendChild(inp); inp.click();
    }

    function openUpload(cat) {
      uploadTargetCat = cat || 'tops';
      // a tiny sheet: choose camera vs library
      fileInput((f) => Closet.addFromFile(f, uploadTargetCat));
    }

    // ---- item detail modal ----
    function openItem(id) {
      const it = Store.items().find((x) => x.id === id);
      if (!it) return;
      openItemId = id;
      const m = document.getElementById('wrItemModal');
      m.querySelector('#wrItemImg').src = it.image_url;
      const catSel = m.querySelector('#wrItemCat');
      catSel.innerHTML = CATEGORIES.map((c) =>
        '<option value="' + c.id + '"' + (c.id === it.category ? ' selected' : '') + '>' + c.icon + ' ' + c.label + '</option>').join('');
      m.querySelector('#wrItemTags').value = (it.tags || []).join(', ');
      m.querySelector('#wrItemSwatch').style.background = it.color;
      document.getElementById('wrItemModalBg').classList.add('show');
    }
    function saveItem() {
      if (!openItemId) return;
      const m = document.getElementById('wrItemModal');
      const tags = m.querySelector('#wrItemTags').value.split(',').map((t) => t.trim()).filter(Boolean);
      Closet.update(openItemId, { category: m.querySelector('#wrItemCat').value, tags });
      closeItem(); Toast.show('Saved');
    }
    function closeItem() { document.getElementById('wrItemModalBg').classList.remove('show'); openItemId = null; }

    // ---- outfit generator ----
    async function generate() {
      const btn = document.getElementById('wrGenBtn');
      const out = document.getElementById('wrOutfits');
      if (Store.items().filter((i) => i.category === 'tops').length === 0 ||
          Store.items().filter((i) => i.category === 'bottoms').length === 0) {
        out.innerHTML = '<div class="wr-empty">Add at least one top and one bottom to generate outfits.</div>';
        return;
      }
      btn.disabled = true; btn.innerHTML = '<span class="wr-spin"></span> Styling…';
      const payload = AIEngine.buildPayload();
      const { outfits, recommendations } = await AIEngine.callAIModel(payload);
      Store.setOutfits(outfits);
      renderOutfits(outfits);
      renderRecs(recommendations);
      btn.disabled = false; btn.textContent = '✨ Regenerate';
      Toast.show(outfits.length + ' outfit' + (outfits.length === 1 ? '' : 's') + ' generated');
    }

    function renderOutfits(outfits) {
      const out = document.getElementById('wrOutfits');
      if (!outfits || !outfits.length) {
        out.innerHTML = '<div class="wr-empty">No combinations yet — tap Generate.</div>'; return;
      }
      out.innerHTML = outfits.map((o) => {
        const slots = o.pieces.map((p) =>
          '<div class="wr-of-slot"><img src="' + p.image + '" alt="' + p.category + '"></div>').join('');
        const pal = o.pieces.map((p) => '<span style="background:' + p.color + '"></span>').join('');
        return (
          '<div class="wr-outfit-card">' +
            '<div class="wr-outfit-strip">' + slots + '</div>' +
            '<div class="wr-outfit-body">' +
              '<div class="wr-outfit-row">' +
                '<span class="wr-outfit-name">' + o.name + '</span>' +
                '<span class="wr-harmony-tag">' + o.harmony + '</span>' +
              '</div>' +
              '<div class="wr-outfit-pal">' + pal + '</div>' +
              '<div class="wr-outfit-why">' + o.why + '</div>' +
              '<div class="wr-outfit-meta">' +
                '<span><b>' + o.pieces.length + '</b> pieces</span>' +
                '<span><b>' + Weather.ICON[o.season] + '</b> ' + o.season + '</span>' +
              '</div>' +
            '</div>' +
          '</div>');
      }).join('');
    }

    function renderRecs(recs) {
      const feed = document.getElementById('wrRecs');
      if (!feed) return;
      if (!recs || !recs.length) {
        feed.innerHTML = '<div class="wr-empty">Your wardrobe looks well-rounded. 👌</div>'; return;
      }
      feed.innerHTML = recs.map((r) =>
        '<div class="wr-rec">' +
          '<div class="wr-rec-ic">' + (r.swatch ? '<span style="width:16px;height:16px;border-radius:50%;display:inline-block;background:' + r.swatch + '"></span>' : r.icon) + '</div>' +
          '<div class="wr-rec-body">' +
            '<div class="wr-rec-title">' + r.title + '</div>' +
            '<div class="wr-rec-desc">' + r.desc + '</div>' +
          '</div>' +
        '</div>').join('');
    }

    // ---- season toggle ----
    function renderSeason() {
      const wrap = document.getElementById('wrSeason');
      if (!wrap) return;
      const active = Store.settings().season;
      wrap.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('active', b.dataset.season === active));
    }

    function wire() {
      // season toggle
      const seasonWrap = document.getElementById('wrSeason');
      seasonWrap && seasonWrap.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const s = Store.settings(); s.season = b.dataset.season; Store.setSettings(s);
        renderSeason();
      });
      // generate
      document.getElementById('wrGenBtn').addEventListener('click', generate);
      // header add
      document.getElementById('wrHeadAdd').addEventListener('click', () => openUpload('tops'));
      // portrait
      document.getElementById('wrPortrait').addEventListener('click', () => fileInput((f) => Profile.setPortrait(f)));
      // profile segmented controls (delegated)
      [['wrUndertone', 'undertone', 'undertone'], ['wrFaceShape', 'faceShape', 'face'], ['wrStyle', 'style', 'style']]
        .forEach(([id, field, attr]) => {
          const wrap = document.getElementById(id);
          wrap && wrap.addEventListener('click', (e) => {
            const b = e.target.closest('button'); if (!b) return;
            Profile.set(field, b.dataset[attr]);
          });
        });
      // item modal
      document.getElementById('wrItemSave').addEventListener('click', saveItem);
      document.getElementById('wrItemDelete').addEventListener('click', () => { if (openItemId) { Closet.remove(openItemId); closeItem(); } });
      document.getElementById('wrItemClose').addEventListener('click', closeItem);
      document.getElementById('wrItemModalBg').addEventListener('click', (e) => { if (e.target.id === 'wrItemModalBg') closeItem(); });
    }

    function renderAll() {
      Closet.render();
      Profile.render();
      renderSeason();
      renderOutfits(Store.outfits());
    }

    return { wire, renderAll, openUpload, openItem, renderOutfits, renderRecs, generate };
  })();

  // expose UI for Closet's inline handlers
  window.UI = UI;

  // ----------------------------------------------------------------
  // App — boot
  // ----------------------------------------------------------------
  function boot() {
    UI.wire();
    UI.renderAll();
    // re-render when cloud sync applies remote changes (storage event)
    Store.onChange(() => { Closet.render(); Profile.render(); });
    window.addEventListener('storage', () => UI.renderAll());
    window.addEventListener('wardrobe-changed', () => UI.renderAll());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else { boot(); }

  // export for debugging / future real-API wiring
  window.Wardrobe = { Store, Img, Color, Weather, AIEngine, Closet, Profile };
})();
