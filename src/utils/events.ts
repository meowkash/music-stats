import type { EntityType } from '../types/music';

export const ENTITY_DETAILS_EVENT = 'open-entity-details';

export interface EntityDetailsDetail {
  type: EntityType | string;
  id: number;
}

export function openEntityDetails(type: EntityType | string, id: number): void {
  window.dispatchEvent(
    new CustomEvent<EntityDetailsDetail>(ENTITY_DETAILS_EVENT, {
      detail: { type, id },
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
          openEntityDetails(type, parseInt(idStr, 10));
        }
        return;
      }
    }

    const row = target.closest('.scrobble-row.clickable-entity, .carousel-item.clickable-entity');
    if (!row || !container.contains(row)) return;

    const type = row.getAttribute('data-type');
    const idStr = row.getAttribute('data-id');
    if (type && idStr && idStr !== '0') {
      openEntityDetails(type, parseInt(idStr, 10));
    }
  });
}
