import fs from 'fs';
import path from 'path';

const OVERRIDES_PATH = path.resolve('src/data/artist-overrides.json');

const PAREN_FEAT_RE = /\s*\(\s*(?:feat\.?|ft\.?|featuring)\s+([^)]+)\)\s*$/i;

/** NFC + lowercase + collapsed whitespace */
export function normalizeName(name) {
  return name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function loadOverrides(overridesPath = OVERRIDES_PATH) {
  if (!fs.existsSync(overridesPath)) {
    return { singleEntities: [], aliases: {} };
  }
  const data = JSON.parse(fs.readFileSync(overridesPath, 'utf-8'));
  return {
    singleEntities: data.singleEntities ?? [],
    aliases: data.aliases ?? {},
  };
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)));
    }
    return this.parent.get(x);
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  groups() {
    const result = new Map();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!result.has(root)) result.set(root, []);
      result.get(root).push(key);
    }
    return result;
  }
}

function applyAlias(name, aliases) {
  if (aliases[name]) return aliases[name];
  return name;
}

/** Protect multi-token band names before delimiter splitting. */
function protectSingleEntities(str, singleEntities) {
  const placeholders = [];
  let protectedStr = str;

  const candidates = singleEntities
    .filter((e) => /[&+,]|(?:feat|ft)/i.test(e) || e.includes(','))
    .sort((a, b) => b.length - a.length);

  for (const entity of candidates) {
    if (!protectedStr.includes(entity)) continue;
    const token = `\x00${placeholders.length}\x00`;
    placeholders.push(entity);
    protectedStr = protectedStr.split(entity).join(token);
  }

  return { protectedStr, placeholders };
}

function restorePlaceholders(segments, placeholders) {
  return segments.map((seg) => {
    let out = seg;
    for (let i = 0; i < placeholders.length; i++) {
      out = out.split(`\x00${i}\x00`).join(placeholders[i]);
    }
    return out.trim();
  }).filter(Boolean);
}

function splitOnDelimiters(str) {
  const re = /\s*(?:,|\s+and\s+|\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|versus)\s+|\s*&\s*|\s+\+\s+|\s+x\s+)\s*/i;
  return str.split(re).map((s) => s.trim()).filter(Boolean);
}

/** Extract featured artists from a track title, e.g. "Song (feat. A & B) [Remix]". */
export function parseTrackFeatureCredits(trackName, overrides = loadOverrides()) {
  const match = trackName.match(/\((?:feat\.?|ft\.?|featuring)\s+([^)]+)\)/i);
  if (!match) return [];

  const { protectedStr, placeholders } = protectSingleEntities(match[1], overrides.singleEntities);
  let segments = splitOnDelimiters(protectedStr);
  segments = restorePlaceholders(segments, placeholders);
  return segments.map((c) => applyAlias(c, overrides.aliases ?? {}));
}

/** Merge artist-tag credits with (feat. ...) credits embedded in the track title. */
export function parseScrobbleCredits(artistName, trackName, overrides = loadOverrides()) {
  const fromArtist = parseArtistCredits(artistName, overrides);
  const fromTitle = parseTrackFeatureCredits(trackName, overrides);
  const seen = new Set(fromArtist.map(normalizeName));
  const merged = [...fromArtist];
  for (const name of fromTitle) {
    const norm = normalizeName(name);
    if (!seen.has(norm)) {
      seen.add(norm);
      merged.push(name);
    }
  }
  return merged;
}

/**
 * Parse a raw Last.fm artist string into credited artist name segments.
 */
export function parseArtistCredits(rawName, overrides = loadOverrides()) {
  const singleSet = new Set(overrides.singleEntities);
  let name = applyAlias(rawName, overrides.aliases);

  if (singleSet.has(name)) {
    return [name];
  }

  const parenMatch = name.match(PAREN_FEAT_RE);
  const parenthetical = [];
  if (parenMatch) {
    parenthetical.push(...splitOnDelimiters(parenMatch[1]));
    name = name.slice(0, parenMatch.index).trim();
  }

  if (!name) {
    return parenthetical.length ? parenthetical : [rawName];
  }

  if (singleSet.has(name)) {
    return [name, ...parenthetical];
  }

  const { protectedStr, placeholders } = protectSingleEntities(name, overrides.singleEntities);
  let segments = splitOnDelimiters(protectedStr);
  segments = restorePlaceholders(segments, placeholders);

  if (segments.length === 0) {
    segments = [name];
  }

  return [...segments, ...parenthetical];
}

const COLLAB_MARKER_RE = /\b(feat\.?|ft\.?|featuring|with|vs\.?|versus)\b|[&+]|\s+x\s+/i;

function nameCaseScore(name) {
  if (name === name.toLowerCase() && /[a-z]/.test(name)) return 0;
  if (name === name.toUpperCase() && /[A-Z]/.test(name)) return 1;
  return 2;
}

/** Prefer highest-play variant, then solo raw spelling, then proper casing. */
function pickDisplayName(names, { segmentWeights, soloRawNames }) {
  return [...names].sort((a, b) => {
    const weightA = segmentWeights.get(a) || 0;
    const weightB = segmentWeights.get(b) || 0;
    if (weightA !== weightB) return weightB - weightA;

    const soloA = soloRawNames.has(a) ? 1 : 0;
    const soloB = soloRawNames.has(b) ? 1 : 0;
    if (soloA !== soloB) return soloB - soloA;

    const caseA = nameCaseScore(a);
    const caseB = nameCaseScore(b);
    if (caseA !== caseB) return caseB - caseA;

    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];
}

/**
 * Build canonical artist attribution for all raw artist strings.
 */
export function buildArtistAttribution(rawArtists, overrides = loadOverrides(), artistCounts = [], tracks = [], trackCounts = []) {
  const aliases = overrides.aliases ?? {};
  const uf = new UnionFind();

  const soloRawNames = new Set(
    rawArtists.filter((name) => !COLLAB_MARKER_RE.test(name)),
  );

  const segmentWeights = new Map();
  const parseResults = rawArtists.map((raw, rawId) => {
    const credits = parseArtistCredits(raw, overrides).map((c) => applyAlias(c, aliases));
    const weight = artistCounts[rawId] || 0;
    for (const c of credits) {
      segmentWeights.set(c, (segmentWeights.get(c) || 0) + weight);
    }
    return { raw, credits };
  });

  const allSegments = new Set();
  for (const { credits } of parseResults) {
    for (const c of credits) allSegments.add(c);
  }

  for (let tId = 0; tId < tracks.length; tId++) {
    const [trackName] = tracks[tId];
    const weight = trackCounts[tId] || 0;
    for (const c of parseTrackFeatureCredits(trackName, overrides).map((n) => applyAlias(n, aliases))) {
      allSegments.add(c);
      segmentWeights.set(c, (segmentWeights.get(c) || 0) + weight);
    }
  }

  for (const name of allSegments) {
    uf.find(name);
  }

  for (const [alias, target] of Object.entries(aliases)) {
    uf.union(alias, target);
  }

  const byNorm = new Map();
  for (const name of allSegments) {
    const norm = normalizeName(name);
    if (byNorm.has(norm)) {
      uf.union(name, byNorm.get(norm));
    } else {
      byNorm.set(norm, name);
    }
  }

  const groups = uf.groups();
  const rootToDisplay = new Map();
  const displayOpts = { segmentWeights, soloRawNames };
  for (const [root, members] of groups) {
    rootToDisplay.set(root, pickDisplayName(members, displayOpts));
  }

  const canonicalNameToId = new Map();
  const canonicalArtists = [];

  function canonicalIdFor(name) {
    const root = uf.find(name);
    const display = rootToDisplay.get(root) ?? name;
    const norm = normalizeName(display);
    if (canonicalNameToId.has(norm)) {
      return canonicalNameToId.get(norm);
    }
    const id = canonicalArtists.length;
    canonicalArtists.push(display);
    canonicalNameToId.set(norm, id);
    return id;
  }

  const rawToCanonical = [];
  const parseReport = [];

  for (const { raw, credits } of parseResults) {
    const ids = [...new Set(credits.map((c) => canonicalIdFor(c)))];
    rawToCanonical.push(ids);
    parseReport.push({ raw, credits, canonicalIds: ids });
  }

  const trackToCanonical = [];
  for (let tId = 0; tId < tracks.length; tId++) {
    const [trackName, artistId] = tracks[tId];
    const credits = parseScrobbleCredits(rawArtists[artistId], trackName, overrides).map((c) => applyAlias(c, aliases));
    trackToCanonical.push([...new Set(credits.map((c) => canonicalIdFor(c)))]);
  }

  return { canonicalArtists, rawToCanonical, trackToCanonical, parseReport };
}

export function creditCanonicalIds(rawArtistId, rawToCanonical) {
  return rawToCanonical[rawArtistId] ?? [rawArtistId];
}

export function creditTrackCanonicalIds(trackId, trackToCanonical, rawArtistId, rawToCanonical) {
  return trackToCanonical?.[trackId] ?? creditCanonicalIds(rawArtistId, rawToCanonical);
}

export function addCanonicalCredits(counts, rawArtistId, playCount, rawToCanonical) {
  const ids = creditCanonicalIds(rawArtistId, rawToCanonical);
  for (const id of ids) {
    counts[id] = (counts[id] || 0) + playCount;
  }
}

export function addTrackCanonicalCredits(counts, trackId, rawArtistId, playCount, trackToCanonical, rawToCanonical) {
  const ids = creditTrackCanonicalIds(trackId, trackToCanonical, rawArtistId, rawToCanonical);
  for (const id of ids) {
    counts[id] = (counts[id] || 0) + playCount;
  }
}
