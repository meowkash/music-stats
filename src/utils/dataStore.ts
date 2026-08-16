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
  '/data/recap-meta.json',
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

export function normalizeDataPath(path: string): string {
  return path.split('?')[0];
}

export function getActiveManifest(): Manifest | null {
  return activeManifest;
}

/** True when a complete generation is already on disk, readable before first paint. */
export function hasStoredData(): boolean {
  return readBootHint()?.complete === true;
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

function manifestEntry(path: string): ManifestEntryLookup {
  const normalized = normalizeDataPath(path);
  const entry = activeManifest?.files.find((f) => f.path === normalized);
  return { normalized, hash: entry?.hash };
}

interface ManifestEntryLookup {
  normalized: string;
  hash: string | undefined;
}

/**
 * Phase 1 of boot: populate memory from IndexedDB with no network access at
 * all. Only the critical set is awaited — everything else resolves from the
 * same store on demand via fetchAppJson, so first paint stays light.
 */
export async function hydrateFromStore(): Promise<boolean> {
  activeManifest = (await loadActiveManifest()) ?? null;
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

/**
 * Read a data file. Memory, then the active generation in IndexedDB, then the
 * network as a genuine last resort (first ever run, or a path the manifest
 * doesn't know about).
 */
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

export function getCachedJson<T>(path: string): T | null {
  const value = memory.get(normalizeDataPath(path));
  return value !== undefined ? (value as T) : null;
}

async function downloadFile(
  file: { path: string; hash: string },
): Promise<[string, unknown] | null> {
  const text = await fetchText(dataUrl(file.path));

  // The service worker is network-first with a 3s deadline, so a slow network
  // can hand back the *previous* body. Verifying against the manifest hash
  // stops stale bytes being filed under the new hash.
  const actual = await hashText(text);
  if (actual !== null && actual !== file.hash) return null;

  try {
    return [file.hash, JSON.parse(text)];
  } catch {
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

/**
 * Phase 2 of boot: reconcile against the server.
 *
 * Downloads land in the content-addressed file store but stay invisible until
 * every one of them has arrived; only then does the manifest pointer move. An
 * interrupted update therefore leaves the previous generation fully intact
 * rather than a half-updated mix.
 *
 * @returns the number of data files that changed.
 */
export async function stageUpdate(): Promise<number> {
  if (staging || !navigator.onLine) return 0;
  staging = true;

  try {
    const remote = await fetchNetwork<Manifest>(dataUrl(MANIFEST_PATH));
    if (!remote?.files?.length) return 0;

    if (activeManifest && activeManifest.generation === remote.generation) {
      // Same generation, but a previous run may have been interrupted before
      // the artwork sweep finished.
      dispatch<Manifest>('data-manifest-ready', remote);
      return 0;
    }

    const activeByPath = new Map(activeManifest?.files.map((f) => [f.path, f.hash]) ?? []);
    const changed = remote.files.filter((f) => activeByPath.get(f.path) !== f.hash);

    const needed: Array<{ path: string; hash: string }> = [];
    for (const file of changed) {
      const stored = await readStoredFile<unknown>(file.hash);
      if (stored === undefined) needed.push(file);
    }

    const downloaded = await downloadAll(needed);
    if (downloaded === null) return 0;

    await writeStoredFiles(downloaded);
    await commitGeneration(remote, changed.map((f) => f.path));
    dispatch<Manifest>('data-manifest-ready', remote);

    return changed.length;
  } catch {
    // Offline or the manifest is unreachable — the stored generation stands.
    return 0;
  } finally {
    staging = false;
  }
}

/** Flip the pointer, refresh memory, and announce the swap exactly once. */
async function commitGeneration(manifest: Manifest, changedPaths: string[]): Promise<void> {
  await saveActiveManifest(manifest);
  activeManifest = manifest;

  const byPath = new Map(manifest.files.map((f) => [f.path, f.hash]));
  const refreshed: string[] = [];

  for (const path of changedPaths) {
    // Only refresh what the app has actually read; anything else will pick up
    // the new hash on its next fetchAppJson.
    if (!memory.has(path)) continue;
    const hash = byPath.get(path);
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
    const remote = await fetchNetwork<Manifest>(dataUrl(MANIFEST_PATH));
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
    activeManifest = remote;
    writeBootHint({ generation: remote.generation, complete: true, artworkCached: 0 });
    dispatch<Manifest>('data-manifest-ready', remote);
  } catch {
    /* stays cold; the app falls back to direct network reads */
  }
}

/** Backfill any manifest file not yet in the store, so offline covers every view. */
export async function backfillStoredFiles(): Promise<void> {
  if (!activeManifest || !navigator.onLine) return;

  const missing: Array<{ path: string; hash: string }> = [];
  for (const file of activeManifest.files) {
    const stored = await readStoredFile<unknown>(file.hash);
    if (stored === undefined) missing.push(file);
  }
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

export function onGenerationSwapped(
  callback: (detail: GenerationSwappedDetail) => void,
): void {
  window.addEventListener('data-generation-swapped', (e) => {
    callback((e as CustomEvent<GenerationSwappedDetail>).detail);
  });
}

export function onManifestReady(callback: (manifest: Manifest) => void): void {
  window.addEventListener('data-manifest-ready', (e) => {
    callback((e as CustomEvent<Manifest>).detail);
  });
}
