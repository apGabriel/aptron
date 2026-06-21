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

// Build an OAuth2 client that auto-refreshes the access token using the
// stored refresh token — no manual re-auth needed after the first setup.
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'http://localhost:3002/callback');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '8mb' }));   // meal-scan posts a base64 image

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
    'Rules: all times are 24-hour "HH:MM". For move_event / complete_event / delete_event, ' +
    '"match" MUST be a distinctive keyword taken from the target event\'s title. ' +
    'For add_event include "title" and "time" (and "durationMin" if the user implies a length). ' +
    'For retime_event (move / reschedule / reduce / extend / "from X to Y") include "match" and the new "time"; ' +
    'add "endTime" for a range, "durationMin" to set an absolute length, or "deltaMin" to grow (+) / shrink (-) it. ' +
    'For log_water set "servings" (default 1) and "unit" ("glass" or "bottle"). ' +
    'For log_food set "name" and "calories" if stated. For a quick reminder/idea with no time, use "note" with "text". ' +
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
            enum: ['add_event', 'move_event', 'retime_event', 'complete_event', 'uncheck_event',
              'delete_event', 'summarize', 'log_water', 'log_food', 'note', 'chat'],
          },
          title: { type: 'STRING' }, match: { type: 'STRING' }, time: { type: 'STRING' },
          endTime: { type: 'STRING' }, deltaMin: { type: 'NUMBER' },
          durationMin: { type: 'NUMBER' }, notes: { type: 'STRING' },
          servings: { type: 'NUMBER' }, unit: { type: 'STRING' },
          name: { type: 'STRING' }, calories: { type: 'NUMBER' },
          text: { type: 'STRING' }, reply: { type: 'STRING' },
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
