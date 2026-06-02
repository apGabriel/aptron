// ─────────────────────────────────────────────────────────────────────────────
// One-time Google OAuth2 authorization script.
// Run this ONCE to get your refresh token, then never again.
//
// Usage:
//   node auth.js
//
// It will print a URL. Open it in your browser, log in with your Google
// account, grant calendar access, and the refresh token will be printed
// to the terminal. Paste it into proxy/.env as GOOGLE_REFRESH_TOKEN.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { google } = require('googleapis');
const http       = require('http');
const url        = require('url');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\nERROR: Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in proxy/.env first.\n');
  process.exit(1);
}

const REDIRECT_URI  = 'http://localhost:3002/callback';
const SCOPES        = ['https://www.googleapis.com/auth/calendar'];

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope:       SCOPES,
  prompt:      'consent',   // force Google to issue a new refresh_token
});

console.log('\n──────────────────────────────────────────────────────────');
console.log('  Step 1 — Open this URL in your browser:');
console.log('──────────────────────────────────────────────────────────\n');
console.log(authUrl);
console.log('\n──────────────────────────────────────────────────────────');
console.log('  Step 2 — Log in and click "Allow".');
console.log('  The browser will redirect to localhost and this script');
console.log('  will capture the code automatically.');
console.log('──────────────────────────────────────────────────────────\n');

// Temporary local HTTP server that listens for Google's redirect
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (!parsed.query.code) {
    res.writeHead(400);
    res.end('No authorization code received.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(parsed.query.code);

    if (!tokens.refresh_token) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h2>No refresh token returned.</h2><p>Try revoking access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and running auth.js again.</p>');
      server.close();
      console.error('\nERROR: Google did not return a refresh_token.');
      console.error('Go to https://myaccount.google.com/permissions, revoke access for your app, then run auth.js again.\n');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2 style="font-family:sans-serif;color:green">✓ Authorized! You can close this tab.</h2><p style="font-family:sans-serif">Go back to your terminal and copy the refresh token.</p>');
    server.close();

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  ✓ Success! Add this line to your proxy/.env file:');
    console.log('══════════════════════════════════════════════════════════\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\n══════════════════════════════════════════════════════════\n');

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error: ' + err.message);
    server.close();
    console.error('\nERROR getting tokens:', err.message);
  }
});

server.listen(3002, () => {
  console.log('  (Waiting for Google redirect on http://localhost:3002 …)\n');
});
