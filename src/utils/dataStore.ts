import {
  MANIFEST_PATH,
  collectGarbage,
  loadActiveManifest,
  readBootHint,
  readStoredFile,
  saveActiveManifest,
  writeBootHint,
  type Manifest,
} from './persist/generations';
import {
  buildShardOwnerIndex,
  expandDatasetPaths,
  mergeShards,
  type DatasetMap,
} from './persist/datasets';
import { syncFiles } from './dataSyncClient';

declare const __CACHE_VERSION__: string | undefined;

export const CACHE_VERSION =
  typeof __CACHE_VERSION__ !== 'undefined' ? __CACHE_VERSION__ : 'dev';

const NETWORK_TIMEOUT_MS = 10000;

/** Parsed data for the active generation, keyed by data path. */
const memory = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

let activeManifest: Manifest | null = null;
let staging = false;

// Component scripts start reading on DOMContentLoaded, which races the boot
// sequence that establishes the manifest. Before sharding, losing that race was
// harmless — the path fell through to a direct network read of a file that
// existed. A sharded dataset has no such file, so a read that arrives early
// must wait to learn whether its path is a dataset.
let manifestSettled = false;
let settleManifestReady: () => void;
const manifestReady = new Promise<void>((resolve) => {
  settleManifestReady = resolve;
});

function settleManifest(): void {
  if (manifestSettled) return;
  manifestSettled = true;
  settleManifestReady();
}

/** Bounded: a boot that never resolves a manifest must not wedge every read. */
const MANIFEST_WAIT_MS = 5000;

async function awaitManifest(): Promise<void> {
  if (manifestSettled) return;
  await Promise.race([
    manifestReady,
    new Promise<void>((resolve) => setTimeout(resolve, MANIFEST_WAIT_MS)),
  ]);
}

export const CRITICAL_DATA_PATHS = [
  '/data/meta.json',
  '/data/artwork.json',
  '/data/recent.json',
  '/data/yearly-totals.json',
  '/data/yearly-stats.json',
  '/data/colors.json',
  // recap-<year>.json is deliberately absent: each is only fetched when that
  // year's story is opened, so the boot generation stays small.
  '/data/recaps.json',
] as const;

export interface DataUpdatedDetail {
  path: string;
  data: unknown;
}

export interface GenerationSwappedDetail {
  generation: string;
  changedPaths: string[];
}

export function dataUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}v=${CACHE_VERSION}`;
}

// Marks a read that must never get a stale body (manifest, hash-verified
// downloads). `v=` alone opted every read out and made the SW deadline dead code.
function freshDataUrl(path: string): string {
  return `${dataUrl(path)}&fresh=1`;
}

export function normalizeDataPath(path: string): string {
  return path.split('?')[0];
}

export function getActiveManifest(): Manifest | null {
  return activeManifest;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNetwork<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

function dispatch<T>(name: string, detail: T): void {
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

/** Rebuilt whenever the pointer moves; `manifestEntry` sits on every data read. */
let activeHashByPath = new Map<string, string>();
/** Sharded dataset path -> its shard files. Empty for a pre-shard manifest. */
let activeDatasets: DatasetMap = {};
/** Shard path -> the dataset path it feeds, so a changed shard invalidates it. */
let shardOwners = new Map<string, string>();

function setActiveManifest(manifest: Manifest | null): void {
  activeManifest = manifest;
  activeHashByPath = new Map(manifest?.files.map((f) => [f.path, f.hash]) ?? []);
  activeDatasets = manifest?.datasets ?? {};
  shardOwners = buildShardOwnerIndex(activeDatasets);
}

/** Reads every shard of a dataset from the store and reassembles it. */
async function readDataset<T>(datasetPath: string): Promise<T | undefined> {
  const spec = activeDatasets[datasetPath];
  if (!spec) return undefined;

  const shards = await Promise.all(
    spec.files.map(async (file) => {
      const hash = activeHashByPath.get(file);
      return hash ? await readStoredFile<unknown>(hash) : undefined;
    }),
  );

  // A dataset is all-or-nothing: a partial merge would look like missing data
  // rather than a failed read, and would be cached as such.
  if (shards.some((shard) => shard === undefined)) return undefined;
  return mergeShards(shards, spec.kind) as T;
}

/** Manifest entries for a dataset's shards, for handing to the sync worker. */
function shardFilesFor(datasetPath: string): Array<{ path: string; hash: string; bytes: number }> {
  const spec = activeDatasets[datasetPath];
  if (!spec) return [];
  const byPath = new Map(activeManifest?.files.map((f) => [f.path, f]) ?? []);
  return spec.files
    .map((file) => byPath.get(file))
    .filter((f): f is { path: string; hash: string; bytes: number } => Boolean(f));
}

/** One read path for both layouts, so callers never branch on shardedness. */
async function readPath<T>(path: string): Promise<T | undefined> {
  if (activeDatasets[path]) return readDataset<T>(path);
  const hash = activeHashByPath.get(path);
  return hash ? readStoredFile<T>(hash) : undefined;
}

function manifestEntry(path: string): ManifestEntryLookup {
  const normalized = normalizeDataPath(path);
  return { normalized, hash: activeHashByPath.get(normalized) };
}

interface ManifestEntryLookup {
  normalized: string;
  hash: string | undefined;
}

// Boot phase 1: fill memory from IndexedDB, no network. Only the critical set
// is awaited; the rest resolves on demand so first paint stays light.
export async function hydrateFromStore(): Promise<boolean> {
  setActiveManifest((await loadActiveManifest()) ?? null);
  // A miss here is not the end of the wait: ensureInitialGeneration() runs next
  // and settles it once the remote manifest lands.
  if (!activeManifest) return false;

  settleManifest();

  await Promise.all(
    CRITICAL_DATA_PATHS.map(async (path) => {
      const data = await readPath<unknown>(path);
      if (data !== undefined) memory.set(path, data);
    }),
  );

  return memory.size > 0;
}

// Memory, then the active generation in IndexedDB, then the network as a last
// resort (first run, or a path the manifest doesn't know).
export async function fetchAppJson<T>(path: string): Promise<T> {
  await awaitManifest();

  const { normalized, hash } = manifestEntry(path);

  if (memory.has(normalized)) return memory.get(normalized) as T;

  const pending = inflight.get(normalized);
  if (pending) return pending as Promise<T>;

  const promise = (async (): Promise<T> => {
    const spec = activeDatasets[normalized];
    if (spec) {
      const merged = await readDataset<T>(normalized);
      if (merged !== undefined) {
        memory.set(normalized, merged);
        return merged;
      }

      // Shards missing from the store — pull them, then reassemble. No
      // monolithic file exists to fall back to.
      await syncFiles(shardFilesFor(normalized), CACHE_VERSION);
      const retried = await readDataset<T>(normalized);
      if (retried !== undefined) {
        memory.set(normalized, retried);
        return retried;
      }

      const shards = await Promise.all(
        spec.files.map((file) => fetchNetwork<unknown>(dataUrl(file))),
      );
      const data = mergeShards(shards, spec.kind) as T;
      memory.set(normalized, data);
      return data;
    }

    if (hash) {
      const stored = await readStoredFile<T>(hash);
      if (stored !== undefined) {
        memory.set(normalized, stored);
        return stored;
      }
    }

    const data = await fetchNetwork<T>(dataUrl(normalized));
    memory.set(normalized, data);
    return data;
  })();

  inflight.set(normalized, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(normalized);
  }
}

/**
 * Ensures the given files are in the store, doing the download, SHA-256 verify
 * and JSON.parse on a worker. Returns false if any file could not be stored —
 * a partial generation is worse than no update, so callers bail on false.
 */
async function ensureFilesStored(
  files: Array<{ path: string; hash: string; bytes: number }>,
  options: { gentle?: boolean } = {},
): Promise<boolean> {
  const outcome = await syncFiles(files, CACHE_VERSION, options);
  return outcome.ok;
}

// Boot phase 2. Downloads stay invisible until all have landed, then the manifest
// pointer moves — so an interrupted update leaves the old generation intact.
export async function stageUpdate(): Promise<number> {
  if (staging || !navigator.onLine) return 0;
  staging = true;

  try {
    const remote = await fetchNetwork<Manifest>(freshDataUrl(MANIFEST_PATH));
    if (!remote?.files?.length) return 0;

    if (activeManifest && activeManifest.generation === remote.generation) {
      // Same generation, but a previous run may have been interrupted before
      // the artwork sweep finished.
      dispatch<Manifest>('data-manifest-ready', remote);
      return 0;
    }

    console.info('[data] New deploy detected:', remote.generation, remote.builtAt);

    // Content-addressed per shard: a daily rebuild only moves the handful of
    // shards whose entries actually changed, not the whole dataset.
    const changed = remote.files.filter((f) => activeHashByPath.get(f.path) !== f.hash);

    if (!(await ensureFilesStored(changed))) return 0;

    await commitGeneration(remote, changed.map((f) => f.path));
    dispatch<Manifest>('data-manifest-ready', remote);

    return changed.length;
  } catch (err) {
    console.warn('[DataStore] Stage remote update failed; continuing with active stored generation:', err);
    return 0;
  } finally {
    staging = false;
  }
}

/** Flip the pointer, refresh memory, and announce the swap exactly once. */
async function commitGeneration(manifest: Manifest, changedPaths: string[]): Promise<void> {
  await saveActiveManifest(manifest);
  setActiveManifest(manifest);

  // A changed shard invalidates the dataset it belongs to, not itself: nothing
  // consumes shard paths directly. Collapse to one entry per affected dataset so
  // 30 changed artwork shards trigger a single reassembly.
  const dirtyPaths = new Set<string>();
  for (const path of changedPaths) {
    dirtyPaths.add(shardOwners.get(path) ?? path);
  }

  const refreshed: string[] = [];

  for (const path of dirtyPaths) {
    // Only refresh what the app has actually read; anything else will pick up
    // the new hash on its next fetchAppJson.
    if (!memory.has(path)) continue;

    const data = await readPath<unknown>(path);
    if (data === undefined) continue;
    memory.set(path, data);
    refreshed.push(path);
  }

  writeBootHint({
    generation: manifest.generation,
    complete: true,
    artworkCached: readBootHint()?.artworkCached ?? 0,
  });

  dispatch<GenerationSwappedDetail>('data-generation-swapped', {
    generation: manifest.generation,
    changedPaths: refreshed,
  });

  // Existing per-path subscribers keep working; they now all fire within one
  // swap rather than trickling in file by file.
  for (const path of refreshed) {
    dispatch<DataUpdatedDetail>('data-updated', { path, data: memory.get(path) });
  }

  void collectGarbage(manifest);
}

/** First successful run has no stored generation, so seed one from the network. */
export async function ensureInitialGeneration(): Promise<void> {
  if (activeManifest || !navigator.onLine) {
    settleManifest();
    return;
  }

  try {
    const remote = await fetchNetwork<Manifest>(freshDataUrl(MANIFEST_PATH));
    if (!remote?.files?.length) return;

    // Published before the downloads: a read that is already waiting only needs
    // to know how to resolve its path, and can then take the store-or-network
    // route itself rather than blocking on the whole critical set.
    setActiveManifest(remote);
    settleManifest();

    // Datasets in the critical set expand to their shards.
    const criticalPaths = new Set(
      expandDatasetPaths(CRITICAL_DATA_PATHS, remote.datasets ?? {}),
    );
    const files = remote.files.filter((f) => criticalPaths.has(f.path));
    if (!(await ensureFilesStored(files))) return;

    // The manifest is recorded in full even though only the critical files were
    // downloaded; the rest resolve lazily and are backfilled by the next sweep.
    await saveActiveManifest(remote);

    // Read back through the same path a warm boot uses, so a dataset is
    // reassembled from its shards rather than special-cased here.
    await Promise.all(
      CRITICAL_DATA_PATHS.map(async (path) => {
        const data = await readPath<unknown>(path);
        if (data !== undefined) memory.set(path, data);
      }),
    );

    writeBootHint({ generation: remote.generation, complete: true, artworkCached: 0 });
    dispatch<Manifest>('data-manifest-ready', remote);
  } catch (err) {
    console.warn('[DataStore] Initial generation seed failed; falling back to direct network reads:', err);
  } finally {
    settleManifest();
  }
}

/** Backfill any manifest file not yet in the store, so offline covers every view. */
export async function backfillStoredFiles(): Promise<void> {
  if (!activeManifest || !navigator.onLine) return;

  // `gentle` — this runs while the user is interacting. The worker paces
  // itself between batches so the sweep never competes with a gesture.
  await ensureFilesStored(activeManifest.files, { gentle: true });
}

export async function revalidateCriticalData(): Promise<void> {
  await stageUpdate();
}

/** Manual refresh (pull-to-refresh). Returns the number of changed files. */
export async function refreshAppData(): Promise<number> {
  if (!navigator.onLine) return 0;
  return stageUpdate();
}

export function onPathsUpdated(
  matchers: Array<string | RegExp>,
  callback: (detail: DataUpdatedDetail) => void,
): void {
  window.addEventListener('data-updated', (e) => {
    const detail = (e as CustomEvent<DataUpdatedDetail>).detail;
    const matched = matchers.some((m) =>
      typeof m === 'string' ? m === detail.path : m.test(detail.path),
    );
    if (matched) callback(detail);
  });
}
