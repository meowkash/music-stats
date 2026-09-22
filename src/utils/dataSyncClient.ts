// Main-thread handle on dataSync.worker. Keeps one worker alive for the session
// and falls back to an in-page download when Workers are unavailable, so the
// data layer behaves identically either way — just with the cost back on the
// main thread.

import type { SyncRequest, SyncResponse } from './dataSync.worker';
import { FILE_STORE, idbKeys, idbSetMany } from './persist/idb';
import { hashText } from './persist/generations';

interface SyncFile {
  path: string;
  hash: string;
  bytes: number;
}

export interface SyncOutcome {
  ok: boolean;
  storedPaths: string[];
  failedPaths: string[];
}

let worker: Worker | null | undefined;
let nextRequestId = 1;
const pending = new Map<number, (result: SyncResponse) => void>();

function failPending(): void {
  for (const [id, resolve] of pending) {
    resolve({ id, ok: false, storedPaths: [], failedPaths: [] });
  }
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;

  if (typeof Worker === 'undefined') {
    worker = null;
    return null;
  }

  try {
    const created = new Worker(new URL('./dataSync.worker.ts', import.meta.url), {
      type: 'module',
    });
    created.addEventListener('message', (event: MessageEvent<SyncResponse>) => {
      const resolve = pending.get(event.data.id);
      if (!resolve) return;
      pending.delete(event.data.id);
      resolve(event.data);
    });
    created.addEventListener('error', (err) => {
      console.warn('[DataSync] Worker failed; syncing on the main thread:', err);
      worker = null;
      failPending();
      created.terminate();
    });
    worker = created;
  } catch (err) {
    console.warn('[DataSync] Worker unavailable; syncing on the main thread:', err);
    worker = null;
  }

  return worker;
}

/** Last-resort path: same logic as the worker, paid for on the main thread. */
async function syncOnMainThread(files: SyncFile[], cacheVersion: string): Promise<SyncOutcome> {
  const storedPaths: string[] = [];
  const failedPaths: string[] = [];

  let present: Set<IDBValidKey>;
  try {
    present = new Set(await idbKeys(FILE_STORE));
  } catch {
    present = new Set();
  }

  const writes: Array<[string, unknown]> = [];

  for (const file of files.filter((f) => !present.has(f.hash))) {
    try {
      const sep = file.path.includes('?') ? '&' : '?';
      const res = await fetch(`${file.path}${sep}v=${cacheVersion}&fresh=1`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      const actual = await hashText(text);
      if (actual !== null && actual !== file.hash) throw new Error('hash mismatch');

      writes.push([file.hash, JSON.parse(text)]);
      storedPaths.push(file.path);
    } catch {
      failedPaths.push(file.path);
    }
  }

  if (writes.length) {
    try {
      await idbSetMany(FILE_STORE, writes);
    } catch {
      return { ok: false, storedPaths: [], failedPaths: files.map((f) => f.path) };
    }
  }

  return { ok: failedPaths.length === 0, storedPaths, failedPaths };
}

/**
 * Ensures every listed file is present in the content-addressed store.
 * `gentle` paces the sweep for background backfill, where finishing fast matters
 * far less than not competing with whatever the user is doing.
 */
export async function syncFiles(
  files: SyncFile[],
  cacheVersion: string,
  options: { gentle?: boolean } = {},
): Promise<SyncOutcome> {
  if (!files.length) return { ok: true, storedPaths: [], failedPaths: [] };

  const active = getWorker();
  if (!active) return syncOnMainThread(files, cacheVersion);

  const id = nextRequestId++;
  const request: SyncRequest = { id, files, cacheVersion, gentle: options.gentle };

  const response = await new Promise<SyncResponse>((resolve) => {
    pending.set(id, resolve);
    try {
      active.postMessage(request);
    } catch {
      pending.delete(id);
      resolve({ id, ok: false, storedPaths: [], failedPaths: [] });
    }
  });

  // A worker that died mid-request reports nothing stored and nothing failed;
  // retry in-page rather than silently leaving the generation incomplete.
  if (!response.ok && !response.failedPaths.length && !response.storedPaths.length) {
    return syncOnMainThread(files, cacheVersion);
  }

  return {
    ok: response.ok,
    storedPaths: response.storedPaths,
    failedPaths: response.failedPaths,
  };
}
