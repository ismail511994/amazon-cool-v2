
/* Amazon Cool V27 service worker — same-origin shell/assets only. */
'use strict';
const CACHE_NAME = 'amazon-cool-shell-v27-0';
const SCOPE_URL = self.registration.scope;
const SHELL = ['.', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon-180.png', 'favicon.ico', 'offline.html'].map(path => new URL(path, SCOPE_URL).href);

async function safeCachePut(cache, request, response) {
  if (!response || !response.ok || response.type === 'opaque') return;
  try { await cache.put(request, response.clone()); }
  catch (error) {
    if (error && (error.name === 'QuotaExceededError' || /quota/i.test(String(error)))) {
      const keys = await caches.keys();
      for (const key of keys) { if (key !== CACHE_NAME && key.startsWith('amazon-cool-')) await caches.delete(key); }
      try { await cache.put(request, response.clone()); } catch (_) {}
    }
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL.map(async url => { try { const response = await fetch(url, {cache: 'reload'}); if (response.ok) await safeCachePut(cache, url, response); } catch (_) {} }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch (_) {} }
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('amazon-cool-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Deliberately never cache Supabase/API cross-origin traffic.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const preloaded = await event.preloadResponse;
        const response = preloaded || await fetch(request);
        if (response && response.ok) await safeCachePut(cache, request, response);
        return response;
      } catch (_) {
        return (await caches.match(request)) || (await caches.match(new URL('offline.html', SCOPE_URL).href)) || (await caches.match(new URL('.', SCOPE_URL).href));
      }
    })());
    return;
  }
  const isStatic = ['style','script','font','image'].includes(request.destination) || /\.(?:webmanifest|svg|png|ico|css|js|woff2?)$/i.test(url.pathname);
  if (!isStatic) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(async response => {
      if (response && response.ok) { const cache = await caches.open(CACHE_NAME); await safeCachePut(cache, request, response); }
      return response;
    });
    if (cached) { event.waitUntil(network.catch(() => undefined)); return cached; }
    try { return await network; } catch (_) { return cached || new Response('الملف غير متاح دون اتصال', {status: 503, headers: {'Content-Type':'text/plain; charset=utf-8'}}); }
  })());
});

self.addEventListener('push', event => {
  let data = {title:'أمازون كول', body:'لديك إشعار جديد', url:'.'};
  try { if (event.data) data = {...data, ...event.data.json()}; } catch (_) { try { if (event.data) data.body = event.data.text(); } catch (_) {} }
  event.waitUntil(self.registration.showNotification(data.title || 'أمازون كول', {body:data.body || '', icon:new URL('icon-192.png', SCOPE_URL).href, badge:new URL('icon-192.png', SCOPE_URL).href, data:{url:data.url || '.'}}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || '.', SCOPE_URL).href;
  event.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(clients => {
    for (const client of clients) { if (new URL(client.url).origin === self.location.origin) { client.navigate(target); return client.focus(); } }
    return self.clients.openWindow(target);
  }));
});
