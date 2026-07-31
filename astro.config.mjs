// @ts-check
import { defineConfig } from 'astro/config';
import fs from 'fs';

// scripts/generate-sw.js writes this file before `astro build` runs (see package.json),
// so reading it here keeps the service worker cache name and the client's
// cache-busting query param (?v=...) in sync even when CACHE_VERSION isn't set.
function resolveCacheVersion() {
  if (process.env.CACHE_VERSION) return process.env.CACHE_VERSION;
  try {
    const written = JSON.parse(fs.readFileSync('public/cache-version.json', 'utf-8'));
    if (written.version) return written.version;
  } catch {
    // generate-sw.js hasn't run yet (e.g. `astro dev`) — fall back to a dev-only value
  }
  return `dev-${Date.now()}`;
}

const cacheVersion = resolveCacheVersion();

// https://astro.build/config
export default defineConfig({
  // Used to build absolute URLs (og:url, og:image, etc.) for social share
  // previews - without this Astro falls back to a localhost URL.
  site: 'https://music.aakashkap.com',
  vite: {
    define: {
      __CACHE_VERSION__: JSON.stringify(cacheVersion),
    },
  },
});
