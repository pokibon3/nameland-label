// Service worker: lets the installed app start without the local server.
// App files are network-first (edits show up immediately while the server
// runs) and fall back to the cache when it is not running.

const CACHE = 'nameland-v30';
const SHELL = [
  './',
  './index.html',
  './app.js?v=1.1.25',
  './printer.js?v=1.1.25',
  './raster.js',
  './fonts.js',
  './barcode.js',
  './library.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];
const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // cache.add() rejects opaque responses, so fetch and put explicitly
    await fetch(QR_LIB, { mode: 'no-cors' }).then((res) => cache.put(QR_LIB, res)).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.href === QR_LIB) {
    // pinned version: cache-first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }

  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./index.html');
      throw new Error('offline');
    }
  })());
});
