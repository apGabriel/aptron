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
    savedOutfits: 'wardrobe:saved_outfits',
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
      try { localStorage.setItem(key, JSON.stringify(value)); }
      catch (e) { Toast.show('Storage full — try fewer / smaller photos'); emit(); return false; }
      emit();
      return true;
    }
    function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); }

    return {
      onChange(fn) { listeners.push(fn); },
      emit,
      // items
      items() { return read(KEYS.items, []); },
      // Items carry the heavy base64 image payloads. After a successful local
      // write, force an immediate upstream push (don't wait for the debounce) so
      // a freshly-added photo survives a quick refresh / mobile backgrounding.
      // Returns the in-flight push promise (or false if the local write failed).
      setItems(arr) {
        if (!write(KEYS.items, arr)) return false;
        if (typeof window.cloudSyncFlush === 'function') {
          try { return window.cloudSyncFlush(); } catch (e) {}
        }
        return Promise.resolve();
      },
      // profile
      profile() { return read(KEYS.profile, { portrait: '', undertone: '', faceShape: '', style: '' }); },
      setProfile(p) { write(KEYS.profile, p); },
      // settings
      settings() { return read(KEYS.settings, { season: 'auto', tempC: null, location: '' }); },
      setSettings(s) { write(KEYS.settings, s); },
      // cached outfits (transient — last generation)
      outfits() { return read(KEYS.outfits, []); },
      setOutfits(o) { write(KEYS.outfits, o); },
      // persisted saved outfits (survive regenerate / reload, synced cross-device)
      savedOutfits() { return read(KEYS.savedOutfits, []); },
      setSavedOutfits(o) { write(KEYS.savedOutfits, o); },
      addSavedOutfit(outfit) {
        const list = read(KEYS.savedOutfits, []);
        if (list.some((o) => o.id === outfit.id)) return false; // already saved
        list.unshift(Object.assign({}, outfit, { savedAt: Date.now() }));
        write(KEYS.savedOutfits, list);
        return true;
      },
      removeSavedOutfit(id) {
        write(KEYS.savedOutfits, read(KEYS.savedOutfits, []).filter((o) => o.id !== id));
      },
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
  // Vision — garment isolation (offscreen pre-processing)
  // Separates the clothing item from background noise (floor / wall / bed /
  // shadow) BEFORE any color or category math runs. Works only on an internal
  // analysis canvas; the stored library image is never modified.
  //
  // Strategy (no ML — pure pixel math):
  //   1. Decode onto a small analysis canvas (long edge ≈ 80px) that PRESERVES
  //      aspect ratio (the category stage needs true garment geometry).
  //   2. Learn the background from a peripheral border ring — the outer ~10%
  //      frame — because garments are virtually always shot centered. Quantize
  //      those border pixels into coarse RGB buckets (3 bits/channel = 8³ = 512
  //      buckets) and keep the few most populated as background reference
  //      clusters. This captures multiple backgrounds at once (wall + floor +
  //      shadow) instead of a single averaged color.
  //   3. Any pixel within an ADAPTIVE RGB distance of ANY background reference
  //      is masked out (mask=0); the survivors are the garment (mask=1). The
  //      threshold widens for busy/noisy borders so we don't punch holes in the
  //      garment, and tightens for clean backdrops for a crisp cut.
  //   4. The garment bounding box is the extent of the surviving foreground.
  //   Graceful fallbacks keep low-contrast / full-frame garments fully intact.
  // ----------------------------------------------------------------
  const Vision = (function () {
    const LONG_EDGE   = 80;    // analysis canvas long edge (px)
    const BORDER_FRAC = 0.10;  // outer ring thickness as a fraction of min side
    const BG_CLUSTERS = 3;     // max distinct background colors to learn
    const MIN_FG_FRAC = 0.08;  // below this fraction of foreground → fill-frame fallback
    let cacheKey = null, cachePromise = null; // 1-entry memo (detect + dominant reuse)

    function analyze(dataUrl) {
      if (dataUrl && dataUrl === cacheKey && cachePromise) return cachePromise;
      cacheKey = dataUrl;
      cachePromise = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(run(img));
        img.onerror = () => resolve(null);
        img.src = dataUrl;
      });
      return cachePromise;
    }

    // Nearest background reference by squared RGB distance.
    function nearest(refs, r, g, b) {
      let bd = Infinity;
      for (let i = 0; i < refs.length; i++) {
        const dr = r - refs[i][0], dg = g - refs[i][1], db = b - refs[i][2];
        const d2 = dr * dr + dg * dg + db * db;
        if (d2 < bd) bd = d2;
      }
      return bd;
    }

    function run(img) {
      const scale = Math.min(1, LONG_EDGE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let data;
      try { data = ctx.getImageData(0, 0, w, h).data; }
      catch (e) { return null; } // tainted (cross-origin) canvas — skip isolation
      const total = w * h;

      // ---- 1. Border ring → background color histogram --------------------
      const margin = Math.max(2, Math.round(Math.min(w, h) * BORDER_FRAC));
      const hist = new Map(); // coarse bucket key -> { r, g, b, n }
      for (let y = 0; y < h; y++) {
        const edgeRow = (y < margin || y >= h - margin);
        for (let x = 0; x < w; x++) {
          if (!edgeRow && x >= margin && x < w - margin) continue; // interior — skip
          const i = (y * w + x) * 4;
          const R = data[i], G = data[i + 1], B = data[i + 2];
          const key = ((R >> 5) << 6) | ((G >> 5) << 3) | (B >> 5); // 3 bits / channel
          let e = hist.get(key);
          if (!e) { e = { r: 0, g: 0, b: 0, n: 0 }; hist.set(key, e); }
          e.r += R; e.g += G; e.b += B; e.n++;
        }
      }
      // Most-populated border buckets become the background reference colors.
      const refs = [...hist.values()].sort((a, b) => b.n - a.n).slice(0, BG_CLUSTERS)
        .map((e) => [e.r / e.n, e.g / e.n, e.b / e.n]);

      // ---- 2. Adaptive threshold from border spread -----------------------
      // Variance = mean squared distance of every border bucket to its nearest
      // reference, weighted by population. A tight border → small std → crisp
      // threshold; a noisy border → large std → looser threshold.
      let bvar = 0, bn = 0;
      for (const e of hist.values()) {
        bvar += nearest(refs, e.r / e.n, e.g / e.n, e.b / e.n) * e.n; bn += e.n;
      }
      const bstd  = bn ? Math.sqrt(bvar / bn) : 0;
      const thresh = Math.max(30, Math.min(70, 26 + 1.4 * bstd)); // RGB distance
      const T2 = thresh * thresh;

      // ---- 3. Foreground mask + garment bounding box ----------------------
      const mask = new Uint8Array(total);
      let fg = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const isBg = refs.length && nearest(refs, data[i], data[i + 1], data[i + 2]) <= T2;
          if (!isBg) {
            mask[y * w + x] = 1; fg++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }

      // ---- 4. Fallback: garment fills the frame / matches the background ---
      if (fg < total * MIN_FG_FRAC || x1 < x0 || y1 < y0) {
        mask.fill(1);
        return { w, h, data, mask, fgCount: total, bbox: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 } };
      }
      return { w, h, data, mask, fgCount: fg, bbox: { x0, y0, x1, y1 } };
    }

    return { analyze };
  })();

  // ----------------------------------------------------------------
  // Detector — garment type auto-categorization (vision seam)
  // Analyzes an uploaded image and guesses its category so the upload
  // modal can pre-select the right chip. Ships with an enhanced heuristic
  // that backs a clearly-marked real-vision placeholder seam.
  // ----------------------------------------------------------------
  const Detector = (function () {
    const VALID = CATEGORIES.map((c) => c.id);

    /* PLACEHOLDER SEAM — real garment-vision model.
       Swap the body for a call to a vision endpoint (Claude vision, a
       hosted classifier, or the project proxy) passing the data URL and
       resolving to one of CATEGORIES' ids. Return null to fall back to
       the local heuristic below. */
    async function callVisionModel(/* dataUrl */) {
      // const r = await fetch('/api/wardrobe/detect', {
      //   method: 'POST', headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify({ model: 'claude-opus-4-8', image: dataUrl }),
      // });
      // const cat = (await r.json()).category;
      // return VALID.indexOf(cat) !== -1 ? cat : null;
      return null;
    }

    // Lightweight HSL (lightness + saturation only) for foreground stats.
    function lsOf(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min));
      return { l, s };
    }

    // Score how strongly a column-mass profile splits into TWO distinct vertical
    // columns flanking a central void (0 = solid block, →1 = two clean columns).
    // Used to tell a trouser leg-pair from a solid silhouette. We compare the
    // garment mass in the left (10–40%) and right (60–90%) bands against the
    // exact center core (42–58%): two legs leave the core much emptier than the
    // flanks. A *relative* dip (not "center must be totally empty") is what makes
    // this survive a thin bright reflection running down the gap.
    function twoColScore(col, len) {
      if (len < 4) return 0;
      let left = 0, core = 0, right = 0;
      for (let x = 0; x < len; x++) {
        const rel = x / (len - 1);
        if (rel >= 0.10 && rel < 0.40) left += col[x];
        else if (rel >= 0.42 && rel <= 0.58) core += col[x];
        else if (rel > 0.60 && rel <= 0.90) right += col[x];
      }
      const flankMin = Math.min(left, right);
      if (flankMin <= 0) return 0;                       // mass on only one side → not a pair
      const flankAvg = (left + right) / 2;
      const dip      = Math.max(0, 1 - core / flankAvg); // how empty the core is vs the legs
      const balance  = flankMin / Math.max(left, right); // 1 = symmetric legs
      return dip * balance;
    }

    // Geometry + mass features computed over the ISOLATED garment only (via
    // Vision's foreground mask), so a centered item against a large/high-
    // contrast background still measures true. All ratios are relative to the
    // garment's own bounding box, never the whole photo.
    async function features(dataUrl) {
      const v = await Vision.analyze(dataUrl);
      if (!v) return null;
      const { w, data, mask, bbox } = v;
      const bw = bbox.x1 - bbox.x0 + 1, bh = bbox.y1 - bbox.y0 + 1;
      const gAspect    = bh / Math.max(1, bw); // >1 = tall/portrait garment
      const widthRatio = bw / Math.max(1, w);  // how much of the frame width it spans

      // Pass 1: foreground light/sat means, vertical-third mass split, centroid.
      let sumL = 0, sumS = 0, n = 0, mx = 0, my = 0;
      let topN = 0, midN = 0, botN = 0;
      const t1 = bbox.y0 + bh / 3, t2 = bbox.y0 + (2 * bh) / 3;
      for (let y = bbox.y0; y <= bbox.y1; y++) {
        for (let x = bbox.x0; x <= bbox.x1; x++) {
          if (!mask[y * w + x]) continue;        // background — excluded
          const i = (y * w + x) * 4;
          const ls = lsOf(data[i], data[i + 1], data[i + 2]);
          sumL += ls.l; sumS += ls.s; n++; mx += x; my += y;
          if (y < t1) topN++; else if (y < t2) midN++; else botN++;
        }
      }
      if (!n) return null;
      mx /= n; my /= n;

      // Pass 2: spatial spread → vertical elongation (stdY vs stdX). A tall,
      // narrow column (trousers) has stdY noticeably greater than stdX.
      let vx = 0, vy = 0;
      for (let y = bbox.y0; y <= bbox.y1; y++)
        for (let x = bbox.x0; x <= bbox.x1; x++) {
          if (!mask[y * w + x]) continue;
          vx += (x - mx) * (x - mx); vy += (y - my) * (y - my);
        }
      const elong = Math.sqrt(vy / n) / Math.max(1e-3, Math.sqrt(vx / n));

      // Leg-split: fraction of lower-half rows showing foreground on BOTH flanks
      // but a gap through the horizontal center — the signature of two trouser
      // legs. This center-mass test catches pants even when poor contrast washes
      // out the top/bottom luminance delta the old heuristic relied on.
      let splitRows = 0, lowerRows = 0;
      for (let y = Math.round(my); y <= bbox.y1; y++) {
        let leftFg = false, rightFg = false, centerFg = false;
        for (let x = bbox.x0; x <= bbox.x1; x++) {
          if (!mask[y * w + x]) continue;
          const rel = (x - bbox.x0) / Math.max(1, bw - 1);
          if (rel < 0.4) leftFg = true; else if (rel > 0.6) rightFg = true; else centerFg = true;
        }
        lowerRows++;
        if (leftFg && rightFg && !centerFg) splitRows++;
      }
      const legSplit = lowerRows ? splitRows / lowerRows : 0;

      // Pass 3: leg-pair vs open-coat discrimination. We build per-column garment
      // mass for the TOP half and the BOTTOM half separately, in two flavors:
      //   • "all"  — every foreground column pixel.
      //   • "dark" — only foreground darker than the garment's mean lightness.
      // The "dark" profile is what defeats the open-jacket illusion: when a bright
      // reflection (or a light shirt) fills the central gap, it is excluded from
      // the dark mass, so two dark legs still register a clean central void. A
      // pair of jeans splits in the BOTTOM half (crotch → ankles); an open coat
      // splits in the TOP half (chest opening) and stays solid across the hem.
      const meanL = sumL / n;
      const midY = bbox.y0 + bh / 2;
      const colAllTop = new Float64Array(bw), colAllBot = new Float64Array(bw);
      const colDarkTop = new Float64Array(bw), colDarkBot = new Float64Array(bw);
      for (let y = bbox.y0; y <= bbox.y1; y++) {
        const bottom = y >= midY;
        for (let x = bbox.x0; x <= bbox.x1; x++) {
          if (!mask[y * w + x]) continue;
          const xi = x - bbox.x0;
          const i = (y * w + x) * 4;
          const l = lsOf(data[i], data[i + 1], data[i + 2]).l;
          if (bottom) { colAllBot[xi]++; if (l < meanL) colDarkBot[xi]++; }
          else        { colAllTop[xi]++; if (l < meanL) colDarkTop[xi]++; }
        }
      }
      // Take the stronger of the two flavors per half: "all" catches a thin
      // reflection (mostly real background in the core), "dark" catches a wide
      // bright gap on a dark garment.
      const splitBot = Math.max(twoColScore(colAllBot, bw), twoColScore(colDarkBot, bw));
      const splitTop = Math.max(twoColScore(colAllTop, bw), twoColScore(colDarkTop, bw));

      return {
        gAspect, widthRatio, elong, legSplit, splitTop, splitBot,
        light: sumL / n, sat: sumS / n,
        topMass: topN / n, midMass: midN / n, botMass: botN / n,
      };
    }

    function heuristic(f) {
      if (!f) return 'tops';
      // Wide, short cluster → footwear (desaturated) or a laid-flat accessory.
      if (f.gAspect < 0.8) return f.sat < 0.22 ? 'footwear' : 'accessories';

      // ── HARD GEOMETRIC ANCHOR FOR BOTTOMS ────────────────────────────────
      // Two distinct dark vertical columns (legs) flanking a central void in the
      // BOTTOM half of the bbox = trousers/jeans — forced regardless of how dark
      // or desaturated the average luminance is. Crucially this runs BEFORE the
      // outerwear branch and requires the split to be bottom-dominant
      // (splitBot >= splitTop), so the "open dark coat over a light shirt"
      // illusion — whose opening sits in the TOP/MIDDLE — cannot trigger it, and
      // a bright reflection in the leg gap cannot suppress it.
      if (f.gAspect > 1.15 && f.splitBot > 0.45 && f.splitBot >= f.splitTop)
        return 'bottoms';

      // Pants / trousers: a tall, vertically-elongated garment, confirmed by
      // EITHER strong vertical mass elongation OR a visible central leg gap.
      if (f.gAspect > 1.25 && f.widthRatio < 0.82 && (f.elong > 1.2 || f.legSplit > 0.22))
        return 'bottoms';

      // Tall, dark, low-saturation, structured → outer layer (coat / jacket) —
      // but ONLY when it does NOT show a bottom-dominant leg split. The extra
      // guard is what stops black jeans with a bright central floor reflection
      // from being read as an open jacket.
      if (f.gAspect > 1.1 && f.light < 0.42 && f.sat < 0.4 && f.splitBot < 0.45)
        return 'outerwear';

      // Tall with clearly heavier lower mass still reads as bottoms (e.g. a
      // folded pair of jeans with no clean leg split).
      if (f.gAspect > 1.2 && f.botMass > f.topMass + 0.12) return 'bottoms';
      // Compact, very saturated piece → accessory (bag / scarf).
      if (f.sat > 0.5 && f.gAspect <= 1.2) return 'accessories';
      return 'tops';
    }

    async function detect(dataUrl) {
      try { const m = await callVisionModel(dataUrl); if (m && VALID.indexOf(m) !== -1) return m; }
      catch (e) {}
      return heuristic(await features(dataUrl));
    }

    return { detect, callVisionModel };
  })();

  // ----------------------------------------------------------------
  // Color — dominant color + harmony analysis
  // ("Color Scale & Harmony" analytical vector)
  // ----------------------------------------------------------------
  const Color = (function () {
    // Dominant garment color via background-isolated k-means clustering.
    // Pulls ONLY foreground (garment) pixels — as masked by Vision — from the
    // inner 60% of the detected bounding box, where fabric lies flat and the
    // edge-pooling fold shadows are excluded. Clustering (not a flat average)
    // means a few stray highlight / button / residual-background pixels land in
    // minority clusters and can't drag the result toward mud; we return the
    // centroid of the most populous cluster as a precise hex.
    async function dominant(dataUrl) {
      const v = await Vision.analyze(dataUrl);
      if (!v) return legacyDominant(dataUrl); // tainted canvas → safe fallback
      const { w, h, data, mask, bbox } = v;
      const bw = bbox.x1 - bbox.x0 + 1, bh = bbox.y1 - bbox.y0 + 1;
      // Inner 60% = shrink 20% off each side of the garment bounding box.
      const ix0 = bbox.x0 + bw * 0.2, ix1 = bbox.x1 - bw * 0.2;
      const iy0 = bbox.y0 + bh * 0.2, iy1 = bbox.y1 - bh * 0.2;

      const collect = (xa, ya, xb, yb) => {
        const pts = [];
        for (let y = Math.floor(ya); y <= Math.ceil(yb); y++) {
          for (let x = Math.floor(xa); x <= Math.ceil(xb); x++) {
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            if (!mask[y * w + x]) continue;        // background — ignored
            const i = (y * w + x) * 4;
            pts.push([data[i], data[i + 1], data[i + 2]]);
          }
        }
        return pts;
      };

      // Inner core first; relax to the full bbox if it was too small to trust.
      let pts = collect(ix0, iy0, ix1, iy1);
      if (pts.length < 12) pts = collect(bbox.x0, bbox.y0, bbox.x1, bbox.y1);
      if (!pts.length) return '#8a8a8a';

      const clusters = kmeans(pts, 3, 6).sort((a, b) => b.n - a.n);
      const c = clusters[0].c;
      return rgbToHex(c[0], c[1], c[2]);
    }

    // k-means over RGB points. Seeded deterministically by luminance spread so
    // results are stable run-to-run; a handful of iterations converges at this
    // pixel count. Returns [{ c:[r,g,b], n }] where n = members in the cluster.
    function kmeans(points, k, iters) {
      const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      if (points.length <= k) return points.map((p) => ({ c: p.slice(), n: 1 }));
      const sorted = points.slice().sort((a, b) => lum(a) - lum(b));
      const cents = [];
      for (let i = 0; i < k; i++) cents.push(sorted[Math.floor(((i + 0.5) / k) * sorted.length)].slice());
      const assign = new Array(points.length).fill(0);
      for (let it = 0; it < iters; it++) {
        for (let p = 0; p < points.length; p++) {
          let best = 0, bd = Infinity;
          for (let cI = 0; cI < k; cI++) {
            const dr = points[p][0] - cents[cI][0], dg = points[p][1] - cents[cI][1], db = points[p][2] - cents[cI][2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bd) { bd = d; best = cI; }
          }
          assign[p] = best;
        }
        const sum = [];
        for (let cI = 0; cI < k; cI++) sum.push([0, 0, 0, 0]);
        for (let p = 0; p < points.length; p++) {
          const cI = assign[p], pt = points[p];
          sum[cI][0] += pt[0]; sum[cI][1] += pt[1]; sum[cI][2] += pt[2]; sum[cI][3]++;
        }
        for (let cI = 0; cI < k; cI++)
          if (sum[cI][3]) cents[cI] = [sum[cI][0] / sum[cI][3], sum[cI][1] / sum[cI][3], sum[cI][2] / sum[cI][3]];
      }
      const counts = new Array(k).fill(0);
      for (let p = 0; p < points.length; p++) counts[assign[p]]++;
      return cents.map((cc, i) => ({ c: cc, n: counts[i] }));
    }

    // Legacy global-average sampler — used only when the analysis canvas is
    // unreadable (e.g. a cross-origin / tainted source) so Vision returns null.
    function legacyDominant(dataUrl) {
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
          let r = 0, g = 0, b = 0, n = 0;        // accent pixels (background ignored)
          let rA = 0, gA = 0, bA = 0, total = 0; // every sampled pixel
          for (let i = 0; i < data.length; i += 4) {
            const R = data[i], G = data[i + 1], B = data[i + 2];
            rA += R; gA += G; bA += B; total++;
            const max = Math.max(R, G, B), min = Math.min(R, G, B);
            if (max > 244 && min > 232) continue; // skip near-white background
            if (max < 18) continue;               // skip near-black background
            r += R; g += G; b += B; n++;
          }
          if (n < total * 0.1) {
            if (!total) { resolve('#8a8a8a'); return; }
            resolve(rgbToHex(rA / total, gA / total, bA / total));
            return;
          }
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
        // Piece include/exclude filters from per-item generation locks.
        filters: {
          include: items.filter((i) => i.lock === 'include').map((i) => i.id),
          exclude: items.filter((i) => i.lock === 'exclude').map((i) => i.id),
        },
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
      const filters = payload.filters || { include: [], exclude: [] };
      const inc = new Set(filters.include);
      const exc = new Set(filters.exclude);
      // Honor locks: drop excluded pieces; if any piece in a category is
      // force-included, restrict that category to the forced pieces.
      const byCat = (c) => {
        const pool = items.filter((i) =>
          i.category === c && Weather.suitsSeason(i, payload.season) && !exc.has(i.id));
        const forced = pool.filter((i) => inc.has(i.id));
        return forced.length ? forced : pool;
      };
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
        await addFromImage(image_url, category);
      } catch (e) { Toast.show('Could not read that image'); }
    }

    // Add an already-ingested (downscaled) base64 image to the closet.
    async function addFromImage(image_url, category) {
      const color = await Color.dominant(image_url);
      const items = Store.items();
      items.unshift({
        id: uid(), image_url, category: category || 'tops',
        color, tags: [], lock: null, createdAt: Date.now(),
      });
      // setItems persists locally AND kicks off an immediate upstream push.
      // false means the local write failed (quota) — bail without a success toast.
      const pushed = Store.setItems(items);
      if (pushed === false) return;
      // Wait for the base64 payload to reach Supabase before reporting success,
      // so the new photo is durable even if the user refreshes immediately.
      try { await pushed; } catch (e) {}
      Toast.show('Added to closet');
    }

    function update(id, patch) {
      const items = Store.items();
      const it = items.find((x) => x.id === id);
      if (!it) return;
      Object.assign(it, patch);
      Store.setItems(items);
    }

    // Cycle a piece's generation lock: none → include (force) → exclude → none.
    const LOCK_CYCLE = { '': 'include', include: 'exclude', exclude: '' };
    function cycleLock(id) {
      const items = Store.items();
      const it = items.find((x) => x.id === id);
      if (!it) return;
      it.lock = LOCK_CYCLE[it.lock || ''] || '';
      Store.setItems(items);
      Toast.show(it.lock === 'include' ? 'Forced into next outfit'
        : it.lock === 'exclude' ? 'Excluded from outfits' : 'Lock cleared');
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
        const lock = i.lock || '';
        const lockIcon = lock === 'include' ? '📌' : lock === 'exclude' ? '🚫' : '🔓';
        const lockTitle = lock === 'include' ? 'Forced in — tap to exclude'
          : lock === 'exclude' ? 'Excluded — tap to clear' : 'Tap to force into outfits';
        html +=
          '<div class="wr-item' + (lock ? ' wr-item-' + lock : '') + '" data-id="' + i.id + '" tabindex="0">' +
            '<img src="' + i.image_url + '" alt="' + (cat ? cat.label : '') + '" loading="lazy">' +
            '<button class="wr-item-lock" data-lock="' + i.id + '" title="' + lockTitle + '" aria-label="' + lockTitle + '">' + lockIcon + '</button>' +
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
      grid.querySelectorAll('.wr-item-lock').forEach((b) =>
        b.addEventListener('click', (e) => { e.stopPropagation(); cycleLock(b.dataset.lock); }));
      grid.querySelectorAll('.wr-item[data-id]').forEach((el) =>
        el.addEventListener('click', () => UI.openItem(el.dataset.id)));
    }

    return { addFromFile, addFromImage, update, remove, cycleLock, render, setCat, uid };
  })();

  // ----------------------------------------------------------------
  // Profiler — automatic style-profile analysis (facial-analysis seam)
  // Auto-calculates baseline undertone / faceShape / style. When a
  // portrait is present it samples the face region; otherwise it returns
  // a sensible neutral baseline. Backs a real facial-analysis placeholder.
  // ----------------------------------------------------------------
  const Profiler = (function () {
    /* PLACEHOLDER SEAM — real facial-analysis model.
       Swap for a call to a vision/face endpoint that returns
       { undertone, faceShape, style }. Return null to fall back. */
    async function callVisionModel(/* dataUrl */) {
      // const r = await fetch('/api/wardrobe/profile', { ... });
      // return await r.json(); // { undertone, faceShape, style }
      return null;
    }

    function baseline() {
      return { undertone: 'neutral', faceShape: 'oval', style: 'minimal' };
    }

    // Sample the central "face" region of a portrait for skin/undertone cues.
    function analyzePortrait(dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const W = 40, H = 40;
          const c = document.createElement('canvas');
          c.width = W; c.height = H;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, W, H);
          let data;
          try { data = ctx.getImageData(0, 0, W, H).data; }
          catch (e) { resolve(baseline()); return; }
          // central region (face tends to sit in the middle of a portrait)
          let r = 0, g = 0, b = 0, n = 0, sat = 0;
          for (let y = H * 0.25; y < H * 0.75; y++) {
            for (let x = W * 0.3; x < W * 0.7; x++) {
              const i = ((y | 0) * W + (x | 0)) * 4;
              r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
              sat += Color.rgbToHsl({ r: data[i], g: data[i + 1], b: data[i + 2] }).s;
            }
          }
          if (!n) { resolve(baseline()); return; }
          r /= n; g /= n; b /= n; sat /= n;
          // Warm undertone skews red/yellow; cool skews blue. Small delta = neutral.
          const delta = r - b;
          const undertone = delta > 18 ? 'warm' : delta < -6 ? 'cool' : 'neutral';
          // Portrait aspect as a rough face-shape proxy (taller = oval/heart).
          const aspect = img.height / Math.max(1, img.width);
          const faceShape = aspect > 1.25 ? 'oval' : aspect < 0.95 ? 'round' : 'square';
          // Colorful portraits → bolder style; muted → minimal.
          const style = sat > 0.4 ? 'bold' : sat > 0.22 ? 'classic' : 'minimal';
          resolve({ undertone, faceShape, style });
        };
        img.onerror = () => resolve(baseline());
        img.src = dataUrl;
      });
    }

    async function analyze(dataUrl) {
      if (dataUrl) {
        try { const m = await callVisionModel(dataUrl); if (m) return m; }
        catch (e) {}
        return analyzePortrait(dataUrl);
      }
      return baseline();
    }

    return { analyze, baseline, callVisionModel };
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
        Toast.show('Portrait saved — analyzing your style…');
        // Background self-profiling: derive baseline undertone/face/style
        // from the new portrait and set them as the active defaults.
        await autoProfile(true);
      } catch (e) { Toast.show('Could not read that image'); }
    }
    function set(field, value) {
      const p = Store.profile();
      p[field] = (p[field] === value) ? '' : value; // toggle off if same
      p.autoProfiled = false;                       // user took manual control
      Store.setProfile(p);
    }

    // Run the Profiler and apply results. With force=true (explicit portrait
    // upload) it overrides; otherwise it only fills fields the user hasn't set.
    async function autoProfile(force) {
      const p = Store.profile();
      const a = await Profiler.analyze(p.portrait || '');
      if (!a) return;
      const next = Store.profile(); // re-read in case it changed during await
      ['undertone', 'faceShape', 'style'].forEach((f) => {
        if (force || !next[f]) next[f] = a[f];
      });
      next.autoProfiled = true;
      Store.setProfile(next);
      render();
    }

    return { render, setPortrait, set, autoProfile };
  })();

  // ----------------------------------------------------------------
  // UI — outfit generator, recommendation feed, modals, wiring
  // ----------------------------------------------------------------
  const UI = (function () {
    let uploadTargetCat = 'tops';
    let openItemId = null;
    let pendingUpload = null;        // { image_url } awaiting category confirm
    let uploadSelectedCat = 'tops';  // chip selected in the upload modal
    let currentOutfits = [];         // outfits currently shown (for save action)

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
      fileInput((f) => beginUpload(f));
    }

    // Ingest the file, run garment auto-detection, then show the upload
    // modal with the detected category chip pre-selected.
    async function beginUpload(file) {
      let image_url;
      try { image_url = await Img.fromFile(file); }
      catch (e) { Toast.show('Could not read that image'); return; }
      pendingUpload = { image_url };
      uploadSelectedCat = uploadTargetCat;
      const note = document.getElementById('wrDetectNote');
      document.getElementById('wrUploadImg').src = image_url;
      if (note) note.textContent = 'Analyzing garment…';
      renderUploadChips();
      document.getElementById('wrUploadModalBg').classList.add('show');
      // Detection runs async; pre-select its result when it resolves.
      try {
        const detected = await Detector.detect(image_url);
        if (!pendingUpload) return;                  // modal already closed
        uploadSelectedCat = detected;
        const c = CATEGORIES.find((x) => x.id === detected);
        if (note) note.textContent = '✨ Auto-detected: ' + (c ? c.label : detected);
        renderUploadChips();
      } catch (e) {
        if (note) note.textContent = 'Pick a category';
      }
    }

    function renderUploadChips() {
      const wrap = document.getElementById('wrUploadCats');
      if (!wrap) return;
      wrap.innerHTML = CATEGORIES.map((c) =>
        '<button type="button" class="wr-cat-chip' + (c.id === uploadSelectedCat ? ' active' : '') +
        '" data-upcat="' + c.id + '">' + c.icon + ' ' + c.label + '</button>').join('');
      wrap.querySelectorAll('[data-upcat]').forEach((b) =>
        b.addEventListener('click', () => {
          uploadSelectedCat = b.dataset.upcat;
          renderUploadChips();
        }));
    }

    function confirmUpload() {
      if (!pendingUpload) return;
      const img = pendingUpload.image_url;
      const cat = uploadSelectedCat;
      closeUpload();
      Closet.addFromImage(img, cat);
    }

    function closeUpload() {
      pendingUpload = null;
      document.getElementById('wrUploadModalBg').classList.remove('show');
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
      // Interface reset — clear any previously generated outfits from view
      // before the new set renders.
      currentOutfits = [];
      out.innerHTML = '<div class="wr-empty"><span class="wr-spin"></span></div>';
      const payload = AIEngine.buildPayload();
      const { outfits, recommendations } = await AIEngine.callAIModel(payload);
      Store.setOutfits(outfits);
      renderOutfits(outfits);
      renderRecs(recommendations);
      btn.disabled = false; btn.textContent = '✨ Regenerate';
      Toast.show(outfits.length + ' outfit' + (outfits.length === 1 ? '' : 's') + ' generated');
    }

    // Shared outfit-card markup. `mode` is 'generated' (Save action) or
    // 'saved' (Remove action).
    function outfitCard(o, mode) {
      const slots = o.pieces.map((p) =>
        '<div class="wr-of-slot"><img src="' + p.image + '" alt="' + p.category + '"></div>').join('');
      const pal = o.pieces.map((p) => '<span style="background:' + p.color + '"></span>').join('');
      const action = mode === 'saved'
        ? '<button class="wr-btn wr-btn-ghost wr-btn-sm wr-of-remove" data-remove="' + o.id + '" type="button">🗑 Quitar</button>'
        : '<button class="wr-btn wr-btn-ghost wr-btn-sm wr-of-save" data-save="' + o.id + '" type="button">＋ Guardar Outfit</button>';
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
            '<div class="wr-outfit-actions">' + action + '</div>' +
          '</div>' +
        '</div>');
    }

    function renderOutfits(outfits) {
      const out = document.getElementById('wrOutfits');
      currentOutfits = outfits || [];
      if (!currentOutfits.length) {
        out.innerHTML = '<div class="wr-empty">No combinations yet — tap Generate.</div>'; return;
      }
      out.innerHTML = currentOutfits.map((o) => outfitCard(o, 'generated')).join('');
      out.querySelectorAll('[data-save]').forEach((b) =>
        b.addEventListener('click', () => saveOutfit(b.dataset.save)));
    }

    function saveOutfit(id) {
      const o = currentOutfits.find((x) => x.id === id);
      if (!o) return;
      const added = Store.addSavedOutfit(o);
      Toast.show(added ? 'Outfit saved' : 'Already saved');
      if (added) renderSaved();
    }

    function renderSaved() {
      const wrap = document.getElementById('wrSaved');
      if (!wrap) return;
      const saved = Store.savedOutfits();
      if (!saved.length) {
        wrap.innerHTML = '<div class="wr-empty">No saved outfits yet — tap “Guardar Outfit” on a look.</div>';
        return;
      }
      wrap.innerHTML = saved.map((o) => outfitCard(o, 'saved')).join('');
      wrap.querySelectorAll('[data-remove]').forEach((b) =>
        b.addEventListener('click', () => { Store.removeSavedOutfit(b.dataset.remove); renderSaved(); Toast.show('Removed'); }));
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
      // upload modal
      document.getElementById('wrUploadConfirm').addEventListener('click', confirmUpload);
      document.getElementById('wrUploadCancel').addEventListener('click', closeUpload);
      document.getElementById('wrUploadModalBg').addEventListener('click', (e) => { if (e.target.id === 'wrUploadModalBg') closeUpload(); });
    }

    function renderAll() {
      Closet.render();
      Profile.render();
      renderSeason();
      renderOutfits(Store.outfits());
      renderSaved();
    }

    return { wire, renderAll, openUpload, openItem, renderOutfits, renderRecs, renderSaved, generate };
  })();

  // expose UI for Closet's inline handlers
  window.UI = UI;

  // ----------------------------------------------------------------
  // App — boot
  // ----------------------------------------------------------------
  function boot() {
    UI.wire();
    UI.renderAll();
    // Self-profiling on entry: if the user hasn't set any style profile yet,
    // auto-calculate baseline undertone / faceShape / style as the defaults.
    const p = Store.profile();
    if (!p.undertone && !p.faceShape && !p.style) { Profile.autoProfile(false); }
    // re-render when cloud sync applies remote changes (storage event)
    Store.onChange(() => { Closet.render(); Profile.render(); });
    window.addEventListener('storage', () => UI.renderAll());
    window.addEventListener('wardrobe-changed', () => UI.renderAll());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else { boot(); }

  // export for debugging / future real-API wiring
  window.Wardrobe = { Store, Img, Detector, Color, Weather, Profiler, AIEngine, Closet, Profile };
})();
