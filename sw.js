/**
 * sw.js — Service Worker for RouteMaker GPS
 *
 * Strategy:
 *  - Static assets (HTML, CSS, JS, manifest): Cache-first
 *  - route.json: Network-first (always try fresh, fallback to cache)
 *  - Audio files: Cache-first (large files, rarely change)
 *
 * Versioning: bump CACHE_VERSION to force re-cache on deploy.
 */

const CACHE_VERSION = 'routemaker-v40';

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './src/main.js',
  './src/state.js',
  './src/logger.js',
  './src/db.js',
  './src/route.js',
  './src/audio.js',
  './src/gps.js',
  './src/cast.js',
  './src/editor.js',
  
  './src/map.js',

  // Brand & Audio assets
  './assets/logos/ilertren-logo.png',
  './assets/ambientetren.mp3',

  // Tourist App Core Assets
  './acceso-turista/',
  './acceso-turista/index.html',
  './acceso-turista/style.css',
  './acceso-turista/manifest.json',
  './acceso-turista/tourist.js',
  './acceso-turista/route.json'
];

// ─── Install ─────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // ── Pass Google Maps API through to network (tiles cannot be cached) ──
  const isMapsRequest = url.hostname.includes('googleapis.com')
                     || url.hostname.includes('gstatic.com');
  if (isMapsRequest) {
    // Let the browser handle it — no SW interception
    return;
  }

  // Network-first for route.json (always try to get fresh data)
  if (url.pathname.endsWith('route.json')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first for audio files
  if (url.pathname.includes('/audios/')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Cache-first for all other static assets
  event.respondWith(cacheFirst(event.request));
});

// ─── Strategies ──────────────────────────────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline and not cached — return a basic offline response
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed — try cache
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}
