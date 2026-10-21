const CACHE_NAME = 'ts-git-zenfs-v1';
const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/registerSW.js',
];

// Install event - cache basic assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CACHE_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch event - network first strategy for dev, cache for assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip vite dev server files
  if (url.pathname.includes('/@') || url.pathname.includes('/src/')) {
    return;
  }

  // Cache-first for static assets, network-first for HTML
  if (
    request.destination === 'image' ||
    request.destination === 'font' ||
    url.pathname.match(/\.(js|css|png|jpg|svg|ico)$/)
  ) {
    // Cache first for static assets
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(request).then((response) => {
          // Don't cache non-success responses
          if (!response || response.status !== 200) {
            return response;
          }
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
          return response;
        });
      })
    );
  } else {
    // Network first for everything else
    event.respondWith(
      fetch(request).catch(() => {
        return caches.match(request);
      })
    );
  }
});
