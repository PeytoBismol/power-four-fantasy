'use strict';

// Service worker: caches the app shell (HTML, CSS, JS, icons) so the app opens fast and
// shows a clear message when offline. API responses are never cached: league data is live.
// Bump SHELL_VERSION whenever a shell file changes, so phones drop the old copy.

const SHELL_VERSION = 'pf-shell-v3';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.css',
  '/views.js',
  '/app.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_VERSION).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only handle our own GET requests. Fonts and anything else pass straight through.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live data and sign-in are never served from cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  // Network first so updates arrive at once; fall back to the cached shell when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
