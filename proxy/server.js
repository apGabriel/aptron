// ─────────────────────────────────────────────────────────────────────────────
// Notion Proxy Server
//
// WHY THIS EXISTS
//   Browsers block direct calls to api.notion.com (CORS policy).
//   This server runs locally on your machine, sits between your dashboard
//   and Notion, and forwards the requests with your secret token attached.
//
//   Browser (index.html)
//       │  HTTP request  (no token, goes to localhost)
//       ▼
//   This proxy  (localhost:3001)
//       │  HTTP request  (attaches your Notion token, goes to notion.com)
//       ▼
//   Notion API  (api.notion.com)
//       │  response
//       ▼
//   This proxy  →  Browser
//
// HOW TO RUN
//   1. Copy .env.example to .env and fill in your values
//   2. npm install
//   3. npm start   (or "npm run dev" to auto-restart on changes)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Notion constants ──────────────────────────────────────────────────────────
const NOTION_TOKEN    = process.env.NOTION_TOKEN    || '';
const NOTION_DB_ID    = process.env.NOTION_DATABASE_ID || '';
const NOTION_BASE_URL = 'https://api.notion.com/v1';
const NOTION_VERSION  = '2022-06-28';

// Guard: fail early if the token is missing
if (!NOTION_TOKEN) {
  console.error('ERROR: NOTION_TOKEN is not set in .env');
  process.exit(1);
}

// ── Middleware ────────────────────────────────────────────────────────────────

// Allow requests from any origin (your HTML file opened via Live Server or file://)
app.use(cors());

// Parse incoming JSON bodies (needed for POST/PATCH requests from the dashboard)
app.use(express.json());

// ── Notion request helper ─────────────────────────────────────────────────────
//
// Every call to Notion needs the same three headers:
//   Authorization  – proves who you are
//   Notion-Version – tells Notion which API version to use
//   Content-Type   – tells Notion the body is JSON
//
async function notionRequest({ method, path, body }) {
  try {
    const response = await axios({
      method,
      url: `${NOTION_BASE_URL}${path}`,
      headers: {
        'Authorization':  `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type':   'application/json',
      },
      data: body,
    });
    return { ok: true, data: response.data };
  } catch (err) {
    const status  = err.response?.status  || 500;
    const message = err.response?.data?.message || err.message;
    return { ok: false, status, message };
  }
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check — open http://localhost:3001/health in your browser to verify
// the proxy is running
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    notion_token_set: !!NOTION_TOKEN,
    notion_database_id_set: !!NOTION_DB_ID,
  });
});


// ── 1. GET /api/events ────────────────────────────────────────────────────────
//
// Fetches all entries from your Notion calendar database.
// By default returns today's events; pass ?date=YYYY-MM-DD to get any day.
//
// How it works:
//   POST to Notion's /databases/:id/query endpoint with a date filter.
//   Notion returns a list of "pages" — each page is one calendar entry.
//
app.get('/api/events', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const { ok, data, status, message } = await notionRequest({
    method: 'POST',
    path:   `/databases/${NOTION_DB_ID}/query`,
    body: {
      // Filter: only return pages whose Date property contains the requested day
      filter: {
        property: 'Date',        // <-- change this to match your column name
        date: {
          equals: date,
        },
      },
      sorts: [
        { property: 'Date', direction: 'ascending' },
      ],
    },
  });

  if (!ok) return res.status(status).json({ error: message });

  // Transform raw Notion pages into a simpler shape for the dashboard
  const events = data.results.map(page => formatPage(page));
  res.json(events);
});


// ── 2. GET /api/events/range ──────────────────────────────────────────────────
//
// Fetch events between two dates.
// Usage: /api/events/range?start=2026-06-01&end=2026-06-07
//
app.get('/api/events/range', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params are required' });
  }

  const { ok, data, status, message } = await notionRequest({
    method: 'POST',
    path:   `/databases/${NOTION_DB_ID}/query`,
    body: {
      filter: {
        and: [
          { property: 'Date', date: { on_or_after: start } },
          { property: 'Date', date: { on_or_before: end  } },
        ],
      },
      sorts: [{ property: 'Date', direction: 'ascending' }],
    },
  });

  if (!ok) return res.status(status).json({ error: message });

  res.json(data.results.map(page => formatPage(page)));
});


// ── 3. POST /api/events ───────────────────────────────────────────────────────
//
// Create a new event/task in your Notion database.
// Body: { title, date, notes }
//
app.post('/api/events', async (req, res) => {
  const { title, date, notes } = req.body;
  if (!title || !date) {
    return res.status(400).json({ error: 'title and date are required' });
  }

  const { ok, data, status, message } = await notionRequest({
    method: 'POST',
    path:   '/pages',
    body: {
      parent: { database_id: NOTION_DB_ID },
      properties: {
        // "Name" and "Date" must match your actual Notion column names
        'Name': {
          title: [{ text: { content: title } }],
        },
        'Date': {
          date: { start: date },
        },
        ...(notes && {
          'Notes': {
            rich_text: [{ text: { content: notes } }],
          },
        }),
      },
    },
  });

  if (!ok) return res.status(status).json({ error: message });

  res.status(201).json(formatPage(data));
});


// ── 4. PATCH /api/events/:id ──────────────────────────────────────────────────
//
// Update an existing event — mark it done, rename it, change the date, etc.
// Body can contain any of: { done, title, date, notes }
//
app.patch('/api/events/:id', async (req, res) => {
  const { done, title, date, notes } = req.body;

  // Build the properties object with only the fields that were sent
  const properties = {};
  if (typeof done  !== 'undefined') properties['Done']  = { checkbox: done };
  if (title)                        properties['Name']  = { title: [{ text: { content: title } }] };
  if (date)                         properties['Date']  = { date: { start: date } };
  if (notes)                        properties['Notes'] = { rich_text: [{ text: { content: notes } }] };

  const { ok, data, status, message } = await notionRequest({
    method: 'PATCH',
    path:   `/pages/${req.params.id}`,
    body:   { properties },
  });

  if (!ok) return res.status(status).json({ error: message });

  res.json(formatPage(data));
});


// ── 5. DELETE /api/events/:id ─────────────────────────────────────────────────
//
// Notion doesn't truly delete pages — it archives them (same as clicking
// the trash icon). The page disappears from your database view.
//
app.delete('/api/events/:id', async (req, res) => {
  const { ok, data, status, message } = await notionRequest({
    method: 'PATCH',
    path:   `/pages/${req.params.id}`,
    body:   { archived: true },
  });

  if (!ok) return res.status(status).json({ error: message });

  res.json({ success: true });
});


// ── Helper: format a raw Notion page into a clean object ──────────────────────
//
// Notion pages have a deeply nested structure. This function flattens them
// into something simple that the dashboard can consume.
//
function formatPage(page) {
  const props = page.properties || {};

  return {
    id:    page.id,
    url:   page.url,
    title: extractText(props['Name'] || props['Title'] || props['title']),
    date:  props['Date']?.date?.start  || null,
    done:  props['Done']?.checkbox     || false,
    notes: extractText(props['Notes']) || '',
  };
}

// Pulls plain text out of Notion's rich_text / title arrays
function extractText(prop) {
  if (!prop) return '';
  const arr = prop.title || prop.rich_text || [];
  return arr.map(t => t.plain_text || '').join('');
}


// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  Notion proxy is running');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log('');
});
