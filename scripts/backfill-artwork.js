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

if (!API_KEY || !USERNAME) {
  console.error('Error: LASTFM_API_KEY and LASTFM_USERNAME environment variables must be set.');
  process.exit(1);
}

const DATA_DIR = path.resolve('src/data');
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork.json');
const CATALOG_PATH = path.resolve('public/data/catalog.json');
const META_PATH = path.resolve('public/data/meta.json');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

function getImage(images) {
  if (!images || !Array.isArray(images)) return null;
  const img = images.find(i => i.size === 'extralarge') || images.find(i => i.size === 'large');
  return img ? img['#text'] : null;
}

async function fetchItunesArtwork(type, { name, artistName }) {
  let entity = 'album';
  let term = `${artistName} ${name}`;

  if (type === 'artist') {
    entity = 'musicArtist';
    term = name;
  } else if (type === 'track') {
    entity = 'song';
    term = `${artistName} ${name}`;
  }

  const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=1`;
  const res = await fetch(itunesUrl);
  if (!res.ok) return null;

  const data = await res.json();
  const artworkUrl100 = data.results?.[0]?.artworkUrl100;
  if (!artworkUrl100) return null;

  return artworkUrl100
    .replace(/\/\d+x\d+bb\.jpg$/, '/1000x1000bb.jpg')
    .replace(/\/\d+x\d+\.jpg$/, '/1000x1000bb.jpg');
}

async function fetchLastfmArtwork(type, { name, artistName, albumName }) {
  let url;
  if (type === 'album') {
    url = `http://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${API_KEY}&artist=${encodeURIComponent(artistName)}&album=${encodeURIComponent(name)}&format=json`;
  } else if (type === 'artist') {
    url = `http://ws.audioscrobbler.com/2.0/?method=artist.getinfo&api_key=${API_KEY}&artist=${encodeURIComponent(name)}&format=json`;
  } else {
    url = `http://ws.audioscrobbler.com/2.0/?method=track.getinfo&api_key=${API_KEY}&artist=${encodeURIComponent(artistName)}&track=${encodeURIComponent(name)}&format=json`;
  }

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();

  if (type === 'album') return getImage(data.album?.image);
  if (type === 'artist') {
    const img = getImage(data.artist?.image);
    if (img && img.includes('2a96cbd8b46e442fc41c2b86b821562f')) return null;
    return img;
  }
  return getImage(data.track?.album?.image) || getImage(data.track?.image);
}

async function fetchEntityArtwork(type, entity) {
  let imgUrl = null;

  try {
    imgUrl = await fetchItunesArtwork(type, entity);
    if (imgUrl) return imgUrl;
  } catch (err) {
    console.warn('   -> iTunes API error:', err.message);
  }

  try {
    imgUrl = await fetchLastfmArtwork(type, entity);
    if (imgUrl && isStaticArtworkUrl(imgUrl)) return imgUrl;
  } catch (err) {
    console.warn('   -> Last.FM API error:', err.message);
  }

  return null;
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

    const imgUrl = await fetchEntityArtwork(type, item);
    if (imgUrl) {
      const validated = await fetchValidatedStaticArtwork(imgUrl);
      if (validated && cacheArtworkUrl(artworkCache, type, item.name, item.artistName || '', validated)) {
        fetchedCount++;
        saveInterval++;
        console.log('   -> Cached artwork');
      } else {
        console.log('   -> Rejected (animated or validation failed)');
      }
    } else {
      console.log('   -> No artwork found (will use placeholder in UI)');
    }

    if (saveInterval >= 10) {
      fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
      saveInterval = 0;
    }

    await delay(150);
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
        fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
        saveInterval = 0;
      }
      continue;
    }

    console.log(`[${i + 1}/${items.length}] canonical artist: "${name}"...`);

    let imgUrl = await fetchEntityArtwork('artist', { name, artistName: '' });
    if (!imgUrl) {
      for (const fallback of fallbacks) {
        if (fallback === name) continue;
        imgUrl = await fetchEntityArtwork('artist', { name: fallback, artistName: '' });
        if (imgUrl) break;
      }
    }

    if (imgUrl) {
      const validated = await fetchValidatedStaticArtwork(imgUrl);
      if (validated && cacheArtworkUrl(artworkCache, 'artist', name, '', validated)) {
        fetchedCount++;
        saveInterval++;
        console.log('   -> Cached artwork');
      } else {
        console.log('   -> Rejected (animated or validation failed)');
      }
    } else {
      console.log('   -> No artwork found (will use placeholder in UI)');
    }

    if (saveInterval >= 10) {
      fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
      saveInterval = 0;
    }

    await delay(150);
  }

  return fetchedCount;
}

async function main() {
  console.log(refresh
    ? `Refreshing all artwork for user: ${USERNAME}`
    : `Starting artwork backfill for user: ${USERNAME}`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let artworkCache = {};
  if (fs.existsSync(ARTWORK_PATH)) {
    artworkCache = JSON.parse(fs.readFileSync(ARTWORK_PATH, 'utf-8'));
  }
  console.log(`Loaded ${Object.keys(artworkCache).length} existing artwork entries.`);

  if (!fs.existsSync(CATALOG_PATH) || !fs.existsSync(META_PATH)) {
    console.error('Error: catalog.json and meta.json required. Run "npm run build" first.');
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));

  const albums = Object.values(catalog.albums || {})
    .sort((a, b) => b.scrobbles - a.scrobbles)
    .map(a => ({ name: a.name, artistName: a.artistName }));

  const artists = Object.values(catalog.artists || {})
    .sort((a, b) => b.scrobbles - a.scrobbles)
    .map(a => ({ name: a.name, artistName: '' }));

  const tracks = Object.entries(catalog.tracks || {})
    .map(([id, count]) => {
      const trackMeta = meta.tracks[parseInt(id, 10)];
      if (!trackMeta) return null;
      const [name, artistId] = trackMeta;
      return {
        name,
        artistName: meta.artists[artistId] || '',
        count,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count)
    .slice(0, 200);

  let total = 0;
  total += await backfillType(artworkCache, 'album', albums, 'albums');
  total += await backfillType(artworkCache, 'artist', artists, 'artists');
  total += await backfillCanonicalArtists(artworkCache, catalog, meta);
  total += await backfillType(artworkCache, 'track', tracks, 'top tracks');

  fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
  console.log(`\nCompleted! Fetched ${total} new entries. Total cache size: ${Object.keys(artworkCache).length}`);
}

main().catch(err => {
  console.error('Critical error in backfill script:', err);
  process.exit(1);
});
