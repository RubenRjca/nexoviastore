'use strict';
// Service worker de Nexovia Store. Objetivo: que la app abra rápido y muestre una página amable sin conexión.
// REGLAS: NUNCA toca /api/* (pedidos, stock, rastreo, reseñas siempre van directo a la red), ni peticiones que no sean GET,
// ni otros dominios, ni /data/ /lib/ /scripts/ /docs/. Para cambiar lo que se guarda, sube VERSION.
const VERSION = 'nx-v15';
const SHELL = `${VERSION}-shell`, ASSETS = `${VERSION}-assets`;
const PRECACHE = ['/offline.html', '/assets/isotipo.png', '/assets/icons/icon-192.png', '/manifest.webmanifest'];
const NUNCA = /^\/(api|data|lib|scripts|docs|tests|supabase|propuestas|_vercel)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || NUNCA.test(url.pathname)) return; // el navegador lo resuelve solo

  if (req.mode === 'navigate') { // páginas: red primero; si no hay conexión, la última versión guardada o la página sin conexión
    e.respondWith(fetch(req).then((r) => { if (url.pathname === '/' && !url.search && r.ok) { const copia = r.clone(); caches.open(SHELL).then((c) => c.put('/', copia)); } return r; }) // solo la portada general (/) se guarda como respaldo sin conexión
      .catch(() => caches.match('/').then((c) => c || caches.match('/offline.html'))));
    return;
  }
  if (url.pathname.startsWith('/assets/')) { // imágenes e iconos: guardados primero, se refrescan en segundo plano
    e.respondWith(caches.open(ASSETS).then((c) => c.match(req).then((hit) => {
      const red = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || red;
    })));
  }
});
