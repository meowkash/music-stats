import fs from 'fs';
import path from 'path';
import { normalizeName } from './artist-resolve.js';

const DATA_DIR = path.resolve('src/data');
const CSV_PATH = path.join(DATA_DIR, 'scrobbles.csv');
const META_PATH = path.resolve('public/data/meta.json');
const OVERRIDES_PATH = path.join(DATA_DIR, 'artist-overrides.json');
const REVIEW_PATH = path.join(DATA_DIR, 'artist-overrides-review.json');

const KNOWN_BANDS = [
  'Simon & Garfunkel', 'Hall & Oates', 'Florence + The Machine', 'Dan + Shay',
  'Above & Beyond', 'Aly & Fila', 'Aly & AJ', 'for KING & COUNTRY', 'Years & Years',
  'Tom Petty & The Heartbreakers', 'Prince & The Revolution', 'Polo & Pan',
  'Super8 & Tab', 'Zion & Lennox', 'Ayo & Teo', 'Selena Gomez & the Scene',
  'Artik & Asti', 'Banx & Ranx', 'Iron & Wine', 'Kool & the Gang',
  'Joan Jett & The Blackhearts', 'W&W', 'PLS&TY', 'D&B Project', 'ALEX&RUS',
  'Ca7riel & Paco Amoroso', 'Static & Ben El', 'Omnia & Ira', 'Bowers & Bidwell',
  'Paola & Chiara', 'Riggi & Piros', 'Pete Bellis & Tommy', 'T & Sugah',
  'SJUR & Boye & Sigvardt', 'Vishal & Shekhar', 'Empire of the Sun',
  'Foster the People', 'Now, Now', 'Tyler, The Creator', 'Brooks & Dunn',
  'Bill Medley & Jennifer Warnes', 'Simon & Garfunkel', 'Cut Copy',
  'Peter, Paul and Mary', 'Peter, Paul & Mary', 'Mattafix', 'Hootie & the Blowfish',
  'Earth, Wind & Fire', 'Crosby, Stills, Nash & Young', 'Crosby, Stills & Nash',
  'Louis Armstrong & Ella Fitzgerald', 'Guns N\' Roses', 'AC/DC', 'Florence + the Machine',
];

function parseCSVLine(line) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    if (char === '"') {
      if (inQuotes && line[j + 1] === '"') { current += '"'; j++; }
      else inQuotes = !inQuotes;
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

function loadArtists() {
  if (fs.existsSync(META_PATH)) {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf-8')).artists;
  }
  if (!fs.existsSync(CSV_PATH)) {
    console.error('No scrobbles.csv or meta.json found.');
    process.exit(1);
  }
  const lines = fs.readFileSync(CSV_PATH, 'utf-8').split('\n');
  const set = new Set();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = parseCSVLine(line);
    if (parts.length >= 2 && parts[1]) set.add(parts[1]);
  }
  return [...set];
}

function looseNorm(s) {
  return s.normalize('NFC').toLowerCase().replace(/[.,']/g, '').replace(/\s+/g, ' ').trim();
}

function detectAliases(artists) {
  const aliases = {};
  const byNorm = new Map();
  for (const a of artists) {
    const n = normalizeName(a);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(a);
  }
  for (const group of byNorm.values()) {
    if (group.length < 2) continue;
    const canonical = group.sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      const aUpper = a === a.toUpperCase() && /[A-Z]/.test(a);
      const bUpper = b === b.toUpperCase() && /[A-Z]/.test(b);
      if (aUpper !== bUpper) return aUpper ? 1 : -1;
      return a.localeCompare(b);
    })[0];
    for (const a of group) {
      if (a !== canonical) aliases[a] = canonical;
    }
  }
  const byLoose = new Map();
  for (const a of artists) {
    const n = looseNorm(a);
    if (!byLoose.has(n)) byLoose.set(n, new Set());
    byLoose.get(n).add(a);
  }
  for (const group of byLoose.values()) {
    if (group.size < 2) continue;
    const names = [...group];
    const canonical = names.sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;
      const aUpper = a === a.toUpperCase() && /[A-Z]/.test(a);
      const bUpper = b === b.toUpperCase() && /[A-Z]/.test(b);
      if (aUpper !== bUpper) return aUpper ? 1 : -1;
      return a.localeCompare(b);
    })[0];
    for (const a of names) {
      if (a !== canonical && !aliases[a]) aliases[a] = canonical;
    }
  }
  // Remove conflicting bidirectional mappings
  for (const [alias, target] of Object.entries(aliases)) {
    if (aliases[target] === alias) {
      delete aliases[alias];
    }
  }
  return aliases;
}

function buildReviewQueue(artists) {
  const artistSet = new Set(artists);
  const review = { likelyCollabs: [], ambiguousAmp: [], parenthetical: [] };

  for (const s of artists) {
    if (/\(\s*(?:feat|ft|featuring)/i.test(s)) {
      review.parenthetical.push(s);
    }
    if (!s.includes(' & ')) continue;
    const parts = s.split(/\s*&\s*/);
    if (parts.length !== 2) continue;
    const [a, b] = parts.map((p) => p.trim());
    if (artistSet.has(a) && artistSet.has(b)) {
      review.likelyCollabs.push(s);
    } else if (!artistSet.has(a) && !artistSet.has(b)) {
      review.ambiguousAmp.push(s);
    }
  }
  return review;
}

function main() {
  const artists = loadArtists();
  const artistSet = new Set(artists);

  const singleEntities = KNOWN_BANDS
    .filter((b) => artistSet.has(b))
    .sort((a, b) => a.localeCompare(b));

  const aliases = detectAliases(artists);
  const review = buildReviewQueue(artists);

  let existing = { singleEntities: [], aliases: {} };
  if (fs.existsSync(OVERRIDES_PATH)) {
    existing = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8'));
  }

  const mergedSingles = [...new Set([...(existing.singleEntities ?? []), ...singleEntities])].sort();
  const mergedAliases = { ...(existing.aliases ?? {}), ...aliases };

  const output = {
    _generated: new Date().toISOString(),
    _source: 'bootstrap-artist-overrides.js',
    singleEntities: mergedSingles,
    aliases: mergedAliases,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(REVIEW_PATH, JSON.stringify(review, null, 2) + '\n', 'utf-8');

  console.log(`Wrote ${OVERRIDES_PATH}`);
  console.log(`  singleEntities: ${mergedSingles.length}`);
  console.log(`  aliases: ${Object.keys(mergedAliases).length}`);
  console.log(`Wrote review queue to ${REVIEW_PATH}`);
}

main();
