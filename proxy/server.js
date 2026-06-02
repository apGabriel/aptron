// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar Proxy Server
//
// WHY THIS EXISTS
//   Browsers can't call the Google Calendar API directly from your HTML pages
//   because OAuth tokens must stay secret (never exposed to the browser).
//   This server holds your credentials, gets fresh access tokens automatically,
//   and forwards the calendar data to your dashboard.
//
//   Browser (index.html / finance.html / …)
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
  console.error('ERROR: Missing Google OAuth credentials in proxy/.env');
  console.error('Run `node auth.js` to get your GOOGLE_REFRESH_TOKEN.');
  process.exit(1);
}

// Build an OAuth2 client that auto-refreshes the access token using the
// stored refresh token — no manual re-auth needed after the first setup.
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'http://localhost:3002/callback');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────────────────────────
function dayBounds(dateStr) {
  return {
    timeMin: `${dateStr}T00:00:00`,
    timeMax: `${dateStr}T23:59:59`,
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

// Health check — open http://localhost:3001/health to verify the proxy is up
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', calendar_id: CALENDAR_ID, timezone: TIMEZONE });
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
      timeMin: `${start}T00:00:00`,
      timeMax: `${end}T23:59:59`,
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


// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  Google Calendar proxy is running');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log('');
});
