import { onPathsUpdated, fetchEntityCatalog, getActiveManifest } from './dataStore';
import { setOverlayOpen } from './overlayState';
import { SMOOTH_EASE_CSS, SMOOTH_MS } from './motion';
import type { MetaData } from '../types/music';
import {
  getArtworkCacheSync,
  loadMetaCache,
} from './ui';
import { bindEdgeSwipeNav, bindSwipeDismiss } from './overlayGestures';
import {
  bindOverlayClicks,
  buildOverlayPayload,
  applyOverlayContent,
  applyOverlayShell,
  applyOverlayLists,
  clearOverlayContent,
  initOverlayAlbumArtwork,
  type OverlayElements,
} from './overlayPopulate';
import { crossfadeOverlayArtwork, freezeOverlayArtwork } from './overlayArtwork';
import { resetOverlayArtworkLayers } from './overlayArtwork';
import {
  OVERLAY_CROSSFADE_MS,
  OVERLAY_SLIDE_PX,
  type OverlayNavDirection,
  slideTransform,
} from './overlayTransitions';
import { onEntityDetails, type ArtistCatalogKey } from './events';
import { onReady } from './dom';

interface DetailData { meta: MetaData; catalog: Record<string, unknown> }
const detailCache = new Map<string, DetailData>();
function detailKey(type: string, id: number, artistCatalog?: ArtistCatalogKey): string {
  return `${getActiveManifest()?.generation}:${type}:${id}:${artistCatalog ?? 'canonicalArtists'}`;
}
function getCachedData(type: string, id: number, artistCatalog?: ArtistCatalogKey): DetailData | null {
  return detailCache.get(detailKey(type, id, artistCatalog)) ?? null;
}
async function ensureData(type: string, id: number, artistCatalog?: ArtistCatalogKey): Promise<DetailData | null> {
  const key = detailKey(type, id, artistCatalog);
  const meta = await loadMetaCache() as MetaData | null;
  const catalog = await fetchEntityCatalog({ type, id, artistCatalog });
  if (!meta) return null;
  if (key !== detailKey(type, id, artistCatalog)) return ensureData(type, id, artistCatalog);
  const data = { meta, catalog: catalog as unknown as Record<string, unknown> };
  detailCache.set(key, data);
  if (detailCache.size > 16) detailCache.delete(detailCache.keys().next().value!);
  return data;
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
  const overlayCloseBtn = document.getElementById('overlayCloseBtn') as HTMLButtonElement;
  const loadStatus = document.getElementById('overlayLoadStatus')!;
  const loadMessage = document.getElementById('overlayLoadMessage')!;
  const retryButton = document.getElementById('overlayRetryBtn') as HTMLButtonElement;
  function showLoadStatus(message: string | null, failed = false): void {
    loadStatus.hidden = message === null;
    loadMessage.textContent = message ?? '';
    retryButton.hidden = !failed;
    panel.setAttribute('aria-busy', String(message !== null && !failed));
  }

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

  const contentRegions = [overlayScrollContainer];
  const artworkElements = {
    front: elements.overlayArtworkFront, back: elements.overlayArtworkBack,
    fallback: elements.overlayArtworkFallback, bgBlur: elements.overlayBgBlur,
    wrapper: elements.overlayArtworkWrapper,
  };
  let navigationAnimations: Animation[] = [];
  let outgoingLayer: HTMLElement | null = null;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function clearNavigation() {
    navigationAnimations.forEach(animation => animation.cancel());
    navigationAnimations = [];
    outgoingLayer?.remove(); outgoingLayer = null;
    clearContentTransition(contentRegions);
  }
  function captureOutgoing(): { layer: HTMLElement; transform: string; opacity: string } {
    const pose = getComputedStyle(overlayScrollContainer);
    const transform = pose.transform, opacity = pose.opacity;
    const layer = overlayScrollContainer.cloneNode(true) as HTMLElement;
    layer.removeAttribute('id');
    layer.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    layer.setAttribute('aria-hidden', 'true'); layer.inert = true;
    layer.classList.add('overlay-navigation-snapshot');
    layer.style.cssText += ';position:absolute;inset:0;z-index:5;pointer-events:none;overflow:hidden;transition:none;contain:paint;';
    // Only one bounded outgoing DOM snapshot exists, without listeners or observers.
    const scrollTop = overlayScrollContainer.scrollTop;
    clearNavigation();
    panel.append(layer); layer.scrollTop = scrollTop;
    outgoingLayer = layer;
    return { layer, transform, opacity };
  }
  type NavEntry = { type: string; id: number; artistCatalog?: ArtistCatalogKey };
  let currentEntity: NavEntry | null = null;
  const navHistory: NavEntry[] = [];
  /** Entries popped by back — right-edge swipe / redo restores these. */
  const forwardStack: NavEntry[] = [];
  type NavMode = 'push' | 'back' | 'forward';

  let closeCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every open and by close; deferred content work bails when stale. */
  let currentOpenToken = 0;

  /** Restarts the entrance transition from its off-screen end state. */
  function startEntrance(): void {
    // A cold open inherits the previous entity's scroll offset otherwise.
    overlayScrollContainer.scrollTop = 0;
    panel.classList.remove('sheet-closing');
    panel.classList.remove('visible');
    backdrop.classList.remove('visible');
    void panel.offsetWidth;
    panel.classList.add('visible');
    backdrop.classList.add('visible');
  }

  function runCloseCleanup() {
    panel.style.transition = '';
    backdrop.style.transition = '';
    clearNavigation();
    showLoadStatus(null);
    document.body.classList.remove('overlay-open');
    clearOverlayContent(elements);
    panel.classList.remove('sheet-closing');
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

    // Freeze the complete visible scene through the exit. Deferred artwork,
    // navigation and data callbacks cannot alter text/cover layers mid-dismiss.
    currentOpenToken++;
    navigationAnimations.forEach(animation => animation.pause());
    freezeOverlayArtwork(artworkElements, [elements.overlayColorWash, elements.overlayColorWashBack]);

    panel.classList.add('sheet-closing');
    panel.classList.remove('visible');
    backdrop.classList.remove('visible');
    const durations = getComputedStyle(panel).transitionDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000));
    const exitMs = Math.max(...durations, 0);
    setOverlayOpen('detail', false, exitMs + 80);
    currentEntity = null;
    navHistory.length = 0;
    forwardStack.length = 0;
    panel.style.transform = '';

    // transitionend is authoritative, with a duration-based fallback for a
    // cancelled transition or reduced motion. Swipe exits can last up to 300ms.
    closeCleanupTimer = setTimeout(() => {
      closeCleanupTimer = null;
      runCloseCleanup();
    }, exitMs + 80);
  }

  panel.addEventListener('transitionend', event => {
    if (event.target !== panel || event.propertyName !== 'transform' || !closeCleanupTimer || panel.classList.contains('visible')) return;
    clearTimeout(closeCleanupTimer); closeCleanupTimer = null;
    runCloseCleanup();
  });

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
    setOverlayOpen('detail', true);

    const openToken = ++currentOpenToken;
    const isColdOpen = !isSwitchingEntity;

    // The entrance is a compositor-driven transform. Nothing that costs main
    // thread — data loads, list building, artwork decode — may run before it
    // starts, or the sheet sits still and then jumps.
    const cached = getCachedData(type, id, artistCatalog);
    if (isColdOpen && !cached) {
      // Data still loading. Blank the previous entity's content and bring the
      // sheet up now; text and lists fill in behind the animation.
      clearOverlayContent(elements);
      elements.overlayTitle.textContent = 'Loading details…';
      startEntrance();
    }

    showLoadStatus(cached ? null : 'Loading…');
    let data: DetailData;
    try {
      const loaded = cached ?? await ensureData(type, id, artistCatalog);
      if (!loaded) throw new Error('Detail metadata unavailable');
      data = loaded;
    } catch (error) {
      if (openToken !== currentOpenToken) return;
      console.warn('Detail load failed', error);
      showLoadStatus('Unable to load details. Please try again.', true);
      return;
    }
    if (openToken !== currentOpenToken) return;
    showLoadStatus(null);

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

    if (isColdOpen) {
      // O(1) work only — title, subtitle, colour wash. Safe in the frame that
      // kicks off the slide.
      applyOverlayShell(payload, elements, overlayScrollContainer, panel);
      if (cached) startEntrance();

      // Two frames in, the transform is committed and running on the
      // compositor, so the list build can't stutter it.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (openToken !== currentOpenToken) return;
          applyOverlayLists(payload, elements, artworkCache);
          initOverlayAlbumArtwork(elements.overlayAlbumsList);
          // Not awaited: artwork resolution hits the network on a cold cache.
          void crossfadeOverlayArtwork(
            {
              front: elements.overlayArtworkFront,
              back: elements.overlayArtworkBack,
              fallback: elements.overlayArtworkFallback,
              bgBlur: elements.overlayBgBlur,
              wrapper: elements.overlayArtworkWrapper,
            },
            payload.imgUrl,
            OVERLAY_CROSSFADE_MS,
            'forward',
          );
        });
      });
      return;
    }

    const outgoing = captureOutgoing();
    freezeOverlayArtwork(artworkElements, [elements.overlayColorWash, elements.overlayColorWashBack]);
    resetOverlayArtworkLayers(artworkElements);
    overlayScrollContainer.scrollTop = 0;
    applyOverlayContent(payload, elements, artworkCache, overlayScrollContainer, panel);
    // The app's spring; an edge swipe has already carried the page part of
    // the way, so it finishes a little sooner.
    const duration = reduceMotion.matches ? 0 : fromEdgeSwipe ? 320 : SMOOTH_MS;
    const timing: KeyframeAnimationOptions = { duration, easing: SMOOTH_EASE_CSS, fill: 'both' };
    overlayScrollContainer.classList.add('is-sliding');
    const incoming = overlayScrollContainer.animate([
      { transform: slideTransform(direction, 'in-start'), opacity: 0 },
      { transform: 'translate3d(0, 0, 0)', opacity: 1 },
    ], timing);
    const leaving = outgoing.layer.animate([
      { transform: outgoing.transform === 'none' ? 'translate3d(0, 0, 0)' : outgoing.transform, opacity: outgoing.opacity },
      { transform: slideTransform(direction, 'out'), opacity: 0 },
    ], timing);
    navigationAnimations = [incoming, leaving];
    // A slow/missing cover only affects its own fade, never the content slide.
    void crossfadeOverlayArtwork(artworkElements, payload.imgUrl, OVERLAY_CROSSFADE_MS, direction);
    await Promise.all(navigationAnimations.map(animation => animation.finished.catch(() => {})));
    if (openToken !== currentOpenToken) return;
    clearNavigation();
    initOverlayAlbumArtwork(elements.overlayAlbumsList);
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
  retryButton.addEventListener('click', () => {
    if (!currentEntity) return;
    const { type, id, artistCatalog } = currentEntity;
    void openDetails(type, id, 'back', artistCatalog).catch(error => console.warn('Detail retry failed', error));
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
  let refreshFrame = 0;
  function refreshWhenStill() {
    cancelAnimationFrame(refreshFrame);
    if (!currentEntity || !panel.classList.contains('visible')) return;
    const moving = panel.classList.contains('sheet-dragging') || panel.getAnimations().some(animation => animation.playState === 'running') || navigationAnimations.length > 0;
    if (moving) { refreshFrame = requestAnimationFrame(refreshWhenStill); return; }
    const entity = currentEntity, token = currentOpenToken;
    void ensureData(entity.type, entity.id, entity.artistCatalog).then(data => {
      if (!data || token !== currentOpenToken) return;
      if (panel.classList.contains('sheet-dragging') || navigationAnimations.length) { refreshFrame = requestAnimationFrame(refreshWhenStill); return; }
      const scrollTop = overlayScrollContainer.scrollTop;
      const payload = buildOverlayPayload(entity.type, entity.id, data.meta, data.catalog, getArtworkCacheSync() || {}, entity.artistCatalog ?? 'canonicalArtists');
      applyOverlayContent(payload, elements, getArtworkCacheSync() || {}, overlayScrollContainer, panel);
      overlayScrollContainer.scrollTop = scrollTop;
    }).catch(error => console.warn('Detail refresh failed; preserving visible content', error));
  }
  onPathsUpdated(['/data/meta.json', '/data/catalog.json', '/data/artwork.json', '/data/colors.json'], () => {
    detailCache.clear();
    cancelAnimationFrame(refreshFrame);
    refreshFrame = requestAnimationFrame(refreshWhenStill);
  });
  onEntityDetails(({ type, id, artistCatalog }) => { void openDetails(type, id, 'push', artistCatalog).catch(error => console.warn('Detail rendering failed', error)); });

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
