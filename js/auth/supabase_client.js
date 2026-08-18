// =============================================================
// Shared Supabase client construction — the single place that builds
// the authed client, so every entry point (js/auth/main.js today,
// js/auth/confirm.js for the email-confirmation page) produces an
// identical client and nothing ever falls back to a second, bare-key
// client that RLS would then deny. Returns null in local-only mode
// (no supabase-js loaded, or js/config.js still has placeholder
// values) — callers decide how to degrade.
// =============================================================
export function createAppSupabaseClient() {
  const CFG_URL = (window.APP_CONFIG || {}).SUPABASE_URL || '';
  const CFG_KEY = (window.APP_CONFIG || {}).SUPABASE_KEY || '';
  if (!window.supabase || !CFG_URL || !CFG_KEY ||
      CFG_URL.indexOf('PASTE-') === 0 || CFG_KEY.indexOf('PASTE-') === 0) {
    return null;
  }
  return window.supabase.createClient(CFG_URL, CFG_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'aptron-auth' },
  });
}
