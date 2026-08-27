/**
 * Fetches track durations and artist/track genre tags from Last.fm.
 *
 * Writes src/data/recap-meta-cache.json — a build-time artifact only. Nothing
 * here is shipped to the client: scripts/generate-recaps.js folds it into the
 * small per-year recap payloads, so the ~1 MB of raw tag data never crosses the
 * network.
 *
 * Entries are keyed by name (and artist), never by meta.json's numeric ids —
 * those are array positions that shift whenever the CSV is reprocessed.
 *
 * Resumable: re-running only fetches what the cache is missing, and progress is
 * checkpointed so an interrupted run keeps everything it already pulled.
 */
import fs from 'fs';
import path from 'path';
import { createLastfmClient, loadEnv, LastfmNotFound } from './lastfm-client.js';

loadEnv();

const API_KEY = process.env.LASTFM_API_KEY;
const USERNAME = process.env.LASTFM_USERNAME;

if (!API_KEY || !USERNAME) {
  console.log('Skipping recap meta enrichment (LASTFM_API_KEY / LASTFM_USERNAME not set).');
  process.exit(0);
}

const META_PATH = path.resolve('public/data/meta.json');
const CATALOG_PATH = path.resolve('public/data/catalog.json');
const CACHE_PATH = path.resolve('src/data/recap-meta-cache.json');

const CHECKPOINT_EVERY = 150;
const CACHE_FORMAT = 2;

/**
 * Per-run fetch budget. Unbounded by default so a local run completes the whole
 * catalogue in one go; CI sets a cap so a cold cache converges over a few daily
 * runs instead of producing one hour-long build.
 */
function limitFor(flag, envVar) {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (arg) return Number(arg.slice(flag.length + 1));
  const fromEnv = Number(process.env[envVar]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : Infinity;
}

const trackLimit = limitFor('--tracks', 'RECAP_TRACK_LIMIT');
const artistLimit = limitFor('--artists', 'RECAP_ARTIST_LIMIT');

const lastfm = createLastfmClient({ apiKey: API_KEY });

/** \0 can't appear in a Last.fm name, so it's a collision-free joiner. */
const trackKey = (name, artist) => `${name}\0${artist}`;

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function loadCache() {
  const cached = readJson(CACHE_PATH);
  // A format bump means the old keying scheme is unusable — start clean.
  if (!cached || cached.format !== CACHE_FORMAT) return { format: CACHE_FORMAT, tracks: {}, artists: {} };
  return { format: CACHE_FORMAT, tracks: cached.tracks ?? {}, artists: cached.artists ?? {} };
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf-8');
}

function normalizeTags(raw, max) {
  return (raw ?? [])
    .slice(0, max)
    .map((t) => t?.name?.toLowerCase().trim())
    .filter(Boolean);
}

async function main() {
  const meta = readJson(META_PATH);
  if (!meta) {
    console.warn('meta.json not found — skipping recap enrichment.');
    process.exit(0);
  }

  const { artists, tracks } = meta;
  const catalog = readJson(CATALOG_PATH, {});
  const cache = loadCache();

  // Most-played first, so an interrupted run still covers what matters most.
  const trackPlays = catalog.tracks ?? {};
  const rankedTracks = Object.keys(trackPlays)
    .map(Number)
    .filter((id) => tracks[id])
    .sort((a, b) => (trackPlays[b] ?? 0) - (trackPlays[a] ?? 0));

  const artistPlays = new Map();
  for (const entry of Object.values(catalog.artists ?? {})) {
    if (entry?.name) artistPlays.set(entry.name, entry.scrobbles ?? entry.count ?? 0);
  }
  const rankedArtists = [...new Set(artists)]
    .filter(Boolean)
    .sort((a, b) => (artistPlays.get(b) ?? 0) - (artistPlays.get(a) ?? 0));

  let fetched = 0;
  let failed = 0;
  let sinceCheckpoint = 0;

  const checkpoint = (force = false) => {
    if (!force && ++sinceCheckpoint < CHECKPOINT_EVERY) return;
    sinceCheckpoint = 0;
    saveCache(cache);
  };

  const pending = rankedTracks.filter((id) => {
    const [name, artistId] = tracks[id];
    return name && artists[artistId] && !cache.tracks[trackKey(name, artists[artistId])];
  });
  console.log(`Tracks: ${rankedTracks.length} total, ${pending.length} missing from cache`);

  let done = 0;
  for (const id of pending) {
    if (done >= trackLimit) break;
    const [name, artistId] = tracks[id];
    const artistName = artists[artistId];
    const key = trackKey(name, artistName);

    try {
      const data = await lastfm({
        method: 'track.getInfo',
        artist: artistName,
        track: name,
        username: USERNAME,
      });
      const duration = Number.parseInt(data.track?.duration, 10);
      cache.tracks[key] = {
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        tags: normalizeTags(data.track?.toptags?.tag, 5),
      };
      fetched++;
    } catch (err) {
      if (err instanceof LastfmNotFound) {
        // Definitive answer — cache it so we never ask again.
        cache.tracks[key] = { duration: null, tags: [] };
      } else {
        // Transient: leave it uncached so the next run retries.
        console.warn(`track.getInfo "${name}" — ${err.message}`);
        failed++;
      }
    }

    done++;
    checkpoint();
    if (done % 500 === 0) console.log(`  … ${done}/${pending.length} tracks`);
  }

  const pendingArtists = rankedArtists.filter((name) => !cache.artists[name]);
  console.log(`Artists: ${rankedArtists.length} total, ${pendingArtists.length} missing from cache`);

  done = 0;
  for (const artistName of pendingArtists) {
    if (done >= artistLimit) break;
    try {
      const data = await lastfm({ method: 'artist.getTopTags', artist: artistName });
      cache.artists[artistName] = { tags: normalizeTags(data.toptags?.tag, 8) };
      fetched++;
    } catch (err) {
      if (err instanceof LastfmNotFound) {
        cache.artists[artistName] = { tags: [] };
      } else {
        console.warn(`artist.getTopTags "${artistName}" — ${err.message}`);
        failed++;
      }
    }

    done++;
    checkpoint();
    if (done % 500 === 0) console.log(`  … ${done}/${pendingArtists.length} artists`);
  }

  checkpoint(true);

  const withDuration = Object.values(cache.tracks).filter((t) => t.duration).length;
  console.log(
    `Recap meta cache: ${Object.keys(cache.tracks).length} tracks (${withDuration} with duration), ` +
      `${Object.keys(cache.artists).length} artists. +${fetched} fetched, ${failed} deferred.`,
  );
}

main().catch((err) => {
  console.error('Recap meta enrichment failed:', err);
  process.exit(1);
});
