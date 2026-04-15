const CACHE_NAME = 'floo-v18';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json'
];

/**
 * Install event — precache the app shell and activate immediately.
 * skipWaiting() ensures the new SW takes over as soon as it installs.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

/**
 * Activate event — clean up old caches and claim all open clients
 * immediately so the updated app shell serves without a reload.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/**
 * Fetch event — route requests by type:
 *
 * 1. version.json: always network-only — never cached, so the version
 *    check in app.js always reflects the live deployed version.
 * 2. Supabase API calls: network-first, so the reading list stays
 *    fresh when online but still works from cache when offline.
 * 3. Navigation & app shell assets: cache-first, falling back to
 *    network. This keeps the shell instant on repeat visits.
 * 4. Everything else: network with no caching (avoids bloating the
 *    cache with opaque cross-origin responses).
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // version.json — always fetch from network, never cache
  if (url.pathname.endsWith('/version.json')) {
    event.respondWith(fetch(request));
    return;
  }

  // Supabase API — network-first
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Same-origin requests — cache-first (app shell + future assets)
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Cross-origin (CDN, external) — just fetch, don't cache opaque responses
  event.respondWith(fetch(request));
});

/**
 * Cache-first strategy: serve from cache, fall back to network.
 * If the network fetch succeeds, update the cache for next time.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline and not in cache — return a basic offline response
    // for navigation requests so the user sees something, not nothing.
    if (request.mode === 'navigate') {
      return caches.match('./index.html');
    }
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * Network-first strategy: try the network, cache the response,
 * fall back to cache if the network fails.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    return new Response(
      JSON.stringify({ error: 'Offline' }),
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}
