import { FILE_STORE, idbKeys } from './persist/idb';
import {
  MANIFEST_PATH,
  collectGarbage,
  hashText,
  loadActiveManifest,
  readBootHint,
  readStoredFile,
  saveActiveManifest,
  writeBootHint,
  writeStoredFiles,
  type Manifest,
} from './persist/generations';

declare const __CACHE_VERSION__: string | undefined;

export const CACHE_VERSION =
  typeof __CACHE_VERSION__ !== 'undefined' ? __CACHE_VERSION__ : 'dev';

const NETWORK_TIMEOUT_MS = 10000;
const DOWNLOAD_CONCURRENCY = 4;

/** Parsed data for the active generation, keyed by data path. */
const memory = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

let activeManifest: Manifest | null = null;
let staging = false;

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

function setActiveManifest(manifest: Manifest | null): void {
  activeManifest = manifest;
  activeHashByPath = new Map(manifest?.files.map((f) => [f.path, f.hash]) ?? []);
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
  if (!activeManifest) return false;

  const critical = new Set<string>(CRITICAL_DATA_PATHS);
  const entries = activeManifest.files.filter((f) => critical.has(f.path));

  await Promise.all(
    entries.map(async (file) => {
      const data = await readStoredFile<unknown>(file.hash);
      if (data !== undefined) memory.set(file.path, data);
    }),
  );

  return memory.size > 0;
}

// Memory, then the active generation in IndexedDB, then the network as a last
// resort (first run, or a path the manifest doesn't know).
export async function fetchAppJson<T>(path: string): Promise<T> {
  const { normalized, hash } = manifestEntry(path);

  if (memory.has(normalized)) return memory.get(normalized) as T;

  const pending = inflight.get(normalized);
  if (pending) return pending as Promise<T>;

  const promise = (async (): Promise<T> => {
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

async function downloadFile(
  file: { path: string; hash: string },
): Promise<[string, unknown] | null> {
  const text = await fetchText(freshDataUrl(file.path));

  // The SW is network-first with a 3s deadline, so a slow network can return the
  // *previous* body; the hash check stops stale bytes filed under the new hash.
  const actual = await hashText(text);
  if (actual !== null && actual !== file.hash) return null;

  try {
    return [file.hash, JSON.parse(text)];
  } catch (err) {
    console.error(`[DataStore] Failed to parse JSON for file ${file.path} (${file.hash}):`, err);
    return null;
  }
}

async function downloadAll(
  files: Array<{ path: string; hash: string }>,
): Promise<Array<[string, unknown]> | null> {
  const results: Array<[string, unknown]> = [];

  for (let i = 0; i < files.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = files.slice(i, i + DOWNLOAD_CONCURRENCY);
    const settled = await Promise.all(
      batch.map((file) => downloadFile(file).catch(() => null)),
    );
    // Partial generations are worse than no update: bail and keep serving the
    // generation already on disk.
    if (settled.some((entry) => entry === null)) return null;
    results.push(...(settled as Array<[string, unknown]>));
  }

  return results;
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

    const changed = remote.files.filter((f) => activeHashByPath.get(f.path) !== f.hash);

    // One transaction for the whole presence test, rather than one read per
    // file just to find out whether it is already on disk.
    const stored = new Set(await idbKeys(FILE_STORE));
    const needed = changed.filter((f) => !stored.has(f.hash));

    const downloaded = await downloadAll(needed);
    if (downloaded === null) return 0;

    await writeStoredFiles(downloaded);
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

  const refreshed: string[] = [];

  for (const path of changedPaths) {
    // Only refresh what the app has actually read; anything else will pick up
    // the new hash on its next fetchAppJson.
    if (!memory.has(path)) continue;
    const hash = activeHashByPath.get(path);
    if (!hash) continue;
    const data = await readStoredFile<unknown>(hash);
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
  if (activeManifest || !navigator.onLine) return;

  try {
    const remote = await fetchNetwork<Manifest>(freshDataUrl(MANIFEST_PATH));
    if (!remote?.files?.length) return;

    const critical = new Set<string>(CRITICAL_DATA_PATHS);
    const files = remote.files.filter((f) => critical.has(f.path));
    const downloaded = await downloadAll(files);
    if (downloaded === null) return;

    await writeStoredFiles(downloaded);

    const byHash = new Map(downloaded);
    for (const file of files) {
      const data = byHash.get(file.hash);
      if (data !== undefined) memory.set(file.path, data);
    }

    // The manifest is recorded in full even though only the critical files were
    // downloaded; the rest resolve lazily and are backfilled by the next sweep.
    await saveActiveManifest(remote);
    setActiveManifest(remote);
    writeBootHint({ generation: remote.generation, complete: true, artworkCached: 0 });
    dispatch<Manifest>('data-manifest-ready', remote);
  } catch (err) {
    console.warn('[DataStore] Initial generation seed failed; falling back to direct network reads:', err);
  }
}

/** Backfill any manifest file not yet in the store, so offline covers every view. */
export async function backfillStoredFiles(): Promise<void> {
  if (!activeManifest || !navigator.onLine) return;

  const stored = new Set(await idbKeys(FILE_STORE));
  const missing = activeManifest.files.filter((f) => !stored.has(f.hash));
  if (!missing.length) return;

  const downloaded = await downloadAll(missing);
  if (downloaded) await writeStoredFiles(downloaded);
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
