import fs from 'fs';
import path from 'path';

// The three big datasets are rewritten by almost every daily build, so shipping
// them whole meant re-downloading ~8.8 MB for a handful of new scrobbles. On
// disk and on the wire they are split into content-addressed shards; the client
// reassembles them into the same single object the app has always consumed, so
// only the shards that actually changed cross the network.
//
// `flat`    — a plain key → value map, sharded by key.
// `buckets` — { bucket: { id: value } }, sharded with buckets preserved, so a
//             merge is one Object.assign per bucket.
//
// `groupBy` decides *placement*. Merging is placement-agnostic, so this is a
// build-side concern only — the client never needs to know.
//
// The catalog groups by canonical artist rather than by each entry's own id.
// Placing by id scatters a day's listening across the whole shard space,
// because the index is a hash: 40 plays of 40 distinct tracks dirtied 28 of 64
// shards. An artist's tracks, albums and aliases now land together, so a day
// spent on a few artists dirties a few shards.
export const SHARDED_DATASETS = {
  'artwork.json': { kind: 'flat' },
  'colors.json': { kind: 'flat' },
  'catalog.json': { kind: 'buckets', groupBy: 'canonicalArtist' },
};

// ~60 KB per shard for artwork/catalog at current data volumes. meta.json is
// deliberately absent: its buckets are positional arrays whose index *is* the
// entity id, and at 740 KB it isn't worth the reassembly complexity.
export const SHARD_COUNT = 64;

/**
 * FNV-1a, 32-bit. Must stay byte-identical to shardIndex() in
 * src/utils/persist/datasets.ts — a divergence silently drops entries.
 */
export function shardIndex(key, count = SHARD_COUNT) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

export function datasetDirName(name) {
  return name.replace(/\.json$/, '');
}

export function shardFileName(index) {
  return `${String(index).padStart(2, '0')}.json`;
}

/**
 * Maps every catalog entry to the canonical artist that owns it. Raw artists
 * fold onto their canonical identity so aliases and collaborations sit with the
 * artist they belong to. Multi-valued mappings take the primary entry — the
 * grouping only has to be deterministic, not complete.
 */
function canonicalArtistGrouper(meta) {
  if (!meta) {
    throw new Error("Sharding catalog.json by canonical artist requires 'meta'");
  }

  const tracks = meta.tracks ?? [];
  const rawToCanonical = meta.rawToCanonical ?? [];
  const trackToCanonical = meta.trackToCanonical ?? [];

  const canonicalOf = (artistId) => {
    const mapped = rawToCanonical[artistId];
    return Array.isArray(mapped) && mapped.length ? mapped[0] : artistId;
  };

  return (bucket, id, value) => {
    const numericId = Number(id);

    switch (bucket) {
      case 'canonicalArtists':
        return `c:${numericId}`;
      case 'artists':
        return `c:${canonicalOf(numericId)}`;
      case 'albums':
        return `c:${canonicalOf(value?.artistId ?? 0)}`;
      case 'tracks': {
        const mapped = trackToCanonical[numericId];
        if (Array.isArray(mapped) && mapped.length) return `c:${mapped[0]}`;
        const track = tracks[numericId];
        return `c:${canonicalOf(track ? track[1] : 0)}`;
      }
      default:
        // An unrecognised bucket still has to land somewhere stable.
        return `${bucket}:${id}`;
    }
  };
}

function groupKeyResolver(spec, context) {
  if (spec.groupBy === 'canonicalArtist') return canonicalArtistGrouper(context.meta);
  return null;
}

function emptyShards(kind, buckets) {
  return Array.from({ length: SHARD_COUNT }, () =>
    kind === 'buckets' ? Object.fromEntries(buckets.map((b) => [b, {}])) : {},
  );
}

/**
 * Splits a dataset into SHARD_COUNT plain objects, ready to serialise.
 * `context` carries whatever the spec's `groupBy` needs — for the catalog, the
 * meta dictionaries that resolve an entry to its canonical artist.
 */
export function splitDataset(data, spec, context = {}) {
  if (spec.kind === 'buckets') {
    const buckets = Object.keys(data);
    const shards = emptyShards('buckets', buckets);
    const groupKey = groupKeyResolver(spec, context);

    for (const bucket of buckets) {
      for (const [id, value] of Object.entries(data[bucket])) {
        const key = groupKey ? groupKey(bucket, id, value) : id;
        shards[shardIndex(key)][bucket][id] = value;
      }
    }
    return shards;
  }

  const shards = emptyShards('flat', []);
  for (const [key, value] of Object.entries(data)) {
    shards[shardIndex(key)][key] = value;
  }
  return shards;
}

/**
 * Inverse of splitDataset. Placement-agnostic by construction: every bucket is
 * merged wholesale, so changing `groupBy` never requires a reader change.
 */
export function mergeShards(shards, kind) {
  if (kind === 'buckets') {
    const merged = {};
    for (const shard of shards) {
      for (const [bucket, entries] of Object.entries(shard)) {
        Object.assign((merged[bucket] ??= {}), entries);
      }
    }
    return merged;
  }

  return Object.assign({}, ...shards);
}

/**
 * Reads a dataset whether it is sharded or still a single file, so a working
 * tree that predates the split (or a dataset we never shard, like meta.json)
 * keeps loading.
 */
export function readDataset(dataDir, name) {
  const spec = SHARDED_DATASETS[name];
  const dir = path.join(dataDir, datasetDirName(name));

  if (spec && fs.existsSync(dir)) {
    const shards = [];
    for (let i = 0; i < SHARD_COUNT; i++) {
      const file = path.join(dir, shardFileName(i));
      if (!fs.existsSync(file)) continue;
      shards.push(JSON.parse(fs.readFileSync(file, 'utf-8')));
    }
    return mergeShards(shards, spec.kind);
  }

  const monolith = path.join(dataDir, name);
  if (!fs.existsSync(monolith)) return null;
  return JSON.parse(fs.readFileSync(monolith, 'utf-8'));
}

/**
 * Writes a dataset in whichever layout it is configured for. Sharded writes
 * clear the monolith, so `public/data` never ships both copies.
 */
export function writeDataset(dataDir, name, data, context = {}) {
  const spec = SHARDED_DATASETS[name];

  if (!spec) {
    fs.writeFileSync(path.join(dataDir, name), JSON.stringify(data));
    return;
  }

  const dir = path.join(dataDir, datasetDirName(name));
  fs.mkdirSync(dir, { recursive: true });

  const shards = splitDataset(data, spec, context);
  shards.forEach((shard, i) => {
    const file = path.join(dir, shardFileName(i));
    const next = JSON.stringify(shard);
    // Rewriting an unchanged shard would give it a new mtime but the same
    // hash, so this is only to save the disk write — the manifest hashes
    // content and would not have marked it changed either way.
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === next) return;
    fs.writeFileSync(file, next);
  });

  fs.rmSync(path.join(dataDir, name), { force: true });
}

/** Every publishable JSON under public/data, including shard subdirectories. */
export function listDataFiles(dataDir, exclude = new Set()) {
  const out = [];

  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith('.json') && !exclude.has(rel)) {
        out.push(rel);
      }
    }
  };

  walk(dataDir, '');
  return out;
}
