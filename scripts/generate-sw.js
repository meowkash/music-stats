import fs from 'fs';
import path from 'path';

const version = process.env.CACHE_VERSION || String(Math.floor(Date.now() / 1000));
const safeVersion = version.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
const shellCache = `music-stats-shell-${safeVersion}`;
// Scoped per deploy so a new build can't be blocked by stale JSON the SW kept
// from an older generation (the client verifies content hashes on download).
const dataCache = `music-stats-data-${safeVersion}`;
// Deliberately not version-scoped: artwork is expensive to re-download and is
// invalidated per-URL by the data manifest, never wholesale by a deploy.
const imageCache = 'music-stats-images-v1';

const swContent = `const SHELL_CACHE = '${shellCache}';
const DATA_CACHE = '${dataCache}';
const IMAGE_CACHE = '${imageCache}';
const CACHE_VERSION = '${safeVersion}';

/** Cache wins after this long so a captive or crawling network can't hang the app. */
const DATA_NETWORK_TIMEOUT_MS = 3000;

const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/logo-mark.svg',
  '/og-image.png',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap'
];

const PWA_ICON_PATHS = new Set([
  '/favicon.svg',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/og-image.png',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
]);

const SHELL_FALLBACK_URLS = ['/', '/index.html'];

// cdn-images.dzcdn.net is here because the resolver falls back to Deezer for
// artist images, which iTunes' musicArtist entity almost never returns.
const ARTWORK_HOSTS = ['lastfm.freetls.fastly.net', 'cdn-images.dzcdn.net', 'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com', 'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'];

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

function jsonUnavailable() {
  return new Response('{}', {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Network-first with a deadline. The network write always completes via
 * waitUntil even when the cached copy is what got served, so a slow response
 * still refreshes the store for next launch.
 */
function respondWithDataJson(event, dataPath) {
  const cacheKey = cacheKeyForPath(dataPath);
  // 'fresh' is set only by the manifest read and the hash-verified generation
  // downloads. Keying off 'v' instead matched every request the app makes,
  // which made the deadline below unreachable.
  const mustBeFresh = new URL(event.request.url).searchParams.has('fresh');

  const network = fetch(event.request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(DATA_CACHE);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  });

  event.waitUntil(network.catch(() => {}));

  // The manifest and generation downloads must not lose a race to stale JSON —
  // the client hashes every byte and aborts the whole update on mismatch.
  if (dataPath === '/data/manifest.json' || mustBeFresh) {
    return network.catch(async () => {
      const cache = await caches.open(DATA_CACHE);
      return (await cache.match(cacheKey)) || jsonUnavailable();
    });
  }

  return (async () => {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), DATA_NETWORK_TIMEOUT_MS);
    });

    let winner = null;
    try {
      winner = await Promise.race([network.catch(() => null), deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (winner && winner.ok) return winner;

    const cache = await caches.open(DATA_CACHE);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Nothing cached to fall back on, so waiting out the network beats failing.
    const late = await network.catch(() => null);
    return late || jsonUnavailable();
  })();
}

/**
 * Cache-first, in a cache that deploys never clear. Builds before the
 * data/image split wrote artwork into DATA_CACHE, so a legacy hit is promoted
 * into IMAGE_CACHE rather than re-downloaded.
 */
async function respondWithArtwork(event) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;

  const dataCacheStore = await caches.open(DATA_CACHE);
  const legacy = await dataCacheStore.match(event.request);
  if (legacy) {
    event.waitUntil(cache.put(event.request, legacy.clone()));
    return legacy;
  }

  // Deliberately does NOT write to the cache. src/utils/artworkPrefetch.ts owns
  // IMAGE_CACHE: it refetches with CORS, downscales to the size actually
  // rendered, and stores a non-opaque entry (~3.6 KB instead of a ~20 KB
  // original, or a ~32 MB padded opaque one). Caching here would race that and
  // win, leaving full-size originals in the cache instead.
  return fetch(event.request);
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

/** Network-first for install icons so a deploy can't leave Safari on a stale mark. */
async function respondWithPwaIcon(event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(event.request);
    if (response.ok) {
      await cache.put(event.request, response.clone());
    }
    return response;
  } catch {
    // ignoreSearch because STATIC_ASSETS pre-caches bare paths while the page
    // requests '/apple-touch-icon.png?v=<version>'; an exact match never hit.
    const cached = await cache.match(event.request, { ignoreSearch: true });
    return cached || Response.error();
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async cache => {
      console.log('[SW] Pre-caching static app shell');
      await Promise.allSettled(
        STATIC_ASSETS.map(url =>
          fetch(url, { cache: 'reload' })
            .then(response => {
              if (response.ok) return cache.put(url, response);
            })
            .catch(err => console.warn('[SW] Could not pre-cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key === DATA_CACHE || key === SHELL_CACHE || key === IMAGE_CACHE) return;
          if (
            key.startsWith('music-stats-shell-') ||
            key.startsWith('music-stats-data-') ||
            key.startsWith('aakashmusic-cache-')
          ) {
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
    event.respondWith(respondWithArtwork(event));
    return;
  }

  if (PWA_ICON_PATHS.has(requestUrl.pathname)) {
    event.respondWith(respondWithPwaIcon(event));
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
// safeVersion, not the raw value: in CI the raw string is
// `<run_number>-<full_sha>`, which would put a different value in every asset
// query param than the one naming the caches.
fs.writeFileSync(
  path.join(publicDir, 'cache-version.json'),
  JSON.stringify({ version: safeVersion })
);
console.log(`Generated service worker with cache version: ${safeVersion}`);
