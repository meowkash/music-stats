/// <reference lib="webworker" />
import { readFiles } from './dataRepository';
import { aggregateTrackCounts, rollupByCategory, rollupTopCounts, nameCollator, type ArtistRollupMode } from './musicQueries';
import type { MetaData, YearData } from '../types/music';
import type { Manifest } from './persist/generations';
export interface QueryRequest {
  id: number;
  manifest: Manifest;
  version: string;
  start: string;
  end: string;
  category?: 'tracks' | 'albums' | 'artists';
  artistMode?: ArtistRollupMode;
  playtime?: boolean;
  search?: string;
  // Used only if persistent storage is unavailable.
  fallback?: { meta: MetaData; years: Record<string, YearData> };
}
const snapshots = new Map<string, NonNullable<QueryRequest['fallback']>>();
const counts = new Map<string, Map<number, number>>();
self.onmessage = (event: MessageEvent<QueryRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.fallback) {
        snapshots.set(request.manifest.generation, request.fallback);
        if (snapshots.size > 2) snapshots.delete(snapshots.keys().next().value!);
      }
      const snapshot = snapshots.get(request.manifest.generation);
      const years = Array.from({ length: Number(request.end.slice(0, 4)) - Number(request.start.slice(0, 4)) + 1 }, (_, i) => String(Number(request.start.slice(0, 4)) + i)).filter(y => request.manifest.files.some(f => f.path === `/data/year-${y}.json`));
      const read = async <T>(path: string) => {
        const dataset = request.manifest.datasets?.[path];
        const files = (dataset?.files ?? [path]).map(p => request.manifest.files.find(f => f.path === p));
        if (files.some(file => !file)) throw new Error(`Missing query source: ${path}`);
        return await readFiles(files as NonNullable<typeof files[number]>[], dataset?.kind, request.version) as T;
      };
      const meta = snapshot?.meta ?? await read<MetaData>('/data/meta.json');
      const key = `${request.manifest.generation}:${request.start}:${request.end}`;
      let tally = counts.get(key);
      if (!tally) {
        const cache = snapshot?.years ?? Object.fromEntries(await Promise.all(years.map(async y => [y, await read<YearData>(`/data/year-${y}.json`)])));
        tally = aggregateTrackCounts(years, request.start, request.end, cache);
        counts.set(key, tally);
        if (counts.size > 8) counts.delete(counts.keys().next().value!);
      }
      const data = request.category ? rollupByCategory(tally, meta, request.category, { artistMode: request.artistMode }) : rollupTopCounts(tally, meta);
      if (Array.isArray(data)) {
        const query = request.search?.trim().toLocaleLowerCase() ?? '';
        const filtered = query ? data.filter(item => `${item.name} ${item.subtitle ?? ''}`.toLocaleLowerCase().includes(query)) : data;
        filtered.sort((a, b) => (request.playtime ? b.playtimeMs - a.playtimeMs : b.count - a.count) || nameCollator.compare(a.name, b.name));
        self.postMessage({ id: request.id, data: filtered });
      } else self.postMessage({ id: request.id, data });
    } catch (error) { self.postMessage({ id: request.id, error: String(error) }); }
  })();
};
