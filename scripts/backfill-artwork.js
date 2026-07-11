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
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork.json');
const CATALOG_PATH = path.resolve('public/data/catalog.json');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log(`Starting Database-Wide Artwork Backfill for user: ${USERNAME}`);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Load existing artwork cache
  let artworkCache = {};
  if (fs.existsSync(ARTWORK_PATH)) {
    artworkCache = JSON.parse(fs.readFileSync(ARTWORK_PATH, 'utf-8'));
  }
  console.log(`Loaded ${Object.keys(artworkCache).length} existing artwork entries.`);

  // Load catalog to get unique albums and play counts
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error(`Error: Catalog database not found at ${CATALOG_PATH}. Run "npm run build" first to aggregate scrobbles.`);
    process.exit(1);
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
  const albums = Object.values(catalog.albums || {});
  
  // Sort albums by scrobbles count descending to prioritize popular items
  albums.sort((a, b) => b.scrobbles - a.scrobbles);
  console.log(`Found ${albums.length} unique albums in catalog database. Prioritizing by scrobble count.`);

  const getImage = (images) => {
    if (!images || !Array.isArray(images)) return null;
    const img = images.find(img => img.size === 'extralarge') || images.find(img => img.size === 'large');
    return img ? img['#text'] : null;
  };

  let fetchedCount = 0;
  let saveInterval = 0;

  for (let i = 0; i < albums.length; i++) {
    const album = albums[i];
    const albumKey = `${album.name}|${album.artistName}`;

    // Skip if already cached
    if (artworkCache[albumKey]) {
      // Ensure artist also has default image if not present
      if (!artworkCache[album.artistName]) {
        artworkCache[album.artistName] = artworkCache[albumKey];
      }
      continue;
    }

    console.log(`[${i + 1}/${albums.length}] Fetching: "${album.name}" by "${album.artistName}" (${album.scrobbles} plays)...`);

    let imgUrl = null;

    // 1. Try iTunes / Apple Music Search API first
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(album.artistName + ' ' + album.name)}&entity=album&limit=1`;
      const res = await fetch(itunesUrl);
      if (res.ok) {
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          const artworkUrl100 = data.results[0].artworkUrl100;
          if (artworkUrl100) {
            // Replace resolution suffix to get high-res image (1000x1000)
            imgUrl = artworkUrl100
              .replace(/\/\d+x\d+bb\.jpg$/, '/1000x1000bb.jpg')
              .replace(/\/\d+x\d+\.jpg$/, '/1000x1000.jpg');
            console.log(`   -> Found iTunes artwork!`);
          }
        }
      }
    } catch (err) {
      console.warn(`   -> iTunes API error:`, err.message);
    }

    // 2. Fall back to Last.FM API if iTunes search yielded nothing
    if (!imgUrl) {
      try {
        const lastfmUrl = `http://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${API_KEY}&artist=${encodeURIComponent(album.artistName)}&album=${encodeURIComponent(album.name)}&format=json`;
        const res = await fetch(lastfmUrl);
        if (res.ok) {
          const data = await res.json();
          const lastfmImg = getImage(data.album?.image);
          if (lastfmImg) {
            imgUrl = lastfmImg;
            console.log(`   -> Found Last.FM artwork fallback!`);
          }
        }
      } catch (err) {
        console.error(`   -> Last.FM API error:`, err.message);
      }
    }

    // 3. Cache the result if found
    if (imgUrl) {
      artworkCache[albumKey] = imgUrl;
      fetchedCount++;
      saveInterval++;

      // Set default artist image if missing
      if (!artworkCache[album.artistName]) {
        artworkCache[album.artistName] = imgUrl;
      }
    } else {
      console.log(`   -> No artwork found on iTunes or Last.FM.`);
    }

    // Save incrementally every 10 fetches
    if (saveInterval >= 10) {
      fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
      console.log(`=== Saved progress: ${Object.keys(artworkCache).length} total artwork entries saved. ===`);
      saveInterval = 0;
    }

    // Rate-limiting delay (150ms is very safe)
    await delay(150);
  }

  // Final save
  fs.writeFileSync(ARTWORK_PATH, JSON.stringify(artworkCache, null, 2), 'utf-8');
  console.log(`Completed backfill! Wrote ${fetchedCount} new entries to ${ARTWORK_PATH}. Total entries: ${Object.keys(artworkCache).length}`);
}

main().catch(err => {
  console.error("Critical error in backfill script:", err);
  process.exit(1);
});
