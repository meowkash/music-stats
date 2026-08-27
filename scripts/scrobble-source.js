/**
 * Reads and parses src/data/scrobbles.csv. Shared by process-data.js and
 * generate-recaps.js so the two can never disagree about how a row is decoded.
 */
import fs from 'fs';
import path from 'path';

export const CSV_PATH = path.resolve('src/data/scrobbles.csv');

/** Handles embedded commas and RFC-4180 doubled quotes inside quoted fields. */
export function parseCSVLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
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

/**
 * Yields `{ uts, artist, album, track }` for every valid row, skipping the
 * header. Streaming as a generator keeps peak memory to one row rather than
 * ~150k parsed arrays.
 */
export function* readScrobbles(csvPath = CSV_PATH) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Raw scrobbles file not found at ${csvPath}. Fetch data first.`);
  }

  const lines = fs.readFileSync(csvPath, 'utf-8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = parseCSVLine(line);
    if (parts.length < 4) continue;

    const uts = Number.parseInt(parts[0], 10);
    if (Number.isNaN(uts)) continue;

    yield { uts, artist: parts[1], album: parts[2], track: parts[3] };
  }
}
