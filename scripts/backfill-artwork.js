import fs from 'fs';
import path from 'path';
import {
  isStaticArtworkUrl,
  normalizeStaticArtworkUrl,
  fetchValidatedStaticArtwork,
} from './artwork-utils.js';
import {
  artworkCacheKey,
  rawArtistNamesForCanonical,
  resolveArtistArtworkFromCache,
  resolveArtistArtworkFromCandidates,
  resolveLegacyArtworkKey,
  storeArtworkInCache,
} from './artwork-keys.js';
import { resolveArtwork } from './resolve-artwork/index.js';

const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const firstEquals = trimmed.indexOf('=');
    if (firstEquals === -1) return;
    const key = trimmed.slice(0, firstEquals).trim();
    let val = trimmed.slice(firstEquals + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  });
}

const API_KEY = process.env.LASTFM_API_KEY;
const USERNAME = process.env.LASTFM_USERNAME;
const refresh = process.argv.includes('--refresh');

const trackLimitArg = process.argv.find((arg) => arg.startsWith('--tracks='));
const TRACK_LIMIT = trackLimitArg ? Number(trackLimitArg.split('=')[1]) : Infinity;
const pruneDead = process.argv.includes('--prune-dead');
const PRUNE_CONCURRENCY = 12;

if (!API_KEY || !USERNAME) {
  console.error('Error: LASTFM_API_KEY and LASTFM_USERNAME environment variables must be set.');
  process.exit(1);
}

const DATA_DIR = path.resolve('src/data');
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork.json');
const OVERRIDES_PATH = path.join(DATA_DIR, 'artwork-overrides.json');
const UNRESOLVED_PATH = path.join(DATA_DIR, 'artwork-unresolved.json');
const CATALOG_PATH = path.resolve('public/data/catalog.json');
const META_PATH = path.resolve('public/data/meta.json');

/** One cache for the whole run, so every episode of a series costs one lookup. */
const seriesCache = new Map();
const unresolved = [];

function cacheArtworkUrl(artworkCache, type, name, artistName, rawUrl) {
  const normalized = normalizeStaticArtworkUrl(rawUrl);
  if (!normalized || !isStaticArtworkUrl(normalized)) return false;
  storeArtworkInCache(artworkCache, type, name, artistName, normalized);
  return true;
}

function hasCached(artworkCache, type, name, artistName = '') {
  const key = artworkCacheKey(type, name, artistName);
  if (artworkCache[key]) return true;
  if (!refresh && artworkCache[resolveLegacyArtworkKey(type, name, artistName)]) return true;
  return false;
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

/**
 * Manual overrides win over every source, always — the escape hatch for the
 * handful of releases no catalog indexes correctly.
 * Keyed exactly like the artwork cache: "album:Name|Artist", "artist:Name".
 */
function applyOverrides(artworkCache) {
  const overrides = loadJson(OVERRIDES_PATH, {});
  let applied = 0;

  for (const [key, url] of Object.entries(overrides)) {
    if (typeof url !== 'string' || !url.startsWith('http')) continue;
    const match = /^(album|artist|track):(.*)$/.exec(key);
    if (!match) continue;

    const [, type, body] = match;
    const split = body.lastIndexOf('|');
    const name = split === -1 ? body : body.slice(0, split);
    const artistName = split === -1 ? '' : body.slice(split + 1);

    if (cacheArtworkUrl(artworkCache, type, name, artistName, url)) applied++;
  }

  if (applied) console.log(`Applied ${applied} manual artwork override(s).`);
  return applied;
}

/**
 * Drop cache entries whose URL no longer resolves.
 *
 * CDN images do disappear — a cached URL is not proof of a working image, and a
 * dead entry otherwise looks "covered" forever because hasCached() only checks
 * that a key exists. Pruning turns them back into ordinary gaps that the normal
 * backfill pass below re-resolves.
 */
async function pruneDeadUrls(artworkCache) {
  const urls = [...new Set(Object.values(artworkCache).filter((u) => typeof u === 'string' && u.startsWith('http')))];
  console.log(`\n=== Checking ${urls.length} cached artwork URLs ===`);

  const dead = new Set();
  for (let i = 0; i < urls.length; i += PRUNE_CONCURRENCY) {
    await Promise.all(
      urls.slice(i, i + PRUNE_CONCURRENCY).map(async (url) => {
        try {
          const res = await fetch(url, { method: 'HEAD' });
          if (!res.ok) dead.add(url);
        } catch {
          dead.add(url);
        }
      }),
    );
  }

  if (!dead.size) {
    console.log('All cached artwork URLs resolve.');
    return 0;
  }

  let removed = 0;
  for (const [key, url] of Object.entries(artworkCache)) {
    if (dead.has(url)) {
      delete artworkCache[key];
      removed++;
    }
  }

  console.log(`Pruned ${removed} cache entries across ${dead.size} dead URL(s).`);
  return removed;
}

/** Resolve one entity through the scored ladder, then validate the bytes. */
async function fetchEntityArtwork(type, entity) {
  const attempts = [];

  const result = await resolveArtwork(
    { type, name: entity.name, artistName: entity.artistName || '' },
    { lastfmKey: API_KEY, seriesCache, onAttempt: (a) => attempts.push(a) },
  );

  if (!result) {
    unresolved.push({
      type,
      name: entity.name,
      artistName: entity.artistName || '',
      attempts: attempts.map((a) => `${a.label}:${a.candidates ?? 0}`),
    });
    return null;
  }

  return result;
}

async function cacheResolved(artworkCache, type, item, resolved) {
  const validated = await fetchValidatedStaticArtwork(resolved.url);
  if (validated && cacheArtworkUrl(artworkCache, type, item.name, item.artistName || '', validated)) {
    console.log(`   -> Cached via ${resolved.via} (${resolved.source}, ${resolved.score.toFixed(2)})`);
    return true;
  }
  console.log('   -> Rejected (animated or validation failed)');
  return false;
}

function save(artworkCache) {
  fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
}

async function backfillType(artworkCache, type, items, label) {
  let fetchedCount = 0;
  let saveInterval = 0;

  console.log(`\n=== Backfilling ${label} (${items.length} items) ===`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!refresh && hasCached(artworkCache, type, item.name, item.artistName || '')) {
      continue;
    }

    console.log(`[${i + 1}/${items.length}] ${type}: "${item.name}"${item.artistName ? ` by "${item.artistName}"` : ''}...`);

    const resolved = await fetchEntityArtwork(type, item);
    if (resolved) {
      if (await cacheResolved(artworkCache, type, item, resolved)) {
        fetchedCount++;
        saveInterval++;
      }
    } else {
      console.log('   -> No confident match (will use placeholder in UI)');
    }

    if (saveInterval >= 10) {
      save(artworkCache);
      saveInterval = 0;
    }
  }

  return fetchedCount;
}

async function backfillCanonicalArtists(artworkCache, catalog, meta) {
  const items = Object.entries(catalog.canonicalArtists || {})
    .sort(([, a], [, b]) => b.scrobbles - a.scrobbles)
    .map(([id, artist]) => ({ canonicalId: parseInt(id, 10), name: artist.name }));

  let fetchedCount = 0;
  let saveInterval = 0;

  console.log(`\n=== Backfilling canonical artists (${items.length} items) ===`);

  for (let i = 0; i < items.length; i++) {
    const { canonicalId, name } = items[i];
    const fallbacks = rawArtistNamesForCanonical(canonicalId, meta);

    if (!refresh && resolveArtistArtworkFromCache(name, artworkCache)) {
      continue;
    }

    const cached = resolveArtistArtworkFromCandidates(fallbacks, artworkCache);
    if (cached && !resolveArtistArtworkFromCache(name, artworkCache)) {
      storeArtworkInCache(artworkCache, 'artist', name, '', cached);
      fetchedCount++;
      saveInterval++;
      console.log(`[${i + 1}/${items.length}] canonical: "${name}" -> promoted from cache`);
      if (saveInterval >= 10) {
        save(artworkCache);
        saveInterval = 0;
      }
      continue;
    }

    console.log(`[${i + 1}/${items.length}] canonical artist: "${name}"...`);

    let resolved = await fetchEntityArtwork('artist', { name, artistName: '' });
    if (!resolved) {
      for (const fallback of fallbacks) {
        if (fallback === name) continue;
        resolved = await fetchEntityArtwork('artist', { name: fallback, artistName: '' });
        if (resolved) break;
      }
    }

    if (resolved) {
      if (await cacheResolved(artworkCache, 'artist', { name, artistName: '' }, resolved)) {
        fetchedCount++;
        saveInterval++;
      }
    } else {
      console.log('   -> No confident match (will use placeholder in UI)');
    }

    if (saveInterval >= 10) {
      save(artworkCache);
      saveInterval = 0;
    }
  }

  return fetchedCount;
}

async function main() {
  console.log(refresh
    ? `Refreshing all artwork for user: ${USERNAME}`
    : `Starting artwork backfill for user: ${USERNAME}`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const artworkCache = loadJson(ARTWORK_PATH, {});
  console.log(`Loaded ${Object.keys(artworkCache).length} existing artwork entries.`);

  if (!fs.existsSync(CATALOG_PATH) || !fs.existsSync(META_PATH)) {
    console.error('Error: catalog.json and meta.json required. Run "npm run build" first.');
    process.exit(1);
  }

  if (pruneDead) await pruneDeadUrls(artworkCache);
  applyOverrides(artworkCache);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));

  const albums = Object.values(catalog.albums || {})
    .sort((a, b) => b.scrobbles - a.scrobbles)
    .map(a => ({ name: a.name, artistName: a.artistName }));

  const artists = Object.values(catalog.artists || {})
    .sort((a, b) => b.scrobbles - a.scrobbles)
    .map(a => ({ name: a.name, artistName: '' }));

  let total = 0;
  total += await backfillType(artworkCache, 'album', albums, 'albums');
  total += await backfillType(artworkCache, 'artist', artists, 'artists');
  total += await backfillCanonicalArtists(artworkCache, catalog, meta);

  // Tracks come last and skip anything the UI would already cover via album or
  // artist fallback — that's what keeps a full run bounded now the old
  // top-200 cap is gone.
  const tracks = Object.entries(catalog.tracks || {})
    .map(([id, count]) => {
      const trackMeta = meta.tracks[parseInt(id, 10)];
      if (!trackMeta) return null;
      const [name, artistId] = trackMeta;
      const artistName = meta.artists[artistId] || '';
      return { name, artistName, count };
    })
    .filter(Boolean)
    .filter((track) => !resolveArtistArtworkFromCache(track.artistName, artworkCache))
    .sort((a, b) => b.count - a.count)
    .slice(0, TRACK_LIMIT);

  total += await backfillType(artworkCache, 'track', tracks, 'tracks without artist artwork');

  save(artworkCache);

  if (unresolved.length) {
    fs.writeFileSync(UNRESOLVED_PATH, JSON.stringify(unresolved, null, 2), 'utf-8');
    console.log(`\n${unresolved.length} entities had no confident match — see ${path.relative(process.cwd(), UNRESOLVED_PATH)}`);
    console.log('Add a manual URL to src/data/artwork-overrides.json to force any of them.');
  }

  console.log(`\nCompleted! Fetched ${total} new entries. Total cache size: ${Object.keys(artworkCache).length}`);
}

main().catch(err => {
  console.error('Critical error in backfill script:', err);
  process.exit(1);
});
