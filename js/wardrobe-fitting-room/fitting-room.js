/* =============================================================
   Wardrobe — 3D Outfit Visualization (fitting room)

   Pre-Shelron stopgap, plain DOM + dynamic-import, no bundler.
   Exposes window.WardrobeFittingRoom.open(pieces). wardrobe.js is
   the only caller; this file never reads/writes app_state or
   localStorage — all state here is in-memory and dies with the tab.

   This is NOT a virtual try-on and NEVER claims to be: it recolors
   a generic stock mannequin from the outfit's stored item colors.
   It does not render the user's actual garments, body or fit.

   Three.js is ESM-only from this pinned version on, so the loader
   uses dynamic import() against the bare "three" specifier declared
   in wardrobe.html's <script type="importmap">, rather than a
   classic <script src> global -- the closest equivalent this repo's
   module system allows to the "one script element" shape elsewhere,
   while still being a single guarded, shared, cached Promise.
   ============================================================= */
(function () {
  'use strict';

  var THREE_VERSION = '0.186.0';
  var CDN_BASE = 'https://cdn.jsdelivr.net/npm/three@' + THREE_VERSION;
  var GLTF_LOADER_URL = CDN_BASE + '/examples/jsm/loaders/GLTFLoader.js';
  var ORBIT_CONTROLS_URL = CDN_BASE + '/examples/jsm/controls/OrbitControls.js';

  var MODEL_URLS = {
    mannequin: 'models/quat-man.glb',
    boots: 'models/boots.glb',
    sneakers: 'models/sneakers.glb',
    backpack: 'models/backpack.glb',
    trousers: 'models/trousers.glb'
  };

  // Proportions used to fit the standalone props to whatever the
  // mannequin's real measured bounding box turns out to be at
  // runtime, rather than hardcoding axis-fragile numbers derived
  // from the raw files' own coordinate conventions.
  var BOOT_HEIGHT_RATIO = 0.12;
  // Tuned independently of BOOT_HEIGHT_RATIO -- visually verified against
  // real renders (same process ADR-027's boot/backpack ratios went
  // through), not shared with boots even though the value happens to match.
  var SNEAKER_HEIGHT_RATIO = 0.12;
  var BACKPACK_HEIGHT_RATIO = 0.34;
  var BACKPACK_BACK_OFFSET_RATIO = 0.62; // fraction of mannequin depth, pushed behind center
  // Trousers overlay prop (bottomStyle === 'trousers'), added after an
  // isolated CC0-candidate validation pass (see Third-Party Models.md).
  // Height ratio is empirically tuned against real renders, like every
  // other prop here -- not derived from the garment's own native proportions,
  // since (unlike a full-character extraction) there's no "whole source
  // body" to compute a fraction against. verticalY in ensureProp() anchors
  // the prop's BOTTOM, so TROUSERS_VERTICAL_RATIO = 0.58 - 0.50 = 0.08
  // reproduces the validated waist-top anchor (0.58) given this height (0.50).
  var TROUSERS_HEIGHT_RATIO = 0.50;
  var TROUSERS_VERTICAL_RATIO = 0.08;
  // Positive, same sign convention as BACKPACK_BACK_OFFSET_RATIO: ensureProp
  // subtracts this fraction of mannequin depth from Z, pushing the prop
  // toward the mannequin's back. A small push here closes most of the
  // rear-seam exposure found during validation; do not negate this sign.
  var TROUSERS_BACK_OFFSET_RATIO = 0.05;

  var dom = null;          // { bg, modal, viewport, state, notice, closeBtn }
  var runtimePromise = null; // Promise<{THREE, GLTFLoader, OrbitControls}>
  var buildPromise = null; // Promise<void> -- the whole viewer build, not just the runtime load
  var viewer = null;       // built scene state, see buildViewer()
  var escHandler = null;

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------
  function ensureDom() {
    if (dom) return dom;
    var bg = document.createElement('div');
    bg.className = 'wr-modal-bg wr-fitroom-bg';
    bg.id = 'wrFitRoomModalBg';
    bg.innerHTML =
      '<div class="wr-modal wr-fitroom-modal" id="wrFitRoomModal" role="dialog" aria-modal="true" aria-label="3D outfit visualization">' +
        '<div class="wr-fitroom-head">' +
          '<h3>3D Outfit Visualization</h3>' +
          '<button class="wr-fitroom-close" type="button" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="wr-fitroom-viewport" id="wrFitRoomViewport">' +
          '<div class="wr-fitroom-state" id="wrFitRoomState">Loading viewer…</div>' +
        '</div>' +
        '<div class="wr-fitroom-notice" id="wrFitRoomNotice" hidden></div>' +
        '<div class="wr-fitroom-disclosure">Approximate 3D visualization on a generic mannequin, for comparing colors and categories only — not your actual garments, body or fit.</div>' +
      '</div>';
    document.body.appendChild(bg);

    dom = {
      bg: bg,
      modal: bg.querySelector('#wrFitRoomModal'),
      viewport: bg.querySelector('#wrFitRoomViewport'),
      state: bg.querySelector('#wrFitRoomState'),
      notice: bg.querySelector('#wrFitRoomNotice'),
      closeBtn: bg.querySelector('.wr-fitroom-close')
    };

    dom.closeBtn.addEventListener('click', close);
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    return dom;
  }

  function setState(message) {
    if (!dom) return;
    if (message) {
      dom.state.textContent = message;
      dom.state.hidden = false;
    } else {
      dom.state.hidden = true;
    }
  }

  // Multiple independent sources can want to show a notice at once (the
  // outerwear disclosure is set synchronously; boot/backpack load failures
  // arrive later, asynchronously) -- a single shared string would let
  // whichever resolves last silently clobber the others. Each source owns
  // its own slot; the DOM always reflects the join of whatever is active.
  var notices = { outerwear: null, bottoms: null, boots: null, backpack: null };
  function setNotice(key, message) {
    notices[key] = message || null;
    if (!dom) return;
    var text = ['outerwear', 'bottoms', 'boots', 'backpack']
      .map(function (k) { return notices[k]; })
      .filter(Boolean)
      .join(' ');
    dom.notice.textContent = text;
    dom.notice.hidden = !text;
  }
  function clearNotices() {
    notices = { outerwear: null, bottoms: null, boots: null, backpack: null };
    if (dom) { dom.notice.textContent = ''; dom.notice.hidden = true; }
  }

  // ---------------------------------------------------------------
  // Lazy Three.js runtime loader -- one shared Promise, concurrent
  // and repeated opens all reuse it, failure is cached as a
  // rejection so a dead CDN doesn't get silently retried forever
  // mid-session without a page reload.
  // ---------------------------------------------------------------
  function loadRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimePromise = Promise.all([
      import('three'),
      import(GLTF_LOADER_URL),
      import(ORBIT_CONTROLS_URL)
    ]).then(function (mods) {
      return { THREE: mods[0], GLTFLoader: mods[1].GLTFLoader, OrbitControls: mods[2].OrbitControls };
    });
    return runtimePromise;
  }

  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  }

  function loadGLTF(loader, url) {
    return new Promise(function (resolve, reject) {
      loader.load(url, resolve, undefined, reject);
    });
  }

  // ---------------------------------------------------------------
  // Scene construction (built once, reused across opens/closes)
  // ---------------------------------------------------------------
  function collectMaterialsByName(root) {
    var map = {};
    root.traverse(function (obj) {
      if (!obj.isMesh) return;
      var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(function (m) { if (m && m.name && !map[m.name]) map[m.name] = m; });
    });
    return map;
  }

  // Companion to collectMaterialsByName(), keyed the same way but holding
  // the actual mesh objects instead of their materials -- needed so a
  // specific named region of the mannequin (its own feet) can be hidden by
  // visibility rather than recolored, which collectMaterialsByName()'s
  // output can't do.
  function collectMeshesByMaterialName(root) {
    var map = {};
    root.traverse(function (obj) {
      if (!obj.isMesh) return;
      var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(function (m) {
        if (!m || !m.name) return;
        (map[m.name] = map[m.name] || []).push(obj);
      });
    });
    return map;
  }

  function safeSetColor(material, colorStr) {
    if (!material || !colorStr) return;
    try { material.color.set(colorStr); } catch (e) { /* malformed color string -- leave material as-is */ }
  }

  // Prop base-color textures (boots/sneakers/trousers) are not neutral
  // shading maps -- inspection of the committed GLBs found boots.glb uses a
  // multi-hue UV "palette atlas" (many fully-saturated swatches) and
  // trousers.glb bakes its own tan colorway directly into the texture.
  // safeSetColor()'s material.color multiply was therefore tinting an
  // already-colored image, producing a blend of the garment's stored color
  // and whatever hue happened to sit under each UV island rather than the
  // garment's actual color. Converting the map to luminance once, before
  // any tint is ever applied, turns it into what it should have been used
  // as all along: a plain light/shadow (AO-style) mask that a flat color
  // multiplies cleanly, the same role sneakers.glb's already-neutral
  // texture plays. Runs once per prop load; failures (e.g. a tainted
  // canvas) just leave the original texture in place.
  function desaturateMaterialMaps(materials) {
    // Keyed by the ORIGINAL texture's uuid, not the material name -- glTF
    // lets more than one named material reference the same Texture object
    // (e.g. several mesh regions sharing one palette atlas). Tier 40 checked
    // this: neither boots.glb/sneakers.glb/trousers.glb currently share a
    // texture across differently-named materials, but the format allows it
    // and nothing here should assume today's asset layout. Cloning and
    // disposing per-MATERIAL instead of per-TEXTURE would double-clone (fine,
    // just wasteful) but ALSO double-dispose the shared original, which
    // would be unsafe to do before every sharer has already switched off it
    // -- so disposal happens in a second pass, once per unique original,
    // after every material referencing it has its own clone installed.
    var grayByOriginalId = {};
    var originals = [];
    Object.keys(materials).forEach(function (name) {
      var m = materials[name];
      if (!m || !m.map || !m.map.image) return;
      var original = m.map;
      var existingClone = grayByOriginalId[original.uuid];
      if (existingClone) {
        m.map = existingClone;
        m.needsUpdate = true;
        return;
      }
      var img = original.image;
      var w = img.width, h = img.height;
      if (!w || !h) return;
      try {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var frame = ctx.getImageData(0, 0, w, h);
        var px = frame.data;
        for (var i = 0; i < px.length; i += 4) {
          var l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          px[i] = px[i + 1] = px[i + 2] = l;
        }
        ctx.putImageData(frame, 0, 0);
        var gray = original.clone();
        gray.image = canvas;
        gray.colorSpace = original.colorSpace; // clone() already copies this; set explicitly so intent isn't implicit
        gray.needsUpdate = true;
        grayByOriginalId[original.uuid] = gray;
        originals.push(original);
        m.map = gray;
        m.needsUpdate = true;
      } catch (e) { /* tainted/unreadable source canvas -- leave texture as-authored */ }
    });
    // Only now, after every material that pointed at a given original has
    // been switched to its (single, shared) gray clone, is it safe to free
    // that original -- clone() doesn't transfer GPU ownership, so leaving it
    // un-disposed would leak it, but disposing inside the loop above could
    // free it out from under a not-yet-processed sharer. Each original was
    // never rendered before being replaced (this runs synchronously right
    // after the prop is added, before the next render), so there's nothing
    // to free on the GPU yet in practice, but dispose() is correct
    // regardless of upload state and prevents a real leak if that timing
    // assumption ever stops holding.
    originals.forEach(function (t) { t.dispose(); });
  }

  function fitAndPlace(THREE, obj, mannequinBox, heightRatio, verticalY) {
    var box = new THREE.Box3().setFromObject(obj);
    var size = new THREE.Vector3();
    box.getSize(size);
    var mSize = new THREE.Vector3();
    mannequinBox.getSize(mSize);
    var scale = size.y > 0 ? (mSize.y * heightRatio) / size.y : 1;
    obj.scale.setScalar(scale);

    box.setFromObject(obj);
    var center = new THREE.Vector3();
    box.getCenter(center);
    var mCenter = new THREE.Vector3();
    mannequinBox.getCenter(mCenter);

    obj.position.x += (mCenter.x - center.x);
    obj.position.z += (mCenter.z - center.z);
    obj.position.y += (verticalY - box.min.y);
  }

  function buildViewer() {
    var deps = viewer.deps;
    var THREE = deps.THREE;

    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    dom.viewport.appendChild(renderer.domElement);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);

    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    var dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(2, 4, 3);
    scene.add(dir);

    var controls = new deps.OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    // minDistance/maxDistance are set once the mannequin's real measured
    // size is known (below) -- a fixed absolute bound here would silently
    // clamp the initial framing regardless of the model's actual scale.
    controls.target.set(0, 0, 0);

    viewer.renderer = renderer;
    viewer.scene = scene;
    viewer.camera = camera;
    viewer.controls = controls;

    var loader = new deps.GLTFLoader();
    return loadGLTF(loader, MODEL_URLS.mannequin).then(function (gltf) {
      var mannequin = gltf.scene;
      scene.add(mannequin);

      var box = new THREE.Box3().setFromObject(mannequin);
      var size = new THREE.Vector3();
      box.getSize(size);
      var center = new THREE.Vector3();
      box.getCenter(center);

      camera.position.set(center.x, center.y + size.y * 0.05, center.z + size.y * 1.85);
      controls.target.set(center.x, center.y, center.z);
      controls.minDistance = size.y * 0.3;
      controls.maxDistance = size.y * 3;
      controls.update();

      viewer.mannequin = mannequin;
      viewer.mannequinBox = box;
      viewer.materials = collectMaterialsByName(mannequin);
      viewer.meshesByMaterial = collectMeshesByMaterialName(mannequin);
      // Captured once, here, before any outfit is ever applied -- the
      // mannequin's own authored colors, so a later outfit that omits a
      // category (no shirt/no trousers piece) has something deterministic
      // to go back to instead of leaving whatever the previous outfit left
      // behind (viewer/its materials are built once and reused across every
      // open(), per ensureViewerBuilt()'s memoization).
      viewer.baseColors = {};
      Object.keys(viewer.materials).forEach(function (name) {
        viewer.baseColors[name] = viewer.materials[name].color.clone();
      });
      viewer.ready = true;

      startRenderLoop();
    });
  }

  function onResize() {
    if (!viewer || !viewer.renderer) return;
    var w = dom.viewport.clientWidth || 1;
    var h = dom.viewport.clientHeight || 1;
    viewer.renderer.setSize(w, h, false);
    viewer.camera.aspect = w / h;
    viewer.camera.updateProjectionMatrix();
  }

  function startRenderLoop() {
    if (viewer.rafId) return;
    function tick() {
      viewer.rafId = requestAnimationFrame(tick);
      if (viewer.controls) viewer.controls.update();
      if (viewer.renderer && viewer.scene && viewer.camera) {
        viewer.renderer.render(viewer.scene, viewer.camera);
      }
    }
    viewer.rafId = requestAnimationFrame(tick);
  }

  function stopRenderLoop() {
    if (viewer && viewer.rafId) {
      cancelAnimationFrame(viewer.rafId);
      viewer.rafId = null;
    }
  }

  // ---------------------------------------------------------------
  // Garment application
  // ---------------------------------------------------------------
  function pickByCategory(pieces, cat) {
    var matches = pieces.filter(function (p) { return p && p.category === cat; });
    if (matches.length > 1 && window.console && console.debug) {
      console.debug('[fitting-room] multiple pieces for category "' + cat + '" -- using the first, ignoring the rest.');
    }
    return matches[0] || null;
  }

  function ensureProp(key, scaleRatio, verticalRatio, backOffset) {
    var THREE = viewer.deps.THREE;
    var state = viewer.props[key];
    if (state.root) return Promise.resolve(state);
    if (state.loading) return state.loading;

    var loader = new viewer.deps.GLTFLoader();
    state.loading = loadGLTF(loader, MODEL_URLS[key]).then(function (gltf) {
      var root = gltf.scene;
      viewer.scene.add(root);

      var mBox = viewer.mannequinBox;
      var mSize = new THREE.Vector3();
      mBox.getSize(mSize);
      var mCenter = new THREE.Vector3();
      mBox.getCenter(mCenter);
      var verticalY = mBox.min.y + mSize.y * verticalRatio;
      fitAndPlace(THREE, root, mBox, scaleRatio, verticalY);
      // -Z, not +Z: the mannequin faces +Z (toward the default camera), so
      // subtracting pushes the prop behind the body instead of in front of it.
      if (backOffset) root.position.z -= mSize.z * backOffset;

      state.root = root;
      state.materials = collectMaterialsByName(root);
      desaturateMaterialMaps(state.materials);
      state.loading = null;
      return state;
    }, function (err) {
      state.loading = null;
      throw err;
    });
    return state.loading;
  }

  // The mannequin's own feet are modeled as a separate "Socks" region (own
  // material, confirmed by inspecting quat-man.glb) under whatever shoe is
  // layered on top. Production browser validation showed this sock/ankle
  // geometry visibly poking out above both boot and sneaker openings --
  // footwear models fitted by fitAndPlace() cover the foot's footprint and
  // height but nothing ever hid the mannequin's own foot underneath. No
  // scale/position tweak closes that, since it's a second, unrelated mesh
  // occupying the same space, not a misaligned one -- so it's hidden
  // outright while a shoe is shown, and restored when none is.
  function setSocksVisible(visible) {
    var meshes = viewer.meshesByMaterial && viewer.meshesByMaterial.Socks;
    if (meshes) meshes.forEach(function (m) { m.visible = visible; });
  }

  function updateBoots(piece) {
    if (!piece) {
      if (viewer.props.boots.root) viewer.props.boots.root.visible = false;
      if (viewer.props.sneakers.root) viewer.props.sneakers.root.visible = false;
      setSocksVisible(true);
      setNotice('boots', null);
      return;
    }

    // Two real footwear models exist (Tier 2): boots and sneakers, selected
    // ONLY by an EXPLICIT, exact footwearStyle match. Tier 42's audit found
    // the real ingestion flow leaves footwearStyle unset unless the user
    // deliberately picks a style -- the old `piece.footwearStyle || 'boots'`
    // fallback silently rendered ordinary sneakers (and anything else
    // unset) as boots for most real items, with no disclosure at all (the
    // disclosure only fired for an explicit-but-unrecognized value like
    // 'sandals', never for the far more common unset/null case). An
    // unspecified or unrecognized style now gets the SAME treatment as "no
    // footwear piece at all" -- the mannequin's own feet, already a correct
    // and fully-supported state -- plus a notice explaining why, instead of
    // guessing a specific shoe shape that may well be wrong.
    var style = piece.footwearStyle;
    if (style !== 'boots' && style !== 'sneakers') {
      if (viewer.props.boots.root) viewer.props.boots.root.visible = false;
      if (viewer.props.sneakers.root) viewer.props.sneakers.root.visible = false;
      setSocksVisible(true);
      setNotice('boots', 'This item’s shoe shape isn’t set yet — showing the mannequin’s own feet instead of guessing boots or sneakers.');
      return;
    }

    setSocksVisible(false);
    var key = style; // guaranteed 'boots' or 'sneakers' by the check above
    var otherKey = key === 'sneakers' ? 'boots' : 'sneakers';
    var ratio = key === 'sneakers' ? SNEAKER_HEIGHT_RATIO : BOOT_HEIGHT_RATIO;
    if (viewer.props[otherKey].root) viewer.props[otherKey].root.visible = false;

    ensureProp(key, ratio, 0).then(function (state) {
      state.root.visible = true;
      Object.keys(state.materials).forEach(function (name) {
        safeSetColor(state.materials[name], piece.color);
      });
      setNotice('boots', null);
    }).catch(function () {
      // setSocksVisible(false) above already ran on the assumption the shoe
      // would load. Tier 39's review caught that this path never undid it --
      // on a genuine load failure the mannequin was left with neither its
      // own feet nor a shoe, an empty gap strictly worse than the pre-shoe
      // behavior (bare feet, always visible). Restore the fallback here,
      // the same recovery updateBoots(null) already gives the "no footwear
      // selected" case.
      setSocksVisible(true);
      setNotice('boots', 'Footwear preview couldn’t be loaded — showing the rest of the outfit.');
    });
  }

  function updateTrousers(piece) {
    if (!piece) {
      if (viewer.props.trousers.root) viewer.props.trousers.root.visible = false;
      return;
    }
    // Only an explicit/default 'trousers' bottomStyle has matching geometry.
    // 'shorts' (or any future unrecognized value) has none -- same as every
    // bottoms item before this prop existed -- so it falls back to just the
    // mannequin's own recolored Pants material, with the existing shape
    // disclosure notice (set separately in applyOutfit, unchanged).
    var bottomStyle = piece.bottomStyle || 'trousers';
    if (bottomStyle !== 'trousers') {
      if (viewer.props.trousers.root) viewer.props.trousers.root.visible = false;
      return;
    }
    ensureProp('trousers', TROUSERS_HEIGHT_RATIO, TROUSERS_VERTICAL_RATIO, TROUSERS_BACK_OFFSET_RATIO).then(function (state) {
      state.root.visible = true;
      Object.keys(state.materials).forEach(function (name) {
        safeSetColor(state.materials[name], piece.color);
      });
    }).catch(function () {
      setNotice('bottoms', 'Trousers preview couldn’t be loaded — showing the rest of the outfit.');
    });
  }

  function updateBackpack(piece) {
    if (!piece) {
      if (viewer.props.backpack.root) viewer.props.backpack.root.visible = false;
      setNotice('backpack', null);
      return;
    }
    ensureProp('backpack', BACKPACK_HEIGHT_RATIO, 0.55, BACKPACK_BACK_OFFSET_RATIO).then(function (state) {
      state.root.visible = true;
      // Unlike boots/sneakers/trousers, backpack.glb has no texture -- it's
      // built from 4 distinctly-colored named materials (body, strap,
      // buckle, trim), confirmed by direct inspection. Forcing all 4 to the
      // item's single stored color (the old behavior) erased that design
      // and wasn't any more accurate than the asset's own colors, so this
      // is shown as modeled instead, with the same kind of honest
      // "can't be customized" disclosure already used for outerwear/shorts
      // below -- not a bug being hidden, a representation limit being named.
      setNotice('backpack', 'This accessory’s colors are shown as modeled — its stored color isn’t applied to the 3D preview.');
    }).catch(function () {
      setNotice('backpack', 'Accessory preview couldn’t be loaded.');
    });
  }

  // Applies the piece's color to the mannequin's own named material region
  // when that category is present in THIS outfit, otherwise restores the
  // mannequin's originally-authored color (captured once in buildViewer())
  // -- never leaves whatever color the previous open() call set. Must run
  // every time applyOutfit() runs, for every base-mannequin category, since
  // viewer.materials is long-lived across opens/closes, not rebuilt per
  // outfit.
  function applyBaseMaterialColor(name, piece) {
    var material = viewer.materials[name];
    if (!material) return;
    if (piece && piece.color) {
      safeSetColor(material, piece.color);
    } else if (viewer.baseColors && viewer.baseColors[name]) {
      material.color.copy(viewer.baseColors[name]);
    }
  }

  function applyOutfit(pieces) {
    var list = Array.isArray(pieces) ? pieces.filter(Boolean) : [];
    if (!Array.isArray(pieces) && window.console && console.debug) {
      console.debug('[fitting-room] open() called without a pieces array -- showing the bare mannequin.');
    }

    var top = pickByCategory(list, 'tops');
    var bottom = pickByCategory(list, 'bottoms');
    var outer = pickByCategory(list, 'outerwear');
    var shoe = pickByCategory(list, 'footwear');
    var acc = pickByCategory(list, 'accessories');

    applyBaseMaterialColor('Shirt', top);
    applyBaseMaterialColor('Pants', bottom);

    updateBoots(shoe);
    updateBackpack(acc);
    updateTrousers(bottom);
    setNotice('outerwear', outer ? 'Outerwear is not visualized yet — shown without the rest of the outfit’s jacket/coat piece.' : null);
    // 'trousers' (default/explicit) now has real overlay geometry via
    // updateTrousers() above. 'shorts' still has none -- the mannequin's
    // "Pants" material region can't become shorter geometry, so it can only
    // be disclosed, never shown correctly.
    var bottomStyle = bottom && (bottom.bottomStyle || 'trousers');
    setNotice('bottoms', bottomStyle === 'shorts'
      ? 'This item is shorts, not trousers — the mannequin’s pants shape can’t be changed yet, so only its color is shown.'
      : null);
  }

  // ---------------------------------------------------------------
  // Public open/close
  // ---------------------------------------------------------------
  function open(pieces) {
    ensureDom();
    dom.bg.classList.add('show');
    clearNotices();

    if (!escHandler) {
      escHandler = function (e) { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', escHandler);
    }

    var ready = viewer && viewer.ready
      ? Promise.resolve()
      : ensureViewerBuilt();

    setState(viewer && viewer.ready ? null : 'Loading viewer…');

    ready.then(function () {
      setState(null);
      onResize();
      startRenderLoop();
      applyOutfit(pieces);
    }).catch(function (err) {
      var reason = (viewer && viewer.fatal) || 'Couldn’t load the 3D viewer. Please try again later.';
      setState(reason);
      if (window.console && console.warn) console.warn('[fitting-room]', err);
    });
  }

  // Memoizes the ENTIRE build (runtime load + mannequin GLB + scene setup),
  // not just the Three.js import -- two opens fired before the first
  // settles must share this one promise, or each would independently
  // create its own renderer/canvas/mannequin once the shared runtime
  // import resolves (the runtime promise alone isn't enough to prevent
  // that, since "has the runtime loaded" and "has the scene been built"
  // are different questions).
  function ensureViewerBuilt() {
    if (viewer && viewer.ready) return Promise.resolve();
    if (buildPromise) return buildPromise;
    if (!webglAvailable()) {
      viewer = viewer || {};
      viewer.fatal = 'Your browser doesn’t support 3D viewing (WebGL unavailable).';
      return Promise.reject(new Error('webgl-unavailable'));
    }
    buildPromise = loadRuntime().then(function (deps) {
      viewer = {
        deps: deps,
        ready: false,
        rafId: null,
        materials: {},
        props: { boots: {}, sneakers: {}, backpack: {}, trousers: {} }
      };
      return buildViewer();
    }, function (err) {
      viewer = viewer || {};
      viewer.fatal = 'Couldn’t load the 3D runtime (network/CDN unavailable).';
      throw err;
    });
    return buildPromise;
  }

  function close() {
    if (!dom) return;
    dom.bg.classList.remove('show');
    stopRenderLoop();
  }

  function disposeAll() {
    stopRenderLoop();
    if (!viewer) return;
    if (viewer.scene && viewer.deps) {
      viewer.scene.traverse(function (obj) {
        if (obj.isMesh) {
          if (obj.geometry) obj.geometry.dispose();
          var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(function (m) { if (m) m.dispose(); });
        }
      });
    }
    if (viewer.renderer) viewer.renderer.dispose();
    viewer = null;
  }

  window.addEventListener('resize', function () { if (dom && dom.bg.classList.contains('show')) onResize(); });
  window.addEventListener('pagehide', disposeAll);

  window.WardrobeFittingRoom = { open: open, close: close };
})();
