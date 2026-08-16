import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Emits public/data/manifest.json — the contract the client uses to decide what
 * it actually needs to download.
 *
 * Files are content-hashed so a deploy that doesn't change a file costs nothing
 * to "update". Artwork URLs are listed because the CDNs we use (mzstatic,
 * Last.fm) are content-addressed: a changed cover means a changed URL, so the
 * URL set *is* the invalidation signal — no separate image hashing needed.
 */

const DATA_DIR = path.resolve('public/data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const MANIFEST_NAME = 'manifest.json';

function hashBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function collectDataFiles() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((name) => name.endsWith('.json') && name !== MANIFEST_NAME)
    .sort()
    .map((name) => {
      const bytes = fs.readFileSync(path.join(DATA_DIR, name));
      return {
        path: `/data/${name}`,
        hash: hashBytes(bytes),
        bytes: bytes.length,
      };
    });
}

function readJson(file) {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Weight each artwork key by how much it's actually listened to, so the client
 * warms the covers you're most likely to see first. This matters because the
 * cache may be bounded: a partial sweep should still cover your top albums.
 */
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

const manifest = {
  generation: generationId(files, artwork),
  builtAt: new Date().toISOString(),
  files,
  artwork,
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));

const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
console.log(
  `Generated manifest ${manifest.generation}: ${files.length} files ` +
    `(${(totalBytes / 1024).toFixed(0)} KB), ${artwork.length} artwork URLs`,
);
