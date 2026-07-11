import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('src/data');
const PUBLIC_DATA_DIR = path.resolve('public/data');
const CSV_PATH = path.join(DATA_DIR, 'scrobbles.csv');
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork.json');

// Helper to check if a year is a leap year
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

// Helper to get day of the year (0-indexed)
function getDayOfYearIndex(dateStr, year) {
  const date = new Date(dateStr + 'T00:00:00Z');
  const start = new Date(Date.UTC(year, 0, 1));
  const diff = date - start;
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}

// Custom CSV row parser to handle commas and double quotes correctly
function parseCSVLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    if (char === '"') {
      if (inQuotes && line[j+1] === '"') {
        current += '"';
        j++;
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
  return parts;
}

function main() {
  console.log("Starting data aggregation and processing...");

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`Error: Raw scrobbles file not found at ${CSV_PATH}. Make sure to fetch data first.`);
    process.exit(1);
  }

  if (!fs.existsSync(PUBLIC_DATA_DIR)) {
    fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
  }

  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split('\n');

  const artists = [];
  const artistMap = new Map();

  const albums = [];
  const albumMap = new Map();

  const tracks = []; // Array of [trackName, artistId, albumId]
  const trackMap = new Map(); // Key: "trackName|artistId|albumId" -> index

  // Daily records: { dateStr: { trackId: count } }
  const dailyRecords = {};

  const artistCounts = [];
  const trackCounts = [];
  let totalScrobbles = 0;

  // Parse lines (skip header)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = parseCSVLine(line);
    if (parts.length < 4) continue;

    const uts = parseInt(parts[0], 10);
    const artistName = parts[1];
    const albumName = parts[2];
    const trackName = parts[3];

    if (isNaN(uts)) continue;

    // Get or create Artist ID
    let artistId = artistMap.get(artistName);
    if (artistId === undefined) {
      artistId = artists.length;
      artists.push(artistName);
      artistMap.set(artistName, artistId);
    }

    // Get or create Album ID
    let albumId = albumMap.get(albumName);
    if (albumId === undefined) {
      albumId = albums.length;
      albums.push(albumName);
      albumMap.set(albumName, albumId);
    }

    // Get or create Track ID
    const trackKey = `${trackName}|${artistId}|${albumId}`;
    let trackId = trackMap.get(trackKey);
    if (trackId === undefined) {
      trackId = tracks.length;
      tracks.push([trackName, artistId, albumId]);
      trackMap.set(trackKey, trackId);
    }

    // Determine UTC Date string YYYY-MM-DD
    const dateStr = new Date(uts * 1000).toISOString().split('T')[0];

    if (!dailyRecords[dateStr]) {
      dailyRecords[dateStr] = {};
    }

    dailyRecords[dateStr][trackId] = (dailyRecords[dateStr][trackId] || 0) + 1;
    
    // Global stats
    artistCounts[artistId] = (artistCounts[artistId] || 0) + 1;
    trackCounts[trackId] = (trackCounts[trackId] || 0) + 1;
    totalScrobbles++;
  }

  console.log(`Parsed database. Unique artists: ${artists.length}, Unique albums: ${albums.length}, Unique tracks: ${tracks.length}`);

  // Write meta.json
  const metaPath = path.join(PUBLIC_DATA_DIR, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ artists, albums, tracks }), 'utf-8');
  console.log(`Wrote dictionary metadata to ${metaPath}`);

  // Group daily records by year
  const yearlyFiles = {}; // year -> { dateStr: [[trackId, count]] }
  const yearlyTotals = {}; // year -> array of daily counts
  const yearlyStats = {}; // year -> { artists: {}, albums: {}, tracks: {} }

  // Sort dates to process chronologically
  const sortedDates = Object.keys(dailyRecords).sort();

  for (const dateStr of sortedDates) {
    const yearStr = dateStr.split('-')[0];
    const year = parseInt(yearStr, 10);

    if (!yearlyFiles[yearStr]) {
      yearlyFiles[yearStr] = {};
    }
    if (!yearlyStats[yearStr]) {
      yearlyStats[yearStr] = { artists: {}, albums: {}, tracks: {} };
    }

    // Format: [[trackId, count], ...] sorted by trackId for consistency
    const dayTracks = Object.entries(dailyRecords[dateStr])
      .map(([tId, count]) => {
        const trackId = parseInt(tId, 10);
        const [trackName, artistId, albumId] = tracks[trackId];
        
        // Aggregate yearly stats
        yearlyStats[yearStr].tracks[trackId] = (yearlyStats[yearStr].tracks[trackId] || 0) + count;
        yearlyStats[yearStr].artists[artistId] = (yearlyStats[yearStr].artists[artistId] || 0) + count;
        // Only count valid albums (not empty)
        if (albums[albumId] !== "") {
          yearlyStats[yearStr].albums[albumId] = (yearlyStats[yearStr].albums[albumId] || 0) + count;
        }

        return [trackId, count];
      })
      .sort((a, b) => a[0] - b[0]);

    yearlyFiles[yearStr][dateStr] = dayTracks;

    // Aggregate daily totals for line chart
    if (!yearlyTotals[yearStr]) {
      const daysCount = isLeapYear(year) ? 366 : 365;
      yearlyTotals[yearStr] = Array(daysCount).fill(0);
    }

    const dayIndex = getDayOfYearIndex(dateStr, year);
    const dayTotal = dayTracks.reduce((acc, curr) => acc + curr[1], 0);

    // Make sure index is in bounds (in rare cases of timezone boundary shifts)
    if (dayIndex >= 0 && dayIndex < yearlyTotals[yearStr].length) {
      yearlyTotals[yearStr][dayIndex] = dayTotal;
    }
  }

  // Trim future dates for the current year in yearlyTotals
  const currentYearStr = new Date().toISOString().split('-')[0];
  if (yearlyTotals[currentYearStr]) {
    const todayIndex = getDayOfYearIndex(new Date().toISOString().split('T')[0], parseInt(currentYearStr, 10));
    // Keep elements only up to today's index (inclusive)
    yearlyTotals[currentYearStr] = yearlyTotals[currentYearStr].slice(0, todayIndex + 1);
  }

  // Write yearly detailed files
  for (const [yearStr, daysData] of Object.entries(yearlyFiles)) {
    const yearFilePath = path.join(PUBLIC_DATA_DIR, `year-${yearStr}.json`);
    fs.writeFileSync(yearFilePath, JSON.stringify(daysData), 'utf-8');
  }
  console.log(`Wrote yearly details files to ${PUBLIC_DATA_DIR}/year-[YYYY].json`);

  // Write yearly-totals.json
  const totalsPath = path.join(PUBLIC_DATA_DIR, 'yearly-totals.json');
  fs.writeFileSync(totalsPath, JSON.stringify(yearlyTotals), 'utf-8');
  console.log(`Wrote yearly-totals to ${totalsPath}`);

  // Write yearly-stats.json
  const finalYearlyStats = {};
  for (const [yearStr, stats] of Object.entries(yearlyStats)) {
    finalYearlyStats[yearStr] = {
      artists: Object.entries(stats.artists).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => [parseInt(e[0]), e[1]]),
      albums: Object.entries(stats.albums).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => [parseInt(e[0]), e[1]]),
      tracks: Object.entries(stats.tracks).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => [parseInt(e[0]), e[1]])
    };
  }
  const statsPath = path.join(PUBLIC_DATA_DIR, 'yearly-stats.json');
  fs.writeFileSync(statsPath, JSON.stringify(finalYearlyStats), 'utf-8');
  console.log(`Wrote yearly-stats to ${statsPath}`);

  // Write recent.json (last 20 scrobbles for live feed)
  const recentScrobbles = [];
  // Parse lines in reverse order (newest first), starting from the end
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = parseCSVLine(line);
    if (parts.length < 4) continue;

    const uts = parseInt(parts[0], 10);
    if (isNaN(uts)) continue;

    recentScrobbles.push({
      uts,
      artist: parts[1],
      album: parts[2],
      track: parts[3]
    });

    if (recentScrobbles.length >= 20) break;
  }

  const recentPath = path.join(PUBLIC_DATA_DIR, 'recent.json');
  fs.writeFileSync(recentPath, JSON.stringify(recentScrobbles), 'utf-8');
  console.log(`Wrote recent scrobbles to ${recentPath}`);

  // Calculate Highlights
  let bestArtistId = -1, bestArtistCount = 0;
  for (let i = 0; i < artistCounts.length; i++) {
    if ((artistCounts[i] || 0) > bestArtistCount) {
      bestArtistCount = artistCounts[i];
      bestArtistId = i;
    }
  }

  let bestTrackId = -1, bestTrackCount = 0;
  for (let i = 0; i < trackCounts.length; i++) {
    if ((trackCounts[i] || 0) > bestTrackCount) {
      bestTrackCount = trackCounts[i];
      bestTrackId = i;
    }
  }

  const highlights = {
    totalScrobbles,
    topArtist: bestArtistId >= 0 ? artists[bestArtistId] : null,
    topArtistPlays: bestArtistCount,
    topTrack: bestTrackId >= 0 ? tracks[bestTrackId][0] : null,
    topTrackArtist: bestTrackId >= 0 ? artists[tracks[bestTrackId][1]] : null,
    topTrackPlays: bestTrackCount
  };

  const highlightsPath = path.join(PUBLIC_DATA_DIR, 'highlights.json');
  fs.writeFileSync(highlightsPath, JSON.stringify(highlights), 'utf-8');
  console.log(`Wrote highlights to ${highlightsPath}`);

  // Build-time pre-aggregated catalog.json
  console.log("Generating pre-aggregated catalog database...");
  const catalog = {
    artists: {},
    albums: {}
  };

  const albumTrackCounts = {}; // albumId -> array of { name, count }
  const albumArtistId = {}; // albumId -> artistId
  const albumScrobbles = {}; // albumId -> scrobbles

  for (let tId = 0; tId < tracks.length; tId++) {
    const [trackName, artistId, albumId] = tracks[tId];
    const count = trackCounts[tId] || 0;
    if (count === 0) continue;

    albumArtistId[albumId] = artistId;
    albumScrobbles[albumId] = (albumScrobbles[albumId] || 0) + count;

    if (!albumTrackCounts[albumId]) {
      albumTrackCounts[albumId] = [];
    }
    albumTrackCounts[albumId].push({ name: trackName, count });
  }

  for (const albumIdStr of Object.keys(albumScrobbles)) {
    const albumId = parseInt(albumIdStr, 10);
    const albTracks = albumTrackCounts[albumId] || [];
    albTracks.sort((a, b) => b.count - a.count);

    catalog.albums[albumId] = {
      name: albums[albumId],
      artistId: albumArtistId[albumId],
      artistName: artists[albumArtistId[albumId]],
      scrobbles: albumScrobbles[albumId],
      tracks: albTracks
    };
  }

  const artistTrackCounts = {}; // artistId -> array of { name, count }
  const artistAlbums = {}; // artistId -> Set of albumIds

  for (let tId = 0; tId < tracks.length; tId++) {
    const [trackName, artistId, albumId] = tracks[tId];
    const count = trackCounts[tId] || 0;
    if (count === 0) continue;

    if (!artistTrackCounts[artistId]) {
      artistTrackCounts[artistId] = [];
    }
    artistTrackCounts[artistId].push({ name: trackName, count });

    if (!artistAlbums[artistId]) {
      artistAlbums[artistId] = new Set();
    }
    if (albumId !== undefined && albumId !== null && albumId !== 0) {
      artistAlbums[artistId].add(albumId);
    }
  }

  for (let artistId = 0; artistId < artists.length; artistId++) {
    const count = artistCounts[artistId] || 0;
    if (count === 0) continue;

    const artTracks = artistTrackCounts[artistId] || [];
    artTracks.sort((a, b) => b.count - a.count);

    const artAlbs = Array.from(artistAlbums[artistId] || []);
    artAlbs.sort((a, b) => {
      const aScrobbles = albumScrobbles[a] || 0;
      const bScrobbles = albumScrobbles[b] || 0;
      return bScrobbles - aScrobbles;
    });

    catalog.artists[artistId] = {
      name: artists[artistId],
      scrobbles: count,
      tracks: artTracks,
      albums: artAlbs.map(albId => ({
        id: albId,
        name: albums[albId],
        scrobbles: albumScrobbles[albId] || 0
      }))
    };
  }

  const catalogPath = path.join(PUBLIC_DATA_DIR, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), 'utf-8');
  console.log(`Wrote pre-aggregated catalog to ${catalogPath}`);

  // Copy Artwork if exists
  if (fs.existsSync(ARTWORK_PATH)) {
    fs.copyFileSync(ARTWORK_PATH, path.join(PUBLIC_DATA_DIR, 'artwork.json'));
    console.log(`Copied artwork.json to public directory`);
  }

  console.log("Data aggregation and processing completed successfully.");
}

main();
