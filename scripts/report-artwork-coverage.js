import fs from 'fs';
import path from 'path';
import {
  artworkCacheKey,
  resolveArtistArtworkFromCache,
  resolveLegacyArtworkKey,
} from './artwork-keys.js';

/**
 * What's actually missing artwork, ranked by how much you listen to it.
 *
 * "Which covers are broken" used to mean scrolling the backfill log. This makes
 * it a command, and sorting by scrobbles keeps attention on the entries you'd
 * actually notice.
 */

const ARTWORK_PATH = path.resolve('src/data/artwork.json');
const CATALOG_PATH = path.resolve('public/data/catalog.json');
const UNRESOLVED_PATH = path.resolve('src/data/artwork-unresolved.json');

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 25;
const VERIFY = process.argv.includes('--verify');
const VERIFY_CONCURRENCY = 12;

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

const cache = loadJson(ARTWORK_PATH, {});
const catalog = loadJson(CATALOG_PATH, null);

if (!catalog) {
  console.error('catalog.json not found — run "npm run build" first.');
  process.exit(1);
}

function hasArtwork(type, name, artistName = '') {
  return Boolean(
    cache[artworkCacheKey(type, name, artistName)] ??
      cache[resolveLegacyArtworkKey(type, name, artistName)],
  );
}

function report(label, items, resolveFn) {
  const missing = items.filter((item) => !resolveFn(item));
  const covered = items.length - missing.length;
  const pct = items.length ? ((covered / items.length) * 100).toFixed(1) : '100.0';

  console.log(`\n${label}: ${covered}/${items.length} covered (${pct}%)`);

  if (!missing.length) return missing;

  missing
    .sort((a, b) => b.scrobbles - a.scrobbles)
    .slice(0, LIMIT)
    .forEach((item) => {
      const suffix = item.artistName ? ` — ${item.artistName}` : '';
      console.log(`  ${String(item.scrobbles).padStart(6)}  ${item.name}${suffix}`);
    });

  if (missing.length > LIMIT) {
    console.log(`  … and ${missing.length - LIMIT} more (--limit=N to show more)`);
  }

  return missing;
}

const albums = Object.values(catalog.albums ?? {}).map((a) => ({
  name: a.name,
  artistName: a.artistName,
  scrobbles: a.scrobbles,
}));

const artists = Object.values(catalog.artists ?? {}).map((a) => ({
  name: a.name,
  artistName: '',
  scrobbles: a.scrobbles,
}));

const canonical = Object.values(catalog.canonicalArtists ?? {}).map((a) => ({
  name: a.name,
  artistName: '',
  scrobbles: a.scrobbles,
}));

console.log('Artwork coverage');
console.log('================');

const missingAlbums = report('Albums', albums, (item) =>
  hasArtwork('album', item.name, item.artistName),
);
const missingArtists = report('Artists', artists, (item) =>
  resolveArtistArtworkFromCache(item.name, cache),
);
const missingCanonical = report('Canonical artists', canonical, (item) =>
  resolveArtistArtworkFromCache(item.name, cache),
);

const unresolved = loadJson(UNRESOLVED_PATH, []);
if (unresolved.length) {
  console.log(`\nLast backfill left ${unresolved.length} entities unmatched.`);
  console.log('Force any of them via src/data/artwork-overrides.json.');
}

const totalMissing = missingAlbums.length + missingArtists.length + missingCanonical.length;
console.log(`\nTotal entities without artwork: ${totalMissing}`);

/**
 * A cached URL isn't the same as a working one — CDN images do disappear, and
 * the entity still counts as "covered" while pointing at a 404.
 */
async function verifyUrls() {
  const urls = [
    ...new Set(Object.values(cache).filter((u) => typeof u === 'string' && u.startsWith('http'))),
  ];
  console.log(`\nVerifying ${urls.length} unique artwork URLs…`);

  const dead = [];
  for (let i = 0; i < urls.length; i += VERIFY_CONCURRENCY) {
    await Promise.all(
      urls.slice(i, i + VERIFY_CONCURRENCY).map(async (url) => {
        try {
          const res = await fetch(url, { method: 'HEAD' });
          if (!res.ok) dead.push({ url, status: res.status });
        } catch {
          dead.push({ url, status: 'error' });
        }
      }),
    );
  }

  if (!dead.length) {
    console.log('All artwork URLs resolve.');
    return;
  }

  const keysFor = (url) => Object.keys(cache).filter((k) => cache[k] === url);
  console.log(`\n${dead.length} dead artwork URL(s):`);
  for (const { url, status } of dead) {
    console.log(`  [${status}] ${url}`);
    for (const key of keysFor(url)) console.log(`          ${key}`);
  }
  console.log('\nRe-run "node scripts/backfill-artwork.js --refresh" to re-resolve these,');
  console.log('or pin a replacement in src/data/artwork-overrides.json.');
}

if (VERIFY) await verifyUrls();
else console.log('\nPass --verify to also check that every cached URL still resolves.');
