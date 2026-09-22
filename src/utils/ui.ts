import { fetchAppJson, onPathsUpdated } from './dataStore';
import { getGlowStyle } from './theme';
import { getStaticArtworkSources, getThumbArtworkSources, normalizeStaticArtworkUrl, resolveAlbumArtwork, resolveArtistArtwork, resolveArtistArtworkFromCandidates, resolveArtworkFromCache, resolveTrackArtwork, type ArtworkEntityType } from './artwork';
import { normalizeBottomColor, type Rgb } from './colorSurface';

export interface ScrobbleRowData {
  type: string;
  id: string | number;
  rank?: number;
  name: string;
  subtitle: string;
  imgUrl: string | null;
  count: number | string;
  color?: string;
  /** Pre-built style for the count cell. Takes precedence over `color` — lets a
      caller bake the glow in at build time instead of re-styling every row after. */
  countStyle?: string;
  infoHtml?: string;
  showThumb?: boolean;
  artistCatalog?: 'artists' | 'canonicalArtists';
}

const TRACK_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
const ALBUM_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>`;
const ARTIST_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M5 20c0-4 3.5-6 7-6s7 2 7 6"/></svg>`;

export function getArtworkFallbackHTML(type: ArtworkEntityType | string = 'track'): string {
  const icon = getArtworkFallbackIcon(type);
  return `<div class="artwork-fallback artwork-fallback--${type}">${icon}</div>`;
}

export function getArtworkFallbackIcon(type: ArtworkEntityType | string = 'track'): string {
  if (type === 'artist') return ARTIST_ICON_SVG;
  if (type === 'album') return ALBUM_ICON_SVG;
  return TRACK_ICON_SVG;
}

export function escapeHTML(str: string): string {
  if (!str) return '';
  return str.replace(/[&<>'"]/g,
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

let artworkCache: Record<string, string> | null = null;

export async function loadArtworkCache(): Promise<Record<string, string>> {
  if (artworkCache) return artworkCache;
  try {
    artworkCache = await fetchAppJson<Record<string, string>>('/data/artwork.json');
  } catch (e) {
    console.error('Failed to load artwork.json', e);
    artworkCache = {};
  }
  return artworkCache;
}

export function getArtworkCacheSync(): Record<string, string> | null {
  return artworkCache;
}

// meta.json: eager; catalog.json (~2MB): idle preload for detail overlay
let metaCache: { artists: string[]; albums: string[]; tracks: [string, number, number][] } | null = null;
let catalogCache: Record<string, unknown> | null = null;
let catalogPromise: Promise<void> | null = null;

export async function loadMetaCache(): Promise<typeof metaCache> {
  if (metaCache) return metaCache;
  try {
    metaCache = await fetchAppJson<{
      artists: string[];
      albums: string[];
      tracks: [string, number, number][];
    }>('/data/meta.json');
  } catch (e) {
    console.error('Failed to load meta.json', e);
  }
  return metaCache;
}

export async function loadCatalogCache(): Promise<Record<string, unknown> | null> {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = fetchAppJson<Record<string, unknown>>('/data/catalog.json')
      .then((catalog) => { catalogCache = catalog; })
      .catch((e) => console.error('Failed to load catalog.json', e));
  }
  await catalogPromise;
  return catalogCache;
}

function scheduleIdle(fn: () => void) {
  if ('requestIdleCallback' in window) {
    (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback(fn, { timeout: 2000 });
  } else {
    // Safari lacks requestIdleCallback
    setTimeout(fn, 150);
  }
}

export async function preloadAppData(): Promise<void> {
  await Promise.all([loadMetaCache(), loadArtworkCache()]);
  scheduleIdle(() => { loadCatalogCache(); });
}

export function getMetaCache() { return metaCache; }
export function getCatalogCache() { return catalogCache; }

export function getArtworkUrl(
  type: string,
  name: string,
  artistName: string,
  albumName: string,
  cache?: Record<string, string>,
): string | null {
  const c = cache || artworkCache || {};
  if (type === 'track') {
    return resolveTrackArtwork(name, artistName, albumName, c);
  }
  if (type === 'artist') {
    return resolveArtistArtwork(name, c);
  }
  if (type === 'album') return resolveAlbumArtwork(name, artistName, c);
  return resolveArtworkFromCache(type as ArtworkEntityType, name, artistName, c);
}

export function getArtistArtworkUrl(
  name: string,
  cache?: Record<string, string>,
  fallbackNames: string[] = [],
): string | null {
  const c = cache || artworkCache || {};
  return resolveArtistArtworkFromCandidates([name, ...fallbackNames], c);
}

export function getArtworkThumbHTML(
  imgUrl: string | null,
  type: ArtworkEntityType | string = 'track',
  options?: { shimmer?: boolean },
): string {
  if (!imgUrl) {
    return getArtworkFallbackHTML(type);
  }
  // Smallest source first: these render at ~44px, so a 500px bitmap costs ~13x
  // the bytes and decode time for pixels that get thrown away.
  const sources = getThumbArtworkSources(imgUrl);
  const lowRes = sources[0] || normalizeStaticArtworkUrl(imgUrl) || imgUrl;
  const highRes = sources[sources.length - 1] || lowRes;
  const shimmerHtml = options?.shimmer === false
    ? ''
    : '<div class="artwork-shimmer" aria-hidden="true"></div>';
  return `
    ${shimmerHtml}
    <img class="artwork-img" src="${escapeHTML(lowRes)}" alt="" crossorigin="anonymous"
         decoding="async" data-artwork-thumb="true" data-fallback-src="${escapeHTML(highRes)}" />
  `;
}

// One shared sweep rather than a setTimeout per image: a scrolled leaderboard
// binds hundreds at once and a timer each was overhead for a rare case.
const ARTWORK_STALL_MS = 8000;
const ARTWORK_STALL_SWEEP_MS = 1000;
const ARTWORK_MAX_RETRIES = 2;
/** Retries are capped globally so a slow network can't pile up hundreds of them. */
const ARTWORK_RETRY_CONCURRENCY = 4;
const SHIMMER_FADE_MS = 280;
const OVERLAY_SHIMMER_FADE_MS = 120;

const stallWatch = new Map<HTMLImageElement, { deadline: number; onStall: () => void }>();
let stallTimer: ReturnType<typeof setInterval> | null = null;

function stopStallSweepIfIdle(): void {
  if (stallTimer !== null && stallWatch.size === 0) {
    clearInterval(stallTimer);
    stallTimer = null;
  }
}

function sweepStalledArtwork(): void {
  const now = Date.now();
  for (const [img, entry] of [...stallWatch]) {
    if (entry.deadline > now) continue;
    stallWatch.delete(img);
    entry.onStall();
  }
  stopStallSweepIfIdle();
}

function watchForStall(img: HTMLImageElement, onStall: () => void): void {
  stallWatch.set(img, { deadline: Date.now() + ARTWORK_STALL_MS, onStall });
  if (stallTimer === null) stallTimer = setInterval(sweepStalledArtwork, ARTWORK_STALL_SWEEP_MS);
}

function unwatchStall(img: HTMLImageElement): void {
  stallWatch.delete(img);
  stopStallSweepIfIdle();
}

const retryQueue: Array<() => void> = [];
let retriesInFlight = 0;

function pumpRetries(): void {
  while (retriesInFlight < ARTWORK_RETRY_CONCURRENCY && retryQueue.length > 0) {
    const run = retryQueue.shift()!;
    retriesInFlight++;
    run();
  }
}

function scheduleRetry(run: () => void): void {
  retryQueue.push(run);
  pumpRetries();
}

function releaseRetrySlot(): void {
  if (retriesInFlight > 0) retriesInFlight--;
  pumpRetries();
}

// Cross-fade shimmer out to avoid blink while image fades in
function fadeOutShimmer(shimmer: Element | null) {
  if (!shimmer) return;
  shimmer.classList.add('artwork-shimmer-hide');
  const isOverlay = shimmer.closest('.overlay-album-card-artwork, .overlay-artwork-wrapper');
  const ms = isOverlay ? OVERLAY_SHIMMER_FADE_MS : SHIMMER_FADE_MS;
  setTimeout(() => shimmer.remove(), ms);
}

function showArtworkFallback(thumb: HTMLElement) {
  thumb.classList.remove('artwork-loading');
  thumb.classList.add('artwork-error');
  const entity = thumb.closest('[data-type]') as HTMLElement | null;
  const entityType = entity?.getAttribute('data-type') || 'track';
  const existing = thumb.querySelector('.artwork-fallback');
  if (!existing) {
    const fb = document.createElement('div');
    fb.className = `artwork-fallback artwork-fallback--${entityType}`;
    fb.innerHTML = entityType === 'artist' ? ARTIST_ICON_SVG : entityType === 'album' ? ALBUM_ICON_SVG : TRACK_ICON_SVG;
    thumb.appendChild(fb);
  }
  fadeOutShimmer(thumb.querySelector('.artwork-shimmer'));
  const img = thumb.querySelector('img.artwork-img') as HTMLImageElement | null;
  if (img) img.remove();
}

function markArtworkLoaded(thumb: HTMLElement) {
  thumb.classList.remove('artwork-loading');
  thumb.classList.add('artwork-loaded');
  fadeOutShimmer(thumb.querySelector('.artwork-shimmer'));
}

interface ArtworkLoadCallbacks {
  onSuccess: (src: string, quality: 'high' | 'low') => void;
  onFailure: () => void;
  beforeRetry?: () => void;
}

// First attempt runs immediately on the browser's own error handling; only
// retries queue behind the cap, and only a no-load/no-error request times out.
function loadArtworkWithRetry(
  img: HTMLImageElement,
  sources: string[],
  callbacks: ArtworkLoadCallbacks,
): void {
  const maxAttempts = sources.length * ARTWORK_MAX_RETRIES;
  let attempt = 0;
  let holdsRetrySlot = false;
  let settled = false;

  const releaseSlot = () => {
    if (!holdsRetrySlot) return;
    holdsRetrySlot = false;
    releaseRetrySlot();
  };

  const detach = () => {
    unwatchStall(img);
    img.onload = null;
    img.onerror = null;
  };

  const succeed = (src: string, quality: 'high' | 'low') => {
    if (settled) return;
    settled = true;
    detach();
    releaseSlot();
    callbacks.onSuccess(src, quality);
  };

  const fail = () => {
    if (settled) return;
    settled = true;
    detach();
    releaseSlot();
    callbacks.onFailure();
  };

  // Exhaust high-res retries before falling back to low-res
  const sourceIndexFor = (n: number) => Math.min(Math.floor(n / ARTWORK_MAX_RETRIES), sources.length - 1);

  const advance = () => {
    if (settled) return;
    detach();
    releaseSlot();
    attempt++;
    if (attempt >= maxAttempts) {
      fail();
      return;
    }
    scheduleRetry(() => {
      holdsRetrySlot = true;
      tryLoad();
    });
  };

  const tryLoad = () => {
    if (settled) {
      releaseSlot();
      return;
    }

    const idx = sourceIndexFor(attempt);
    const src = sources[idx];
    const quality: 'high' | 'low' = idx === 0 ? 'high' : 'low';
    callbacks.beforeRetry?.();

    img.onload = () => succeed(src, quality);
    img.onerror = advance;
    watchForStall(img, advance);

    if (img.src !== src) {
      img.src = src;
    } else if (img.complete) {
      if (img.naturalWidth > 0) succeed(src, quality);
      else advance();
    }
  };

  tryLoad();
}

function bindArtworkImage(img: HTMLImageElement) {
  if (img.dataset.artworkBound) return;
  img.dataset.artworkBound = 'true';

  const thumb = img.closest('.scrobble-row-thumb, .overlay-album-card-artwork, .overlay-artwork-wrapper, .carousel-artwork-wrapper') as HTMLElement;
  if (!thumb) return;

  thumb.classList.add('artwork-loading');

  const primarySrc = img.src;
  const fallbackSrc = img.dataset.fallbackSrc || primarySrc;
  const sources = img.dataset.artworkThumb
    ? getThumbArtworkSources(primarySrc)
    : getStaticArtworkSources(primarySrc);
  if (sources.length === 0) {
    sources.push(primarySrc);
    if (fallbackSrc !== primarySrc) sources.push(fallbackSrc);
  }

  loadArtworkWithRetry(img, sources, {
    beforeRetry: () => { img.style.opacity = '0'; },
    onSuccess: () => {
      img.style.opacity = '';
      markArtworkLoaded(thumb);
    },
    onFailure: () => showArtworkFallback(thumb),
  });
}

function bindOverlayAlbumCardImage(img: HTMLImageElement) {
  if (img.dataset.artworkBound) return;
  img.dataset.artworkBound = 'true';

  const thumb = img.closest('.overlay-album-card-artwork') as HTMLElement | null;
  if (!thumb) return;

  thumb.querySelector('.artwork-shimmer')?.remove();

  const markLoaded = () => {
    thumb.classList.add('artwork-loaded');
    img.style.opacity = '';
  };

  if (img.complete) {
    if (img.naturalWidth > 0) {
      markLoaded();
      return;
    } else {
      // Already failed before binding
      const fallbackSrc = img.dataset.fallbackSrc;
      if (fallbackSrc && img.src !== fallbackSrc && img.src !== window.location.href) {
        img.onerror = () => showArtworkFallback(thumb);
        img.src = fallbackSrc;
        return;
      }
      showArtworkFallback(thumb);
      return;
    }
  }

  img.onload = () => markLoaded();
  img.onerror = () => {
    const fallbackSrc = img.dataset.fallbackSrc;
    if (fallbackSrc && img.src !== fallbackSrc) {
      img.onerror = () => showArtworkFallback(thumb);
      img.src = fallbackSrc;
      return;
    }
    showArtworkFallback(thumb);
  };
}

// Either a container to search or the exact nodes, so an infinite-scroll chunk
// can touch only its own rows instead of re-querying everything rendered.
export type RenderScope = ParentNode | Iterable<Element>;

function eachMatch(scope: RenderScope, selector: string, fn: (el: Element) => void): void {
  if (typeof (scope as ParentNode).querySelectorAll === 'function') {
    (scope as ParentNode).querySelectorAll(selector).forEach(fn);
    return;
  }
  for (const el of scope as Iterable<Element>) {
    if (el.matches(selector)) fn(el);
    el.querySelectorAll(selector).forEach(fn);
  }
}

export function initArtworkImages(scope: RenderScope = document) {
  eachMatch(
    scope,
    'img.artwork-img, .scrobble-row-thumb img:not([data-artwork-bound]), .carousel-artwork-wrapper img:not([data-artwork-bound])',
    (el) => bindArtworkImage(el as HTMLImageElement),
  );
}

export function initOverlayAlbumArtwork(container: ParentNode = document) {
  container.querySelectorAll('.overlay-album-card-artwork img.artwork-img').forEach((el) => {
    bindOverlayAlbumCardImage(el as HTMLImageElement);
  });
}


export function generateScrobbleRowHTML(data: ScrobbleRowData, showRank: boolean = true): string {
  const showThumb = data.showThumb !== false;
  const thumbContent = showThumb ? getArtworkThumbHTML(data.imgUrl, data.type || 'track') : '';
  const rankClass = data.rank && data.rank <= 3 ? ` rank-${data.rank}` : '';
  const rankHtml = showRank ? `<span class="scrobble-row-rank${rankClass}">${data.rank}</span>` : '';
  const countColorStyle =
    data.countStyle ??
    (data.color ? `color: ${data.color}; text-shadow: 0 0 10px ${data.color}80;` : '');

  const infoBlock = data.infoHtml ?? `
        <span class="scrobble-row-title">${escapeHTML(data.name)}</span>
        <span class="scrobble-row-subtitle">${escapeHTML(data.subtitle)}</span>`;

  const clickableClass = data.type && data.id !== undefined ? ' clickable-entity' : '';

  const catalogAttr = data.artistCatalog ? ` data-artist-catalog="${data.artistCatalog}"` : '';
  return `
    <div class="scrobble-row${clickableClass}" data-type="${escapeHTML(data.type)}" data-id="${data.id}"${catalogAttr}>
      ${rankHtml}
      ${showThumb ? `<div class="scrobble-row-thumb">${thumbContent}</div>` : ''}
      <div class="scrobble-row-info">${infoBlock}</div>
      <div class="scrobble-row-right">
        <span class="scrobble-count-val" style="${countColorStyle}">${typeof data.count === 'number' ? data.count.toLocaleString() : escapeHTML(String(data.count))}</span>
      </div>
    </div>
  `;
}

let colorsCache: Record<string, ColorEntry> | null = null;
let colorsPromise: Promise<void> | null = null;

export interface ColorEntry {
  r: number;
  g: number;
  b: number;
  bottom?: Rgb;
  bottomVersion?: number;
}

export async function loadColorsCache() {
  if (colorsCache) return;
  if (!colorsPromise) {
    colorsPromise = fetchAppJson<Record<string, ColorEntry>>('/data/colors.json')
      .then((data) => { colorsCache = data; resolvedColorEntries.clear(); })
      .catch((e) => { console.error('Failed to load colors.json', e); colorsCache = {}; });
  }
  await colorsPromise;
  // Components render in parallel with this load, so anything that painted
  // during the race is sitting on the fallback glow and needs a second pass.
  repaintPendingGlows();
}

onPathsUpdated(['/data/artwork.json'], ({ data }) => {
  artworkCache = data as Record<string, string>;
});

onPathsUpdated(['/data/meta.json'], ({ data }) => {
  metaCache = data as typeof metaCache;
});

onPathsUpdated(['/data/catalog.json'], ({ data }) => {
  catalogCache = data as Record<string, unknown>;
});

onPathsUpdated(['/data/colors.json'], ({ data }) => {
  colorsCache = data as Record<string, ColorEntry>;
  resolvedColorEntries.clear();
  repaintPendingGlows();
});

function urlVariants(url: string): string[] {
  let cleanUrl = url;
  if (URL.canParse(url)) {
    const parsed = new URL(url);
    cleanUrl = parsed.origin + parsed.pathname;
  } else if (URL.canParse(url, window.location.href)) {
    const parsed = new URL(url, window.location.href);
    cleanUrl = parsed.origin === window.location.origin ? parsed.pathname : parsed.origin + parsed.pathname;
  }

  const variants = new Set<string>([cleanUrl]);
  variants.add(cleanUrl.replace('/500x500/', '/300x300/'));
  variants.add(cleanUrl.replace('/300x300/', '/500x500/'));
  variants.add(cleanUrl.replace('/1000x1000bb.jpg', '/600x600bb.jpg'));
  variants.add(cleanUrl.replace('/1000x1000bb.jpg', '/500x500/'));
  variants.add(cleanUrl.replace('/600x600bb.jpg', '/300x300bb.jpg'));
  // Thumbnails now load the smallest variant, but colours were extracted from
  // the largest, so the lookup has to climb back up as well as down.
  variants.add(cleanUrl.replace('/300x300bb.jpg', '/1000x1000bb.jpg'));
  variants.add(cleanUrl.replace('/600x600bb.jpg', '/1000x1000bb.jpg'));
  return [...variants];
}

// On the render path of every row: unmemoised this built a URL, a Set and eight
// string variants per row, re-run by repaintPendingGlows on every colour arrival.
const resolvedColorEntries = new Map<string, ColorEntry | null>();

function resolveColorEntryFromCache(url: string): ColorEntry | null {
  if (!colorsCache) return null;

  const memo = resolvedColorEntries.get(url);
  if (memo !== undefined) return memo;

  let found: ColorEntry | null = null;
  for (const variant of urlVariants(url)) {
    const entry = colorsCache[variant];
    if (entry) {
      const brightness = (entry.r * 299 + entry.g * 587 + entry.b * 114) / 1000;
      if (brightness >= 30) {
        found = entry;
        break;
      }
    }
  }

  resolvedColorEntries.set(url, found);
  return found;
}

function resolveColorFromCache(url: string): { r: number; g: number; b: number } | null {
  const entry = resolveColorEntryFromCache(url);
  return entry ? { r: entry.r, g: entry.g, b: entry.b } : null;
}

/** `resolved` is false when the cache missed and `rgb` is the white fallback. */
export function getDominantColor(
  imgEl: HTMLImageElement,
  callback: (rgb: { r: number; g: number; b: number }, resolved: boolean) => void,
) {
  const fallback = { r: 255, g: 255, b: 255 };
  if (!imgEl.src || imgEl.src.includes('undefined')) {
    callback(fallback, false);
    return;
  }

  const color = resolveColorFromCache(imgEl.src);
  callback(color || fallback, color !== null);
}

const ROW_THUMB_SELECTOR = '.scrobble-row-thumb img.artwork-img, .scrobble-row-thumb img';

// Only a real cache hit latches: a row painted before colors.json lands keeps the
// white fallback and stays `pending`, so repaintPendingGlows can finish it.
function paintRowGlow(row: Element): void {
  const imgEl = row.querySelector(ROW_THUMB_SELECTOR) as HTMLImageElement | null;
  const countEl = row.querySelector('.scrobble-count-val');
  if (!imgEl || !countEl) return;

  if (countEl.getAttribute('data-color-state') === 'resolved') return;

  const apply = () => {
    getDominantColor(imgEl, (rgb, resolved) => {
      countEl.setAttribute('style', getGlowStyle(rgb, { blur: 8, alpha: 0.5 }));
      countEl.setAttribute('data-color-state', resolved ? 'resolved' : 'pending');
      (row as HTMLElement).style.setProperty('--row-accent', `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
    });
  };

  if (imgEl.complete && imgEl.naturalWidth > 0) {
    apply();
  } else {
    imgEl.addEventListener('load', apply, { once: true });
  }
}

export function applyCountGlows(scope: RenderScope) {
  eachMatch(scope, '.scrobble-row', paintRowGlow);
}

/** Re-resolve rows still showing the fallback glow, after colors data arrives. */
export function repaintPendingGlows(root: ParentNode = document): void {
  root
    .querySelectorAll('.scrobble-count-val[data-color-state="pending"]')
    .forEach((countEl) => {
      const row = countEl.closest('.scrobble-row');
      if (row) paintRowGlow(row);
    });
}

export function getColorForUrl(url: string | null): { r: number; g: number; b: number } | null {
  if (!url) return null;
  return resolveColorFromCache(url);
}

export function getBottomColorForUrl(url: string | null): Rgb | null {
  if (!url) return null;
  const entry = resolveColorEntryFromCache(url);
  if (!entry) return null;
  return normalizeBottomColor(entry);
}
