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

  function safeSetColor(material, colorStr) {
    if (!material || !colorStr) return;
    try { material.color.set(colorStr); } catch (e) { /* malformed color string -- leave material as-is */ }
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
      state.loading = null;
      return state;
    }, function (err) {
      state.loading = null;
      throw err;
    });
    return state.loading;
  }

  function updateBoots(piece) {
    if (!piece) {
      if (viewer.props.boots.root) viewer.props.boots.root.visible = false;
      if (viewer.props.sneakers.root) viewer.props.sneakers.root.visible = false;
      setNotice('boots', null);
      return;
    }
    // Two real footwear models exist now (Tier 2): boots and sneakers,
    // selected by the item's own footwearStyle. Anything else (sandals,
    // heels, ... -- no asset exists) falls back to the boots model as a
    // disclosed placeholder, same as ALL footwear did before sneakers got
    // real geometry; see fitting-room's Tier 1/Tier 2 passes.
    var style = piece.footwearStyle || 'boots';
    var key = style === 'sneakers' ? 'sneakers' : 'boots';
    var otherKey = key === 'sneakers' ? 'boots' : 'sneakers';
    var ratio = key === 'sneakers' ? SNEAKER_HEIGHT_RATIO : BOOT_HEIGHT_RATIO;
    if (viewer.props[otherKey].root) viewer.props[otherKey].root.visible = false;

    ensureProp(key, ratio, 0).then(function (state) {
      state.root.visible = true;
      Object.keys(state.materials).forEach(function (name) {
        safeSetColor(state.materials[name], piece.color);
      });
      setNotice('boots', (style !== 'boots' && style !== 'sneakers')
        ? 'This item isn’t boot-shaped — showing a generic boot placeholder since a matching shoe model isn’t available yet.'
        : null);
    }).catch(function () {
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
      Object.keys(state.materials).forEach(function (name) {
        safeSetColor(state.materials[name], piece.color);
      });
      setNotice('backpack', null);
    }).catch(function () {
      setNotice('backpack', 'Accessory preview couldn’t be loaded.');
    });
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

    if (viewer.materials.Shirt && top) safeSetColor(viewer.materials.Shirt, top.color);
    if (viewer.materials.Pants && bottom) safeSetColor(viewer.materials.Pants, bottom.color);

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
