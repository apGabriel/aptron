// =============================================================
// Shared public Supabase config. Must load (defer) BEFORE any
// consumer: sync.js, js/topbar.js, js/gym/gym-sync.js,
// js/gym/gym-cloud.js. The publishable (anon) key is public by
// design — access is gated by RLS, not by hiding this value.
// =============================================================
window.APP_CONFIG = {
  SUPABASE_URL: 'https://vcuqcjtzdjtonvaqolzm.supabase.co',
  SUPABASE_KEY: 'sb_publishable_JEudB5hgyn38SkUiO6oWhw_9Qrtr36b',
};
