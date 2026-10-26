import { fetchAppJson, getActiveManifest, hydrateFromStore, CACHE_VERSION } from './dataStore';
import type { QueryRequest } from './analytics.worker';
import type { MetaData, YearData } from '../types/music';
import { getYearsInRange, aggregateTrackCounts, rollupByCategory, rollupTopCounts, nameCollator, type RollupItem } from './musicQueries';
let worker: Worker | null | undefined;
let id = 0;
let primed = ''; 
const pending = new Map<number, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function stop(): void {
  worker?.terminate(); worker = undefined; primed = ''; 
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Analytics worker interrupted; retry the query')); }
  pending.clear();
}
export async function queryMusic<T>(options: Omit<QueryRequest, 'id' | 'manifest' | 'version' | 'fallback'>): Promise<T> {
  // Ensure sources have been verified by the shared download scheduler first.
  const years = getYearsInRange(options.start, options.end);
  await hydrateFromStore();
  const manifest = getActiveManifest()!;
  const meta = await fetchAppJson<MetaData>('/data/meta.json');
  const existing = years.filter(y => manifest.files.some(f => f.path === `/data/year-${y}.json`));
  const values = await Promise.all(existing.map(y => fetchAppJson<YearData>(`/data/year-${y}.json`)));
  if (getActiveManifest() !== manifest) return queryMusic(options);
  if (worker === undefined && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./analytics.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        const task = pending.get(event.data.id); if (!task) return;
        pending.delete(event.data.id); clearTimeout(task.timer);
        event.data.error ? task.reject(new Error(event.data.error)) : task.resolve(event.data.data);
      };
      worker.onerror = worker.onmessageerror = stop;
    } catch { worker = null; }
  }
  const fallback = { meta, years: Object.fromEntries(existing.map((y, i) => [y, values[i]])) };
  if (worker) {
    const active = worker, requestId = ++id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(stop, 30000);
      pending.set(requestId, { resolve: value => resolve(value as T), reject, timer });
      // These sources are already parsed; transfer only when IDB is unavailable
      // is possible later. Keeping a snapshot also protects eviction during a query.
      try {
        const key = `${manifest.generation}:${existing.join(',')}`;
        active.postMessage({ ...options, manifest, version: CACHE_VERSION, id: requestId, fallback: primed === key ? undefined : fallback });
        primed = key;
      } catch { stop(); }
    });
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  const counts = aggregateTrackCounts(existing, options.start, options.end, fallback.years);
  if (!options.category) return rollupTopCounts(counts, meta) as T;
  const query = options.search?.trim().toLocaleLowerCase() ?? '';
  const items: RollupItem[] = rollupByCategory(counts, meta, options.category, { artistMode: options.artistMode });
  const result = items.filter(item => !query || `${item.name} ${item.subtitle ?? ''}`.toLocaleLowerCase().includes(query));
  result.sort((a, b) => (options.playtime ? b.playtimeMs - a.playtimeMs : b.count - a.count) || nameCollator.compare(a.name, b.name));
  return result as T;
}
