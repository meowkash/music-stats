import { FILE_STORE, idbGet, idbSet } from './persist/idb';
import { hashText, type ManifestFile } from './persist/generations';
import { mergeShards, type DatasetKind } from './persist/datasets';

// Shared by the download worker and the compatibility fallback. Every request
// joins the same hash promise and global network limit, including backfills.
const resident = new Map<string, unknown>();
const pending = new Map<string, Promise<unknown>>();
const merged = new Map<string, unknown>();
let downloads = 0;
const queue: Array<{ priority: number; run: () => void }> = [];
let persistent = true;
export function hasPersistence(): boolean { return persistent; }
async function slot(priority: number): Promise<() => void> {
  if (downloads >= 4) await new Promise<void>(resolve => {
    queue.push({ priority, run: () => { downloads++; resolve(); } });
    queue.sort((a, b) => b.priority - a.priority);
  });
  else downloads++;
  return () => { downloads--; queue.shift()?.run(); };
}
function retain(hash: string, value: unknown): void {
  resident.delete(hash);
  resident.set(hash, value);
  if (resident.size > 256) resident.delete(resident.keys().next().value!);
}
export async function loadFile(file: ManifestFile, version: string, network = true): Promise<unknown> {
  if (resident.has(file.hash)) return resident.get(file.hash);
  const key = `${file.hash}:${network}`;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const stored = await idbGet(FILE_STORE, file.hash);
    if (stored !== undefined) { retain(file.hash, stored); return stored; }
    if (!network) throw new Error(`Offline data unavailable: ${file.path}`);
    const release = await slot(/\/(artwork|colors)(\/|[.-])/.test(file.path) ? 0 : 1);
    try {
      const response = await fetch(`${file.url ?? file.path}?v=${encodeURIComponent(version)}&hash=${file.hash}&fresh=1`, {
        cache: 'no-cache', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`${file.path}: HTTP ${response.status}`);
      const text = await response.text();
      const actual = await hashText(text);
      if (!actual || actual !== file.hash) throw new Error(`Data integrity mismatch: ${file.path}`);
      const value: unknown = JSON.parse(text);
      try { await idbSet(FILE_STORE, file.hash, value); } catch { persistent = false; }
      retain(file.hash, value);
      return value;
    } finally { release(); }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
export async function readFiles(files: ManifestFile[], kind: DatasetKind | undefined, version: string, network = true): Promise<unknown> {
  if (!files.length) throw new Error('Dataset has no files');
  const key = `${kind ?? 'file'}:${files.map(f => f.hash).join(',')}`;
  if (merged.has(key)) return merged.get(key);
  const values = await Promise.all(files.map(file => loadFile(file, version, network)));
  const value = kind ? mergeShards(values, kind) : values[0];
  merged.set(key, value);
  if (merged.size > 12) merged.delete(merged.keys().next().value!);
  return value;
}
