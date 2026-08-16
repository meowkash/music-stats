import {
  FILE_STORE,
  META_STORE,
  idbDeleteMany,
  idbGet,
  idbKeys,
  idbSet,
  idbSetMany,
} from './idb';

export interface ManifestFile {
  path: string;
  hash: string;
  bytes: number;
}

export interface Manifest {
  generation: string;
  builtAt: string;
  files: ManifestFile[];
  artwork: string[];
}

/** Synchronous boot hint — the only thing read before first paint. */
export interface BootHint {
  generation: string;
  complete: boolean;
  artworkCached: number;
}

const ACTIVE_KEY = 'active';
const BOOT_HINT_KEY = 'music-stats-boot';

export const MANIFEST_PATH = '/data/manifest.json';

export function readBootHint(): BootHint | null {
  try {
    const raw = localStorage.getItem(BOOT_HINT_KEY);
    return raw ? (JSON.parse(raw) as BootHint) : null;
  } catch {
    return null;
  }
}

export function writeBootHint(hint: BootHint): void {
  try {
    localStorage.setItem(BOOT_HINT_KEY, JSON.stringify(hint));
  } catch {
    /* storage disabled — the IDB manifest is still authoritative */
  }
}

export function loadActiveManifest(): Promise<Manifest | undefined> {
  return idbGet<Manifest>(META_STORE, ACTIVE_KEY);
}

export function saveActiveManifest(manifest: Manifest): Promise<void> {
  return idbSet(META_STORE, ACTIVE_KEY, manifest);
}

export function readStoredFile<T>(hash: string): Promise<T | undefined> {
  return idbGet<T>(FILE_STORE, hash);
}

export function writeStoredFiles(entries: Array<[string, unknown]>): Promise<void> {
  return idbSetMany(FILE_STORE, entries);
}

/**
 * Must mirror scripts/generate-manifest.js: sha256 of the file's UTF-8 bytes,
 * first 16 hex chars.
 */
export async function hashText(text: string): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Drop file blobs no longer referenced by the active manifest.
 *
 * Safe to run only after a commit: until then the previous generation's blobs
 * are the copy keeping the app usable offline.
 */
export async function collectGarbage(active: Manifest): Promise<number> {
  const live = new Set(active.files.map((f) => f.hash));
  const stored = await idbKeys(FILE_STORE);
  const dead = stored.filter((key) => typeof key === 'string' && !live.has(key));
  if (dead.length) await idbDeleteMany(FILE_STORE, dead);
  return dead.length;
}
