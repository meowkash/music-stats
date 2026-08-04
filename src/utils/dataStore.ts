declare const __CACHE_VERSION__: string | undefined;

export const CACHE_VERSION =
  typeof __CACHE_VERSION__ !== 'undefined' ? __CACHE_VERSION__ : 'dev';

const DB_NAME = 'music-stats';
const DB_VERSION = 1;
const STORE_NAME = 'json';
const NETWORK_TIMEOUT_MS = 12_000;

const memory = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();
const revalidating = new Set<string>();

export const CRITICAL_DATA_PATHS = [
  '/data/meta.json',
  '/data/artwork.json',
  '/data/recent.json',
  '/data/yearly-totals.json',
  '/data/yearly-stats.json',
  '/data/colors.json',
] as const;

const REVALIDATE_CONCURRENCY = 3;
const CACHE_VERSION_STORAGE_KEY = 'music-stats-cache-version';

export interface DataUpdatedDetail {
  path: string;
  data: unknown;
}

export function dataUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}v=${CACHE_VERSION}`;
}

export function normalizeDataPath(path: string): string {
  return path.split('?')[0];
}

async function clearIDB(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

/** Drop persisted JSON when a new deploy ships so we don't serve stale scrobbles. */
export async function ensureCacheVersion(): Promise<void> {
  try {
    const stored = localStorage.getItem(CACHE_VERSION_STORAGE_KEY);
    if (stored === CACHE_VERSION) return;
    localStorage.setItem(CACHE_VERSION_STORAGE_KEY, CACHE_VERSION);
  } catch {
    /* ignore */
  }

  memory.clear();
  await clearIDB();
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'path' });
    };
  });
}

async function readIDB(path: string): Promise<unknown | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(path);
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function writeIDB(path: string, data: unknown): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ path, data, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* quota / private mode — memory cache still works this session */
  }
}

async function fetchNetwork<T>(url: string): Promise<T> {
  if (!navigator.onLine) {
    throw new Error('Offline');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function dataChanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function dispatchUpdate(path: string, data: unknown): void {
  window.dispatchEvent(
    new CustomEvent<DataUpdatedDetail>('data-updated', { detail: { path, data } }),
  );
}

async function revalidatePath(path: string): Promise<void> {
  if (!navigator.onLine) return;
  if (revalidating.has(path)) return;
  revalidating.add(path);
  try {
    const fresh = await fetchNetwork<unknown>(dataUrl(path));
    const prev = memory.get(path);
    memory.set(path, fresh);
    await writeIDB(path, fresh);
    if (prev !== undefined && dataChanged(prev, fresh)) {
      dispatchUpdate(path, fresh);
    }
  } catch {
    /* offline or slow — keep serving stale data */
  } finally {
    revalidating.delete(path);
  }
}

export function scheduleRevalidate(path: string): void {
  const normalized = normalizeDataPath(path);
  queueMicrotask(() => {
    void revalidatePath(normalized);
  });
}

/** Revalidate the files every view needs — fast enough to run on startup and resume. */
export async function revalidateCriticalData(): Promise<void> {
  if (!navigator.onLine) return;

  const paths = new Set<string>(CRITICAL_DATA_PATHS);
  for (const path of memory.keys()) {
    if (/^\/data\/year-\d+\.json$/.test(path)) paths.add(path);
  }

  await revalidatePaths([...paths]);
}

/** Stale-while-revalidate JSON fetch backed by IndexedDB. */
export async function fetchAppJson<T>(path: string): Promise<T> {
  const normalized = normalizeDataPath(path);

  if (memory.has(normalized)) {
    scheduleRevalidate(normalized);
    return memory.get(normalized) as T;
  }

  const pending = inflight.get(normalized);
  if (pending) return pending as Promise<T>;

  const promise = (async (): Promise<T> => {
    const cached = await readIDB(normalized);
    if (cached !== null) {
      memory.set(normalized, cached);
      scheduleRevalidate(normalized);
      return cached as T;
    }

    if (!navigator.onLine) {
      throw new Error(`Offline with no cached data for ${normalized}`);
    }

    const data = await fetchNetwork<T>(dataUrl(path));
    memory.set(normalized, data);
    await writeIDB(normalized, data);
    return data;
  })();

  inflight.set(normalized, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(normalized);
  }
}

/** Hydrate memory from IndexedDB before first paint. */
export async function warmDataCache(paths: string[]): Promise<boolean> {
  const timeoutMs = 1500;

  const work = (async () => {
    let hasAny = false;
    await Promise.all(
      paths.map(async (path) => {
        const normalized = normalizeDataPath(path);
        if (memory.has(normalized)) {
          hasAny = true;
          return;
        }
        const cached = await readIDB(normalized);
        if (cached !== null) {
          memory.set(normalized, cached);
          hasAny = true;
        }
      }),
    );
    return hasAny;
  })();

  const timedOut = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });

  return Promise.race([work, timedOut]);
}

function collectRefreshPaths(): string[] {
  const paths = new Set<string>(CRITICAL_DATA_PATHS);

  for (const path of memory.keys()) {
    paths.add(path);
  }

  const totals = memory.get('/data/yearly-totals.json') as Record<string, unknown> | undefined;
  if (totals) {
    for (const year of Object.keys(totals)) {
      paths.add(`/data/year-${year}.json`);
    }
  }

  return [...paths];
}

async function revalidatePaths(paths: string[]): Promise<number> {
  let changed = 0;
  const unique = [...new Set(paths.map(normalizeDataPath))];

  for (let i = 0; i < unique.length; i += REVALIDATE_CONCURRENCY) {
    const batch = unique.slice(i, i + REVALIDATE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (path) => {
        const prev = memory.get(path);
        await revalidatePath(path);
        const next = memory.get(path);
        return prev !== undefined && next !== undefined && dataChanged(prev, next);
      }),
    );
    changed += results.filter(Boolean).length;
  }

  return changed;
}

/** Manual refresh — revalidates critical paths plus anything loaded this session. */
export async function refreshAppData(): Promise<number> {
  if (!navigator.onLine) return 0;
  return revalidatePaths(collectRefreshPaths());
}

export async function revalidateAllCached(): Promise<void> {
  await revalidatePaths(collectRefreshPaths());
}

export function getCachedJson<T>(path: string): T | null {
  const normalized = normalizeDataPath(path);
  const value = memory.get(normalized);
  return value !== undefined ? (value as T) : null;
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
