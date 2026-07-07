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
//   1. Copy .env.example to .env and fill in GOOGLE_CLIENT_ID,
//      GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//      (run `node auth.js` once to get the refresh token)
//   2. npm install
//   3. npm start   (or "npm run dev" to auto-restart on changes)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const crypto       = require('crypto');
const { google }   = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Google OAuth2 config ──────────────────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';
const CALENDAR_ID   = process.env.GOOGLE_CALENDAR_ID   || 'primary';
const TIMEZONE      = process.env.TIMEZONE             || 'UTC';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('ERROR: Missing Google OAuth credentials in environment variables.');
}

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

// Build an OAuth2 client that auto-refreshes the access token using the
// stored refresh token — no manual re-auth needed after the first setup.
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'http://localhost:3002/callback');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ── Multi-tenant calendar linking (Step 2) ────────────────────────────────────
// Per-user Google linking stores each user's refresh token in the Supabase vault
// (public.calendar_connections, migration 0005) instead of the single global
// GOOGLE_REFRESH_TOKEN above. Three new secrets gate it:
//   • SUPABASE_SERVICE_ROLE_KEY — reads/writes the vault, BYPASSING RLS (the
//     browser can never read tokens; only this server can). Keep it server-side.
//   • TOKEN_ENC_KEY             — encrypts refresh tokens at rest (AES-256-GCM).
//   • GOOGLE_REDIRECT_URI       — the OAuth redirect, e.g.
//     https://<proxy-host>/oauth/google/callback. Must be an Authorized redirect
//     URI on a "Web application" Google OAuth client (not the Desktop client the
//     CLI auth.js uses). The same CLIENT_ID/SECRET can be a Web client, or set a
//     dedicated web client's id/secret here.
// If any secret is missing the linking routes fail closed (503); the legacy
// single-owner /api/events routes keep working off GOOGLE_REFRESH_TOKEN.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TOKEN_ENC_KEY             = process.env.TOKEN_ENC_KEY             || '';
const GOOGLE_REDIRECT_URI       = process.env.GOOGLE_REDIRECT_URI       || '';
// 32-byte AES key derived from the passphrase so TOKEN_ENC_KEY can be any string.
const ENC_KEY = TOKEN_ENC_KEY ? crypto.createHash('sha256').update(TOKEN_ENC_KEY).digest() : null;
const OAUTH_LINK_CONFIGURED = !!(CLIENT_ID && CLIENT_SECRET && GOOGLE_REDIRECT_URI &&
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function dayBounds(dateStr) {
  return {
    timeMin: `${dateStr}T00:00:00Z`,
    timeMax: `${dateStr}T23:59:59Z`,
  };
}

function formatEvent(ev) {
  const allDay = !ev.start?.dateTime;
  return {
    id:       ev.id,
    title:    ev.summary    || '(no title)',
    start:    ev.start?.dateTime || ev.start?.date || null,
    end:      ev.end?.dateTime   || ev.end?.date   || null,
    allDay,
    notes:    ev.description || '',
    location: ev.location   || '',
    status:   ev.status,
    url:      ev.htmlLink   || '',
    color:    ev.colorId    || null,
  };
}

async function listEvents({ timeMin, timeMax }) {
  const res = await calendar.events.list({
    calendarId:  CALENDAR_ID,
    timeMin,
    timeMax,
    timeZone:    TIMEZONE,
    singleEvents: true,
    orderBy:     'startTime',
    maxResults:  250,
  });
  return (res.data.items || []).map(formatEvent);
}

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


// ── 1. GET /api/events?date=YYYY-MM-DD ────────────────────────────────────────
// Returns all events for a single day (defaults to today).
app.get('/api/events', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    res.json(await listEvents(dayBounds(date)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── 2. GET /api/events/range?start=YYYY-MM-DD&end=YYYY-MM-DD ─────────────────
// Returns all events between two dates (inclusive).
app.get('/api/events/range', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required' });
  try {
    res.json(await listEvents({
      timeMin: `${start}T00:00:00Z`,
      timeMax: `${end}T23:59:59Z`,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── 3. POST /api/events ───────────────────────────────────────────────────────
// Create a new event.
// Body: { title, date, notes?, startTime?, endTime?, allDay? }
//   allDay=true  (or no startTime/endTime) → all-day event
//   startTime/endTime → timed event, must be full ISO strings
app.post('/api/events', async (req, res) => {
  const { title, date, notes, startTime, endTime, allDay } = req.body;
  if (!title || !date) return res.status(400).json({ error: 'title and date are required' });

  const requestBody = {
    summary:     title,
    description: notes || '',
  };

  if (allDay || (!startTime && !endTime)) {
    requestBody.start = { date };
    requestBody.end   = { date };
  } else {
    requestBody.start = { dateTime: startTime || `${date}T09:00:00`, timeZone: TIMEZONE };
    requestBody.end   = { dateTime: endTime   || `${date}T10:00:00`, timeZone: TIMEZONE };
  }

  try {
    const res2 = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody });
    res.status(201).json(formatEvent(res2.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── 4. PATCH /api/events/:id ──────────────────────────────────────────────────
// Update an existing event. Send only the fields you want to change.
// Body can include: { title?, notes?, date?, startTime?, endTime? }
app.patch('/api/events/:id', async (req, res) => {
  const { title, notes, date, startTime, endTime } = req.body;
  const requestBody = {};
  if (title !== undefined) requestBody.summary     = title;
  if (notes !== undefined) requestBody.description = notes;
  if (date && !startTime && !endTime) {
    requestBody.start = { date };
    requestBody.end   = { date };
  }
  if (startTime) requestBody.start = { dateTime: startTime, timeZone: TIMEZONE };
  if (endTime)   requestBody.end   = { dateTime: endTime,   timeZone: TIMEZONE };

  try {
    const res2 = await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId:    req.params.id,
      requestBody,
    });
    res.json(formatEvent(res2.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── 5. DELETE /api/events/:id ─────────────────────────────────────────────────
// Permanently deletes the event from Google Calendar.
app.delete('/api/events/:id', async (req, res) => {
  try {
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


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

app.post('/api/gemini/meal-scan', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});


// ── 7. POST /api/gemini/assistant ─────────────────────────────────────────────
// The dashboard's AI command assistant. The browser handles common tactical
// commands locally (instant/offline); anything free-form is forwarded here and
// Gemini returns ONE structured intent the frontend applies to the calendar /
// modules. Same server-side key as meal-scan — never reaches the browser.
// Body: { message: string, context?: { date, events:[{title,start,end,done}] } }
// Returns the intent object (see responseSchema below).
app.post('/api/gemini/assistant', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server' });
  const { message, context } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const events = (context && Array.isArray(context.events)) ? context.events : [];
  const sys =
    'You are the orchestrator AI for a personal day-planner dashboard. ' +
    'Convert the user message into EXACTLY ONE structured action. ' +
    'Today is ' + ((context && context.date) || new Date().toISOString().slice(0, 10)) + '. ' +
    "The user's current calendar events (JSON): " + JSON.stringify(events).slice(0, 4000) + '. ' +
    'Rules: all times are 24-hour "HH:MM". For move_event / complete_event / delete_event / rename_event, ' +
    '"match" MUST be a distinctive keyword taken from the target event\'s title. ' +
    'For rename_event (the user wants to change/correct an event\'s NAME or TITLE, e.g. ' +
    '"rename X to Y", "change the name of X to Y", "call X Y") set "match" to the existing block and ' +
    '"title" to the new name. NEVER refuse a rename or suggest deleting + re-adding — rename_event is native. ' +
    'For add_event include "title" and "time" (and "durationMin" if the user implies a length). ' +
    'For retime_event (move / reschedule / reduce / extend / "from X to Y") include "match" and the new "time"; ' +
    'add "endTime" for a range, "durationMin" to set an absolute length, or "deltaMin" to grow (+) / shrink (-) it. ' +
    'For log_water set "servings" (default 1) and "unit" ("glass" or "bottle"). ' +
    'For log_food set "name" and "calories" if stated. For a quick reminder/idea with no time, use "note" with "text". ' +
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
              'delete_event', 'restore_event', 'summarize', 'log_water', 'log_food', 'note', 'chat'],
          },
          title: { type: 'STRING' }, match: { type: 'STRING' }, time: { type: 'STRING' },
          endTime: { type: 'STRING' }, deltaMin: { type: 'NUMBER' },
          durationMin: { type: 'NUMBER' }, notes: { type: 'STRING' },
          servings: { type: 'NUMBER' }, unit: { type: 'STRING' },
          name: { type: 'STRING' }, calories: { type: 'NUMBER' },
          text: { type: 'STRING' }, reply: { type: 'STRING' },
          // Ordered intents for a compound message; healing/restore comes first.
          steps: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                action: {
                  type: 'STRING',
                  enum: ['add_event', 'move_event', 'retime_event', 'rename_event', 'complete_event', 'uncheck_event',
                    'delete_event', 'restore_event', 'log_water', 'log_food', 'note'],
                },
                title: { type: 'STRING' }, match: { type: 'STRING' }, time: { type: 'STRING' },
                endTime: { type: 'STRING' }, deltaMin: { type: 'NUMBER' }, durationMin: { type: 'NUMBER' },
                notes: { type: 'STRING' }, servings: { type: 'NUMBER' }, unit: { type: 'STRING' },
                name: { type: 'STRING' }, calories: { type: 'NUMBER' }, text: { type: 'STRING' },
              },
              required: ['action'],
            },
          },
        },
        required: ['action', 'reply'],
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
    res.status(500).json({ error: err.message });
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

// ── per-request Google client (replaces the single global oauth2Client) ────────
// Builds a fresh OAuth2 client from THIS user's stored refresh token, so every
// calendar call acts on the caller's own Google account. The step-4 mirror
// (push/pull) is the main consumer; ?verify=1 on /status also exercises it. The
// legacy /api/events routes still use the global client until the mirror lands.
function newOAuthClient() { return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, GOOGLE_REDIRECT_URI); }
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
  const url = newOAuthClient().generateAuthUrl({
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
    const client = newOAuthClient();
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
    // Kick off the first mirror in the background so the user's Google events
    // show up shortly after linking — don't block the popup on it.
    syncUser(uid, { reason: 'link' }).catch((e) => console.error('[sync] post-link failed:', e && e.message));
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
    await deleteConnection(req.user.id);
    res.json({ ok: true });
  } catch (err) {
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
const FULL_SYNC_WINDOW_DAYS  = 30;      // baseline window for a clean (tokenless) sync
const syncing = new Set();              // per-uid lock: never overlap two syncs

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
  do {
    const params = { calendarId: GCAL_ID, singleEvents: true, maxResults: 250, pageToken: pageToken || undefined };
    if (syncToken && !full) {
      params.syncToken = syncToken;       // incremental: Google includes cancellations
    } else {
      params.timeMin = new Date(Date.now() - FULL_SYNC_WINDOW_DAYS * 864e5).toISOString();
      params.showDeleted = false;         // clean baseline
    }
    const res = await cal.events.list(params);
    (res.data.items || []).forEach((e) => items.push(e));
    pageToken     = res.data.nextPageToken || null;
    nextSyncToken = res.data.nextSyncToken || nextSyncToken;
  } while (pageToken);
  return { items, nextSyncToken };
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
async function pullSync(uid, conn, cal) {
  let full = !conn.sync_token;
  let items, nextSyncToken;
  try {
    ({ items, nextSyncToken } = await listGoogleDelta(cal, conn.sync_token || null, full));
  } catch (e) {
    if (!isGone(e)) throw e;
    // 410 GONE → the syncToken expired/invalidated. Drop it and do a clean sync.
    console.warn('[sync] syncToken gone for', uid, '→ full resync');
    full = true;
    ({ items, nextSyncToken } = await listGoogleDelta(cal, null, true));
  }
  const counts = await applyItemsToSupabase(uid, items);
  await patchConnection(uid, {
    sync_token: nextSyncToken || null,
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return Object.assign({ full, seen: items.length }, counts);
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
  if (syncing.has(uid)) return { skipped: 'in_progress' };
  syncing.add(uid);
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
app.post('/api/calendar/sync/trigger', async (req, res) => {
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

module.exports = app;
