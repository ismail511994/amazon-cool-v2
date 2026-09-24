/* ============================================================
   أمازون كول — Service Worker v3.0
   Network-first strategy for fresh content always
   ============================================================ */
const CACHE_NAME = 'amazoncool-v4';
const STATIC_ASSETS = [
  './manifest.json',
  './icon.svg'
];

/* Install — Cache everything and activate immediately */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => {
        console.log('[SW] Assets cached');
        return self.skipWaiting();
      })
      .catch((err) => console.warn('[SW] Install failed:', err))
  );
});

/* Activate — Clean old caches and take control immediately */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
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

/* Fetch — Network-first for HTML, Cache-first for assets */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  if (url.origin !== location.origin) return;

// HTML: NEVER cache — always fetch fresh
if (req.headers.get('accept')?.includes('text/html')) {
  event.respondWith(fetch(req));
  return;
}

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
        }).catch(() => {});
        return cached;
      }
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

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});

console.log('[SW] Service Worker v3.0 loaded');
