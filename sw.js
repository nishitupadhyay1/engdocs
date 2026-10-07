/* Service Worker – Engineering Document & Note Manager
   Strategy: cache-first. Everything below is pre-cached at install so the app runs fully offline after one visit. */
'use strict';

const CACHE = 'eng-docs-v1';
const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist';
const PRISM = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0';

const KATEX_FONTS = [
  'AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold', 'Fraktur-Regular',
  'Main-Bold', 'Main-BoldItalic', 'Main-Italic', 'Main-Regular', 'Math-BoldItalic', 'Math-Italic',
  'SansSerif-Bold', 'SansSerif-Italic', 'SansSerif-Regular', 'Script-Regular',
  'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'Typewriter-Regular',
].map((f) => `${KATEX}/fonts/KaTeX_${f}.woff2`);

// Same-origin shell (required: install fails if these cannot be fetched)
const CORE = ['./', './index.html', './manifest.json'];

// Third-party libraries (best-effort individually, so one CDN hiccup does not abort install)
const CDN = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  `${KATEX}/katex.min.js`,
  `${KATEX}/katex.min.css`,
  `${PRISM}/prism.min.js`,
  `${PRISM}/themes/prism.min.css`,
  `${PRISM}/components/prism-clike.min.js`,
  `${PRISM}/components/prism-c.min.js`,
  `${PRISM}/components/prism-cpp.min.js`,
  `${PRISM}/components/prism-python.min.js`,
  'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js',
  ...KATEX_FONTS,
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    const results = await Promise.allSettled(CDN.map((u) => cache.add(new Request(u, { mode: 'cors', credentials: 'omit' }))));
    results.forEach((r, i) => { if (r.status === 'rejected') console.warn('[sw] pre-cache failed:', CDN[i], r.reason); });
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !/^https?:/.test(req.url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;                                   // cache-first

    try {
      const res = await fetch(req);                        // network fallback
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {                       // offline navigation → app shell
        const shell = await cache.match('./index.html') || await cache.match('./');
        if (shell) return shell;
      }
      return new Response('Offline and not cached.', { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
