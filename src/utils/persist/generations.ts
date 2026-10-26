import type { DatasetMap } from './datasets';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  FILE_STORE,
  META_STORE,
  idbDeleteMany,
  idbGet,
  idbKeys,
  idbSet,
  idbSetMany,
  idbUpdateMany,
} from './idb';

export interface ManifestFile {
  path: string;
  hash: string;
  bytes: number;
  url?: string;
}

export interface Manifest {
  generation: string;
  builtAt: string;
  files: ManifestFile[];
  // Absent on manifests built before the shard split; dataStore treats a
  // missing map as "every path is a whole file", which is the old behaviour.
  datasets?: DatasetMap;
  artwork: string[];
  artworkPath?: string;
  schemaVersion?: number;
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
    // Boot hint is an optimisation; losing it only costs a slower first paint.
  }
}

export function loadActiveManifest(): Promise<Manifest | undefined> {
  return idbGet<Manifest>(META_STORE, ACTIVE_KEY);
}

export async function saveActiveManifest(manifest: Manifest): Promise<void> {
  await idbUpdateMany(META_STORE, [ACTIVE_KEY, 'history'], ([stored, prior]) => {
    const current = stored as Manifest | undefined;
    const history = (prior as Manifest[] | undefined) ?? [];
    // A late backfill or another tab must never move durable state backwards.
    if (current && current.builtAt > manifest.builtAt) return [];
    const retained = [manifest, ...history.filter(m => m.generation !== manifest.generation)].slice(0, 3);
    return [[ACTIVE_KEY, manifest], ['history', retained]];
  });
}
const clientId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
export async function leaseGeneration(manifest: Manifest, previous?: Manifest): Promise<void> {
  await idbSet(META_STORE, `lease:${clientId}`, { manifests: previous ? [manifest, previous] : [manifest], expires: Date.now() + 86400000 });
}


export function readStoredFile<T>(hash: string): Promise<T | undefined> {
  return idbGet<T>(FILE_STORE, hash);
}

export function writeStoredFiles(entries: Array<[string, unknown]>): Promise<void> {
  return idbSetMany(FILE_STORE, entries);
}

// Must mirror scripts/generate-manifest.js: sha256 of the file's UTF-8 bytes,
// first 16 hex chars.
export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  let digest: Uint8Array | undefined;
  // Desktop localhost is a secure context; an iPhone opening the same dev
  // server over a LAN HTTP address is not. Verify identical bytes in both.
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try { digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
    catch { /* Some webviews expose SubtleCrypto but reject its operations. */ }
  }
  digest ??= sha256(bytes);
  return [...digest.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Drop blobs the active manifest no longer references. Only safe after a commit:
// until then those blobs are what keeps the app usable offline.
export async function collectGarbage(active: Manifest): Promise<number> {
  const retained = [active, ...(await idbGet<Manifest[]>(META_STORE, 'history') ?? [])];
  const leases = (await idbKeys(META_STORE)).filter(key => String(key).startsWith('lease:'));
  for (const key of leases) {
    const lease = await idbGet<{ manifests?: Manifest[]; manifest?: Manifest; expires: number }>(META_STORE, key);
    if (lease && lease.expires > Date.now()) retained.push(...(lease.manifests ?? (lease.manifest ? [lease.manifest] : [])));
    else await idbDeleteMany(META_STORE, [key]);
  }
  const live = new Set(retained.flatMap(m => m.files.map(f => f.hash)));
  const dead = (await idbKeys(FILE_STORE)).filter(key => typeof key === 'string' && !live.has(key));
  await idbDeleteMany(FILE_STORE, dead);
  return dead.length;
}
