import fs from 'fs';
import path from 'path';

// Load environment variables from .env if present
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
    const lines = content.split('\n');
    
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

  // Calculate "from" timestamp.
  // Last.FM allows retroactive edits/scrobbles within 14 days, so we refetch from 14 days before the latest scrobble,
  // or 0 if starting fresh.
  const FOURTEEN_DAYS_IN_SEC = 14 * 24 * 60 * 60;
  let fromUts = 0;
  if (latestUts > 0) {
    fromUts = Math.max(0, latestUts - FOURTEEN_DAYS_IN_SEC);
  }

  console.log(`Fetching scrobbles from timestamp: ${fromUts} (${new Date(fromUts * 1000).toISOString()})`);

  let page = 1;
  let totalPages = 1;
  let newTracks = [];

  do {
    console.log(`Fetching page ${page} of ${totalPages}...`);
    let url = `http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${USERNAME}&api_key=${API_KEY}&format=json&limit=200&page=${page}`;
    if (fromUts > 0) {
      url += `&from=${fromUts}`;
    }

    let data;
    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        data = await response.json();
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
      console.warn("No recent tracks returned. Stopping.");
      break;
    }

    const attr = recenttracks['@attr'] || {};
    totalPages = parseInt(attr.totalPages, 10) || 1;
    
    const rawTracks = recenttracks.track;
    if (rawTracks) {
      const tracksArr = Array.isArray(rawTracks) ? rawTracks : [rawTracks];
      for (const track of tracksArr) {
        // Skip currently playing track
        if (track['@attr'] && track['@attr'].nowplaying === 'true') {
          continue;
        }

        if (!track.date || !track.date.uts) {
          continue;
        }

        newTracks.push({
          uts: parseInt(track.date.uts, 10),
          artist: track.artist['#text'] || '',
          album: track.album['#text'] || '',
          track: track.name || ''
        });

        // Harvest artwork
        if (track.image && Array.isArray(track.image)) {
          const img = track.image.find(i => i.size === 'extralarge') || track.image.find(i => i.size === 'large');
          if (img && img['#text']) {
            const artistName = track.artist['#text'] || '';
            const albumName = track.album['#text'] || '';
            if (albumName) {
              artworkCache[`${albumName}|${artistName}`] = img['#text'];
            }
            if (artistName && !artworkCache[artistName]) {
              artworkCache[artistName] = img['#text'];
            }
            artworkCache[`${track.name}|${artistName}`] = img['#text'];
          }
        }
      }
    }

    // Save artwork progressively
    if (Object.keys(artworkCache).length > 0) {
      fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
    }

    page++;
    await delay(300); // 300ms delay to keep requests below 5/sec rate limit
  } while (page <= totalPages);

  console.log(`Fetched ${newTracks.length} tracks from API.`);

  // Merge datasets:
  // 1. Filter out old tracks that overlap with our fetch range (anything >= fromUts)
  const filteredExisting = fromUts > 0 
    ? existingScrobbles.filter(s => s.uts < fromUts) 
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
  
  fs.writeFileSync(CSV_PATH, header + rows, 'utf-8');
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
    .filter(k => !artworkCache[k])
    .sort((a, b) => albumCounts[b] - albumCounts[a])
    .slice(0, 50); // fetch top 50 missing albums per run

  // Find missing artists
  const missingArtists = Object.keys(artistCounts)
    .filter(k => !artworkCache[k])
    .sort((a, b) => artistCounts[b] - artistCounts[a])
    .slice(0, 30); // fetch top 30 missing artists per run

  let newArtworkCount = 0;

  const getImage = (images) => {
    if (!images || !Array.isArray(images)) return null;
    const img = images.find(img => img.size === 'extralarge') || images.find(img => img.size === 'large');
    return img ? img['#text'] : null;
  };

  for (const albumKey of missingAlbums) {
    const [album, artist] = albumKey.split('|');
    try {
      const url = `http://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${API_KEY}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.album && data.album.image) {
          const img = getImage(data.album.image);
          if (img) {
            artworkCache[albumKey] = img;
            newArtworkCount++;
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
      const url = `http://ws.audioscrobbler.com/2.0/?method=artist.getinfo&api_key=${API_KEY}&artist=${encodeURIComponent(artist)}&format=json`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.artist && data.artist.image) {
          const img = getImage(data.artist.image);
          if (img && !img.includes('2a96cbd8b46e442fc41c2b86b821562f')) { // Ignore default star image
            artworkCache[artist] = img;
            newArtworkCount++;
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
