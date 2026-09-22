// Client half of the shard split described in scripts/data-files.js. The wire
// format is N small content-addressed files; the app still consumes one object
// per dataset, so nothing above dataStore has to know this happened.

export type DatasetKind = 'flat' | 'buckets';

export interface DatasetSpec {
  kind: DatasetKind;
  /** Shard paths, in manifest order. */
  files: string[];
}

export type DatasetMap = Record<string, DatasetSpec>;

/**
 * FNV-1a, 32-bit. Must stay byte-identical to shardIndex() in
 * scripts/data-files.js. Not used to place entries on the client — kept so a
 * future single-shard read path can resolve a key without loading the dataset.
 */
export function shardIndex(key: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

/** Reassembles shards into the object the app expects. */
export function mergeShards(shards: unknown[], kind: DatasetKind): unknown {
  if (kind === 'buckets') {
    const merged: Record<string, Record<string, unknown>> = {};
    for (const shard of shards) {
      if (!shard || typeof shard !== 'object') continue;
      for (const [bucket, entries] of Object.entries(shard as Record<string, unknown>)) {
        if (!entries || typeof entries !== 'object') continue;
        Object.assign((merged[bucket] ??= {}), entries as Record<string, unknown>);
      }
    }
    return merged;
  }

  const merged: Record<string, unknown> = {};
  for (const shard of shards) {
    if (!shard || typeof shard !== 'object') continue;
    Object.assign(merged, shard as Record<string, unknown>);
  }
  return merged;
}

/** Expands dataset paths to the shard paths that compose them; others pass through. */
export function expandDatasetPaths(paths: readonly string[], datasets: DatasetMap): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const spec = datasets[path];
    if (spec) out.push(...spec.files);
    else out.push(path);
  }
  return out;
}

/** Reverse lookup: which dataset, if any, a shard path belongs to. */
export function buildShardOwnerIndex(datasets: DatasetMap): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [datasetPath, spec] of Object.entries(datasets)) {
    for (const file of spec.files) owners.set(file, datasetPath);
  }
  return owners;
}
