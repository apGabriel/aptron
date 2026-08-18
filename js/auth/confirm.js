// =============================================================
// Confirmation-page orchestrator — click-gated exchange of the signup
// confirmation email's token_hash for a session. Loaded as
// <script type="module"> on confirm.html only.
//
// Click-gated by design: email security scanners / link prefetchers
// (Microsoft Safe Links and similar) GET this page's HTML exactly like
// a human would, but that GET never touches Supabase — verifyOtp()
// only fires from the button's click handler below, so a prefetch can
// no longer burn the one-time token before the real human click. See
// Supabase's auth-email-templates docs, "Email prefetching".
//
// Reuses createAppSupabaseClient() (same client construction as
// js/auth/main.js) and the existing session storage (storageKey
// 'aptron-auth') rather than managing a second success path: on a
// successful verifyOtp, supabase-js persists the session under that
// same key, and a plain redirect to index.html lets the ordinary
// main.js boot pick it up exactly as it does after any other sign-in.
// =============================================================
import { createAppSupabaseClient } from './supabase_client.js';
import { GATE_CSS } from './auth_ui.js';
import { parseConfirmParams, confirmEmail } from './confirm_service.js';

const style = document.createElement('style');
style.textContent = GATE_CSS;
document.head.appendChild(style);

const sub = document.getElementById('confirmSub');
const err = document.getElementById('confirmErr');
const btn = document.getElementById('confirmBtn');
const btnLabel = document.getElementById('confirmBtnLabel');

function showError(msg) {
  err.textContent = msg;
}
function fail(msg) {
  showError(msg);
  btn.hidden = true;
}

const params = parseConfirmParams(location.search);
// Scrub the token out of the visible URL/history immediately — it lives on
// only in the `params` closure below, never logged, never redisplayed.
if (window.history && history.replaceState) {
  history.replaceState(null, '', location.pathname);
}

if (!params) {
  sub.textContent = '';
  fail('This confirmation link is missing required information. Sign up again to get a new one.');
} else {
  const supa = createAppSupabaseClient();
  if (!supa) {
    fail('Confirmation needs a network connection. Reconnect and reopen the link from your email.');
  } else {
    btn.hidden = false;
    let busy = false;
    btn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      showError('');
      btnLabel.textContent = 'Confirming…';
      const res = await confirmEmail(supa, params);
      if (!res.ok) {
        busy = false;
        btn.disabled = false;
        btnLabel.textContent = 'Confirm email';
        showError(res.message);
        return;
      }
      btnLabel.textContent = 'Confirmed — redirecting…';
      sub.textContent = 'Your email is confirmed. Taking you to Aptron…';
      setTimeout(() => { location.replace('index.html'); }, 500);
    });
  }
}
