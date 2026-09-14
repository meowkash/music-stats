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

// id "0" is the placeholder for an entity that never resolved, so it opens nothing.
function emitFrom(el: Element): void {
  const type = el.getAttribute('data-type');
  const idStr = el.getAttribute('data-id');
  if (!type || !idStr || idStr === '0') return;
  const catalog = el.getAttribute('data-artist-catalog');
  openEntityDetails(
    type,
    parseInt(idStr, 10),
    catalog === 'artists' || catalog === 'canonicalArtists' ? catalog : undefined,
  );
}

export function bindEntityClicks(container: HTMLElement, options?: { nested?: boolean }): void {
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    if (options?.nested !== false) {
      const entityEl = target.closest('.clickable-entity');
      if (entityEl && container.contains(entityEl)) {
        emitFrom(entityEl);
        return;
      }
    }

    const row = target.closest('.scrobble-row.clickable-entity, .carousel-item.clickable-entity');
    if (row && container.contains(row)) emitFrom(row);
  });
}
