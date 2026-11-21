'use strict';

// Solo se almacenan recursos estáticos locales. Nunca interceptar /api/*.
const CACHE_NAME = 'nexovia-static-v1';
const STATIC_SHELL = ['/manifest.webmanifest', '/assets/isotipo.png'];
const STATIC_EXTENSIONS = /\.(?:avif|css|gif|ico|jpe?g|js|mjs|png|svg|webmanifest|webp|woff2?)$/i;

function isApi(url) {
  return url.origin === self.location.origin && /^\/api(?:\/|$)/i.test(url.pathname);
}

function isCacheableStatic(request, url) {
  return request.method === 'GET' &&
    url.origin === self.location.origin &&
    !isApi(url) &&
    STATIC_EXTENSIONS.test(url.pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => cache.addAll(STATIC_SHELL))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((key) => key.startsWith('nexovia-static-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Sin caché ni redirección de ningún tipo para las APIs.
  if (isApi(url) || !isCacheableStatic(request, url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
