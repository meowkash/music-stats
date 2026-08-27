import type { Manifest } from './persist/generations';
import { readBootHint, writeBootHint } from './persist/generations';

/**
 * Staged artwork warming.
 *
 * Stage 1 covers what's on screen so the current view settles immediately;
 * stage 2 sweeps the rest in the background while the app is in use, which is
 * what makes a later offline launch complete rather than partial.
 *
 * Invalidation rides on the URL. mzstatic and Last.fm URLs are content
 * addresses, so a changed cover is a changed URL: anything in the manifest but
 * not in the cache needs fetching, and anything cached but no longer in the
 * manifest is dead and gets evicted. No separate image hashing required.
 */

/** Must match IMAGE_CACHE in scripts/generate-sw.js. */
const IMAGE_CACHE = 'music-stats-images-v1';

const PRIORITY_CONCURRENCY = 6;
const BACKGROUND_CONCURRENCY = 6;
/** Breathing room between background batches so the sweep never fights the UI. */
const BACKGROUND_BATCH_PAUSE_MS = 120;

/**
 * Why the images are re-encoded instead of cached as they arrive.
 *
 * A no-cors fetch yields an *opaque* response, and browsers pad opaque cache
 * entries by a flat ~32 MB each in quota accounting — a privacy measure so a
 * site can't infer cross-origin resource sizes by watching its own quota. It's
 * charged per entry regardless of the real file size, so the full library would
 * have needed ~24 GB against a ~3 GB quota.
 *
 * lastfm.freetls.fastly.net does send `access-control-allow-origin: *`, so the
 * bytes are readable. Fetching with CORS, downscaling to the size actually
 * displayed, and storing a Response we construct ourselves makes the entry
 * non-opaque: measured 8.7 KB instead of ~32 MB, ~3700x smaller.
 */
const MAX_QUOTA_FRACTION = 0.5;

const THUMB_PX = 160;
/** Sized-variant source is 500x500, so the sweep can't usefully exceed it. */
const HERO_PX = 512;
/**
 * The detail hero is full-bleed, where 512 upscaled on a 3x screen looks soft.
 * Last.fm also serves the unresized upload (measured 1000-1946px) at a URL with
 * no size segment, so an opened overlay can be upgraded to a genuine 768.
 *
 * Not part of the background sweep on purpose: pulling originals for all 732
 * covers is ~220 MB of transfer and ~56 MB stored, versus ~9 MB for the whole
 * sweep today. On demand, it's one ~300 KB fetch for something you're looking at.
 */
const HERO_UPGRADE_PX = 768;

/** One cache entry to produce: `url` is the key the UI will request. */
interface WarmTarget {
  url: string;
  px: number;
}

/** One network fetch, feeding every size derived from it. */
interface WarmGroup {
  source: string;
  targets: WarmTarget[];
}

/**
 * The UI requests two URL variants per image (getThumbArtworkSources and
 * getStaticArtworkSources), so both need a cache entry — but both are derived
 * from a single download.
 *
 * The thumb is rendered from the 500x500 source rather than fetched from the
 * /300x300/ URL: Last.fm doesn't publish that variant for every image, so
 * requesting it 404s for a handful. Deriving locally halves the request count
 * and removes that failure mode entirely.
 */
function warmGroupFor(url: string): WarmGroup {
  const thumbUrl = url.replace('/500x500/', '/300x300/');
  const targets: WarmTarget[] = [{ url, px: HERO_PX }];
  if (thumbUrl !== url) targets.unshift({ url: thumbUrl, px: THUMB_PX });
  return { source: url, targets };
}

/** Downscale a decoded bitmap into a non-opaque Response. */
async function encodeAt(bitmap: ImageBitmap, px: number): Promise<Response | null> {
  try {
    const size = Math.min(px, Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size, size);

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    return new Response(blob, { headers: { 'Content-Type': 'image/webp' } });
  } catch {
    return null;
  }
}

/**
 * Downscale to `px` and hand back a same-origin-style Response.
 * Falls back to the untouched (still non-opaque) response if the browser lacks
 * OffscreenCanvas encoding.
 */
async function reencode(response: Response, px: number): Promise<Response> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return response;
  }
  try {
    const bitmap = await createImageBitmap(await response.blob());
    const encoded = await encodeAt(bitmap, px);
    bitmap.close();
    return encoded ?? response;
  } catch {
    return response;
  }
}

export interface ArtworkPrefetchProgress {
  cached: number;
  total: number;
  stage: 'priority' | 'background' | 'done' | 'quota-limited';
}

let running = false;

async function quotaHeadroomBytes(): Promise<number> {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota) return Number.POSITIVE_INFINITY;
    return quota * MAX_QUOTA_FRACTION - usage;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    }).requestIdleCallback;

    if (ric) ric(() => resolve(), { timeout: 1000 });
    else setTimeout(resolve, BACKGROUND_BATCH_PAUSE_MS);
  });
}

function dispatchProgress(detail: ArtworkPrefetchProgress): void {
  window.dispatchEvent(
    new CustomEvent<ArtworkPrefetchProgress>('artwork-prefetch-progress', { detail }),
  );
}

/** Artwork URLs currently referenced by the DOM, in document order. */
function urlsOnScreen(): Set<string> {
  const urls = new Set<string>();
  document.querySelectorAll('img').forEach((img) => {
    const src = (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src;
    if (src && src.startsWith('http')) urls.add(src);
  });
  return urls;
}

async function cachedUrls(cache: Cache): Promise<Set<string>> {
  const keys = await cache.keys();
  return new Set(keys.map((request) => request.url));
}

class QuotaExhausted extends Error {}

async function warmBatch(cache: Cache, groups: WarmGroup[]): Promise<number> {
  const results = await Promise.all(
    groups.map(async (group) => {
      try {
        // no-store keeps the full-size original out of the HTTP disk cache —
        // otherwise every image is retained twice, once at source size.
        const response = await fetch(group.source, { mode: 'cors', cache: 'no-store' });
        if (!response.ok) return 0;

        // Decode once, then write every size derived from it.
        if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
          await cache.put(group.targets[0].url, response);
          return 1;
        }

        const bitmap = await createImageBitmap(await response.blob());
        let written = 0;
        for (const target of group.targets) {
          const encoded = await encodeAt(bitmap, target.px);
          if (!encoded) continue;
          await cache.put(target.url, encoded);
          written++;
        }
        bitmap.close();
        return written;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'QuotaExceededError') {
          throw new QuotaExhausted();
        }
        /* transient failure — the next sweep retries it */
      }
      return 0;
    }),
  );
  return results.reduce((sum, n) => sum + n, 0);
}

async function warmAll(
  cache: Cache,
  groups: WarmGroup[],
  concurrency: number,
  stage: ArtworkPrefetchProgress['stage'],
  progress: { cached: number; total: number },
): Promise<boolean> {
  for (let i = 0; i < groups.length; i += concurrency) {
    if (!navigator.onLine) return false;

    // Re-checked as we go: opaque padding means headroom drops far faster than
    // the bytes actually downloaded would suggest.
    if (await quotaHeadroomBytes() <= 0) {
      dispatchProgress({ ...progress, stage: 'quota-limited' });
      return false;
    }

    try {
      progress.cached += await warmBatch(cache, groups.slice(i, i + concurrency));
    } catch (err) {
      if (err instanceof QuotaExhausted) {
        dispatchProgress({ ...progress, stage: 'quota-limited' });
        return false;
      }
      throw err;
    }
    dispatchProgress({ ...progress, stage });

    if (stage === 'background') await idle();
  }

  return true;
}

/**
 * Warm every artwork URL in the manifest, on-screen images first.
 * Safe to call repeatedly — already-cached URLs are skipped.
 */
export async function prefetchArtwork(manifest: Manifest): Promise<void> {
  if (running || !('caches' in window) || !manifest.artwork?.length) return;
  running = true;

  try {
    const cache = await caches.open(IMAGE_CACHE);
    const allGroups = manifest.artwork.map(warmGroupFor);
    const wanted = new Set(allGroups.flatMap((g) => g.targets.map((t) => t.url)));
    const alreadyCached = await cachedUrls(cache);

    // Covers replaced server-side leave their old URL behind; drop it so the
    // cache doesn't grow without bound across generations.
    const stale = [...alreadyCached].filter((url) => !wanted.has(url));
    await Promise.all(stale.map((url) => cache.delete(url)));
    for (const url of stale) alreadyCached.delete(url);

    // A group is worth fetching if any of its sizes is missing; the targets are
    // narrowed so an interrupted run doesn't re-encode what it already wrote.
    const missing = allGroups
      .map((group) => ({
        ...group,
        targets: group.targets.filter((t) => !alreadyCached.has(t.url)),
      }))
      .filter((group) => group.targets.length > 0);

    const progress = { cached: alreadyCached.size, total: wanted.size };

    if (!missing.length) {
      dispatchProgress({ ...progress, stage: 'done' });
      recordProgress(manifest, progress.cached);
      return;
    }

    const onScreen = urlsOnScreen();
    const priority = missing.filter((g) => g.targets.some((t) => onScreen.has(t.url)));
    const rest = missing.filter((g) => !g.targets.some((t) => onScreen.has(t.url)));

    const priorityDone = await warmAll(cache, priority, PRIORITY_CONCURRENCY, 'priority', progress);
    const restDone =
      priorityDone && (await warmAll(cache, rest, BACKGROUND_CONCURRENCY, 'background', progress));

    if (priorityDone && restDone) dispatchProgress({ ...progress, stage: 'done' });
    recordProgress(manifest, progress.cached);
  } catch {
    /* cache unavailable — images still load straight from the network */
  } finally {
    running = false;
  }
}

function recordProgress(manifest: Manifest, cached: number): void {
  const hint = readBootHint();
  writeBootHint({
    generation: manifest.generation,
    complete: hint?.complete ?? true,
    artworkCached: cached,
  });
}

/** Strip the size segment from a Last.fm CDN path to reach the original upload. */
function originalSourceUrl(url: string): string | null {
  const match = url.match(/^(https:\/\/[^/]+\/i\/u\/)[^/]+\/(.+)$/);
  return match ? `${match[1]}${match[2]}` : null;
}

const upgraded = new Set<string>();

/**
 * Re-cache one hero at 768 from the original upload. Idempotent per session and
 * safe to call on every overlay open; stores under the same URL the UI already
 * requests, so nothing downstream needs to know.
 */
export async function upgradeHeroArtwork(url: string | null): Promise<void> {
  if (!url || upgraded.has(url) || !('caches' in window) || !navigator.onLine) return;
  upgraded.add(url);

  const source = originalSourceUrl(url);
  if (!source) return;

  try {
    if ((await quotaHeadroomBytes()) <= 0) return;

    const response = await fetch(source, { mode: 'cors', cache: 'no-store' });
    if (!response.ok) return;

    const cache = await caches.open(IMAGE_CACHE);
    await cache.put(url, await reencode(response, HERO_UPGRADE_PX));
  } catch {
    // Original may not exist for every hash — the 512 entry stays in place.
  }
}
