// =============================================================================
// Shared theme applier — promotes the dashboard theme switch to every page,
// and is the single synchronous, pre-paint authority for the Custom Theme
// engine (Phase 2). Reads the theme picked in Account -> Preferences
// (index.html, js/account.js) from the synced profile blob and stamps
// <html data-apt-theme="..."> so each page's stylesheet can restyle its
// surfaces. Loaded SYNCHRONOUSLY in <head> (no defer) so the attribute lands
// before first paint -- no dark flash. Custom Theme validation runs in this
// same synchronous pass, so a bad/corrupt custom theme never paints even once.
//
// 'dark' (the default) removes the attribute, matching js/account.js's
// applyTheme(). The storage listener keeps long-lived tabs in step when the
// theme changes in another tab (or when account.js nudges same-document
// listeners).
//
// Custom Theme contract (aptron_profile_v1.customTheme):
//   { v: 1, accent: "#rrggbb", accent2: "#rrggbb",
//     bgPage?: "#rrggbb", bgSurface?: "#rrggbb" }
// Validation is atomic -- any single failure invalidates the whole object,
// never a partial apply. accent maps to --accent; accent2 maps to the
// existing --accent-dark token (no new global --accent-2 is introduced --
// --accent-dark already has real consumers, e.g. css/styles.css:355).
// bgPage/bgSurface are optional and map to --bg-page/--bg-surface; when
// omitted, no inline override is set, so the stylesheet default applies.
//
// A custom theme is classified as data-apt-theme="custom-dark" or
// "custom-light" (never bare "custom") by comparing the effective --bg-page
// against black vs. white -- this lets it ride the SAME existing
// light-family selectors (:is([data-apt-theme="light"], [...="nordic"],
// [...="custom-light"])) that Wardrobe/Health/Gym/topbar/account already
// use, rather than duplicating any override block.
//
// If theme === "custom" but customTheme fails validation, the profile is
// corrected in place (customTheme removed, theme forced to "dark") and
// persisted with one localStorage write -- mirrors js/account.js's own
// saveProfile(), duplicated here (not imported) because there is no shared
// module system in this project (no build step, see CLAUDE.md) and the two
// scripts are independent IIFEs.
// =============================================================================
(function () {
  'use strict';
  var PKEY = 'aptron_profile_v1';
  var HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var CUSTOM_VARS = ['--accent', '--accent-dark', '--bg-page', '--bg-surface'];

  // ── color validation / normalization ────────────────────────────────────
  // Strict whitelist: only #rgb / #rrggbb pass. Everything else (named
  // colors, rgb()/hsl(), var(), url(), color-mix()...) is rejected outright
  // -- this is also what keeps CSS injection impossible, since the only
  // thing ever handed to element.style.setProperty() is a value that has
  // already passed this exact regex.
  function normalizeHex(v) {
    if (typeof v !== 'string' || !HEX_RE.test(v)) return null;
    var h = v.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return '#' + h.toLowerCase();
  }

  // ── WCAG relative luminance / contrast ──────────────────────────────────
  function srgbToLinear(c) {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function relLuminance(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  }
  function contrastRatio(hexA, hexB) {
    var la = relLuminance(hexA), lb = relLuminance(hexB);
    var lighter = Math.max(la, lb), darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }

  // Which text-scheme (dark canvas + white text vs. light canvas + ink text)
  // reads better against this background -- used both to classify
  // custom-dark/custom-light and, internally, as the fallback background a
  // preview/validation pass measures against when bgPage is omitted.
  var DEFAULT_BG_PAGE = '#101010';   // css/styles.css :root --bg-page
  // The one authoritative contrast floor -- validateCustomTheme() and the
  // Phase 3 suggestAccessible() below both read this instead of each
  // hardcoding 4.5 independently.
  var MIN_CONTRAST = 4.5;

  // ── customTheme validation (atomic) ─────────────────────────────────────
  // Any single failure -- missing field, wrong version, malformed color,
  // failing contrast -- invalidates the ENTIRE object. Never partially
  // applied, never silently repaired into something plausible. Unknown
  // extra keys on the input object are simply ignored (forward-compatible;
  // never interpolated anywhere, so they carry no injection risk).
  function validateCustomTheme(ct) {
    if (!ct || typeof ct !== 'object') return null;
    if (ct.v !== 1) return null;

    var accent = normalizeHex(ct.accent);
    var accent2 = normalizeHex(ct.accent2);
    if (!accent || !accent2) return null;

    var bgPage;
    if (ct.bgPage !== undefined) {
      bgPage = normalizeHex(ct.bgPage);
      if (!bgPage) return null;          // present but malformed -> whole object invalid
    }
    var bgSurface;
    if (ct.bgSurface !== undefined) {
      bgSurface = normalizeHex(ct.bgSurface);
      if (!bgSurface) return null;
    }

    var effBg = bgPage || DEFAULT_BG_PAGE;
    var effSurface = bgSurface || effBg;

    // Required text contrast (>=4.5:1): accent and accent2 (--accent-dark)
    // are both real text colors in this app (css/styles.css:306,383,599,
    // 651,914 for --accent; --accent-dark feeds gradients/text partners),
    // checked against both possible backgrounds a consumer might sit on.
    if (contrastRatio(accent, effBg) < MIN_CONTRAST) return null;
    if (contrastRatio(accent, effSurface) < MIN_CONTRAST) return null;
    if (contrastRatio(accent2, effBg) < MIN_CONTRAST) return null;
    if (contrastRatio(accent2, effSurface) < MIN_CONTRAST) return null;

    var out = { v: 1, accent: accent, accent2: accent2 };
    if (bgPage) out.bgPage = bgPage;
    if (bgSurface) out.bgSurface = bgSurface;
    return out;
  }

  // custom-dark vs custom-light: whichever of pure black/white reads better
  // against the effective background wins -- reuses contrastRatio() itself
  // rather than a hardcoded luminance threshold, so the same WCAG math this
  // whole engine relies on is also what decides the classification.
  function classify(validCt) {
    var bg = (validCt && validCt.bgPage) || DEFAULT_BG_PAGE;
    var blackWins = contrastRatio(bg, '#000000') > contrastRatio(bg, '#ffffff');
    return blackWins ? 'custom-light' : 'custom-dark';
  }

  // ── Phase 3: "Ajustar automáticamente" candidate generation ─────────────
  // HSL is used ONLY to generate candidate colors along a lightness ramp --
  // contrastRatio() (above) remains the sole authority on whether a
  // candidate actually passes. Small, deterministic, no color library.
  function hexToRgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  }
  function rgbToHex(r, g, b) {
    function ch(n) {
      var v = Math.max(0, Math.min(255, Math.round(n)));
      var s = v.toString(16);
      return s.length === 1 ? '0' + s : s;
    }
    return '#' + ch(r) + ch(g) + ch(b);
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h, s: s, l: l };
  }
  function hslToRgb(h, s, l) {
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return {
      r: hue2rgb(p, q, h + 1 / 3) * 255,
      g: hue2rgb(p, q, h) * 255,
      b: hue2rgb(p, q, h - 1 / 3) * 255
    };
  }

  // Given a color that fails contrast against one or more backgrounds,
  // finds the nearest color (by lightness steps along the SAME hue/
  // saturation) that passes against ALL of them -- never jumps straight to
  // black/white unless that's genuinely where the nearest passing value
  // lies. Deterministic: identical inputs always produce the identical
  // output. Returns null if no lightness value on this hue/saturation ramp
  // satisfies every background (e.g. the backgrounds are themselves too
  // close to opposite extremes for any single color to bridge).
  function suggestAccessible(hex, backgrounds, minRatio) {
    var color = normalizeHex(hex);
    if (!color) return null;
    var bgs = [];
    for (var i = 0; i < (backgrounds || []).length; i++) {
      var bg = normalizeHex(backgrounds[i]);
      if (!bg) return null;
      bgs.push(bg);
    }
    if (!bgs.length) return null;
    var threshold = typeof minRatio === 'number' ? minRatio : MIN_CONTRAST;

    function passes(candidate) {
      for (var j = 0; j < bgs.length; j++) {
        if (contrastRatio(candidate, bgs[j]) < threshold) return false;
      }
      return true;
    }
    if (passes(color)) return color;   // already valid -- predictable no-op

    var rgb = hexToRgb(color);
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    var STEP = 0.01;   // 1 lightness percentage-point per step

    function search(direction) {
      for (var step = 1; step <= 100; step++) {
        var l = direction > 0
          ? Math.min(1, hsl.l + step * STEP)
          : Math.max(0, hsl.l - step * STEP);
        var c = hslToRgb(hsl.h, hsl.s, l);
        var candidate = normalizeHex(rgbToHex(c.r, c.g, c.b));
        if (candidate && passes(candidate)) return { hex: candidate, steps: step };
        if (l === 1 || l === 0) break;   // hit the boundary -- stop
      }
      return null;
    }
    var lighter = search(1);
    var darker = search(-1);
    if (lighter && darker) return lighter.steps <= darker.steps ? lighter.hex : darker.hex;
    if (lighter) return lighter.hex;
    if (darker) return darker.hex;
    return null;
  }

  function clearCustomInline(el) {
    for (var i = 0; i < CUSTOM_VARS.length; i++) el.style.removeProperty(CUSTOM_VARS[i]);
  }

  function applyCustom(validCt) {
    var el = document.documentElement;
    el.setAttribute('data-apt-theme', classify(validCt));
    el.style.setProperty('--accent', validCt.accent);
    el.style.setProperty('--accent-dark', validCt.accent2);
    if (validCt.bgPage) el.style.setProperty('--bg-page', validCt.bgPage);
    else el.style.removeProperty('--bg-page');
    if (validCt.bgSurface) el.style.setProperty('--bg-surface', validCt.bgSurface);
    else el.style.removeProperty('--bg-surface');
  }

  // Mirrors js/account.js's saveProfile() (JSON.stringify + setItem on the
  // same key) -- see file header for why this is duplicated rather than
  // shared. Sets window.__aptThemeRecovered so the Preferences UI can show a
  // one-line, non-blocking notice next time it's opened (Section 14).
  function correctProfile(profile) {
    delete profile.customTheme;
    profile.theme = 'dark';
    try { localStorage.setItem(PKEY, JSON.stringify(profile)); } catch (e) {}
    try { window.__aptThemeRecovered = true; } catch (e) {}
  }

  function apply() {
    var profile;
    try { profile = JSON.parse(localStorage.getItem(PKEY)) || {}; } catch (e) { profile = {}; }
    var el = document.documentElement;
    clearCustomInline(el);
    var t = profile.theme;

    if (t === 'custom') {
      var valid = validateCustomTheme(profile.customTheme);
      if (valid) { applyCustom(valid); return; }
      correctProfile(profile);
      t = 'dark';
    }

    if (!t || t === 'dark') el.removeAttribute('data-apt-theme');
    else el.setAttribute('data-apt-theme', t);
  }

  apply();
  window.addEventListener('storage', apply);

  // Shared bridge so js/account.js's customizer can reuse the exact same
  // validation/normalization/contrast/classification logic for live preview
  // and for re-validating on Save -- no separate copy, no drift risk. Same
  // pattern as the existing window.AptAccount / window.initCloudSync bridges
  // (no module system in this project).
  window.AptTheme = {
    normalizeHex: normalizeHex,
    contrastRatio: contrastRatio,
    relLuminance: relLuminance,
    validateCustomTheme: validateCustomTheme,
    classify: classify,
    clearCustomInline: clearCustomInline,
    applyCustom: applyCustom,
    apply: apply,
    suggestAccessible: suggestAccessible,
    DEFAULT_BG_PAGE: DEFAULT_BG_PAGE,
    MIN_CONTRAST: MIN_CONTRAST
  };
})();
