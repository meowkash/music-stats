/// <reference lib="webworker" />

// Downloading, SHA-256 verifying and JSON.parsing the data generation used to
// run on the main thread while the user was interacting — a 3.9 MB artwork
// payload is enough main-thread time to drop a whole gesture. All of it happens
// here instead, and IndexedDB is written from the worker too, so the main thread
// only ever learns *which* paths changed.

import { FILE_STORE, idbKeys, idbSetMany } from './persist/idb';

const NETWORK_TIMEOUT_MS = 10000;
const DOWNLOAD_CONCURRENCY = 4;

interface ManifestFile {
  path: string;
  hash: string;
  bytes: number;
}

export interface SyncRequest {
  id: number;
  /** Files the active generation wants present in the store. */
  files: ManifestFile[];
  /** Cache-busting query the main thread would have used. */
  cacheVersion: string;
  /** Yield between batches so a concurrent gesture keeps the network to itself. */
  gentle?: boolean;
}

export interface SyncResponse {
  id: number;
  ok: boolean;
  /** Paths actually written this run. */
  storedPaths: string[];
  /** Files that could not be fetched or failed verification. */
  failedPaths: string[];
}

function freshUrl(path: string, cacheVersion: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}v=${cacheVersion}&fresh=1`;
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

/** Mirrors hashText() in persist/generations.ts: sha256, first 16 hex chars. */
async function hashText(text: string): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  } catch {
    return null;
  }
}

async function downloadFile(
  file: ManifestFile,
  cacheVersion: string,
): Promise<[string, unknown] | null> {
  const text = await fetchText(freshUrl(file.path, cacheVersion));

  // The SW is network-first with a deadline, so a slow network can hand back the
  // *previous* body. Verify before filing it under the new hash.
  const actual = await hashText(text);
  if (actual !== null && actual !== file.hash) return null;

  try {
    return [file.hash, JSON.parse(text)];
  } catch {
    return null;
  }
}

/** Lets the event loop (and any pending IDB callbacks) breathe between batches. */
const yieldToLoop = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sync(request: SyncRequest): Promise<SyncResponse> {
  const { id, files, cacheVersion, gentle } = request;
  const storedPaths: string[] = [];
  const failedPaths: string[] = [];

  let present: Set<IDBValidKey>;
  try {
    present = new Set(await idbKeys(FILE_STORE));
  } catch {
    present = new Set();
  }

  const missing = files.filter((f) => !present.has(f.hash));
  if (!missing.length) return { id, ok: true, storedPaths, failedPaths };

  for (let i = 0; i < missing.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = missing.slice(i, i + DOWNLOAD_CONCURRENCY);
    const settled = await Promise.all(
      batch.map((file) =>
        downloadFile(file, cacheVersion)
          .then((entry) => ({ file, entry }))
          .catch(() => ({ file, entry: null as [string, unknown] | null })),
      ),
    );

    const writes: Array<[string, unknown]> = [];
    for (const { file, entry } of settled) {
      if (entry) {
        writes.push(entry);
        storedPaths.push(file.path);
      } else {
        failedPaths.push(file.path);
      }
    }

    // Written per batch rather than all at the end: an interrupted sweep keeps
    // whatever it already verified, so the next run has less to do.
    if (writes.length) {
      try {
        await idbSetMany(FILE_STORE, writes);
      } catch {
        for (const { file } of settled) failedPaths.push(file.path);
      }
    }

    if (gentle) await yieldToLoop(50);
  }

  return { id, ok: failedPaths.length === 0, storedPaths, failedPaths };
}

self.addEventListener('message', (event: MessageEvent<SyncRequest>) => {
  void sync(event.data).then(
    (response) => (self as unknown as Worker).postMessage(response),
    () =>
      (self as unknown as Worker).postMessage({
        id: event.data.id,
        ok: false,
        storedPaths: [],
        failedPaths: event.data.files.map((f) => f.path),
      } satisfies SyncResponse),
  );
});
