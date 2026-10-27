import fs from 'fs';
import path from 'path';
import { isStaticArtworkUrl, normalizeStaticArtworkUrl } from './artwork-utils.js';
import { artworkCacheKey, harvestScrobbleArtwork, storeArtworkInCache } from './artwork-keys.js';

import { csvRecords } from './scrobble-source.js';
import { loadEnv } from './lastfm-client.js';
loadEnv();

const API_KEY = process.env.LASTFM_API_KEY;
const USERNAME = process.env.LASTFM_USERNAME;

if (!API_KEY || !USERNAME) {
  console.error("Error: LASTFM_API_KEY and LASTFM_USERNAME environment variables must be set.");
  process.exit(1);
}

const DATA_DIR = path.resolve('src/data');
const CSV_PATH = path.join(DATA_DIR, 'scrobbles.csv');
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork.json');

// Helper to escape CSV fields
function escapeCSV(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Helper to delay execution (rate limiting: 5 requests per second max)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log(`Starting Last.FM sync for user: ${USERNAME}`);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  let existingScrobbles = [];
  let latestUts = 0;

  if (fs.existsSync(CSV_PATH)) {
    console.log("Reading existing scrobbles.csv...");
    const content = fs.readFileSync(CSV_PATH, 'utf-8');
    const lines = csvRecords(content);

    // Header check
    if (lines.length > 1) {
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Basic CSV parser (handles quotes)
        const parts = [];
        let current = '';
        let inQuotes = false;
        for (let j = 0; j < line.length; j++) {
          const char = line[j];
          if (char === '"') {
            if (inQuotes && line[j+1] === '"') {
              current += '"';
              j++; // skip next quote
            } else {
              inQuotes = !inQuotes;
            }
          } else if (char === ',' && !inQuotes) {
            parts.push(current);
            current = '';
          } else {
            current += char;
          }
        }
        parts.push(current);

        if (parts.length >= 4) {
          const uts = parseInt(parts[0], 10);
          if (!isNaN(uts)) {
            existingScrobbles.push({
              uts,
              artist: parts[1],
              album: parts[2],
              track: parts[3]
            });
            if (uts > latestUts) {
              latestUts = uts;
            }
          }
        }
      }
    }
    console.log(`Found ${existingScrobbles.length} existing scrobbles in CSV. Latest timestamp: ${latestUts} (${new Date(latestUts * 1000).toISOString()})`);
  } else {
    console.log("No existing scrobbles.csv found. Will perform full fetch.");
  }

  let artworkCache = {};
  if (fs.existsSync(ARTWORK_PATH)) {
    try {
      artworkCache = JSON.parse(fs.readFileSync(ARTWORK_PATH, 'utf-8'));
    } catch(e) {}
  }

  // Last.fm allows retroactive edits within 14 days, so refetch from 14 days
  // before the latest scrobble, or 0 when starting fresh.
  const FOURTEEN_DAYS_IN_SEC = 14 * 24 * 60 * 60;
  let fromUts = 0;
  if (latestUts > 0) {
    fromUts = Math.max(0, latestUts - FOURTEEN_DAYS_IN_SEC);
  }

  console.log(`Fetching scrobbles from timestamp: ${fromUts} (${new Date(fromUts * 1000).toISOString()})`);

  let page = 1;
  let totalPages = 1;
  let newTracks = [];
  const untilUts = Math.floor(Date.now() / 1000);
  let expectedTotal = null;

  do {
    console.log(`Fetching page ${page} of ${totalPages}...`);
    let url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${USERNAME}&api_key=${API_KEY}&format=json&limit=200&page=${page}&to=${untilUts}`;
    if (fromUts > 0) {
      url += `&from=${fromUts}`;
    }

    let data;
    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        data = await response.json();
        if (data.error) throw new Error(`Last.fm API error ${data.error}: ${data.message || 'unknown'}`);
        if (!data.recenttracks || !data.recenttracks['@attr']) throw new Error('Malformed Last.fm pagination response');
        break;
      } catch (err) {
        retries--;
        console.warn(`Fetch failed (retries left: ${retries}): ${err.message}`);
        if (retries === 0) throw err;
        await delay(2000);
      }
    }

    const recenttracks = data.recenttracks;
    if (!recenttracks) {
      throw new Error('Missing recenttracks: original CSV preserved');
    }

    const attr = recenttracks['@attr'] || {};
    const pages = Number(attr.totalPages);
    const total = Number(attr.total);
    if (!Number.isInteger(pages) || pages < 0 || !Number.isInteger(total) || total < 0 || Number(attr.page) !== page) {
      throw new Error('Invalid Last.fm pagination: original CSV preserved');
    }
    if (expectedTotal !== null && expectedTotal !== total) throw new Error('History changed during pagination; retry the snapshot');
    expectedTotal = total;
    totalPages = Math.max(1, pages);

    const rawTracks = recenttracks.track;
    if (rawTracks) {
      const tracksArr = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
      for (const track of tracksArr) {
        // Skip currently playing track
        if (track['@attr'] && track['@attr'].nowplaying === 'true') {
          continue;
        }

        if (!Number.isInteger(Number(track.date?.uts)) || Number(track.date.uts) <= 0 || !track.name || !track.artist?.['#text']) {
          throw new Error('Malformed scrobble: original CSV preserved');
        }

        if (Number(track.date.uts) <= fromUts || Number(track.date.uts) >= untilUts) throw new Error('Scrobble outside the requested snapshot');
        newTracks.push({
          uts: parseInt(track.date.uts, 10),
          artist: track.artist['#text'] || '',
          album: track.album['#text'] || '',
          track: track.name || ''
        });

        // Harvest artwork
        if (track.image && Array.isArray(track.image)) {
          const img = track.image.find(i => i.size === 'extralarge') || track.image.find(i => i.size === 'large');
          if (img && img['#text'] && isStaticArtworkUrl(img['#text'])) {
            harvestScrobbleArtwork(artworkCache, {
              trackName: track.name,
              artistName: track.artist['#text'] || '',
              albumName: track.album['#text'] || '',
              url: normalizeStaticArtworkUrl(img['#text']),
            });
          }
        }
      }
    }

    page++;
    await delay(300); // 300ms delay to keep requests below 5/sec rate limit
  } while (page <= totalPages);

  if (newTracks.length !== expectedTotal) throw new Error(`Incomplete history: expected ${expectedTotal}, received ${newTracks.length}; original CSV preserved`);
  const previousOverlap = existingScrobbles.filter(s => s.uts > fromUts && s.uts < untilUts).length;
  if (previousOverlap >= 20 && newTracks.length < previousOverlap / 2 && process.env.ALLOW_HISTORY_REDUCTION !== '1') {
    throw new Error('Suspicious history reduction; original CSV preserved. Verify deletions before setting ALLOW_HISTORY_REDUCTION=1.');
  }
  console.log(`Fetched ${newTracks.length} tracks from API.`);

  // Merge datasets:
  // 1. Filter out old tracks that overlap with our fetch range (anything >= fromUts)
  const filteredExisting = fromUts > 0
    ? existingScrobbles.filter(s => s.uts <= fromUts || s.uts >= untilUts)
    : [];

  // 2. Combine and sort by uts ascending
  const combined = [...filteredExisting, ...newTracks];
  combined.sort((a, b) => a.uts - b.uts);

  // 3. Deduplicate exact consecutive scrobbles with same timestamp (just in case)
  const uniqueCombined = [];
  for (let i = 0; i < combined.length; i++) {
    const cur = combined[i];
    const prev = uniqueCombined[uniqueCombined.length - 1];
    if (!prev || prev.uts !== cur.uts || prev.artist !== cur.artist || prev.track !== cur.track) {
      uniqueCombined.push(cur);
    }
  }

  console.log(`Total unique scrobbles in database: ${uniqueCombined.length}`);

  // Write back to CSV
  const header = 'uts,artist,album,track\n';
  const rows = uniqueCombined.map(s => `${s.uts},${escapeCSV(s.artist)},${escapeCSV(s.album)},${escapeCSV(s.track)}`).join('\n');

  // Preserve the last valid snapshot before atomically replacing the canonical file.
  if (fs.existsSync(CSV_PATH)) fs.copyFileSync(CSV_PATH, `${CSV_PATH}.previous`);
  const nextPath = `${CSV_PATH}.next`;
  fs.writeFileSync(nextPath, header + rows, 'utf-8');
  fs.renameSync(nextPath, CSV_PATH);
  fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache), 'utf-8');
  console.log(`Successfully wrote database to ${CSV_PATH}`);

  // Artwork Backfilling Logic
  console.log("Checking for missing artwork...");
  const artistCounts = {};
  const albumCounts = {};

  uniqueCombined.forEach(s => {
    if (s.artist) artistCounts[s.artist] = (artistCounts[s.artist] || 0) + 1;
    if (s.album && s.artist) {
      const key = `${s.album}|${s.artist}`;
      albumCounts[key] = (albumCounts[key] || 0) + 1;
    }
  });

  // Find missing albums
  const missingAlbums = Object.keys(albumCounts)
    .filter(k => {
      const [album, artist] = k.split('|');
      return !artworkCache[artworkCacheKey('album', album, artist)] && !artworkCache[k];
    })
    .sort((a, b) => albumCounts[b] - albumCounts[a])
    .slice(0, 50);

  const missingArtists = Object.keys(artistCounts)
    .filter(k => !artworkCache[artworkCacheKey('artist', k)] && !artworkCache[k])
    .sort((a, b) => artistCounts[b] - artistCounts[a])
    .slice(0, 30);

  let newArtworkCount = 0;

  const getImage = (images) => {
    if (!images || !Array.isArray(images)) return null;
    const img = images.find(img => img.size === 'extralarge') || images.find(img => img.size === 'large');
    return img ? img['#text'] : null;
  };

  for (const albumKey of missingAlbums) {
    const [album, artist] = albumKey.split('|');
    try {
      const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${API_KEY}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&format=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        if (data.album && data.album.image) {
          const img = getImage(data.album.image);
          if (img && isStaticArtworkUrl(img)) {
            const normalized = normalizeStaticArtworkUrl(img);
            if (normalized) {
              storeArtworkInCache(artworkCache, 'album', album, artist, normalized);
              newArtworkCount++;
            }
          }
        }
      }
      await delay(250);
    } catch (e) {
      console.warn(`Failed to fetch artwork for album: ${albumKey}`);
    }
  }

  for (const artist of missingArtists) {
    try {
      // Last.fm artist.getinfo no longer provides images consistently, but we can search for their top tracks/albums
      // Or just try artist.getinfo anyway as fallback
      const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&api_key=${API_KEY}&artist=${encodeURIComponent(artist)}&format=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        if (data.artist && data.artist.image) {
          const img = getImage(data.artist.image);
          if (img && !img.includes('2a96cbd8b46e442fc41c2b86b821562f') && isStaticArtworkUrl(img)) {
            const normalized = normalizeStaticArtworkUrl(img);
            if (normalized) {
              storeArtworkInCache(artworkCache, 'artist', artist, '', normalized);
              newArtworkCount++;
            }
          }
        }
      }
      await delay(250);
    } catch (e) {
      console.warn(`Failed to fetch artwork for artist: ${artist}`);
    }
  }

  if (newArtworkCount > 0) {
    fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
    console.log(`Added ${newArtworkCount} new artwork items.`);
  } else {
    console.log("No new artwork found or needed.");
  }
}

main().catch(err => {
  console.error("Critical error in fetch script:", err);
  process.exit(1);
});
