// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar Proxy Server
//
// WHY THIS EXISTS
//   Browsers can't call the Google Calendar API directly from your HTML pages
//   because OAuth tokens must stay secret (never exposed to the browser).
//   This server holds your credentials, gets fresh access tokens automatically,
//   and forwards the calendar data to your dashboard.
//
//   Browser (index.html / wardrobe.html / …)
//       │  HTTP request  (no token, goes to localhost)
//       ▼
//   This proxy  (localhost:3001)
//       │  HTTP request  (attaches OAuth access token, goes to Google)
//       ▼
//   Google Calendar API
//       │  response
//       ▼
//   This proxy  →  Browser
//
// HOW TO RUN
//   1. Copy .env.example to .env and fill in SUPABASE_URL / SUPABASE_ANON_KEY
//      (gates /api behind login) plus GOOGLE_CLIENT_ID/SECRET and the per-user
//      linking secrets (GOOGLE_REDIRECT_URI, SUPABASE_SERVICE_ROLE_KEY,
//      TOKEN_ENC_KEY) — each user links their OWN Google Calendar from the
//      dashboard's Account panel (Multi-tenant calendar linking, below).
//   2. npm install
//   3. npm start   (or "npm run dev" to auto-restart on changes)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const crypto       = require('crypto');
const { google }   = require('googleapis');
const rateLimit    = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Google OAuth2 config ──────────────────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// Per-user web linking (newOAuthClient, below) needs a "Web application" OAuth
// client. Set GOOGLE_WEB_CLIENT_ID/SECRET to it; falls back to CLIENT_ID/SECRET
// when unset so a single OAuth client can serve both roles if desired.
const WEB_CLIENT_ID     = process.env.GOOGLE_WEB_CLIENT_ID     || CLIENT_ID;
const WEB_CLIENT_SECRET = process.env.GOOGLE_WEB_CLIENT_SECRET || CLIENT_SECRET;
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID   || 'primary';
const TIMEZONE      = process.env.TIMEZONE             || 'UTC';

// ── Supabase auth (gate /api behind the dashboard login) ──────────────────────
// The frontend attaches the logged-in user's JWT as `Authorization: Bearer …`.
// We validate it by asking Supabase's GoTrue `/auth/v1/user` endpoint (no extra
// dependency — just fetch), then cache the result briefly so a burst of calendar
// calls doesn't hit Supabase once each.
const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
const AUTH_CONFIGURED   = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
if (!AUTH_CONFIGURED) {
  const missing = [!SUPABASE_URL && 'SUPABASE_URL', !SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY']
    .filter(Boolean).join(' and ');
  console.error(
    '\n  [auth] DISABLED — missing ' + missing + ' in the environment.\n' +
    '  Every /api request will return 503 until these are set in proxy/.env\n' +
    '  (and on the host, e.g. Render). /health stays open.\n'
  );
} else {
  console.log('  [auth] enabled — validating JWTs against ' + SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user');
}
const tokenCache = new Map();   // jwt → { user, exp(ms) }
const TOKEN_TTL_MS = 60 * 1000;

// ── Multi-tenant calendar linking (Step 2) ────────────────────────────────────
// Per-user Google linking stores each user's refresh token in the Supabase vault
// (public.calendar_connections, migration 0005) — every calendar call is built
// fresh per-request from THIS user's own stored token (calendarForUser, below).
// Three new secrets gate it:
//   • SUPABASE_SERVICE_ROLE_KEY — reads/writes the vault, BYPASSING RLS (the
//     browser can never read tokens; only this server can). Keep it server-side.
//   • TOKEN_ENC_KEY             — encrypts refresh tokens at rest (AES-256-GCM).
//   • GOOGLE_REDIRECT_URI       — the OAuth redirect, e.g.
//     https://<proxy-host>/oauth/google/callback. Must be an Authorized redirect
//     URI on a "Web application" Google OAuth client. The same CLIENT_ID/SECRET
//     can be a Web client, or set a dedicated web client's id/secret here.
// If any secret is missing, the linking routes fail closed (503).
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TOKEN_ENC_KEY             = process.env.TOKEN_ENC_KEY             || '';
// .trim() + strip accidental wrapping quotes: a trailing space/newline or a
// pasted-in quote is a classic redirect_uri_mismatch cause (Google compares the
// redirect_uri byte-for-byte against the registered list).
const GOOGLE_REDIRECT_URI       = (process.env.GOOGLE_REDIRECT_URI      || '').trim().replace(/^["']|["']$/g, '');
// 32-byte AES key derived from the passphrase so TOKEN_ENC_KEY can be any string.
const ENC_KEY = TOKEN_ENC_KEY ? crypto.createHash('sha256').update(TOKEN_ENC_KEY).digest() : null;
const OAUTH_LINK_CONFIGURED = !!(WEB_CLIENT_ID && WEB_CLIENT_SECRET && GOOGLE_REDIRECT_URI &&
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && ENC_KEY);
if (!OAUTH_LINK_CONFIGURED) {
  console.warn(
    '  [link] per-user Google linking DISABLED — set GOOGLE_REDIRECT_URI, ' +
    'SUPABASE_SERVICE_ROLE_KEY and TOKEN_ENC_KEY to enable /api/oauth/* + /api/calendar/*.'
  );
} else {
  console.log('  [link] per-user Google linking enabled — redirect ' + GOOGLE_REDIRECT_URI);
}
const SB_REST      = (SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1';
const OAUTH_SCOPES = ['https://www.googleapis.com/auth/calendar', 'openid', 'email'];

// ── Middleware ────────────────────────────────────────────────────────────────
// Explicit CORS so the Authorization (JWT) header is always allowed and OPTIONS
// preflights are answered up-front. In production the dashboard reaches /api
// same-origin (Vercel rewrite), so this mainly matters for local cross-origin dev.
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '8mb' }));   // meal-scan posts a base64 image

// Require a valid Supabase session on every /api route. `/health` stays open so
// uptime checks work without a token. Fails CLOSED: if auth isn't configured, or
// the token is missing/invalid/expired, no calendar or Gemini access is granted.
async function requireAuth(req, res, next) {
  // Never gate CORS preflight — it carries no auth header by design. cors() above
  // already answers OPTIONS; this is belt-and-suspenders against a future reorder.
  if (req.method === 'OPTIONS') return next();
  if (!AUTH_CONFIGURED) {
    return res.status(503).json({
      error: 'Proxy auth not configured (SUPABASE_URL / SUPABASE_ANON_KEY missing on the server)',
    });
  }
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const cached = tokenCache.get(token);
  if (cached && cached.exp > Date.now()) { req.user = cached.user; return next(); }

  try {
    const r = await fetch(SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.status(401).json({ error: 'Invalid or expired session' });
    const user = await r.json();
    if (!user || !user.id) return res.status(401).json({ error: 'Invalid session' });
    tokenCache.set(token, { user, exp: Date.now() + TOKEN_TTL_MS });
    req.user = user;
    next();
  } catch (err) {
    // The token may be perfectly valid — we just couldn't reach Supabase to
    // verify it. Surface that as 502 (upstream problem) so it's not confused
    // with a genuinely bad token (401).
    console.error('[auth] could not reach Supabase to verify token:', err && err.message);
    return res.status(502).json({ error: 'Could not verify session (auth server unreachable)' });
  }
}
app.use('/api', requireAuth);   // registered before the /api routes below

// Per-USER (not per-IP) rate limit for routes that cost real money (Gemini) or
// consume external quota (Google Calendar API). Keyed by req.user.id, which
// requireAuth above guarantees is set before this ever runs. Deliberately not
// applied globally — cheap/read-only routes (e.g. /api/calendar/status) don't
// need it, and a shared egress IP (Vercel/Render) would make IP-keying wrong
// for a multi-user deployment. In-memory only, like the existing tokenCache/
// syncing maps — resets per instance/restart; acceptable at this project's
// current single/few-instance scale (see Known Issues for the cross-instance
// caveat shared with the `syncing` lock).
const expensiveLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,   // 5 minutes
  limit: 20,                 // generous for real interactive use, not for abuse/loops
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) || 'anonymous',
  message: { error: 'Too many requests — please wait a few minutes and try again.' },
});

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check — open http://localhost:3001/health to verify the proxy is up.
// gemini_key_present is a boolean-only probe (never the value) to diagnose
// whether the GEMINI_API_KEY env var is actually bound in this deployment.
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    calendar_id: CALENDAR_ID,
    timezone: TIMEZONE,
    gemini_key_present: !!(process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY),
    oauth_link_configured: OAUTH_LINK_CONFIGURED,
  });
});

// NOTE: routes 1-5 (GET/POST/PATCH/DELETE /api/events*) were removed here —
// they operated on one global, single-owner calendar client with no per-user
// authorization check, so any authenticated account (any self-registered user)
// could read/write/delete the app owner's real Google Calendar. Nothing in the
// frontend called them (js/index.js uses the Supabase `events` table directly;
// real per-user Google sync goes through /api/calendar/* below, which correctly
// scopes every call to calendarForUser(req.user.id)). See Known Issues.md.


// ── 6. POST /api/gemini/meal-scan ─────────────────────────────────────────────
// Estimate a meal's nutrition from a photo. The Gemini key stays server-side
// (process.env.GEMINI_API_KEY) so it never reaches the browser.
// Body: { image: <base64 JPEG/PNG, no data: prefix>, mime?: 'image/jpeg' }
// Returns: { meal_name, calories, protein, carbs, fats }  (integers, >= 0)
// Prefer the unprefixed name; fall back to VITE_-prefixed for the current
// Vercel setup. NOTE: rename the Vercel var to GEMINI_API_KEY when convenient —
// the VITE_ prefix would leak the key to the client bundle if a build step is
// ever added. Safe for now only because this project has no bundler.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
const GEMINI_MODEL   = 'gemini-2.5-flash';   // free tier ~15 RPM; swap if needed
const MEAL_PROMPT =
  'You are a meticulous nutrition estimator. Identify the specific dish in the image and estimate its TOTAL nutrition for the full portion actually shown. ' +
  'Judge portion size from concrete visual cues — plate/bowl diameter, utensils, hands, packaging or other objects for scale, and the food\'s height and density — instead of assuming a default serving. ' +
  'Base the numbers on the real visible quantity and the typical ingredients/preparation of that dish; do NOT fall back on round or generic placeholder values when the image shows enough detail to do better. ' +
  'Keep the macros realistic and internally consistent with the calories: protein and carbs ≈ 4 kcal/g, fat ≈ 9 kcal/g, so (4*protein + 4*carbs + 9*fats) should land within ~10% of the calories figure. ' +
  'If the image is ambiguous, commit to your single best realistic estimate (never 0 for a food that is clearly present). ' +
  'Respond ONLY with minified JSON matching: {"meal_name":string,"calories":number,"protein":number,"carbs":number,"fats":number}. ' +
  'Calories in kcal; protein, carbs and fats in grams, as integers. No prose, no markdown.';

app.post('/api/gemini/meal-scan', expensiveLimiter, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server' });
  const { image, mime } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image (base64) is required' });

  const body = {
    contents: [{ parts: [
      { text: MEAL_PROMPT },
      { inline_data: { mime_type: mime || 'image/jpeg', data: image } }
    ] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          meal_name: { type: 'STRING' },
          calories:  { type: 'NUMBER' },
          protein:   { type: 'NUMBER' },
          carbs:     { type: 'NUMBER' },
          fats:      { type: 'NUMBER' }
        },
        required: ['meal_name', 'calories', 'protein', 'carbs', 'fats']
      }
    }
  };

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
      ':generateContent?key=' + GEMINI_API_KEY;
    const gr = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!gr.ok) {
      // Don't echo Google's body back to the client — it can contain key context.
      return res.status(502).json({ error: 'Gemini request failed (HTTP ' + gr.status + ')' });
    }
    const j = await gr.json();
    const text = (((j.candidates || [])[0] || {}).content?.parts || [])[0]?.text || '';
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return res.status(502).json({ error: 'Could not read the AI response' }); }
    const num = v => Math.max(0, Math.round(Number(v) || 0));
    res.json({
      meal_name: String(parsed.meal_name || 'Meal').slice(0, 80),
      calories: num(parsed.calories), protein: num(parsed.protein),
      carbs: num(parsed.carbs), fats: num(parsed.fats),
    });
  } catch (err) {
    console.error('[gemini] meal-scan failed:', err && err.message);
    res.status(500).json({ error: 'Could not analyze the meal photo' });
  }
});


// ── 7. POST /api/gemini/assistant ─────────────────────────────────────────────
// The dashboard's AI command assistant. The browser handles common tactical
// commands locally (instant/offline); anything free-form is forwarded here and
// Gemini returns ONE structured intent the frontend applies to the calendar /
// modules. Same server-side key as meal-scan — never reaches the browser.
// Body: { message: string, context?: { date, domain, memory: string[],
//         events?:[...], gym?: {...}|null, health?: {...}|null,
//         wardrobe?: {...}|null } }
// `domain` is js/index.js's deterministic classifyIntentDomain() result — it
// decides WHICH of events/gym/health/wardrobe were even fetched (contextual
// retrieval, Shenlong Intelligence pass, 2026-08-03): a field being ABSENT
// means "not relevant to this question, wasn't looked up" (say nothing about
// it); a field being present but `null` means "looked up, nothing logged"
// (say so explicitly). The prompt below must keep that distinction — it must
// never claim "nothing logged" for a domain it was never even given.
// Returns the intent object (see responseSchema below).
app.post('/api/gemini/assistant', expensiveLimiter, async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server' });
  const { message, context } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const domain = (context && context.domain) || 'unknown';
  const memory = (context && Array.isArray(context.memory)) ? context.memory : [];
  // Each domain block is only present when js/index.js's classifier decided
  // it was relevant — "fetched" (undefined check) is a different fact than
  // "fetched but empty" (null), and the prompt text below must say so per
  // domain rather than collapsing both into one generic sentence.
  const hasEvents = context && Object.prototype.hasOwnProperty.call(context, 'events');
  const hasGym = context && Object.prototype.hasOwnProperty.call(context, 'gym');
  const hasHealth = context && Object.prototype.hasOwnProperty.call(context, 'health');
  const hasWardrobe = context && Object.prototype.hasOwnProperty.call(context, 'wardrobe');
  const events = hasEvents && Array.isArray(context.events) ? context.events : [];
  const domainLine = (label, has, val, cap) => has
    ? label + ' (JSON, null means nothing logged): ' + JSON.stringify(val === undefined ? null : val).slice(0, cap) + '. '
    : label + ': not fetched for this question — it was classified as unrelated; do not claim it is empty or missing, simply don\'t mention it. ';

  // ── Unified Daily Brief mode (Product Constitution / Unified Intelligence
  // Strategy, 2026-08-04; widened to up to 3 facts for the Narrative
  // Dashboard, Goal 4.1, still 2026-08-04) — a distinct, much narrower prompt
  // for the dashboard's proactive greeting. The frontend's deterministic
  // ranking (js/index.js's selectTopSignals, plus the narrative dashboard's
  // own single optional "yesterday" addition) has already decided the ONLY
  // facts worth mentioning today, in priority order (urgent calendar
  // conflicts > health conditions > workout recovery > meal consistency);
  // this prompt's one job is weaving 1-3 pre-verified facts into ONE
  // genuinely flowing paragraph, never adding a fact of its own and never
  // opening with its own greeting (the caller prepends a deterministic one —
  // Goal 4.1's explicit call: a greeting is a function of the clock, not
  // something worth a model call to get right). Reuses the same
  // schema/auth/error-handling below unchanged — only `sys` differs.
  const isBrief = context && context.mode === 'daily_brief';
  let sys;
  if (isBrief) {
    const signals = Array.isArray(context.signals) ? context.signals.slice(0, 3) : [];
    const signalLines = signals.length
      ? signals.map((s, i) => (i + 1) + '. [' + String((s && s.domain) || '?').slice(0, 20) + '] ' + String((s && s.fact) || '').slice(0, 240)).join(' ')
      : 'No notable signals were found for today — the day looks steady.';
    sys =
      'You are Shenlong, the orchestrator AI for a personal day-planner dashboard — wise, calm, protective, confident. ' +
      'Today is ' + ((context && context.date) || new Date().toISOString().slice(0, 10)) + '. ' +
      'A deterministic system already scanned the user\'s calendar, gym, and health data and selected the ONLY facts ' +
      'worth mentioning today, already ranked by priority (urgent calendar conflicts, then health conditions ' +
      'affecting today, then workout recovery, then meal consistency): ' + signalLines + ' ' +
      'These are the ONLY facts you may reference. Do not add, invent, or infer any other fact about the user\'s ' +
      'day, their history, or their habits — not sleep, not mood, not anything not explicitly listed above. ' +
      'TASK: write ONE unified recommendation for today, as a single genuinely flowing paragraph — not separate ' +
      'sentences bolted together, not a list, never section headers like "Calendar:"/"Health:", never more than ' +
      'one recommendation. When multiple facts are given, connect them causally or contextually ("You trained X ' +
      'yesterday and today Y — I\'d Z") so the paragraph reads as one thought, not several tips in a row. Do NOT ' +
      'open with a greeting or salutation of any kind ("Good morning", "Hi", etc.) — the caller prepends its own ' +
      'deterministic greeting before this text; starting with one yourself would duplicate it. Length scales with ' +
      'how much there is to connect: 2-4 sentences for one fact, up to 6 for three — never more than 6. Always end ' +
      'with one concrete, actionable suggestion — never end on a bare observation with nothing to do about it. ' +
      'CONFIDENCE: "high" only if the recommendation follows directly from the facts given with no assumption; ' +
      '"medium" if you filled a small, clearly-stated gap; "low" if the facts are thin or ambiguous — when medium ' +
      'or low, say so plainly inside the recommendation itself, not as a separate caveat. ' +
      'TONE: chief of staff — short, warm, concrete, never a bullet list, never restating a raw number you weren\'t ' +
      'explicitly given above. Set "action" to "chat" and put the recommendation in "reply".';
  } else {
  sys =
    'You are Shenlong, the orchestrator AI for a personal day-planner dashboard — wise, calm, protective, ' +
    'confident. Never theatrical, never roleplay, never a generic chatbot voice. ' +
    'Convert the user message into EXACTLY ONE structured action. ' +
    'Today is ' + ((context && context.date) || new Date().toISOString().slice(0, 10)) + '. ' +
    'This request was classified as domain "' + domain + '" (calendar/gym/health/wardrobe/general/multi/unknown) ' +
    'by a deterministic classifier — "general"/"multi"/"unknown" mean multiple domains may be relevant, so reason ' +
    'across whatever context is present below. ' +
    domainLine("The user's calendar events", hasEvents, events, 4000) +
    domainLine("Today's gym status", hasGym, context && context.gym, 1000) +
    domainLine("Today's health/nutrition status", hasHealth, context && context.health, 1000) +
    domainLine("The user's wardrobe status (item counts only — no live weather feed exists yet, so NEVER judge an outfit as too warm/cold/appropriate)", hasWardrobe, context && context.wardrobe, 1000) +
    'Remembered long-term facts/preferences about the user (JSON array, may be empty): ' + JSON.stringify(memory).slice(0, 1500) + '. ' +
    'REASONING STEPS (internal — never narrate these, only output the final JSON): ' +
    '(1) Use the domain classification above to decide what this request is really about. ' +
    '(2) Read only the context actually provided — never assume a not-fetched domain is empty. ' +
    '(3) Discard anything contradictory or clearly stale before reasoning over it. ' +
    '(4) Form the single best action + a short reply. ' +
    '(5) SELF-CHECK before finalizing: does every factual claim in "reply" trace to the JSON above, to a remembered ' +
    'fact, or to general knowledge of how to use this app? If any claim does not, remove it or state the uncertainty ' +
    'instead of asserting it. ' +
    'GROUNDING (more important than being helpful-sounding): only state facts present in the context above. ' +
    'If a fetched field is null or a value is missing, say plainly that you don\'t have that data or nothing is ' +
    'logged yet — never invent a number, event, workout, or meal, and never assume something didn\'t happen just ' +
    'because it\'s not in the data. When the user asks about their day, prioritize this local data over generic ' +
    'knowledge. ' +
    'CONFIDENCE: set "confidence" to "high" only when your answer is fully backed by the provided context/memory ' +
    'and normal app rules with no assumptions; "medium" when you filled a small, clearly-stated gap (e.g. no time ' +
    'given, so you asked); "low" whenever the request is ambiguous, the needed domain wasn\'t fetched, or you are ' +
    'uncertain — and when confidence is "low" or "medium", say so plainly in "reply" (e.g. "I don\'t have your ' +
    'workout data for that" or "Not sure which one you mean — the 3pm or the 5pm block?") rather than guessing ' +
    'silently. ' +
    'TONE: behave like a personal chief of staff, not a generic chatbot — short, concrete, actionable sentences ' +
    '(e.g. "You have two meetings before lunch. Train after 18:00. You still need water today.") rather than ' +
    'long or hedging paragraphs. Never explain obvious things. Never overuse metaphors. ' +
    'Rules: all times are 24-hour "HH:MM". Dates are ALWAYS absolute "YYYY-MM-DD" — if the user names a day ' +
    '("tomorrow", "next Friday", "this Monday", a specific date), resolve it against today\'s date above: "next X" ' +
    'means the occurrence of weekday X that is NOT today (1-7 days out); "this X" means the closest upcoming ' +
    'occurrence of X, including today if today IS X. If the day reference is genuinely ambiguous, ask rather than ' +
    'guess — never fabricate a date. Leave "date" absent when the user does not mention a day (it then applies to ' +
    'whatever day is already selected). For move_event / complete_event / delete_event / rename_event, ' +
    '"match" MUST be a distinctive keyword taken from the target event\'s title. ' +
    'For rename_event (the user wants to change/correct an event\'s NAME or TITLE, e.g. ' +
    '"rename X to Y", "change the name of X to Y", "call X Y") set "match" to the existing block and ' +
    '"title" to the new name. NEVER refuse a rename or suggest deleting + re-adding — rename_event is native. ' +
    'For add_event include "title" and "time" (and "durationMin" if the user implies a length). ' +
    'For retime_event (move / reschedule / reduce / extend / "from X to Y") include "match" and the new "time"; ' +
    'add "endTime" for a range, "durationMin" to set an absolute length, or "deltaMin" to grow (+) / shrink (-) it. ' +
    'For log_water set "servings" (default 1) and "unit" ("glass" or "bottle"). ' +
    'For log_food set "name" and "calories" if stated. For a quick reminder/idea with no time, use "note" with "text". ' +
    'For remember_fact (the user wants YOU to remember something about them long-term, e.g. "remember that I\'m ' +
    'vegetarian", "keep in mind I train in the mornings" — NOT "remember to [do something]", which is a reminder: ' +
    'use "note" for that instead) set "text" to the fact, written in third person as a short standalone statement. ' +
    'CORRECTIONS & UNDO: If the user expresses regret or reversal — "sorry", "my mistake", ' +
    '"cancel that", "undo", "recover [X]", "bring back [X]", "restore [X]" — do NOT blindly parse ' +
    'any following negative keywords as a NEW delete. Instead use action "restore_event" to reverse ' +
    'the previous deletion (set "match" to the name of the block to bring back if given). Prioritise ' +
    'healing the user\'s mistake over executing further destructive actions. ' +
    'COMPOUND COMMANDS: If one message contains several instructions ' +
    '(e.g. "recover the walk and delete the run"), process them SEQUENTIALLY in order and return them ' +
    'as the "steps" array — each element a full intent object — restoring/healing BEFORE deleting. ' +
    'Use a single top-level action only when there is exactly one instruction. ' +
    'If the message is purely conversational with no concrete action, use action "chat". ' +
    'ALWAYS set "reply" to a brief, warm one-line confirmation or a single clarifying question.';
  }

  const body = {
    contents: [{ parts: [{ text: sys + '\n\nUser: ' + message }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          action: {
            type: 'STRING',
            enum: ['add_event', 'move_event', 'retime_event', 'rename_event', 'complete_event', 'uncheck_event',
              'delete_event', 'restore_event', 'summarize', 'log_water', 'log_food', 'note', 'remember_fact', 'chat'],
          },
          title: { type: 'STRING' }, match: { type: 'STRING' }, time: { type: 'STRING' },
          date: { type: 'STRING' },
          endTime: { type: 'STRING' }, deltaMin: { type: 'NUMBER' },
          durationMin: { type: 'NUMBER' }, notes: { type: 'STRING' },
          servings: { type: 'NUMBER' }, unit: { type: 'STRING' },
          name: { type: 'STRING' }, calories: { type: 'NUMBER' },
          text: { type: 'STRING' }, reply: { type: 'STRING' },
          // Self-assessed per the SELF-CHECK/CONFIDENCE reasoning steps above —
          // not shown to the user as a badge (Shenlong stays conversational,
          // not clinical); "low"/"medium" must instead be voiced in "reply"
          // itself. Kept structured for testing/telemetry (Shenlong
          // Intelligence pass, 2026-08-03).
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          // Ordered intents for a compound message; healing/restore comes first.
          steps: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                action: {
                  type: 'STRING',
                  enum: ['add_event', 'move_event', 'retime_event', 'rename_event', 'complete_event', 'uncheck_event',
                    'delete_event', 'restore_event', 'log_water', 'log_food', 'note', 'remember_fact'],
                },
                title: { type: 'STRING' }, match: { type: 'STRING' }, time: { type: 'STRING' },
                date: { type: 'STRING' },
                endTime: { type: 'STRING' }, deltaMin: { type: 'NUMBER' }, durationMin: { type: 'NUMBER' },
                notes: { type: 'STRING' }, servings: { type: 'NUMBER' }, unit: { type: 'STRING' },
                name: { type: 'STRING' }, calories: { type: 'NUMBER' }, text: { type: 'STRING' },
              },
              required: ['action'],
            },
          },
        },
        required: ['action', 'reply', 'confidence'],
      },
    },
  };

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
      ':generateContent?key=' + GEMINI_API_KEY;
    const gr = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    if (!gr.ok) return res.status(502).json({ error: 'Gemini request failed (HTTP ' + gr.status + ')' });
    const j = await gr.json();
    const text = (((j.candidates || [])[0] || {}).content?.parts || [])[0]?.text || '';
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return res.status(502).json({ error: 'Could not read the AI response' }); }
    res.json(parsed);
  } catch (err) {
    console.error('[gemini] assistant failed:', err && err.message);
    res.status(500).json({ error: 'Could not reach the assistant' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MULTI-TENANT CALENDAR LINKING — OAuth handshake, token vault, per-user client
// ═════════════════════════════════════════════════════════════════════════════

// ── token encryption (AES-256-GCM; stored base64 as iv|tag|ciphertext) ────────
function encToken(plain) {
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decToken(b64) {
  const raw = Buffer.from(String(b64), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ── CSRF-safe OAuth state: HMAC-signed {uid, nonce, exp} ───────────────────────
// The callback arrives as a top-level redirect with no JWT, so the user is
// identified by this signed state instead of a bearer. Key derived from
// TOKEN_ENC_KEY; expires in 10 minutes; compared in constant time.
const STATE_TTL_MS = 10 * 60 * 1000;
function stateKey() { return crypto.createHash('sha256').update('oauth-state|' + TOKEN_ENC_KEY).digest(); }
function signState(uid) {
  const body = Buffer.from(JSON.stringify({
    uid, n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + STATE_TTL_MS,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj; try { obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!obj || !obj.uid || !obj.exp || obj.exp < Date.now()) return null;
  return obj.uid;
}

// ── Supabase vault access (service role → bypasses RLS) ────────────────────────
// The service role key is a superuser-grade secret: it is used ONLY here,
// server-side, and never leaves the proxy. It bypasses the calendar_connections
// RLS (which denies every client) so the proxy can read/write tokens.
async function sbFetch(path, opts) {
  return fetch(SB_REST + path, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    }, (opts && opts.headers) || {}),
    signal: AbortSignal.timeout(8000),
  }));
}
async function getConnection(uid) {
  const r = await sbFetch('/calendar_connections?user_id=eq.' + encodeURIComponent(uid) + '&select=*', { method: 'GET' });
  if (!r.ok) throw new Error('vault read failed (HTTP ' + r.status + ')');
  const rows = await r.json();
  return (rows && rows[0]) || null;
}
async function upsertConnection(row) {
  const r = await sbFetch('/calendar_connections', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error('vault upsert failed (HTTP ' + r.status + ')');
  return (await r.json())[0] || null;
}
async function patchConnection(uid, patch) {
  const r = await sbFetch('/calendar_connections?user_id=eq.' + encodeURIComponent(uid), {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error('vault update failed (HTTP ' + r.status + ')');
  return (await r.json())[0] || null;
}
async function deleteConnection(uid) {
  const r = await sbFetch('/calendar_connections?user_id=eq.' + encodeURIComponent(uid), { method: 'DELETE' });
  if (!r.ok) throw new Error('vault delete failed (HTTP ' + r.status + ')');
}
// Delete this user's Google-MIRRORED event rows (google_event_id IS NOT NULL) on
// disconnect, so the dashboard clears. Local-only rows (google_event_id IS NULL)
// are left untouched. Authored-but-synced blocks are removed here too, but they
// survive in the user's Google Calendar (re-linking re-pulls them). Returns the
// deleted count (PostgREST reports it in Content-Range with Prefer: count=exact).
async function deleteMirroredEvents(uid) {
  const r = await sbFetch(
    '/events?user_id=eq.' + encodeURIComponent(uid) + '&google_event_id=not.is.null',
    { method: 'DELETE', headers: { Prefer: 'count=exact' } });
  if (!r.ok) throw new Error('events cleanup failed (HTTP ' + r.status + ')');
  const n = parseInt(((r.headers.get('content-range') || '').split('/')[1] || '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

// ── dynamic OAuth redirect URI (branch previews vs prod) ──────────────────────
// On Vercel the proxy runs SAME-ORIGIN with the dashboard, so a given deployment
// (prod OR a branch preview) serves both /api/oauth/google/start and
// /oauth/google/callback on the same host. That lets us derive the redirect from
// the request host: Google redirects the callback back to that same host, so the
// value at generateAuthUrl and at getToken stay byte-for-byte identical (Google
// requires that match, on TOP of the Console allowlist).
//
// The Host / x-forwarded-host header is client-controllable, so we only trust
// hosts matching a strict allowlist; anything else falls back to the static
// GOOGLE_REDIRECT_URI. Google's own allowlist is the real security boundary (an
// un-whitelisted host just yields redirect_uri_mismatch), but validating here
// keeps behavior predictable and avoids minting auth URLs for junk hosts. Add
// one-off hosts via OAUTH_EXTRA_HOSTS (comma-separated, no scheme/path).
const OAUTH_HOST_ALLOWLIST = [
  /^localhost(:\d+)?$/i,
  /^127\.0\.0\.1(:\d+)?$/,
  /^aptron-[a-z0-9-]+\.vercel\.app$/i,   // prod (aptron-chi) + every branch alias
  /^aptron\.vercel\.app$/i,
].concat(
  (process.env.OAUTH_EXTRA_HOSTS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(h => new RegExp('^' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'))
);
function redirectUriFor(req) {
  // Prefer Vercel's STABLE alias env vars over the raw request host. The host
  // Vercel injects into the function can be the immutable per-deploy URL
  // (aptron-<hash>-<scope>.vercel.app) even when the browser used the branch
  // alias — that per-deploy host PASSES the allowlist regex but is NOT the URL
  // registered with Google, so it still yields redirect_uri_mismatch. The two
  // env vars below are the stable aliases you actually whitelist; VERCEL_URL
  // (the per-deploy hash) is intentionally NOT consulted. Falls back to the
  // request host, then the static env, for non-Vercel (local) runs.
  const strip     = (s) => String(s || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  const env       = process.env.VERCEL_ENV || null;                    // 'production' | 'preview' | 'development' | null
  const branchUrl = strip(process.env.VERCEL_BRANCH_URL);              // aptron-git-<ref>-<scope>.vercel.app (stable)
  const prodUrl   = strip(process.env.VERCEL_PROJECT_PRODUCTION_URL);  // aptron-chi.vercel.app (stable)
  const hdrHost   = strip(String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0]);

  // The host the user is actually on is the source of truth for where Google
  // redirects back — so prefer it, BUT only when it exactly equals a known-stable,
  // whitelistable alias (branch alias / prod domain / OAUTH_EXTRA_HOSTS / local),
  // never the rotating per-deploy hash URL. VERCEL_ENV is deliberately NOT used
  // to choose: it reports 'production' even for a branch-alias deploy (e.g. the
  // test branch deployed with --prod / as the Production Branch), which wrongly
  // forced the prod domain. Falls back to the stable branch alias (then prod,
  // then the static env) when the request host is a hash / unknown / empty.
  const extras  = (process.env.OAUTH_EXTRA_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const trusted = new Set([branchUrl, prodUrl, ...extras].filter(Boolean));
  const isLocal = /^(localhost|127\.)/.test(hdrHost);
  const host = (hdrHost && (trusted.has(hdrHost) || isLocal))
    ? hdrHost                          // user's real host, and it's stable + whitelistable
    : (branchUrl || prodUrl || hdrHost);   // hash / unknown → stable branch alias

  const proto = /^(localhost|127\.)/.test(host) ? 'http' : 'https';    // Vercel is https externally
  const allowed = !!host && OAUTH_HOST_ALLOWLIST.some((re) => re.test(host));
  const uri = allowed ? `${proto}://${host}/oauth/google/callback` : GOOGLE_REDIRECT_URI;
  // Low-volume (only fires during a link handshake). Prints every input so a
  // wrong redirect is unambiguous: which stable aliases reached the function,
  // the request host, and which one we chose. env is informational only now.
  console.log('[oauth] redirect_uri=%s | env=%j branchUrl=%j prodUrl=%j hdr=%j chosen=%j allowed=%s',
    uri, env, branchUrl || null, prodUrl || null, hdrHost || null, host || null, allowed);
  return uri;   // trusted host → dynamic; hash/unknown → stable alias; empty → static
}

// ── per-request Google client ──────────────────────────────────────────────────
// Builds a fresh OAuth2 client from THIS user's stored refresh token, so every
// calendar call acts on the caller's own Google account. The step-4 mirror
// (push/pull) is the main consumer; ?verify=1 on /status also exercises it.
// `redirectUri` only matters for the auth-code exchange (start + callback);
// refresh-token calls ignore it, so it defaults to the static env value.
function newOAuthClient(redirectUri) {
  return new google.auth.OAuth2(WEB_CLIENT_ID, WEB_CLIENT_SECRET, redirectUri || GOOGLE_REDIRECT_URI);
}
async function calendarForUser(uid) {
  const conn = await getConnection(uid);
  if (!conn || !conn.refresh_token_enc) {
    throw Object.assign(new Error('No Google Calendar linked for this user'), { code: 'not_linked' });
  }
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: decToken(conn.refresh_token_enc) });
  return { calendar: google.calendar({ version: 'v3', auth: client }), client, conn };
}

// ── the popup result page: postMessage back to the dashboard, then close ───────
function callbackHtml(ok, message) {
  const safe = String(message || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  // targetOrigin '*' because in local dev the proxy origin differs from the
  // dashboard's; the listener validates data.source === 'aptron-oauth'. The
  // payload is non-secret (ok + email), so this is an acceptable tradeoff.
  const payload = JSON.stringify({ source: 'aptron-oauth', ok: !!ok, message: message || '' });
  return '<!doctype html><html><head><meta charset="utf-8"><title>' +
    (ok ? 'Calendar linked' : 'Link failed') + '</title><style>' +
    'body{font-family:-apple-system,Segoe UI,sans-serif;background:#0d0d0e;color:#e6cf9c;' +
    'display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}' +
    'p{color:rgba(255,255,255,.5);font-size:14px}</style></head><body><div>' +
    '<h2>' + (ok ? '✓ ' : '⚠ ') + safe + '</h2><p>You can close this window.</p></div><script>' +
    'try{if(window.opener)window.opener.postMessage(' + payload + ',"*");}catch(e){}' +
    'setTimeout(function(){try{window.close();}catch(e){}},' + (ok ? '1200' : '4000') + ');' +
    '</script></body></html>';
}

// ── 8. GET /api/oauth/google/start ────────────────────────────────────────────
// (gated by requireAuth) → returns { url } for the dashboard to open as a popup.
app.get('/api/oauth/google/start', (req, res) => {
  if (!OAUTH_LINK_CONFIGURED) return res.status(503).json({ error: 'Calendar linking is not configured on the server' });
  const url = newOAuthClient(redirectUriFor(req)).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',                 // force a refresh_token on every link
    include_granted_scopes: true,
    scope: OAUTH_SCOPES,
    state: signState(req.user.id),     // binds the flow to THIS logged-in user
  });
  res.json({ url });
});

// ── 9. GET /oauth/google/callback ─────────────────────────────────────────────
// NOT under /api (Google redirects here with no bearer). Auth comes from the
// signed `state`. Exchanges the code, stores the ENCRYPTED refresh token, then
// returns the popup page that notifies the dashboard (→ the Shenlong "wish
// granted" animation lands here in step 3).
app.get('/oauth/google/callback', async (req, res) => {
  const done = (ok, msg) => res.status(ok ? 200 : 400).type('html').send(callbackHtml(ok, msg));
  if (!OAUTH_LINK_CONFIGURED) return done(false, 'Calendar linking is not configured.');
  if (req.query.error)        return done(false, 'Google denied the request.');
  const uid = verifyState(req.query.state);
  if (!uid)            return done(false, 'This link expired or was tampered with — please try again.');
  if (!req.query.code) return done(false, 'No authorization code received.');
  try {
    // Must match the redirect_uri used at /start — derived identically from the
    // host Google just redirected the callback to.
    const client = newOAuthClient(redirectUriFor(req));
    const { tokens } = await client.getToken(req.query.code);
    if (!tokens.refresh_token) {
      // Google only returns a refresh_token on first consent; prompt=consent
      // above should force one, but guard in case the user pre-authorized.
      return done(false, 'Google did not return a refresh token. Revoke access at myaccount.google.com/permissions and retry.');
    }
    client.setCredentials(tokens);
    // Identify the linked Google account (best-effort; token is stored regardless).
    let google_sub = null, google_email = null;
    try {
      const me = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
      google_sub = me.data.id || null; google_email = me.data.email || null;
    } catch (e) { /* userinfo optional */ }
    await upsertConnection({
      user_id: uid,
      google_sub, google_email,
      refresh_token_enc: encToken(tokens.refresh_token),
      scope: tokens.scope || OAUTH_SCOPES.join(' '),
      sync_enabled: true,               // linking IS the "Start Synchronization" action
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // NOTE: deliberately NO server-side background sync here. On Vercel the
    // function instance is frozen the moment this popup response is sent, so a
    // detached syncUser() would be suspended mid-pull — never finishing, and
    // leaking the in-memory lock (last_sync_at stays null, every later trigger
    // reports "already syncing"). The dashboard drives the first mirror instead,
    // via an AWAITED POST /api/calendar/sync/trigger right after link success.
    return done(true, google_email ? ('Linked ' + google_email) : 'Your calendar is linked');
  } catch (err) {
    console.error('[oauth] callback failed:', err && err.message);
    return done(false, 'Could not complete linking. Please try again.');
  }
});

// ── 10. GET /api/calendar/status  (?verify=1 to probe the live token) ─────────
// Non-secret connection metadata for the UI. NEVER returns the token. With
// ?verify=1 it also calls calendarForUser() and lists one calendar to confirm
// the stored refresh token still works (adds one Google round-trip).
app.get('/api/calendar/status', async (req, res) => {
  if (!OAUTH_LINK_CONFIGURED) return res.json({ configured: false, connected: false, sync_enabled: false });
  try {
    const conn = await getConnection(req.user.id);
    const out = {
      configured: true,
      connected: !!conn,
      email: conn ? (conn.google_email || null) : null,
      sync_enabled: conn ? !!conn.sync_enabled : false,
      last_sync_at: conn ? (conn.last_sync_at || null) : null,
    };
    if (conn && req.query.verify) {
      try { const { calendar: cal } = await calendarForUser(req.user.id); await cal.calendarList.list({ maxResults: 1 }); out.verified = true; }
      catch (e) { out.verified = false; }
    }
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: 'Could not read connection status' });
  }
});

// ── 10b. GET /api/calendar/list ───────────────────────────────────────────────
// Read-only: the linked account's calendars with their IDs, so you can confirm
// which one holds the events (the mirror pulls GCAL_ID='primary'). Never returns
// tokens; just id/summary/primary/accessRole from calendarList.list().
app.get('/api/calendar/list', async (req, res) => {
  if (!OAUTH_LINK_CONFIGURED) return res.status(503).json({ error: 'Calendar linking is not configured' });
  try {
    const { calendar: cal } = await calendarForUser(req.user.id);
    const r = await cal.calendarList.list({ maxResults: 250, showHidden: true });
    const calendars = (r.data.items || []).map((c) => ({
      id: c.id, summary: c.summary, primary: !!c.primary,
      accessRole: c.accessRole, selected: !!c.selected,
    }));
    res.json({ mirroring: GCAL_ID, calendars });
  } catch (err) {
    if (err && err.code === 'not_linked') return res.status(404).json({ error: 'No calendar linked' });
    console.error('[calendar] list failed:', err && err.message);
    res.status(502).json({ error: 'Could not list calendars' });
  }
});

// ── 11. POST /api/calendar/sync  { enabled: bool } ────────────────────────────
// Toggle mirroring on/off without unlinking.
app.post('/api/calendar/sync', async (req, res) => {
  if (!OAUTH_LINK_CONFIGURED) return res.status(503).json({ error: 'Calendar linking is not configured' });
  const enabled = !!(req.body && req.body.enabled);
  try {
    const updated = await patchConnection(req.user.id, { sync_enabled: enabled, updated_at: new Date().toISOString() });
    if (!updated) return res.status(404).json({ error: 'No calendar linked' });
    res.json({ sync_enabled: !!updated.sync_enabled });
  } catch (err) {
    res.status(502).json({ error: 'Could not update the sync setting' });
  }
});

// ── 12. POST /api/calendar/disconnect ─────────────────────────────────────────
// Best-effort revoke at Google, then delete our vault row.
app.post('/api/calendar/disconnect', async (req, res) => {
  if (!OAUTH_LINK_CONFIGURED) return res.status(503).json({ error: 'Calendar linking is not configured' });
  try {
    const conn = await getConnection(req.user.id);
    if (conn && conn.refresh_token_enc) {
      try { await newOAuthClient().revokeToken(decToken(conn.refresh_token_enc)); }
      catch (e) { /* best-effort; we still drop our copy below */ }
    }
    // Clear the mirrored events BEFORE dropping the connection so a mid-way
    // failure leaves the user still "linked" (retryable) rather than linked-less
    // with stale events. Local-only rows are preserved.
    const eventsRemoved = await deleteMirroredEvents(req.user.id);
    await deleteConnection(req.user.id);
    res.json({ ok: true, events_removed: eventsRemoved });
  } catch (err) {
    console.error('[calendar] disconnect failed:', err && err.message);
    res.status(502).json({ error: 'Could not disconnect' });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// SYNC / MIRROR ENGINE — bidirectional delta sync between public.events and each
// user's Google Calendar. Runs on manual trigger + right after linking.
//
// One trigger = push THEN pull, per user:
//   • push  local changes (sync_state='local') → Google  (creates/patches/deletes)
//   • pull  Google delta (syncToken) → local events       (upserts + tombstones)
// Push-before-pull means a simultaneous edit resolves LOCAL-WINS (the dashboard
// is the primary surface). Pulled rows are stamped sync_state='synced', so only
// genuine local edits stay 'local' — that's what stops a push⇄pull echo loop.
// ═════════════════════════════════════════════════════════════════════════════
const GCAL_ID               = 'primary';
const FULL_SYNC_WINDOW_DAYS   = 30;     // baseline look-BACK for a clean (tokenless) sync
const FUTURE_SYNC_WINDOW_DAYS = 90;     // baseline look-AHEAD — bounds recurring expansion
// Per-uid in-memory lock so two syncs for the same user never overlap. Maps
// uid → start time and self-heals: on serverless a frozen/killed instance can
// leave a lock set (its `finally` never runs), so a lock older than the TTL is
// treated as stale instead of wedging every future sync. Cross-instance
// concurrency isn't guarded — push/pull are upsert-based and tolerate overlap.
const syncing = new Map();
const SYNC_LOCK_TTL_MS = 2 * 60 * 1000;

function gStatus(e)   { return (e && (e.code || (e.response && e.response.status))) || 0; }
function isGone(e)    { const s = gStatus(e); return s === 410 || s === '410'; }
function isNotFound(e){ const s = gStatus(e); return s === 404 || s === '404'; }

// ── row helpers (Supabase events, service role) ───────────────────────────────
async function patchEventRow(id, patch) {
  const r = await sbFetch('/events?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error('event patch failed (HTTP ' + r.status + ')');
}
function markSynced(id, extra) { return patchEventRow(id, Object.assign({ sync_state: 'synced' }, extra || {})); }
async function upsertEvents(rows) {
  const r = await sbFetch('/events?on_conflict=user_id,google_event_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error('events upsert failed (HTTP ' + r.status + ') ' + (await r.text().catch(() => '')));
}
async function tombstoneByGoogleId(uid, gid) {
  const r = await sbFetch('/events?user_id=eq.' + encodeURIComponent(uid) + '&google_event_id=eq.' + encodeURIComponent(gid), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ deleted_at: new Date().toISOString(), sync_state: 'synced', updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('tombstone failed (HTTP ' + r.status + ')');
}

// ── shape mapping (Google event ⇄ events row) ─────────────────────────────────
function gEventToRow(uid, ev) {
  const allDay = !(ev.start && ev.start.dateTime);
  const sVal = ev.start && (ev.start.dateTime || ev.start.date);
  const eVal = (ev.end && (ev.end.dateTime || ev.end.date)) || sVal;
  return {
    user_id: uid,
    google_event_id: ev.id,
    title: ev.summary || '(no title)',
    starts_at: allDay ? (String(sVal).slice(0, 10) + 'T00:00:00.000Z') : new Date(sVal).toISOString(),
    ends_at:   allDay ? (String(eVal).slice(0, 10) + 'T00:00:00.000Z') : new Date(eVal).toISOString(),
    all_day: allDay,
    tz: (ev.start && ev.start.timeZone) || null,
    notes: ev.description || '',
    location: ev.location || '',
  };
}
function rowToGoogle(row) {
  const body = { summary: row.title || '(no title)', description: row.notes || '', location: row.location || '' };
  if (row.all_day) {
    const sd = String(row.starts_at).slice(0, 10);
    let ed = String(row.ends_at || row.starts_at).slice(0, 10);
    if (ed <= sd) { const d = new Date(sd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); ed = d.toISOString().slice(0, 10); }
    body.start = { date: sd };            // Google all-day end.date is EXCLUSIVE
    body.end   = { date: ed };
  } else {
    body.start = { dateTime: new Date(row.starts_at).toISOString(),            timeZone: row.tz || TIMEZONE };
    body.end   = { dateTime: new Date(row.ends_at || row.starts_at).toISOString(), timeZone: row.tz || TIMEZONE };
  }
  return body;
}

// ── PULL — Google → local, incremental via syncToken with 410 full-resync ─────
// Paginates one delta. `full` forces a tokenless baseline sync (timeMin window,
// no deletions). syncToken and timeMin are mutually exclusive by design, so we
// pick exactly one. nextSyncToken only arrives on the final page.
async function listGoogleDelta(cal, syncToken, full) {
  const items = [];
  let pageToken = null, nextSyncToken = null;
  let windowTimeMin = null, windowTimeMax = null;   // only set for a tokenless (full) pull
  do {
    const params = { calendarId: GCAL_ID, singleEvents: true, maxResults: 250, pageToken: pageToken || undefined };
    if (syncToken && !full) {
      params.syncToken = syncToken;       // incremental: Google includes cancellations
    } else {
      // Bound BOTH ends of the baseline. With singleEvents:true an open-ended
      // timeMax makes Google expand recurring series into unbounded future
      // instances (this ballooned the table to 20k+ rows). timeMin/timeMax are
      // mutually exclusive with syncToken, so this only applies to the tokenless
      // baseline; the returned syncToken then carries this window into deltas.
      params.timeMin = new Date(Date.now() - FULL_SYNC_WINDOW_DAYS   * 864e5).toISOString();
      params.timeMax = new Date(Date.now() + FUTURE_SYNC_WINDOW_DAYS * 864e5).toISOString();
      params.showDeleted = false;         // clean baseline
      windowTimeMin = params.timeMin;
      windowTimeMax = params.timeMax;
    }
    const res = await cal.events.list(params);
    (res.data.items || []).forEach((e) => items.push(e));
    pageToken     = res.data.nextPageToken || null;
    nextSyncToken = res.data.nextSyncToken || nextSyncToken;
  } while (pageToken);
  return { items, nextSyncToken, windowTimeMin, windowTimeMax };
}
async function applyItemsToSupabase(uid, items) {
  const confirmed = items.filter((e) => e.status !== 'cancelled');
  const cancelled = items.filter((e) => e.status === 'cancelled');
  if (confirmed.length) {
    const now = new Date().toISOString();
    await upsertEvents(confirmed.map((ev) =>
      Object.assign(gEventToRow(uid, ev), { deleted_at: null, sync_state: 'synced', updated_at: now })));
  }
  // Cancellations only ever arrive via incremental deltas (full sync sends none),
  // so there are just a handful — soft-delete each by its Google id. A PATCH that
  // matches no local row (event we never had) is a harmless no-op.
  for (const ev of cancelled) await tombstoneByGoogleId(uid, ev.id);
  return { upserts: confirmed.length, tombstones: cancelled.length };
}

// ── RECONCILE — full-baseline-only cleanup for rows Google no longer mirrors ──
// A full/baseline pull (showDeleted:false, no syncToken) structurally cannot
// receive cancellations from Google — applyItemsToSupabase above can only ever
// ADD or REFRESH rows during a full pull, never remove one. This closes that
// gap, but ONLY for exactly the window a *completed* full baseline queried, and
// only for rows a full pull is actually allowed to touch.
//
// Coverage predicate (why start/end don't both need to be inside the window):
// Google's own timeMin/timeMax filter is an interval-OVERLAP test — timeMin is
// an exclusive lower bound on an event's END, timeMax an exclusive upper bound
// on an event's START (see the Google Calendar API `events.list` reference for
// timeMin/timeMax; this repo's own comment above only names the two params, not
// the inclusive/exclusive overlap semantics, so this predicate is asserted from
// the documented API contract and pinned down by the Watch Film test case below,
// which really did come back from the live probe under a narrow same-day window
// despite starting the evening before). A row is therefore "covered" by
// [timeMin, timeMax) iff `starts_at < timeMax && ends_at > timeMin` — the exact
// mirror of Google's own filter. A row whose interval doesn't overlap the
// window at all was never something this baseline could have confirmed one way
// or the other, so it is always left untouched regardless of confirmedIds.
function computeStaleRowIds(rows, timeMin, timeMax, confirmedIds) {
  const winMin = new Date(timeMin).getTime();
  const winMax = new Date(timeMax).getTime();
  return rows.filter((row) => {
    if (!row.google_event_id) return false;                   // never Aptron-only/local rows
    if (row.sync_state !== 'synced') return false;             // pending local edit, not a clean mirror
    if (row.deleted_at) return false;                          // already tombstoned — idempotent
    if (confirmedIds.has(row.google_event_id)) return false;   // Google still returns this exact occurrence
    const s = new Date(row.starts_at).getTime();
    const e = new Date(row.ends_at || row.starts_at).getTime();
    return s < winMax && e > winMin;                           // overlap test — see comment above
  }).map((row) => row.id);
}
// Reconciliation only ever runs after a full pull whose pagination genuinely
// completed: no exception escaped listGoogleDelta (a mid-pagination failure
// throws and is never reached here — see pullSync), AND Google actually handed
// back a nextSyncToken. nextSyncToken only arrives on a page where Google
// considers the listing complete, so its absence after a clean pagination loop
// is Google's own signal that this baseline shouldn't be trusted as exhaustive
// — not a row-count guess, an evidence-based completeness signal already
// required anyway to persist the next delta's syncToken.
function isReconciliationEligible(full, nextSyncToken) {
  return !!(full && nextSyncToken);
}

const RECONCILE_PAGE_SIZE = 1000;   // see fetchAllRows — matches PostgREST's common default db-max-rows

// ── paginated, verified-complete PostgREST GET ────────────────────────────────
// An unbounded GET can be silently capped by PostgREST's configured
// db-max-rows (commonly 1000) WITHOUT a non-2xx status — the only signal is
// the returned row count falling short of Content-Range's exact total. This
// is exactly how a production account with 13k+ mirrored rows caused
// reconcileFullBaseline's original single unbounded GET to examine only a
// capped subset and silently miss every stale candidate outside it, even
// though the read itself "succeeded" (r.ok was true). Prefer: count=exact +
// Content-Range is the SAME convention this file already uses in
// deleteMirroredEvents above; this generalizes it into an explicit
// Range/Range-Unit pagination loop that REFUSES to return a result unless
// the accumulated row count exactly matches what PostgREST itself reports as
// the total for this filter — fails closed (throws) rather than ever
// silently treating a partial read as complete. The caller MUST include a
// stable `order=` in `path` so pages can't skip or duplicate rows as the
// underlying table changes between requests.
async function fetchAllRows(path, pageSize) {
  pageSize = pageSize || RECONCILE_PAGE_SIZE;
  const rows = [];
  let offset = 0, total = NaN;
  do {
    const r = await sbFetch(path, {
      method: 'GET',
      headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: offset + '-' + (offset + pageSize - 1) },
    });
    if (!r.ok) throw new Error('paged read failed (HTTP ' + r.status + ') at offset ' + offset);
    const batch = await r.json();
    const totalPart = (r.headers.get('content-range') || '').split('/')[1];
    total = totalPart === '*' ? NaN : parseInt(totalPart, 10);
    if (!Number.isFinite(total)) {
      throw new Error('paged read: PostgREST did not report an exact total (Content-Range=' +
        JSON.stringify(r.headers.get('content-range')) + ') — refusing to treat as complete');
    }
    rows.push(...batch);
    offset += batch.length;
    if (batch.length === 0) break;   // no forward progress; the length check below catches any shortfall
  } while (offset < total);
  if (rows.length !== total) {
    throw new Error('paged read: accumulated ' + rows.length + ' rows but PostgREST reported ' + total +
      ' total for this filter — refusing to treat as complete');
  }
  return rows;
}

async function reconcileFullBaseline(uid, timeMin, timeMax, confirmedIds) {
  // Narrow to the exact overlap window in SQL first — without this, the
  // candidate set is the user's WHOLE mirrored history (10k+ rows for an
  // active account), not just this baseline's window. Same strict overlap
  // test computeStaleRowIds re-checks in JS below (kept, not removed — this
  // is a defense-in-depth narrowing, not a replacement for it), so a mismatch
  // here could only ever under-select rows computeStaleRowIds would also
  // exclude, never smuggle in one it wouldn't have flagged anyway.
  // order=id.asc gives pagination a stable, deterministic cursor.
  const rows = await fetchAllRows(
    '/events?user_id=eq.' + encodeURIComponent(uid) +
    '&sync_state=eq.synced&google_event_id=not.is.null&deleted_at=is.null' +
    '&starts_at=lt.' + encodeURIComponent(timeMax) +
    '&ends_at=gt.' + encodeURIComponent(timeMin) +
    '&select=id,google_event_id,starts_at,ends_at&order=id.asc'
  );
  const staleIds = computeStaleRowIds(rows, timeMin, timeMax, confirmedIds);
  if (!staleIds.length) return 0;
  const now = new Date().toISOString();
  // Repeat the SAME ownership/state predicates the candidate read above used,
  // as a conditional guard against the GET→PATCH race: if another sync/edit
  // already moved a row off sync_state='synced' (e.g. the user started a local
  // edit) or already tombstoned/resurrected it in the meantime, this WHERE
  // simply won't match that row anymore — Postgres/PostgREST treats "0 rows
  // matched" as an ordinary success, not an error, so this never breaks the
  // call, it just stops it from clobbering state that moved on since the GET.
  // `id IN (...)` alone would happily overwrite whatever the row currently is.
  // Batched (not one giant id IN (...)) so a large stale set can never build a
  // URL past practical length limits; each batch repeats the full guard, and
  // any batch failing aborts the whole reconciliation rather than reporting a
  // partial success.
  let reconciledCount = 0;
  for (let i = 0; i < staleIds.length; i += RECONCILE_PAGE_SIZE) {
    const batchIds = staleIds.slice(i, i + RECONCILE_PAGE_SIZE);
    const r2 = await sbFetch(
      '/events?id=in.(' + batchIds.map(encodeURIComponent).join(',') + ')' +
      '&user_id=eq.' + encodeURIComponent(uid) +
      '&sync_state=eq.synced&deleted_at=is.null',
      {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ deleted_at: now, sync_state: 'synced', updated_at: now }),
      }
    );
    if (!r2.ok) throw new Error('reconcile tombstone failed (HTTP ' + r2.status + ')');
    // Report what the conditional WHERE actually matched, not what we asked
    // for — with return=minimal there'd be no way to tell the two apart, and a
    // row that moved on between the read and this write must be reflected here,
    // not just silently excluded from the mutation.
    reconciledCount += (await r2.json()).length;
  }
  return reconciledCount;
}

async function pullSync(uid, conn, cal) {
  let full = !conn.sync_token;
  let items, nextSyncToken, windowTimeMin, windowTimeMax;
  try {
    ({ items, nextSyncToken, windowTimeMin, windowTimeMax } = await listGoogleDelta(cal, conn.sync_token || null, full));
  } catch (e) {
    if (!isGone(e)) throw e;
    // 410 GONE → the syncToken expired/invalidated. Drop it and do a clean sync.
    console.warn('[sync] syncToken gone for', uid, '→ full resync');
    full = true;
    ({ items, nextSyncToken, windowTimeMin, windowTimeMax } = await listGoogleDelta(cal, null, true));
  }
  const counts = await applyItemsToSupabase(uid, items);
  let reconciled = 0;
  if (isReconciliationEligible(full, nextSyncToken)) {
    const confirmedIds = new Set(items.filter((e) => e.status !== 'cancelled').map((e) => e.id));
    reconciled = await reconcileFullBaseline(uid, windowTimeMin, windowTimeMax, confirmedIds);
  } else if (full) {
    console.warn('[sync] full baseline for', uid, 'completed without nextSyncToken — skipping reconciliation this run');
  }
  await patchConnection(uid, {
    sync_token: nextSyncToken || null,
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return Object.assign({ full, seen: items.length, reconciled }, counts);
}

// ── PUSH — local → Google (creates / patches / deletes for sync_state='local') ─
async function pushLocalChanges(uid, cal) {
  const r = await sbFetch('/events?user_id=eq.' + encodeURIComponent(uid) + '&sync_state=eq.local&select=*&limit=500', { method: 'GET' });
  if (!r.ok) throw new Error('local read failed (HTTP ' + r.status + ')');
  const rows = await r.json();
  let created = 0, updated = 0, deleted = 0;
  for (const row of rows) {
    try {
      if (row.deleted_at) {
        // Locally deleted → remove from Google (ignore already-gone), then settle.
        if (row.google_event_id) {
          try { await cal.events.delete({ calendarId: GCAL_ID, eventId: row.google_event_id }); deleted++; }
          catch (e) { if (!isGone(e) && !isNotFound(e)) throw e; }
        }
        await markSynced(row.id);
      } else if (row.google_event_id) {
        // Locally edited mirror row → patch in place.
        try {
          await cal.events.patch({ calendarId: GCAL_ID, eventId: row.google_event_id, requestBody: rowToGoogle(row) });
          updated++; await markSynced(row.id);
        } catch (e) {
          if (!isGone(e) && !isNotFound(e)) throw e;
          // Vanished on Google → recreate and adopt the new id.
          const ins = await cal.events.insert({ calendarId: GCAL_ID, requestBody: rowToGoogle(row) });
          created++; await markSynced(row.id, { google_event_id: ins.data.id });
        }
      } else {
        // Brand-new local block → create in Google, record its id.
        const ins = await cal.events.insert({ calendarId: GCAL_ID, requestBody: rowToGoogle(row) });
        created++; await markSynced(row.id, { google_event_id: ins.data.id });
      }
    } catch (e) {
      // Leave sync_state='local' so the next trigger retries this row.
      console.warn('[sync] push failed for row', row.id, '-', e && e.message);
    }
  }
  return { created, updated, deleted, candidates: rows.length };
}

// ── orchestrator — one push+pull for a user, guarded against overlap ──────────
async function syncUser(uid, opts) {
  const startedAt = syncing.get(uid);
  if (startedAt && (Date.now() - startedAt) < SYNC_LOCK_TTL_MS) return { skipped: 'in_progress' };
  syncing.set(uid, Date.now());
  try {
    let ctx;
    try { ctx = await calendarForUser(uid); }
    catch (e) { return { skipped: 'not_linked' }; }
    const { calendar: cal, conn } = ctx;
    if (!conn.sync_enabled) return { skipped: 'sync_disabled' };
    const pushed = await pushLocalChanges(uid, cal);
    const pulled = await pullSync(uid, conn, cal);
    return { ok: true, reason: (opts && opts.reason) || 'manual', pushed, pulled };
  } finally {
    syncing.delete(uid);
  }
}

// ── 13. POST /api/calendar/sync/trigger ───────────────────────────────────────
// Manual mirror from the dashboard (also fired server-side right after linking).
app.post('/api/calendar/sync/trigger', expensiveLimiter, async (req, res) => {
  if (!OAUTH_LINK_CONFIGURED) return res.status(503).json({ error: 'Calendar linking is not configured' });
  try {
    const result = await syncUser(req.user.id, { reason: 'manual' });
    if (result.skipped === 'not_linked')    return res.status(404).json({ error: 'No calendar linked' });
    if (result.skipped === 'sync_disabled') return res.status(409).json({ error: 'Sync is paused' });
    if (result.skipped === 'in_progress')   return res.status(202).json({ status: 'already syncing' });
    res.json(result);
  } catch (err) {
    console.error('[sync] trigger failed:', err && err.message);
    res.status(502).json({ error: 'Sync failed' });
  }
});


// ── Crash visibility ───────────────────────────────────────────────────────────
// Every route above already catches its own errors and answers with a normal
// HTTP response — these two only fire for a bug that slipped past all of them.
// Node kills the process for both cases either way; the only thing missing
// before this was a log line explaining why. The platform (Render / pm2)
// restarts the process — log loudly, then let it die, rather than leaving the
// owner staring at a proxy that's mysteriously stopped answering.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', (err && err.stack) || err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandled rejection:', (err && err.stack) || err);
  process.exit(1);
});

// ── Start server (local dev only) ─────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('  Google Calendar proxy is running');
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Health:  http://localhost:${PORT}/health`);
    console.log('');
  });
}

// Exposed ONLY for tools/smoke/calendar-reconciliation-smoke.mjs — no HTTP
// surface change, no behavior change for the running app. These are the same
// functions the real sync path calls; the smoke test exercises them directly
// (with a fake `cal`/`sbFetch`-shaped stub, never a live Google/Supabase call)
// instead of re-implementing the logic in the test.
app._internal = { computeStaleRowIds, isReconciliationEligible, listGoogleDelta, pullSync, fetchAllRows, reconcileFullBaseline };

module.exports = app;
