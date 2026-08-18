// =============================================================
// Email-confirmation service — parses token_hash/type off the
// confirm.html query string and exchanges it for a session via
// supa.auth.verifyOtp(). No DOM, no window. Mirrors register_service
// / login_service: pure logic over an injected client.
// =============================================================
import { errorText, transportError } from './login_service.js';

// The "Confirm signup" email template links here as:
//   {{ .RedirectTo }}/confirm.html?token_hash={{ .TokenHash }}&type=email
// Both params are required — verifyOtp() has no meaningful partial call.
export function parseConfirmParams(search) {
  const params = new URLSearchParams(search || '');
  const tokenHash = params.get('token_hash') || '';
  const type = params.get('type') || '';
  return tokenHash && type ? { tokenHash, type } : null;
}

export function friendlyConfirmError(error) {
  const m = errorText(error);
  const transport = transportError(m);
  if (transport) return transport;
  return 'That confirmation link is invalid or has already been used. Sign up again to get a new one.';
}

// → { ok:true } | { ok:false, message }. Only ever surfaces a friendly
// message derived from the error — never the raw token or error object,
// so nothing sensitive reaches a caller that might log or display it.
export async function confirmEmail(supa, { tokenHash, type }) {
  const { error } = await supa.auth.verifyOtp({ token_hash: tokenHash, type });
  return error ? { ok: false, message: friendlyConfirmError(error) } : { ok: true };
}
