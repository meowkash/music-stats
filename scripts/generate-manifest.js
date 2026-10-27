import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  CHUNKED_DATASETS,
  SHARDED_DATASETS,
  SHARD_COUNT,
  datasetDirName,
  listDataFiles,
  readDataset,
  shardFileName,
  writeChunks,
  writeDataset,
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
  // Chunked datasets ship as their chunks; the monolith stays for build tools.
  const exclude = new Set([MANIFEST_NAME, ...Object.keys(CHUNKED_DATASETS)]);
  return listDataFiles(DATA_DIR, exclude).filter(rel => !rel.startsWith('versions/')).map((rel) => {
    const bytes = fs.readFileSync(path.join(DATA_DIR, rel));
    const hash = hashBytes(bytes);
    const versionDir = path.join(DATA_DIR, 'versions');
    fs.mkdirSync(versionDir, { recursive: true });
    const immutable = path.join(versionDir, `${hash}.json`);
    if (!fs.existsSync(immutable)) fs.writeFileSync(immutable, bytes);
    return {
      path: `/data/${rel}`,
      url: `/data/versions/${hash}.json`,
      hash,
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

  for (const [name, spec] of Object.entries(CHUNKED_DATASETS)) {
    const dir = path.join(DATA_DIR, datasetDirName(name));
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
      .map((file) => `/data/${datasetDirName(name)}/${file}`);
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

// { url: weight } with weight = log2 of the best play count among the keys
// sharing that URL; the client sorts it heaviest first.
function collectArtworkUrls() {
  const cache = readJson('artwork.json');
  if (!cache) return {};

  const weights = artworkWeights();
  // artwork.json stores each URL under both a prefixed and a legacy key, so the
  // value list is roughly double the real image count.
  const byUrl = new Map();

  for (const [key, url] of Object.entries(cache)) {
    if (typeof url !== 'string' || !url.startsWith('http')) continue;
    const weight = weights.get(key) ?? 0;
    byUrl.set(url, Math.max(byUrl.get(url) ?? 0, weight));
  }

  return Object.fromEntries(
    [...byUrl.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([url, weight]) => [url, Math.floor(Math.log2(weight + 1))]),
  );
}

function generationId(files) {
  const digest = crypto.createHash('sha256');
  for (const file of files) digest.update(`${file.path}:${file.hash}\n`);
  return digest.digest('hex').slice(0, 16);
}

const artwork = collectArtworkUrls();
writeDataset(DATA_DIR, 'artwork-urls.json', artwork);
for (const name of Object.keys(CHUNKED_DATASETS)) {
  const data = readDataset(DATA_DIR, name);
  if (data) writeChunks(DATA_DIR, name, data);
}
const files = collectDataFiles();
const datasets = collectDatasets();

const manifest = {
  // 3: meta.json arrives as 'arrays' chunks, which a v2 client cannot merge.
  schemaVersion: 3,
  generation: generationId(files),
  builtAt: new Date().toISOString(),
  files,
  datasets,
  artwork: [],
  artworkPath: '/data/artwork-urls.json',
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));

const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
console.log(
  `Generated manifest ${manifest.generation}: ${files.length} files ` +
    `(${(totalBytes / 1024).toFixed(0)} KB), ${Object.keys(datasets).length} sharded datasets, ` +
    `${Object.keys(artwork).length} artwork URLs`,
);
