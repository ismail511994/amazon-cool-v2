/* ============================================================
   أمازون كول — Service Worker v5.0
   Smart caching strategy:
   - HTML: Network-First (always fresh)
   - Static assets: Cache-First (fast)
   - Images: Network-First with cache fallback
   ============================================================ */
const CACHE_NAME = 'amazoncool-v5';
const STATIC_ASSETS = [
  './manifest.json',
  './icon.svg'
];

/* Install — Cache static assets */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing v5.0...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => {
        console.log('[SW] Static assets cached');
        return self.skipWaiting();
      })
      .catch((err) => console.warn('[SW] Install failed:', err))
  );
});

/* Activate — Clean old caches and take control immediately */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating v5.0...');
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => {
              console.log('[SW] Deleting old cache:', k);
              return caches.delete(k);
            })
        );
      })
      .then(() => {
        console.log('[SW] Claiming clients');
        return self.clients.claim();
      })
  );
});

/* Fetch — Smart caching strategy */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET and cross-origin API requests
  if (req.method !== 'GET') return;

  // Skip Supabase API calls (should always be fresh)
  if (url.hostname.includes('supabase')) return;

  // HTML: NEVER cache — always fetch fresh
  if (req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(fetch(req));
    return;
  }

  // Cross-origin (e.g., images from placehold.co, fonts): Network-First with cache fallback
  if (url.origin !== location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Same-origin static assets (JS, CSS, icons): Cache-First
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Update in background
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
        }).catch(() => {});
        return cached;
      }
      // Not in cache — fetch and cache
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});

/* Message handler */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});

console.log('[SW] Service Worker v5.0 loaded');
