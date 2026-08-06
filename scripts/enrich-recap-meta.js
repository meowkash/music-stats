/**
 * Fetches track durations and artist tags from Last.fm, cached incrementally.
 * Output: public/data/recap-meta.json
 */
import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split(/\r?\n/).forEach((line) => {
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

if (!API_KEY || !USERNAME) {
  console.log('Skipping recap meta enrichment (LASTFM_API_KEY / LASTFM_USERNAME not set).');
  process.exit(0);
}

const META_PATH = path.resolve('public/data/meta.json');
const CACHE_PATH = path.resolve('src/data/recap-meta-cache.json');
const OUTPUT_PATH = path.resolve('public/data/recap-meta.json');

const TRACK_BATCH = 250;
const ARTIST_BATCH = 80;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lastfmGet(params) {
  const qs = new URLSearchParams({ ...params, api_key: API_KEY, format: 'json' });
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.message || `Last.fm error ${data.error}`);
  return data;
}

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) {
    return { tracks: {}, artists: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return { tracks: {}, artists: {} };
  }
}

function trackKey(name, artist) {
  return `${name}\0${artist}`;
}

async function main() {
  if (!fs.existsSync(META_PATH)) {
    console.warn('meta.json not found — skipping recap enrichment.');
    process.exit(0);
  }

  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  const { artists, tracks } = meta;
  const cache = loadCache();

  // Rank tracks by play count using catalog if available
  const catalogPath = path.resolve('public/data/catalog.json');
  const trackCounts = {};
  const artistCounts = {};

  if (fs.existsSync(catalogPath)) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    for (const [id, count] of Object.entries(catalog.tracks || {})) {
      trackCounts[id] = count;
    }
    for (const [id, data] of Object.entries(catalog.artists || {})) {
      artistCounts[id] = data.scrobbles ?? data.count ?? 0;
    }
  }

  const rankedTrackIds = Object.keys(trackCounts)
    .map(Number)
    .filter((id) => tracks[id])
    .sort((a, b) => (trackCounts[b] || 0) - (trackCounts[a] || 0));

  const rankedArtistIds = Object.keys(artistCounts)
    .map(Number)
    .filter((id) => artists[id])
    .sort((a, b) => (artistCounts[b] || 0) - (artistCounts[a] || 0));

  let fetchedTracks = 0;
  for (const trackId of rankedTrackIds) {
    if (fetchedTracks >= TRACK_BATCH) break;
    const key = String(trackId);
    if (cache.tracks[key]?.fetched) continue;

    const [name, artistId] = tracks[trackId];
    const artistName = artists[artistId];
    if (!name || !artistName) continue;

    try {
      const data = await lastfmGet({
        method: 'track.getInfo',
        artist: artistName,
        track: name,
        username: USERNAME,
      });
      const duration = parseInt(data.track?.duration, 10) || 0;
      const tags = (data.track?.toptags?.tag || [])
        .slice(0, 5)
        .map((t) => t.name?.toLowerCase())
        .filter(Boolean);

      cache.tracks[key] = {
        duration: duration > 0 ? duration : null,
        tags,
        fetched: true,
        name,
        artist: artistName,
      };
      fetchedTracks++;
      await delay(260);
    } catch (err) {
      cache.tracks[key] = { duration: null, tags: [], fetched: true, name, artist: artistName };
      console.warn(`track.getInfo failed for "${name}" — ${err.message}`);
      fetchedTracks++;
      await delay(260);
    }
  }

  let fetchedArtists = 0;
  for (const artistId of rankedArtistIds) {
    if (fetchedArtists >= ARTIST_BATCH) break;
    const artistName = artists[artistId];
    if (!artistName || cache.artists[artistName]?.fetched) continue;

    try {
      const data = await lastfmGet({
        method: 'artist.getTopTags',
        artist: artistName,
      });
      const tags = (data.toptags?.tag || [])
        .slice(0, 8)
        .map((t) => t.name?.toLowerCase())
        .filter(Boolean);

      cache.artists[artistName] = { tags, fetched: true };
      fetchedArtists++;
      await delay(260);
    } catch (err) {
      cache.artists[artistName] = { tags: [], fetched: true };
      console.warn(`artist.getTopTags failed for "${artistName}" — ${err.message}`);
      fetchedArtists++;
      await delay(260);
    }
  }

  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf-8');

  const output = {
    tracks: Object.fromEntries(
      Object.entries(cache.tracks).map(([id, t]) => [id, { duration: t.duration, tags: t.tags }]),
    ),
    artists: Object.fromEntries(
      Object.entries(cache.artists).map(([name, a]) => [name, { tags: a.tags }]),
    ),
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output), 'utf-8');

  console.log(
    `Recap meta: ${Object.keys(output.tracks).length} tracks, ${Object.keys(output.artists).length} artists (+${fetchedTracks} tracks, +${fetchedArtists} artists this run)`,
  );
}

main().catch((err) => {
  console.error('Recap meta enrichment failed:', err);
  process.exit(1);
});
