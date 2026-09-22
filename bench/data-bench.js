import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import {
  SHARDED_DATASETS,
  mergeShards,
  splitDataset,
  readDataset,
} from '../scripts/data-files.js';

/** Dictionaries the catalog's canonical-artist grouping resolves against. */
function loadMeta() {
  const file = path.join(DATA_DIR, 'meta.json');
  if (!fs.existsSync(file)) return null;
  const meta = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return {
    tracks: meta.tracks,
    rawToCanonical: meta.rawToCanonical,
    trackToCanonical: meta.trackToCanonical,
  };
}

const DATA_DIR = path.resolve('public/data');

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { ms: Math.round((performance.now() - start) * 10) / 10, value };
}

/**
 * How long the client spends reassembling each dataset from its shards. This is
 * main-thread time on every boot, so it is a budget, not a curiosity.
 */
function mergeCost() {
  const results = {};

  for (const [name, spec] of Object.entries(SHARDED_DATASETS)) {
    const dir = path.join(DATA_DIR, name.replace(/\.json$/, ''));
    if (!fs.existsSync(dir)) continue;

    const texts = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'));

    const parsed = timed(() => texts.map((t) => JSON.parse(t)));
    const merged = timed(() => mergeShards(parsed.value, spec.kind));

    results[name] = {
      shards: texts.length,
      totalKB: Math.round(texts.reduce((s, t) => s + t.length, 0) / 1024),
      parseMs: parsed.ms,
      mergeMs: merged.ms,
      entries: Object.keys(merged.value).length,
    };
  }

  return results;
}

function measureDelta(baseCatalog, meta, touchTrack, count) {
  const spec = SHARDED_DATASETS['catalog.json'];
  const catalog = JSON.parse(JSON.stringify(baseCatalog));
  const before = splitDataset(catalog, spec, { meta }).map((s) => JSON.stringify(s));

  const trackIds = Object.keys(catalog.tracks);
  for (let i = 0; i < count; i++) {
    const id = touchTrack(trackIds, i, count);
    catalog.tracks[id] = (catalog.tracks[id] ?? 0) + 1;
  }

  const after = splitDataset(catalog, spec, { meta }).map((s) => JSON.stringify(s));

  let changedShards = 0;
  let changedBytes = 0;
  for (let i = 0; i < after.length; i++) {
    if (after[i] !== before[i]) {
      changedShards++;
      changedBytes += after[i].length;
    }
  }

  const totalBytes = after.reduce((s, t) => s + t.length, 0);

  return {
    scrobbles: count,
    changedShards,
    totalShards: after.length,
    deltaKB: Math.round(changedBytes / 1024),
    wholeDatasetKB: Math.round(totalBytes / 1024),
    deltaRatio: Math.round((changedBytes / totalBytes) * 1000) / 1000,
  };
}

/** Track ids grouped by the canonical artist that owns them. */
function tracksByArtist(catalog, meta) {
  const byArtist = new Map();
  for (const trackId of Object.keys(catalog.tracks)) {
    const canonical = meta.trackToCanonical?.[trackId]?.[0];
    if (canonical === undefined) continue;
    const bucket = byArtist.get(canonical);
    if (bucket) bucket.push(trackId);
    else byArtist.set(canonical, [trackId]);
  }
  // Most-played first, so "a day on one artist" means a real catalog, not a
  // single-track artist that would understate the spread.
  return [...byArtist.values()].sort((a, b) => b.length - a.length);
}

/**
 * The number this whole split exists to keep small: bytes a returning client
 * downloads after a day's new scrobbles.
 *
 * Reported for three listening shapes, because the delta depends entirely on
 * how many distinct *artists* a day touches. Shards are placed by canonical
 * artist, so an artist's whole catalog moves together:
 *
 *   oneArtist   — a day on a single artist. The case artist grouping exists
 *                 for; by track id this was 62 of 64 shards.
 *   fewArtists  — five artists, roughly a normal day.
 *   varied      — 40 plays of 40 unrelated tracks. Grouping cannot help a day
 *                 that genuinely touches 40 artists, so this is the ceiling.
 *                 It climbing toward 100% is expected, not a regression; the
 *                 first two climbing is the signal that something broke.
 */
function dailyDelta() {
  const catalog = readDataset(DATA_DIR, 'catalog.json');
  const meta = loadMeta();
  if (!catalog || !meta) return null;

  const byArtist = tracksByArtist(catalog, meta);
  if (!byArtist.length) return null;

  const pickFrom = (pool) => (ids, i) => pool[i % pool.length];

  const oneArtistPool = byArtist[0];
  const fewArtistsPool = byArtist.slice(0, 5).flatMap((tracks) => tracks.slice(0, 8));

  return {
    oneArtist: measureDelta(catalog, meta, pickFrom(oneArtistPool), oneArtistPool.length),
    fewArtists: measureDelta(catalog, meta, pickFrom(fewArtistsPool), fewArtistsPool.length),
    varied: measureDelta(
      catalog,
      meta,
      (ids, i, count) => ids[(i * Math.max(1, Math.floor(ids.length / count))) % ids.length],
      40,
    ),
  };
}

export function runDataBenchmarks() {
  return {
    merge: mergeCost(),
    dailyDelta: dailyDelta(),
  };
}
