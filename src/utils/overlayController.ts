import type { MetaData } from '../types/music';
import {
  getArtworkCacheSync,
  preloadAppData,
  getMetaCache,
  getCatalogCache,
  loadCatalogCache,
} from './ui';
import { bindSwipeDismiss } from './overlayGestures';
import {
  populateOverlay,
  bindOverlayClicks,
  buildOverlayPayload,
  applyOverlayContent,
  crossfadeOverlayContent,
  initOverlayAlbumArtwork,
  type OverlayElements,
} from './overlayPopulate';
import { resetOverlayArtworkLayers } from './overlayArtwork';
import {
  OVERLAY_CROSSFADE_MS,
  OVERLAY_CONTENT_OUT_MS,
  type OverlayNavDirection,
  slideTransform,
  dualLayerTransition,
  sleep,
} from './overlayTransitions';
import { onEntityDetails, type ArtistCatalogKey } from './events';
import { onReady } from './dom';

function getCachedData(): { meta: MetaData; catalog: Record<string, unknown> } | null {
  const meta = getMetaCache() as MetaData | null;
  const catalog = getCatalogCache();
  if (!meta || !catalog) return null;
  return { meta, catalog: catalog as Record<string, unknown> };
}

async function ensureData(): Promise<{ meta: MetaData; catalog: Record<string, unknown> } | null> {
  await preloadAppData();
  const meta = getMetaCache() as MetaData | null;
  const catalog = getCatalogCache() || (await loadCatalogCache());
  if (!meta || !catalog) return null;
  return { meta, catalog: catalog as Record<string, unknown> };
}

function slideContentOut(regions: HTMLElement[], ms: number, direction: OverlayNavDirection): void {
  const transition = dualLayerTransition(ms);
  regions.forEach((el) => {
    el.classList.add('is-sliding');
    el.style.transition = transition;
    el.style.opacity = '1';
    el.style.transform = slideTransform(direction, 'in-end');
  });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      regions.forEach((el) => {
        el.style.opacity = '0';
        el.style.transform = slideTransform(direction, 'out');
      });
    });
  });
}

function slideContentIn(regions: HTMLElement[], ms: number, direction: OverlayNavDirection): void {
  const transition = dualLayerTransition(ms);
  regions.forEach((el) => {
    el.classList.add('is-sliding');
    el.style.transition = 'none';
    el.style.opacity = '0';
    el.style.transform = slideTransform(direction, 'in-start');
  });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      regions.forEach((el) => {
        el.style.transition = transition;
        el.style.opacity = '1';
        el.style.transform = slideTransform(direction, 'in-end');
      });
    });
  });
}

function clearContentTransition(regions: HTMLElement[]): void {
  regions.forEach((el) => {
    el.classList.remove('is-sliding');
    el.style.transition = '';
    el.style.opacity = '';
    el.style.transform = '';
  });
}

export function initDetailOverlay(): void {
  const backdrop = document.getElementById('detailsOverlayBackdrop') as HTMLDivElement;
  const panel = document.getElementById('detailsOverlayPanel') as HTMLDivElement;
  const overlayScrollContainer = document.getElementById('overlayScrollContainer') as HTMLDivElement;
  const overlayHeaderContent = document.getElementById('overlayHeaderContent') as HTMLDivElement;
  const overlayContentWrapper = document.getElementById('overlayContentWrapper') as HTMLDivElement;
  const overlayCloseBtn = document.getElementById('overlayCloseBtn') as HTMLButtonElement;

  const elements: OverlayElements = {
    overlayArtworkFront: document.getElementById('overlayArtworkFront') as HTMLImageElement,
    overlayArtworkBack: document.getElementById('overlayArtworkBack') as HTMLImageElement,
    overlayArtworkWrapper: document.querySelector('.overlay-artwork-wrapper') as HTMLElement,
    overlayArtworkFallback: document.getElementById('overlayArtworkFallback') as HTMLElement,
    overlayTitle: document.getElementById('overlayTitle') as HTMLElement,
    overlaySubtitle: document.getElementById('overlaySubtitle') as HTMLElement,
    overlayMetadata: document.getElementById('overlayMetadata') as HTMLElement,
    overlaySongsList: document.getElementById('overlaySongsList') as HTMLElement,
    overlayBgBlur: document.getElementById('overlayBgBlur') as HTMLElement,
    overlayColorWash: document.getElementById('overlayColorWash') as HTMLElement,
    overlayColorWashBack: document.getElementById('overlayColorWashBack') as HTMLElement,
    overlayAlbumsSection: document.getElementById('overlayAlbumsSection') as HTMLElement,
    overlayAlbumsHeader: document.getElementById('overlayAlbumsHeader') as HTMLElement,
    overlayAlbumsList: document.getElementById('overlayAlbumsList') as HTMLElement,
  };

  const contentRegions = [overlayHeaderContent, overlayContentWrapper];
  let currentEntity: { type: string; id: number; artistCatalog?: ArtistCatalogKey } | null = null;
  const navHistory: { type: string; id: number; artistCatalog?: ArtistCatalogKey }[] = [];

  function closeDetails() {
    panel.classList.remove('visible');
    backdrop.classList.remove('visible');
    document.body.classList.remove('overlay-open');
    currentEntity = null;
    navHistory.length = 0;
    panel.style.transform = '';
    panel.style.removeProperty('--overlay-bg-bottom');
    overlayScrollContainer.style.removeProperty('--overlay-bg-bottom');
    clearContentTransition(contentRegions);
    resetOverlayArtworkLayers({
      front: elements.overlayArtworkFront,
      back: elements.overlayArtworkBack,
      fallback: elements.overlayArtworkFallback,
      bgBlur: elements.overlayBgBlur,
      wrapper: elements.overlayArtworkWrapper,
    });
    elements.overlayColorWash.style.opacity = '';
    elements.overlayColorWashBack.style.opacity = '0';
  }

  async function openDetails(
    type: string,
    id: number,
    isBack = false,
    artistCatalog?: ArtistCatalogKey,
  ) {
    if (!isBack && currentEntity) {
      navHistory.push(currentEntity);
    }
    currentEntity = { type, id, artistCatalog };

    const isSwitchingEntity = panel.classList.contains('visible');
    const direction: OverlayNavDirection = isBack ? 'back' : 'forward';

    document.body.classList.add('overlay-open');

    if (!isSwitchingEntity) {
      panel.classList.add('visible');
      backdrop.classList.add('visible');
    }

    const data = getCachedData() || (await ensureData());
    if (!data) return;

    const artworkCache = getArtworkCacheSync() || {};
    const catalogKey = artistCatalog ?? (type === 'artist' ? 'canonicalArtists' : undefined);
    const payload = buildOverlayPayload(
      type,
      id,
      data.meta,
      data.catalog,
      artworkCache,
      catalogKey ?? 'canonicalArtists',
    );

    if (isSwitchingEntity) {
      overlayScrollContainer.scrollTo({ top: 0, behavior: 'auto' });

      const contentInMs = OVERLAY_CROSSFADE_MS - OVERLAY_CONTENT_OUT_MS;

      slideContentOut(contentRegions, OVERLAY_CONTENT_OUT_MS, direction);
      const visualsPromise = crossfadeOverlayContent(
        payload,
        elements,
        OVERLAY_CROSSFADE_MS,
        direction,
        overlayScrollContainer,
        panel,
      );

      await sleep(OVERLAY_CONTENT_OUT_MS);
      applyOverlayContent(payload, elements, artworkCache, overlayScrollContainer, panel);
      slideContentIn(contentRegions, contentInMs, direction);

      await visualsPromise;
      initOverlayAlbumArtwork(elements.overlayAlbumsList);
      clearContentTransition(contentRegions);
      return;
    }

    await populateOverlay(type, id, data.meta, data.catalog, {
      elements,
      artworkCache,
      onNavigate: (t, i, catalog) => openDetails(t, i, false, catalog),
      animate: false,
      scrollContainer: overlayScrollContainer,
      panel,
    }, artistCatalog ?? 'canonicalArtists');
  }

  overlayCloseBtn.addEventListener('click', () => {
    if (navHistory.length > 0) {
      const prev = navHistory.pop()!;
      openDetails(prev.type, prev.id, true, prev.artistCatalog);
    } else {
      closeDetails();
    }
  });

  backdrop.addEventListener('click', closeDetails);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('visible')) {
      closeDetails();
    }
  });

  bindSwipeDismiss({
    panel,
    scrollContainer: overlayScrollContainer,
    onDismiss: closeDetails,
  });

  bindOverlayClicks(panel, (type, id, catalog) => openDetails(type, id, false, catalog));
  onEntityDetails(({ type, id, artistCatalog }) => openDetails(type, id, false, artistCatalog));

  // iOS text autosizing can cache inflated sizes across rotation when the
  // sheet is open; reset inline layout state after the viewport settles.
  function resetOverlayLayoutAfterRotation() {
    if (!panel.classList.contains('visible')) return;
    panel.style.transform = '';
    panel.style.transition = '';
    clearContentTransition(contentRegions);
  }

  window.addEventListener('orientationchange', () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resetOverlayLayoutAfterRotation);
    });
  });
}

onReady(initDetailOverlay);
