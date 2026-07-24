// =============================================================
// Login service — Supabase sign-in plus the credential shaping
// shared with registration. No DOM, no window: pure logic over an
// injected supabase client, so it stays trivially testable.
// =============================================================

export const MAX_LEN = 100;                    // cap both credential fields

// Strict shape check that also rejects <>"'` and backslash, so nothing
// that could ever read as markup or a quote-breaker survives — even though
// every DOM write in auth_ui.js goes through textContent (never innerHTML),
// which is the actual escaping boundary.
export const EMAIL_RE = /^[^\s@<>"'`\\]+@[^\s@<>"'`\\]+\.[^\s@<>"'`\\]+$/;

// Trim + length-cap the email before any network call.
export function normalizeEmail(v) {
  return (v || '').trim().slice(0, MAX_LEN);
}

// Passwords are length-capped but NOT trimmed — leading/trailing chars can
// be significant, so trimming would silently alter a valid secret.
export function normalizePassword(v) {
  return (v || '').slice(0, MAX_LEN);
}

// Lower-cased GoTrue error text; raw text is matched against, never echoed.
export function errorText(error) {
  return ((error && (error.message || error.error_description)) || '').toLowerCase();
}

// Failures that aren't about the credentials at all (shared with signup).
export function transportError(m) {
  if (m.indexOf('rate limit') !== -1 || m.indexOf('too many') !== -1)
    return 'Too many attempts. Wait a moment and try again.';
  if (m.indexOf('failed to fetch') !== -1 || m.indexOf('network') !== -1)
    return 'Network error. Check your connection.';
  return null;
}

// Anti-enumeration: every non-transport sign-IN failure collapses to ONE
// generic string — "Email not confirmed" or a user-exists hint would
// confirm the account exists. (Sign-UP deliberately relaxes this; see
// register_service.js.)
export function friendlyLoginError(error) {
  return transportError(errorText(error)) || 'Invalid login credentials.';
}

// → [{ field, message }] — empty when the credentials are locally sound.
export function validateLogin({ email, password }) {
  const errors = [];
  if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'Enter a valid email address.' });
  if (!password) errors.push({ field: 'password', message: 'Enter your password.' });
  return errors;
}

// → { ok } | { ok:false, message }. On success the caller's
// onAuthStateChange(SIGNED_IN) takes over (gate dismissal, APP_AUTH_READY).
export async function signIn(supa, { email, password }) {
  const { error } = await supa.auth.signInWithPassword({ email, password });
  return error ? { ok: false, message: friendlyLoginError(error) } : { ok: true };
}
