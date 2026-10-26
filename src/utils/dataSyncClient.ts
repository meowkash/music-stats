import { selectCatalogEntity, type CatalogEntitySelection, type EntityCatalog } from './catalogEntity';
import type { ArtworkFallbackIndex } from './artwork';
import type { RepositoryRequest, RepositoryResponse } from './dataSync.worker';
import type { ManifestFile } from './persist/generations';
import type { DatasetKind } from './persist/datasets';
let worker: Worker | null | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: RepositoryResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function stopWorker(): void {
  worker?.terminate(); worker = null;
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Data worker unavailable')); }
  pending.clear();
}
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return worker = null;
  try {
    worker = new Worker(new URL('./dataSync.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<RepositoryResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id); clearTimeout(entry.timer);
      event.data.ok ? entry.resolve(event.data) : entry.reject(new Error(event.data.error));
    };
    worker.onerror = worker.onmessageerror = stopWorker;
  } catch { worker = null; }
  return worker;
}
async function request(input: Omit<RepositoryRequest, 'id'>): Promise<RepositoryResponse> {
  const active = getWorker();
  if (active) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(stopWorker, Math.max(30000, Math.ceil(input.files.length / 4) * 16000));
      pending.set(id, { resolve, reject, timer });
      try { active.postMessage({ ...input, id }); } catch { stopWorker(); }
    });
  }
  // Older browsers keep correctness, with a yield before CPU work. Modern
  // browsers use the worker for fetch, hash, parse, IDB reads and shard merging.
  const repository = await import('./dataRepository');
  await new Promise(resolve => setTimeout(resolve, 0));
  let data: unknown;
  if (input.operation === 'read') {
    data = await repository.readFiles(input.files, input.kind, input.cacheVersion, input.network);
    if (input.entity) data = selectCatalogEntity(data as EntityCatalog, input.entity);
  }
  else for (const file of input.files) {
    await repository.loadFile(file, input.cacheVersion);
    await new Promise(resolve => setTimeout(resolve, input.gentle ? 50 : 0));
  }
  return { id: 0, ok: true, persistent: repository.hasPersistence(), data };
}
export async function syncFiles(files: ManifestFile[], cacheVersion: string, options: { gentle?: boolean } = {}): Promise<{ ok: boolean; persistent: boolean }> {
  return request({ operation: 'sync', files, cacheVersion, ...options });
}
export async function readDataFiles<T>(files: ManifestFile[], kind: DatasetKind | undefined, cacheVersion: string, network = true): Promise<{ data: T; persistent: boolean; artworkIndex?: ArtworkFallbackIndex }> {
  const result = await request({ operation: 'read', files, kind, cacheVersion, network });
  return { data: result.data as T, persistent: result.persistent, artworkIndex: result.artworkIndex };
}

export async function readEntityCatalog(files: ManifestFile[], cacheVersion: string, entity: CatalogEntitySelection): Promise<EntityCatalog> {
  const result = await request({ operation: 'read', files, kind: 'buckets', cacheVersion, entity });
  return result.data as EntityCatalog;
}
