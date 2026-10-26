/// <reference lib="webworker" />
import { selectCatalogEntity, type CatalogEntitySelection, type EntityCatalog } from './catalogEntity';
import { buildArtworkIndex, type ArtworkFallbackIndex } from './artwork';
import { hasPersistence, loadFile, readFiles } from './dataRepository';
import type { ManifestFile } from './persist/generations';
import type { DatasetKind } from './persist/datasets';
export interface RepositoryRequest {
  id: number;
  operation: 'sync' | 'read';
  files: ManifestFile[];
  cacheVersion: string;
  kind?: DatasetKind;
  network?: boolean;
  gentle?: boolean;
  entity?: CatalogEntitySelection;
}
export interface RepositoryResponse {
  id: number;
  ok: boolean;
  persistent: boolean;
  data?: unknown;
  error?: string;
  artworkIndex?: ArtworkFallbackIndex;
}
self.addEventListener('message', (event: MessageEvent<RepositoryRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      let data: unknown;
      if (request.operation === 'read') {
        data = await readFiles(request.files, request.kind, request.cacheVersion, request.network);
        if (request.entity) data = selectCatalogEntity(data as EntityCatalog, request.entity);
      } else {
        // Bound scheduling as well as requests: backfills yield between batches.
        for (let i = 0; i < request.files.length; i += 4) {
          await Promise.all(request.files.slice(i, i + 4).map(file => loadFile(file, request.cacheVersion)));
          if (request.gentle) await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      const artworkIndex = data && request.files.every(file => file.path.startsWith('/data/artwork/') || file.path === '/data/artwork.json') ? buildArtworkIndex(data as Record<string, string>) : undefined;
      self.postMessage({ id: request.id, ok: true, persistent: hasPersistence(), data, artworkIndex } satisfies RepositoryResponse);
    } catch (error) {
      self.postMessage({ id: request.id, ok: false, persistent: hasPersistence(), error: String(error) } satisfies RepositoryResponse);
    }
  })();
});
