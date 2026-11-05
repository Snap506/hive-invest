/* Offline shell: the app opens without a connection and shows the last data it had.
   Network first for everything, so a new version is picked up on the next open. API calls are never cached. */
const CACHE = 'hive-shell-v2.3.0';
const SHELL = ['/', '/index.html', '/css/app.css?v=2.3.0', '/js/app.js?v=2.3.0', '/js/engine.js', '/js/patterns.js', '/js/projection.js', '/js/projection-worker.js', '/js/api.js', '/js/chart.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
