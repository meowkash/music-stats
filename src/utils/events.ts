import type { EntityType } from '../types/music';

export const ENTITY_DETAILS_EVENT = 'open-entity-details';

export type ArtistCatalogKey = 'artists' | 'canonicalArtists';

export interface EntityDetailsDetail {
  type: EntityType | string;
  id: number;
  artistCatalog?: ArtistCatalogKey;
}

export function openEntityDetails(
  type: EntityType | string,
  id: number,
  artistCatalog?: ArtistCatalogKey,
): void {
  window.dispatchEvent(
    new CustomEvent<EntityDetailsDetail>(ENTITY_DETAILS_EVENT, {
      detail: { type, id, ...(artistCatalog ? { artistCatalog } : {}) },
    }),
  );
}

export function onEntityDetails(handler: (detail: EntityDetailsDetail) => void): void {
  window.addEventListener(ENTITY_DETAILS_EVENT, ((e: CustomEvent<EntityDetailsDetail>) => {
    handler(e.detail);
  }) as EventListener);
}

export function bindEntityClicks(
  container: HTMLElement,
  options?: { nested?: boolean },
): void {
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    if (options?.nested !== false) {
      const entityEl = target.closest('.clickable-entity');
      if (entityEl && container.contains(entityEl)) {
        const type = entityEl.getAttribute('data-type');
        const idStr = entityEl.getAttribute('data-id');
        if (type && idStr && idStr !== '0') {
          const catalog = entityEl.getAttribute('data-artist-catalog');
          openEntityDetails(
            type,
            parseInt(idStr, 10),
            catalog === 'artists' || catalog === 'canonicalArtists' ? catalog : undefined,
          );
        }
        return;
      }
    }

    const row = target.closest('.scrobble-row.clickable-entity, .carousel-item.clickable-entity');
    if (!row || !container.contains(row)) return;

    const type = row.getAttribute('data-type');
    const idStr = row.getAttribute('data-id');
    if (type && idStr && idStr !== '0') {
      const catalog = row.getAttribute('data-artist-catalog');
      openEntityDetails(
        type,
        parseInt(idStr, 10),
        catalog === 'artists' || catalog === 'canonicalArtists' ? catalog : undefined,
      );
    }
  });
}
