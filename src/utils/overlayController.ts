import type { MetaData } from '../types/music';
import {
  getArtworkCacheSync,
  preloadAppData,
  getMetaCache,
  getCatalogCache,
  loadCatalogCache,
} from './ui';
import { bindEdgeSwipeNav, bindSwipeDismiss } from './overlayGestures';
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
  OVERLAY_SLIDE_PX,
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
  type NavEntry = { type: string; id: number; artistCatalog?: ArtistCatalogKey };
  let currentEntity: NavEntry | null = null;
  const navHistory: NavEntry[] = [];
  /** Entries popped by back — right-edge swipe / redo restores these. */
  const forwardStack: NavEntry[] = [];
  type NavMode = 'push' | 'back' | 'forward';

  let closeCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  function runCloseCleanup() {
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

  function closeDetails() {
    if (closeCleanupTimer) {
      clearTimeout(closeCleanupTimer);
      closeCleanupTimer = null;
    }

    panel.classList.remove('visible');
    backdrop.classList.remove('visible');
    document.body.classList.remove('overlay-open');
    currentEntity = null;
    navHistory.length = 0;
    forwardStack.length = 0;
    panel.style.transform = '';

    // Let the slide-out start on the compositor before tearing down artwork /
    // lists — that sync work was the main source of the "delayed" dismiss feel.
    closeCleanupTimer = setTimeout(() => {
      closeCleanupTimer = null;
      runCloseCleanup();
    }, 380);
  }

  function frames(count: number): Promise<void> {
    return new Promise((resolve) => {
      const step = (n: number) => {
        if (n <= 0) resolve();
        else requestAnimationFrame(() => step(n - 1));
      };
      step(count);
    });
  }

  async function openDetails(
    type: string,
    id: number,
    mode: NavMode | boolean = 'push',
    artistCatalog?: ArtistCatalogKey,
    opts?: { fromEdgeSwipe?: boolean },
  ) {
    if (closeCleanupTimer) {
      clearTimeout(closeCleanupTimer);
      closeCleanupTimer = null;
      runCloseCleanup();
    }

    // Boolean kept for older call sites: true → back, false → push.
    const navMode: NavMode = mode === true ? 'back' : mode === false ? 'push' : mode;

    if (navMode === 'push' && currentEntity) {
      navHistory.push(currentEntity);
      // New branch invalidates anything that was ahead.
      forwardStack.length = 0;
    }
    currentEntity = { type, id, artistCatalog };

    const isSwitchingEntity = panel.classList.contains('visible');
    const direction: OverlayNavDirection = navMode === 'back' ? 'back' : 'forward';
    const fromEdgeSwipe = Boolean(opts?.fromEdgeSwipe);

    document.body.classList.add('overlay-open');

    if (!isSwitchingEntity) {
      // Paint the off-screen state, then add .visible so the CSS transition
      // actually runs instead of jumping straight to the end state.
      panel.classList.remove('visible');
      backdrop.classList.remove('visible');
      void panel.offsetWidth;
      panel.classList.add('visible');
      backdrop.classList.add('visible');
      // Yield two frames so the slide is on the compositor before DOM work.
      await frames(2);
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

      const contentInMs = fromEdgeSwipe
        ? OVERLAY_CROSSFADE_MS
        : OVERLAY_CROSSFADE_MS - OVERLAY_CONTENT_OUT_MS;

      const visualsPromise = crossfadeOverlayContent(
        payload,
        elements,
        OVERLAY_CROSSFADE_MS,
        direction,
        overlayScrollContainer,
        panel,
      );

      if (fromEdgeSwipe) {
        // Edge swipe already drove content to this direction's "out" end state.
        contentRegions.forEach((el) => {
          el.classList.add('is-sliding');
          el.style.transition = 'none';
          el.style.opacity = '0';
          el.style.transform = slideTransform(direction, 'out');
        });
      } else {
        slideContentOut(contentRegions, OVERLAY_CONTENT_OUT_MS, direction);
        await sleep(OVERLAY_CONTENT_OUT_MS);
      }

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
      onNavigate: (t, i, catalog) => openDetails(t, i, 'push', catalog),
      animate: false,
      scrollContainer: overlayScrollContainer,
      panel,
    }, artistCatalog ?? 'canonicalArtists');
  }

  function goBackOrClose() {
    if (navHistory.length > 0) {
      if (currentEntity) forwardStack.push(currentEntity);
      const prev = navHistory.pop()!;
      void openDetails(prev.type, prev.id, 'back', prev.artistCatalog);
    } else {
      closeDetails();
    }
  }

  overlayCloseBtn.addEventListener('click', goBackOrClose);

  backdrop.addEventListener('click', closeDetails);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('visible')) {
      closeDetails();
    }
  });

  bindSwipeDismiss({
    panel,
    scrollContainer: overlayScrollContainer,
    backdrop,
    onDismiss: closeDetails,
    // Steal edges only while the matching stack has somewhere to go.
    reserveLeftEdgePx: () => (navHistory.length > 0 ? 22 : 0),
    reserveRightEdgePx: () => (forwardStack.length > 0 ? 22 : 0),
  });

  bindEdgeSwipeNav({
    gestureEl: panel,
    contentEls: contentRegions,
    direction: 'back',
    canNavigate: () => navHistory.length > 0,
    slidePx: OVERLAY_SLIDE_PX,
    onNavigate: () => {
      if (navHistory.length === 0 || !currentEntity) return;
      forwardStack.push(currentEntity);
      const prev = navHistory.pop()!;
      void openDetails(prev.type, prev.id, 'back', prev.artistCatalog, { fromEdgeSwipe: true });
    },
  });

  bindEdgeSwipeNav({
    gestureEl: panel,
    contentEls: contentRegions,
    direction: 'forward',
    canNavigate: () => forwardStack.length > 0,
    slidePx: OVERLAY_SLIDE_PX,
    onNavigate: () => {
      if (forwardStack.length === 0 || !currentEntity) return;
      navHistory.push(currentEntity);
      const next = forwardStack.pop()!;
      void openDetails(next.type, next.id, 'forward', next.artistCatalog, { fromEdgeSwipe: true });
    },
  });

  bindOverlayClicks(panel, (type, id, catalog) => openDetails(type, id, 'push', catalog));
  onEntityDetails(({ type, id, artistCatalog }) => openDetails(type, id, 'push', artistCatalog));

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
