'use strict';

require('./env').loadEnv();

// One process serves the JSON API and the web app. Built on node:http only.
//   PORT (default 8080), HOST (default 0.0.0.0), DB_PATH, WEB_DIR, ADMIN_TOKEN, COOKIE_SECURE=1 behind HTTPS

const http = require('http');
const fs = require('fs');
const path = require('path');
const { openDb, tx } = require('./db');
const { handleApi, tokenFrom } = require('./api');
const { ApiError } = require('./util');
const { createLimits } = require('./limiter');
const { startMaintenance } = require('./maintenance');
const draft = require('./draft');
const L = require('./league');

const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, '..', 'web'));
const COOKIE = 'pf_session';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...extra });
  res.end(JSON.stringify(body));
}

function sessionCookie(token, maxAge) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function apiRequest(req, res, db, url, limits) {
  try {
    let result = (await handleApi(req, { db, limits, pathname: url.pathname, query: url.searchParams, token: tokenFrom(req) })) || {};
    const headers = {};
    if (result.session) {
      headers['Set-Cookie'] = sessionCookie(result.session.token, result.session.maxAge);
      // Keeps the other fields (user, and a recovery code on sign-up or reset) and adds the token
      const { session, ...rest } = result;
      result = { ...rest, token: session.token };
    } else if (result.logout) {
      headers['Set-Cookie'] = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
      result = { ok: true };
    }
    send(res, 200, result, headers);
  } catch (err) {
    if (err instanceof ApiError) return send(res, err.status, { error: err.message });
    console.error(err);
    return send(res, 500, { error: 'Something went wrong on the server' });
  }
}

// Serves files from web/. Unknown paths without an extension get the app shell (client-side routes).
function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (err) {
    return send(res, 400, { error: 'Bad URL encoding' });
  }
  const file = path.join(WEB_DIR, path.posix.normalize('/' + rel));
  fs.stat(file, (err, st) => {
    let target = file;
    if (err || !st.isFile()) {
      if (path.extname(rel)) return send(res, 404, { error: 'Not found' });
      target = path.join(WEB_DIR, 'index.html');
    }
    const isShell = target === path.join(WEB_DIR, 'index.html');
    // The service worker and manifest must always be fresh so phones pick up new versions
    const fresh = isShell || path.basename(target) === 'sw.js' || path.extname(target) === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': fresh ? 'no-cache' : 'public, max-age=300',
      ...SECURITY
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
  });
}

// Runs drafts whose timers have expired or whose next pick is a CPU team, even when nobody is looking.
// Most of the time no draft is live, so the check is a plain read and the write lock is taken only when needed.
function tickDrafts(db) {
  try {
    if (!db.prepare("SELECT 1 FROM leagues WHERE status = 'drafting' LIMIT 1").get()) return;
    tx(db, () => {
      const live = db.prepare("SELECT * FROM leagues WHERE status = 'drafting'").all().map(L.parseLeague);
      for (const league of live) draft.processDraft(db, league);
    });
  } catch (err) {
    console.error('Draft tick failed:', err.message);
  }
}

function createApp({ dbFile }) {
  const db = openDb(dbFile);
  const limits = createLimits();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let work;
    if (url.pathname === '/healthz') work = Promise.resolve(send(res, 200, { ok: true }));
    else if (url.pathname.startsWith('/api/')) work = apiRequest(req, res, db, url, limits);
    else if (req.method !== 'GET' && req.method !== 'HEAD') work = Promise.resolve(send(res, 405, { error: 'Method not allowed' }));
    else work = Promise.resolve(serveStatic(req, res, url));
    work.catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong on the server' });
    });
  });
  const timer = setInterval(() => tickDrafts(db), 5000);
  timer.unref();
  server.on('close', () => {
    clearInterval(timer);
    db.close();
  });
  return { server, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'power-four.sqlite');
  const { server, db } = createApp({ dbFile });
  const maintenance = startMaintenance({ db, dbFile });
  server.listen(port, host, () => {
    console.log(`Power Four Fantasy is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
  const shutdown = () => {
    maintenance.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, tickDrafts };
