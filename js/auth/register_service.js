// =============================================================
// Registration service — user creation (supa.auth.signUp), the
// signup validations, the premium avatar presets, and the
// aptron_pending_profile_v1 stash/promote engine. No DOM, no window.
// =============================================================
import { EMAIL_RE, errorText, transportError } from './login_service.js';

// Sign-up password policy — each rule checked separately so the inline
// error names exactly what's missing. "Special" = any non-alphanumeric,
// deliberately broader than a fixed symbol list so -, _, ~ etc. count.
export const PW_RULES = [
  { re: /.{8,}/,        label: '8+ characters' },
  { re: /[a-z]/,        label: 'a lowercase letter' },
  { re: /[A-Z]/,        label: 'an uppercase letter' },
  { re: /[0-9]/,        label: 'a number' },
  { re: /[^A-Za-z0-9]/, label: 'a special character' },
];

const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;

export function normalizeFullName(v) {
  return (v || '').trim().slice(0, 60);
}
export function normalizeUsername(v) {
  return (v || '').trim().toLowerCase().slice(0, 24);
}

// → [{ field, message }] — every local failure at once, so the UI can show
// all the chips in a single pass.
export function validateRegistration({ fullName, username, email, password }) {
  const errors = [];
  if (!fullName) errors.push({ field: 'name', message: 'Enter your full name.' });
  if (username && !USERNAME_RE.test(username))
    errors.push({ field: 'username', message: 'Username: 3–24 letters, numbers, _ or .' });
  if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'Enter a valid email address.' });
  if (!password) errors.push({ field: 'password', message: 'Enter your password.' });
  else {
    const missing = PW_RULES.filter((r) => !r.re.test(password)).map((r) => r.label);
    if (missing.length) errors.push({ field: 'password', message: 'Password needs ' + missing.join(', ') + '.' });
  }
  return errors;
}

// Error surfacing: unlike sign-in (strictly generic — see login_service.js),
// sign-UP names the actual blocker — the owner accepted the enumeration
// tradeoff here so a taken email, a server-side password rejection, or the
// instance-wide "signups disabled" toggle (AUTH.md step 1 recommends it
// stays OFF) don't masquerade as a mysterious generic failure. Raw GoTrue
// text is still never echoed.
export function friendlySignupError(error) {
  const m = errorText(error);
  const transport = transportError(m);
  if (transport) return transport;
  if (m.indexOf('not allowed') !== -1 || m.indexOf('disabled') !== -1)
    return 'Registrations are switched off for this instance.';
  if (m.indexOf('already registered') !== -1 || m.indexOf('already been registered') !== -1)
    return 'That email is already registered — sign in instead.';
  if (m.indexOf('password') !== -1)
    return 'The server rejected that password — try a longer one.';
  return 'Could not create the account. Please try again.';
}

// ── Premium default avatars ─────────────────────────────────────────────────
// Gradient portrait orbs in the theme palettes, built as self-contained SVG
// data URIs so they ride the synced profile blob exactly like an uploaded
// photo (account.js renders p.avatar as-is).
function makePresetAvatar(a, b) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
    '<defs><radialGradient id="g" cx="35%" cy="28%" r="85%">' +
    '<stop offset="0%" stop-color="' + a + '"/>' +
    '<stop offset="100%" stop-color="' + b + '"/></radialGradient></defs>' +
    '<rect width="160" height="160" fill="url(#g)"/>' +
    '<circle cx="80" cy="62" r="25" fill="rgba(255,255,255,0.88)"/>' +
    '<path d="M26 160c7-33 27-50 54-50s47 17 54 50z" fill="rgba(255,255,255,0.88)"/>' +
    '</svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
// 4 presets + the initials option = one clean row on the 372px card.
export const AVATAR_PRESETS = [
  ['#e6cf9c', '#956534'],   // Shenlong gold
  ['#c3ad7e', '#1c1c1e'],   // obsidian
  ['#00F0FF', '#0a2a3a'],   // cyber neon
  ['#52D1A2', '#0a2018'],   // emerald
].map((p) => makePresetAvatar(p[0], p[1]));

// ── Profile bootstrap (aptron_profile_v1) ───────────────────────────────────
// register() stashes the collected profile (name / username / avatar / theme)
// under a PENDING key; main.js promotes it into the real, synced profile only
// once a session exists — immediately with auto-confirm, or on the sign-in
// that follows email confirmation. The promote is fill-only, so it can never
// clobber an existing (possibly cloud-synced) profile.
const PROFILE_KEY = 'aptron_profile_v1';
const PENDING_PROFILE_KEY = 'aptron_pending_profile_v1';

function stashPendingProfile(p) {
  try { localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
}
function clearPendingProfile() {
  try { localStorage.removeItem(PENDING_PROFILE_KEY); } catch (e) {}
}
export function promotePendingProfile() {
  try {
    const raw = localStorage.getItem(PENDING_PROFILE_KEY);
    if (!raw) return;
    localStorage.removeItem(PENDING_PROFILE_KEY);
    const pending = JSON.parse(raw) || {};
    let cur = {};
    try { cur = JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch (e) {}
    Object.keys(pending).forEach((k) => {
      if (cur[k] === undefined || cur[k] === null) cur[k] = pending[k];
    });
    localStorage.setItem(PROFILE_KEY, JSON.stringify(cur));
  } catch (e) {}
}

// → { ok, needsConfirmation? } | { ok:false, message }.
export async function register(supa, { email, password, fullName, username, avatar }) {
  const meta = { display_name: fullName };
  if (username) meta.username = username;
  // Seed the base profile BEFORE the call: with auto-confirm the SIGNED_IN
  // event (which promotes it into aptron_profile_v1) can fire during this
  // await, ahead of any code below.
  const prof = { name: fullName, theme: 'dark' };
  if (username) prof.username = username;
  if (avatar) prof.avatar = avatar;
  stashPendingProfile(prof);
  const { data, error } = await supa.auth.signUp({
    email, password, options: { data: meta },
  });
  if (error) {
    clearPendingProfile();
    return { ok: false, message: friendlySignupError(error) };
  }
  // No session yet → email confirmation is on; the stash waits for the
  // post-confirmation sign-in. Supabase obfuscates already-registered emails
  // on signUp, so the caller's notice is safe to show unconditionally.
  return { ok: true, needsConfirmation: !data || !data.session };
}
