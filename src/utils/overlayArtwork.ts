import {
  OVERLAY_CROSSFADE_MS,
  OVERLAY_EASE,
  type OverlayNavDirection,
  dualLayerTransition,
  slideTransform,
} from './overlayTransitions';
import {
  artworkContentHash,
  getStaticArtworkSources,
  normalizeStaticArtworkUrl,
} from './artwork';

function preloadImage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(url);
    img.onerror = () => reject(new Error('Artwork load failed'));
    img.src = url;
  });
}

export async function loadBestArtworkSource(url: string): Promise<string | null> {
  for (const src of getStaticArtworkSources(url)) {
    try {
      return await preloadImage(src);
    } catch {
      /* try next source */
    }
  }
  return null;
}

export interface OverlayArtworkElements {
  front: HTMLImageElement;
  back: HTMLImageElement;
  fallback: HTMLElement;
  bgBlur: HTMLElement;
  wrapper: HTMLElement | null;
}

export interface OverlayColorPair {
  primary: { r: number; g: number; b: number };
  bottom: { r: number; g: number; b: number };
}

let activeLayerIsFront = true;

function getActiveLayer(els: OverlayArtworkElements): HTMLImageElement {
  return activeLayerIsFront ? els.front : els.back;
}

function runDualLayerCrossfade(
  active: HTMLImageElement,
  incoming: HTMLImageElement,
  durationMs: number,
  direction: OverlayNavDirection,
  onStart: () => void,
): Promise<void> {
  const transition = dualLayerTransition(durationMs);

  incoming.style.transition = transition;
  active.style.transition = transition;
  incoming.style.opacity = '0';
  incoming.style.transform = slideTransform(direction, 'in-start');
  incoming.classList.add('is-visible');

  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        onStart();
        incoming.style.opacity = '1';
        incoming.style.transform = slideTransform(direction, 'in-end');
        active.style.opacity = '0';
        active.style.transform = slideTransform(direction, 'out');
      });
    });
    setTimeout(resolve, durationMs);
  });
}

function isSameArtworkVisible(active: HTMLImageElement, contentHash: string): boolean {
  return Boolean(
    contentHash &&
    active.dataset.artworkHash === contentHash &&
    active.classList.contains('is-visible') &&
    active.src,
  );
}

function showOverlayShimmer(wrapper: HTMLElement | null): void {
  if (!wrapper) return;
  wrapper.classList.add('artwork-loading');
  if (!wrapper.querySelector('.artwork-shimmer')) {
    const shimmer = document.createElement('div');
    shimmer.className = 'artwork-shimmer';
    shimmer.setAttribute('aria-hidden', 'true');
    wrapper.insertBefore(shimmer, wrapper.firstChild);
  }
}

function hideOverlayShimmer(wrapper: HTMLElement | null): void {
  if (!wrapper) return;
  wrapper.classList.remove('artwork-loading');
  const shimmer = wrapper.querySelector('.artwork-shimmer');
  if (shimmer) {
    shimmer.classList.add('artwork-shimmer-hide');
    setTimeout(() => shimmer.remove(), 120);
  }
}

export async function crossfadeOverlayArtwork(
  els: OverlayArtworkElements,
  url: string | null,
  durationMs = OVERLAY_CROSSFADE_MS,
  direction: OverlayNavDirection = 'forward',
  preloadedUrl?: string | null,
): Promise<void> {
  const { front, back, fallback, bgBlur, wrapper } = els;
  const active = getActiveLayer(els);
  const incoming = activeLayerIsFront ? back : front;

  fallback.classList.add('hidden');
  bgBlur.style.transition = `opacity ${durationMs}ms ${OVERLAY_EASE}`;

  if (!url) {
    if (!active.classList.contains('is-visible') || !active.src) {
      fallback.classList.remove('hidden');
      hideOverlayShimmer(wrapper);
      return;
    }

    const transition = dualLayerTransition(durationMs);
    front.style.transition = transition;
    back.style.transition = transition;
    front.classList.remove('is-visible');
    back.classList.remove('is-visible');
    front.style.opacity = '0';
    back.style.opacity = '0';
    front.style.transform = '';
    back.style.transform = '';
    bgBlur.style.opacity = '0';
    front.dataset.artworkHash = '';
    back.dataset.artworkHash = '';
    front.src = '';
    back.src = '';
    activeLayerIsFront = true;

    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    fallback.classList.remove('hidden');
    hideOverlayShimmer(wrapper);
    return;
  }

  if (!preloadedUrl) showOverlayShimmer(wrapper);
  const loadedUrl = preloadedUrl ?? (await loadBestArtworkSource(url));

  if (!loadedUrl) {
    hideOverlayShimmer(wrapper);
    fallback.classList.remove('hidden');
    return;
  }

  const contentHash = artworkContentHash(loadedUrl);

  if (isSameArtworkVisible(active, contentHash)) {
    hideOverlayShimmer(wrapper);
    return;
  }

  const quality = loadedUrl.includes('1000x1000') || loadedUrl.includes('600x600') ? 'high' : 'low';
  incoming.src = loadedUrl;
  incoming.dataset.artworkHash = contentHash;
  incoming.dataset.artworkQuality = quality;

  const hasVisibleArtwork = active.classList.contains('is-visible') && active.src;

  if (hasVisibleArtwork && active.dataset.artworkHash === contentHash) {
    hideOverlayShimmer(wrapper);
    return;
  }

  if (hasVisibleArtwork) {
    await runDualLayerCrossfade(active, incoming, durationMs, direction, () => {
      bgBlur.style.backgroundImage = `url('${loadedUrl}')`;
      bgBlur.style.opacity = '0.45';
    });

    active.classList.remove('is-visible');
    active.style.opacity = '0';
    active.style.transform = '';
    active.src = '';
    active.dataset.artworkHash = '';
    activeLayerIsFront = incoming === front;
  } else {
    incoming.style.transition = dualLayerTransition(durationMs);
    incoming.style.opacity = '0';
    incoming.style.transform = slideTransform(direction, 'in-start');
    incoming.classList.add('is-visible');
    bgBlur.style.backgroundImage = `url('${loadedUrl}')`;

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          incoming.style.opacity = '1';
          incoming.style.transform = slideTransform(direction, 'in-end');
          bgBlur.style.opacity = '0.45';
        });
      });
      setTimeout(resolve, durationMs);
    });

    activeLayerIsFront = incoming === front;
  }

  hideOverlayShimmer(wrapper);
}

export function resetOverlayArtworkLayers(els: OverlayArtworkElements): void {
  activeLayerIsFront = true;
  els.front.classList.remove('is-visible');
  els.back.classList.remove('is-visible');
  els.front.style.opacity = '0';
  els.back.style.opacity = '0';
  els.front.style.transform = '';
  els.back.style.transform = '';
  els.front.src = '';
  els.back.src = '';
  els.front.dataset.artworkHash = '';
  els.back.dataset.artworkHash = '';
  els.bgBlur.style.opacity = '0';
  els.bgBlur.style.backgroundImage = 'none';
}

export function washGradient(colors: OverlayColorPair): string {
  const { primary, bottom } = colors;
  return `linear-gradient(to bottom,
    rgba(${primary.r}, ${primary.g}, ${primary.b}, 0.28) 0%,
    rgba(${bottom.r}, ${bottom.g}, ${bottom.b}, 0.75) 260px,
    rgb(${bottom.r}, ${bottom.g}, ${bottom.b}) 360px,
    rgb(${bottom.r}, ${bottom.g}, ${bottom.b}) 100%)`;
}

export function applyOverlayBackground(
  scrollContainer: HTMLElement,
  panel: HTMLElement,
  bottom: { r: number; g: number; b: number },
): void {
  const value = `rgb(${bottom.r}, ${bottom.g}, ${bottom.b})`;
  scrollContainer.style.setProperty('--overlay-bg-bottom', value);
  panel.style.setProperty('--overlay-bg-bottom', value);
}

export async function crossfadeColorWash(
  front: HTMLElement,
  back: HTMLElement,
  colors: OverlayColorPair,
  durationMs = OVERLAY_CROSSFADE_MS,
): Promise<void> {
  const transition = `opacity ${durationMs}ms ${OVERLAY_EASE}`;
  front.style.transition = transition;
  back.style.transition = transition;

  back.style.background = washGradient(colors);
  back.style.opacity = '0';

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        back.style.opacity = '1';
        front.style.opacity = '0';
      });
    });
    setTimeout(resolve, durationMs);
  });

  front.style.background = washGradient(colors);
  front.style.opacity = '1';
  back.style.opacity = '0';
}

/** Wash and artwork cross-dissolve in parallel (iOS-style). */
export async function crossfadeOverlayVisuals(
  artworkEls: OverlayArtworkElements,
  washFront: HTMLElement,
  washBack: HTMLElement,
  imgUrl: string | null,
  colors: OverlayColorPair,
  durationMs = OVERLAY_CROSSFADE_MS,
  direction: OverlayNavDirection = 'forward',
): Promise<void> {
  const staticUrl = imgUrl ? normalizeStaticArtworkUrl(imgUrl) : null;
  const active = getActiveLayer(artworkEls);
  const newHash = staticUrl ? artworkContentHash(staticUrl) : '';

  const washPromise = crossfadeColorWash(washFront, washBack, colors, durationMs);

  if (staticUrl && isSameArtworkVisible(active, newHash)) {
    await washPromise;
    return;
  }

  const artworkPromise = staticUrl
    ? loadBestArtworkSource(staticUrl).then((preloadedUrl) =>
        crossfadeOverlayArtwork(artworkEls, staticUrl, durationMs, direction, preloadedUrl),
      )
    : crossfadeOverlayArtwork(artworkEls, null, durationMs, direction);

  await Promise.all([washPromise, artworkPromise]);
}
