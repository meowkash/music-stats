import { MANIFEST_PATH, collectGarbage, leaseGeneration, loadActiveManifest, saveActiveManifest, writeBootHint, readBootHint, type Manifest, type ManifestFile } from './persist/generations';
import { buildShardOwnerIndex } from './persist/datasets';
import { primeArtworkIndex } from './artwork';
import type { MetaData } from '../types/music';
import type { CatalogEntitySelection, EntityCatalog } from './catalogEntity';
import { readDataFiles, readEntityCatalog, syncFiles } from './dataSyncClient';

declare const __CACHE_VERSION__: string | undefined;
export const CACHE_VERSION = typeof __CACHE_VERSION__ !== 'undefined' ? __CACHE_VERSION__ : 'dev';
export const CRITICAL_DATA_PATHS = ['/data/recent.json', '/data/yearly-totals.json', '/data/yearly-stats.json', '/data/recaps.json'] as const;
export interface DataUpdatedDetail { path: string; data: unknown }
export interface GenerationSwappedDetail { generation: string; changedPaths: string[] }
export type RefreshResult = { status: 'updated' | 'unchanged' | 'offline' | 'failed'; changedPaths: string[]; error?: string; persistent?: boolean };
let memory = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();
let activeManifest: Manifest | null = null;
let initialization: Promise<void> | null = null;
let staging: Promise<RefreshResult> | null = null;
let persistent = true;
let needsRetry = false;

export function normalizeDataPath(path: string): string { return path.split('?')[0]; }
export function dataUrl(path: string): string { return `${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(CACHE_VERSION)}`; }
export function getActiveManifest(): Manifest | null { return activeManifest; }
function dispatch<T>(name: string, detail: T): void { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail })); }
function inline<T>(id: string): T | null {
  try { return JSON.parse(document.getElementById(id)?.textContent || 'null') as T | null; } catch { return null; }
}
export function validateManifest(value: unknown): Manifest {
  const m = value as Manifest;
  if (!m || (m.schemaVersion !== undefined && m.schemaVersion > 3) || typeof m.generation !== 'string' || !Array.isArray(m.files) || !m.files.length) throw new Error('Invalid data manifest');
  const paths = new Set<string>();
  for (const file of m.files) {
    if (!/^\/data\/[a-zA-Z0-9_./-]+\.json$/.test(file.path) || file.path.includes('..') || !/^[a-f0-9]{16}$/.test(file.hash) || !Number.isFinite(file.bytes) || paths.has(file.path)) throw new Error('Invalid manifest file');
    if (file.url && file.url !== `/data/versions/${file.hash}.json`) throw new Error('Invalid immutable data URL');
    paths.add(file.path);
  }
  for (const spec of Object.values(m.datasets ?? {})) {
    if (!['flat', 'buckets', 'arrays'].includes(spec.kind) || !spec.files.length || spec.files.some(p => !paths.has(p))) throw new Error('Incomplete manifest dataset');
  }
  return m;
}
async function networkManifest(): Promise<Manifest> {
  const response = await fetch(`${dataUrl(MANIFEST_PATH)}&fresh=1`, { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
  return validateManifest(await response.json());
}
function initialize(): Promise<void> {
  return initialization ??= (async () => {
    const stored = await loadActiveManifest();
    const embedded = typeof document === 'undefined' ? null : inline<Manifest>('boot-manifest');
    const selected = stored && (!embedded || stored.builtAt >= embedded.builtAt) ? stored : embedded;
    activeManifest = selected ? validateManifest(selected) : await networkManifest();
    void leaseGeneration(activeManifest).catch(() => {});
    if (embedded?.generation === activeManifest.generation) {
      const data = inline<Record<string, unknown>>('boot-data');
      for (const [path, value] of Object.entries(data ?? {})) memory.set(path, value);
    }
  })().catch(error => { initialization = null; needsRetry = true; throw error; });
}
function filesFor(manifest: Manifest, path: string): ManifestFile[] {
  const paths = manifest.datasets?.[path]?.files ?? [path];
  const index = new Map(manifest.files.map(file => [file.path, file]));
  const files = paths.map(p => index.get(p));
  if (files.some(f => !f)) throw new Error(`Path unavailable in generation: ${path}`);
  return files as ManifestFile[];
}
function signature(manifest: Manifest, path: string): string {
  try { return `${manifest.datasets?.[path]?.kind ?? 'file'}:${filesFor(manifest, path).map(f => f.hash).join(',')}`; } catch { return ''; }
}
async function readSnapshot<T>(manifest: Manifest, path: string, network = true): Promise<T> {
  const result = await readDataFiles<T>(filesFor(manifest, path), manifest.datasets?.[path]?.kind, CACHE_VERSION, network);
  persistent &&= result.persistent;
  if (result.artworkIndex) primeArtworkIndex(result.data as Record<string, string>, result.artworkIndex);
  return result.data;
}
export async function hydrateFromStore(): Promise<boolean> { await initialize(); return !!activeManifest; }
export async function ensureInitialGeneration(): Promise<void> {
  await initialize();
  await Promise.all(CRITICAL_DATA_PATHS.map(path => fetchAppJson(path)));
  await persistManifest(activeManifest!);
}
async function persistManifest(manifest: Manifest): Promise<void> {
  if (persistent) try { await saveActiveManifest(manifest); } catch { persistent = false; }
  writeBootHint({ generation: manifest.generation, complete: persistent, artworkCached: readBootHint()?.artworkCached ?? 0 });
}
export async function fetchAppJson<T>(path: string): Promise<T> {
  await initialize();
  const normalized = normalizeDataPath(path);
  // A superseded response is never allowed to write into the published view.
  for (;;) {
    const snapshot = activeManifest!;
    if (memory.has(normalized)) return memory.get(normalized) as T;
    const key = `${snapshot.generation}:${normalized}`;
    let promise = inflight.get(key);
    if (!promise) {
      promise = readSnapshot<T>(snapshot, normalized);
      inflight.set(key, promise);
    }
    let value: unknown;
    try { value = await promise; }
    catch (error) { if (snapshot !== activeManifest) continue; needsRetry = true; throw error; }
    finally { if (inflight.get(key) === promise) inflight.delete(key); }
    if (snapshot !== activeManifest) continue;
    memory.set(normalized, value);
    return value as T;
  }
}
async function commit(remote: Manifest): Promise<string[]> {
  const previous = activeManifest;
  const logical = (manifest: Manifest | null) => manifest ? [...manifest.files.map(f => f.path), ...Object.keys(manifest.datasets ?? {})] : [];
  const owners = buildShardOwnerIndex(remote.datasets ?? {});
  const oldOwners = buildShardOwnerIndex(previous?.datasets ?? {});
  const changed = [...new Set([...logical(previous), ...logical(remote)].map(p => owners.get(p) ?? oldOwners.get(p) ?? p))]
    .filter(path => !previous || signature(previous, path) !== signature(remote, path));
  const next = new Map(memory);
  await Promise.all(changed.map(async path => {
    next.delete(path);
    if (!signature(remote, path)) return;
    if (memory.has(path) || CRITICAL_DATA_PATHS.includes(path as typeof CRITICAL_DATA_PATHS[number])) next.set(path, await readSnapshot(remote, path));
  }));
  // Everything is prepared before either pointer becomes visible.
  await persistManifest(remote);
  activeManifest = remote; memory = next;
  dispatch<GenerationSwappedDetail>('data-generation-swapped', { generation: remote.generation, changedPaths: changed });
  for (const path of changed) dispatch<DataUpdatedDetail>('data-updated', { path, data: memory.get(path) });
  channel?.postMessage(remote.generation);
  return changed;
}
export function stageUpdate(): Promise<RefreshResult> {
  if (staging) return staging;
  staging = (async (): Promise<RefreshResult> => {
    if (!navigator.onLine) return { status: 'offline', changedPaths: [] };
    try {
      await initialize();
      const remote = await networkManifest();
      if (remote.builtAt && activeManifest?.builtAt && remote.builtAt < activeManifest.builtAt) throw new Error('Server returned an older data snapshot');
      if (activeManifest?.generation === remote.generation) {
        void leaseGeneration(activeManifest).catch(() => {});
        if (needsRetry) { needsRetry = false; if (typeof window !== 'undefined') window.dispatchEvent(new Event('data-retry')); }
        return { status: 'unchanged', changedPaths: [], persistent };
      }
      // Verify all required bodies, including unchanged files evicted by storage.
      await leaseGeneration(remote, activeManifest ?? undefined).catch(() => {});
      // The prefetch list is not needed to show the new generation; the gentle
      // backfill fetches it afterwards.
      const deferred = new Set(remote.artworkPath ? remote.datasets?.[remote.artworkPath]?.files ?? [remote.artworkPath] : []);
      const result = await syncFiles(remote.files.filter(file => !deferred.has(file.path)), CACHE_VERSION);
      persistent &&= result.persistent;
      const changedPaths = await commit(remote);
      if (persistent && 'locks' in navigator) await navigator.locks.request('music-stats-gc', () => collectGarbage(remote)).catch(() => {});
      return { status: 'updated', changedPaths, persistent };
    } catch (error) {
      if (activeManifest) void leaseGeneration(activeManifest).catch(() => {});
      console.warn('[DataStore] Refresh failed; keeping the previous snapshot', error);
      return { status: 'failed', changedPaths: [], error: String(error) };
    }
  })().finally(() => { staging = null; });
  return staging;
}
export async function backfillStoredFiles(): Promise<void> {
  await initialize();
  if (!navigator.onLine || !activeManifest) return;
  const snapshot = activeManifest;
  const result = await syncFiles(snapshot.files, CACHE_VERSION, { gentle: true });
  persistent &&= result.persistent;
  if (snapshot === activeManifest) await persistManifest(snapshot);
}
export async function revalidateCriticalData(): Promise<void> { await stageUpdate(); }
export const refreshAppData = stageUpdate;
// Coalesce every matching path in one publication into one callback per view.
export function onPathsUpdated(matchers: Array<string | RegExp>, callback: (detail: DataUpdatedDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let latest: DataUpdatedDetail | null = null;
  let active = true;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<DataUpdatedDetail>).detail;
    if (!matchers.some(m => typeof m === 'string' ? m === detail.path : m.test(detail.path))) return;
    const queued = latest !== null; latest = detail;
    if (!queued) queueMicrotask(() => { const value = latest; latest = null; if (active && value) callback(value); });
  };
  const retry = () => { if (active) callback({ path: '', data: undefined }); };
  window.addEventListener('data-updated', handler);
  window.addEventListener('data-retry', retry);
  return () => { active = false; window.removeEventListener('data-updated', handler); window.removeEventListener('data-retry', retry); };
}
const channel = typeof document !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('music-stats-data') : null;
if (channel) channel.onmessage = event => { if (event.data !== activeManifest?.generation) void stageUpdate(); };

export async function fetchEntityCatalog(selection: CatalogEntitySelection): Promise<EntityCatalog> {
  await initialize();
  for (;;) {
    const snapshot = activeManifest!;
    const meta = await fetchAppJson<MetaData>('/data/meta.json');
    if (snapshot !== activeManifest) continue;
    const catalog = await readEntityCatalog(filesFor(snapshot, '/data/catalog.json'), CACHE_VERSION, {
      ...selection, artistId: selection.type === 'track' ? meta.tracks[selection.id]?.[1] : selection.artistId,
    });
    if (snapshot === activeManifest) return catalog;
  }
}
