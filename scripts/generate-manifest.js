import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  SHARDED_DATASETS,
  SHARD_COUNT,
  datasetDirName,
  listDataFiles,
  readDataset,
  shardFileName,
} from './data-files.js';

// The contract the client downloads against. Files are content-hashed; artwork
// CDN URLs are content addresses, so the URL set *is* the invalidation signal.

const DATA_DIR = path.resolve('public/data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const MANIFEST_NAME = 'manifest.json';

function hashBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function collectDataFiles() {
  // Recursive: the sharded datasets live in per-dataset subdirectories.
  return listDataFiles(DATA_DIR, new Set([MANIFEST_NAME])).map((rel) => {
    const bytes = fs.readFileSync(path.join(DATA_DIR, rel));
    return {
      path: `/data/${rel}`,
      hash: hashBytes(bytes),
      bytes: bytes.length,
    };
  });
}

// Tells the client which shard files reassemble into each logical dataset, and
// how to merge them. Consumers keep asking for '/data/catalog.json'.
function collectDatasets() {
  const datasets = {};

  for (const [name, spec] of Object.entries(SHARDED_DATASETS)) {
    const dir = path.join(DATA_DIR, datasetDirName(name));
    if (!fs.existsSync(dir)) continue;

    const files = [];
    for (let i = 0; i < SHARD_COUNT; i++) {
      const shard = shardFileName(i);
      if (!fs.existsSync(path.join(dir, shard))) continue;
      files.push(`/data/${datasetDirName(name)}/${shard}`);
    }

    if (files.length) datasets[`/data/${name}`] = { kind: spec.kind, files };
  }

  return datasets;
}

function readJson(file) {
  try {
    return readDataset(DATA_DIR, file);
  } catch (err) {
    console.error(`[GenerateManifest] Failed to read dataset ${file}:`, err);
    return null;
  }
}

// Weighted by play count so the client warms likely covers first: the cache may
// be bounded, and a partial sweep should still cover the top albums.
function artworkWeights() {
  const catalog = readJson('catalog.json');
  const meta = readJson('meta.json');
  const weights = new Map();

  const bump = (key, value) => {
    if (!key || !value) return;
    weights.set(key, Math.max(weights.get(key) ?? 0, value));
  };

  for (const album of Object.values(catalog?.albums ?? {})) {
    bump(`album:${album.name}|${album.artistName}`, album.scrobbles);
  }
  for (const artist of Object.values(catalog?.artists ?? {})) {
    bump(`artist:${artist.name}`, artist.scrobbles);
  }
  for (const artist of Object.values(catalog?.canonicalArtists ?? {})) {
    bump(`artist:${artist.name}`, artist.scrobbles);
  }
  for (const [id, count] of Object.entries(catalog?.tracks ?? {})) {
    const track = meta?.tracks?.[Number(id)];
    if (!track) continue;
    bump(`track:${track[0]}|${meta.artists?.[track[1]] ?? ''}`, count);
  }

  return weights;
}

function collectArtworkUrls() {
  const cache = readJson('artwork.json');
  if (!cache) return [];

  const weights = artworkWeights();
  // artwork.json stores each URL under both a prefixed and a legacy key, so the
  // value list is roughly double the real image count.
  const byUrl = new Map();

  for (const [key, url] of Object.entries(cache)) {
    if (typeof url !== 'string' || !url.startsWith('http')) continue;
    const weight = weights.get(key) ?? 0;
    byUrl.set(url, Math.max(byUrl.get(url) ?? 0, weight));
  }

  return [...byUrl.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([url]) => url);
}

function generationId(files, artworkUrls) {
  const digest = crypto.createHash('sha256');
  for (const file of files) digest.update(`${file.path}:${file.hash}\n`);
  digest.update(`artwork:${artworkUrls.length}:${hashBytes(artworkUrls.join('\n'))}`);
  return digest.digest('hex').slice(0, 16);
}

const files = collectDataFiles();
const artwork = collectArtworkUrls();
const datasets = collectDatasets();

const manifest = {
  generation: generationId(files, artwork),
  builtAt: new Date().toISOString(),
  files,
  datasets,
  artwork,
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));

const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
console.log(
  `Generated manifest ${manifest.generation}: ${files.length} files ` +
    `(${(totalBytes / 1024).toFixed(0)} KB), ${Object.keys(datasets).length} sharded datasets, ` +
    `${artwork.length} artwork URLs`,
);
