import fs from 'fs';
import path from 'path';

const version = process.env.CACHE_VERSION || String(Math.floor(Date.now() / 1000));
const shellCache = `music-stats-shell-${version}`;
const dataCache = 'music-stats-data-v1';

const swContent = `const SHELL_CACHE = '${shellCache}';
const DATA_CACHE = '${dataCache}';
const CACHE_VERSION = '${version}';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/logo-mark.svg',
  '/og-image.png',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap'
];

const SHELL_FALLBACK_URLS = ['/', '/index.html'];

const ARTWORK_HOSTS = ['lastfm.freetls.fastly.net', 'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com', 'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'];

function isArtworkRequest(url) {
  return ARTWORK_HOSTS.some(host => url.host.includes(host));
}

function dataPathname(url) {
  if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    return url.pathname;
  }
  return null;
}

function cacheKeyForPath(pathname) {
  return new Request(pathname, { mode: 'same-origin' });
}

async function respondWithDataJson(event, dataPath) {
  const cacheKey = cacheKeyForPath(dataPath);

  try {
    const response = await fetch(event.request);
    if (response.ok) {
      const clone = response.clone();
      event.waitUntil(
        caches.open(DATA_CACHE).then((cache) => cache.put(cacheKey, clone))
      );
    }
    return response;
  } catch {
    const cache = await caches.open(DATA_CACHE);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    return new Response('{}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function matchShellCache(cache, request) {
  const direct = await cache.match(request);
  if (direct) return direct;
  for (const url of SHELL_FALLBACK_URLS) {
    const hit = await cache.match(url);
    if (hit) return hit;
  }
  return undefined;
}

async function respondWithShell(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await matchShellCache(cache, event.request);

  const revalidate = fetch(event.request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(event.request, response.clone());
        if (event.request.url.endsWith('/')) {
          await cache.put('/index.html', response.clone());
        }
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(revalidate);
    return cached;
  }

  const network = await revalidate;
  if (network) return network;

  const fallback = await matchShellCache(cache, event.request);
  if (fallback) return fallback;

  return Response.error();
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      console.log('[SW] Pre-caching static app shell');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key === DATA_CACHE || key === SHELL_CACHE) return;
          if (key.startsWith('music-stats-shell-') || key.startsWith('aakashmusic-cache-')) {
            console.log('[SW] Clearing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  const dataPath = dataPathname(requestUrl);

  if (dataPath) {
    event.respondWith(respondWithDataJson(event, dataPath));
    return;
  }

  if (event.request.mode === 'navigate' || requestUrl.pathname === '/') {
    event.respondWith(respondWithShell(event));
    return;
  }

  if (isArtworkRequest(requestUrl)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.status === 200 || response.status === 0) {
            const clone = response.clone();
            caches.open(DATA_CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then(response => {
        if (
          event.request.method === 'GET' &&
          (response.status === 200 || response.status === 0) &&
          (requestUrl.pathname.includes('/_astro/') || requestUrl.host.includes('fonts.gstatic.com'))
        ) {
          const responseClone = response.clone();
          caches.open(SHELL_CACHE).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      });
    })
  );
});
`;

const publicDir = path.resolve('public');
fs.writeFileSync(path.join(publicDir, 'sw.js'), swContent);
fs.writeFileSync(
  path.join(publicDir, 'cache-version.json'),
  JSON.stringify({ version })
);
console.log(`Generated service worker with cache version: ${version}`);
