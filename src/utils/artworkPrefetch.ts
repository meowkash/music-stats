import { encodeBitmap } from './encodeBitmap';
import type { Manifest } from './persist/generations';
import { readBootHint, writeBootHint } from './persist/generations';
import type { EncodeRequest, EncodeResult } from './artworkEncode.worker';

// Stage 1 warms what's on screen, stage 2 sweeps the rest so a later offline
// launch is complete. CDN URLs are content addresses, so they are the invalidation.

/** Must match IMAGE_CACHE in scripts/generate-sw.js. */
const IMAGE_CACHE = 'music-stats-images-v1';

const PRIORITY_CONCURRENCY = 6;
const BACKGROUND_CONCURRENCY = 6;
/** Breathing room between background batches so the sweep never fights the UI. */
const BACKGROUND_BATCH_PAUSE_MS = 120;

// Opaque (no-cors) cache entries are charged a flat ~32 MB each against quota,
// so the library needed ~24 GB of ~3 GB. Re-encoding with CORS gives 8.7 KB.
const MAX_QUOTA_FRACTION = 0.5;

const THUMB_PX = 160;
/** Sized-variant source is 500x500, so the sweep can't usefully exceed it. */
const HERO_PX = 512;
// On-demand only: the full-bleed hero wants a real 768, but sweeping originals
// for all 732 covers is ~220 MB transferred versus ~9 MB for the whole sweep.
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

// Both URL variants the UI asks for are derived from one download. The thumb
// comes off the 500x500 source because /300x300/ 404s for some Last.fm images.
function warmGroupFor(url: string): WarmGroup {
  const thumbUrl = url.replace('/500x500/', '/300x300/');
  const targets: WarmTarget[] = [{ url, px: HERO_PX }];
  if (thumbUrl !== url) targets.unshift({ url: thumbUrl, px: THUMB_PX });
  return { source: url, targets };
}

// Downscale to `px` and return a same-origin-style Response, falling back to
// the untouched (still non-opaque) one without OffscreenCanvas encoding.
async function reencode(response: Response, px: number): Promise<Response> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return response;
  }
  try {
    const bitmap = await createImageBitmap(await response.blob());
    const encoded = await encodeBitmap(bitmap, px);
    bitmap.close();
    return encoded ?? response;
  } catch (err) {
    console.warn('[ArtworkPrefetch] Failed to re-encode image response:', err);
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
  } catch (err) {
    console.warn('[ArtworkPrefetch] Storage quota estimation failed:', err);
    return Number.POSITIVE_INFINITY;
  }
}

/** How long a headroom reading stays good enough to reuse. */
const QUOTA_RECHECK_MS = 5000;

let quotaCheckedAt = 0;
let quotaHeadroom = Number.POSITIVE_INFINITY;

// estimate() walks the origin's whole storage accounting (~120 walks per sweep
// if called per batch), so it is time-throttled; a real quota error re-reads.
async function throttledQuotaHeadroom(): Promise<number> {
  const now = Date.now();
  if (now - quotaCheckedAt < QUOTA_RECHECK_MS) return quotaHeadroom;
  quotaHeadroom = await quotaHeadroomBytes();
  quotaCheckedAt = now;
  return quotaHeadroom;
}

function invalidateQuotaHeadroom(): void {
  quotaCheckedAt = 0;
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

// The visibility test is the point: an infinite scroller keeps every rendered
// row in the DOM, so "every img" degenerates to "almost everything".
function urlsOnScreen(): Set<string> {
  const urls = new Set<string>();
  const viewportH = window.innerHeight || document.documentElement.clientHeight;
  const viewportW = window.innerWidth || document.documentElement.clientWidth;

  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src || !src.startsWith('http')) return;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom <= 0 || rect.top >= viewportH) return;
    if (rect.right <= 0 || rect.left >= viewportW) return;
    urls.add(src);
  });
  return urls;
}

async function cachedUrls(cache: Cache): Promise<Set<string>> {
  const keys = await cache.keys();
  return new Set(keys.map((request) => request.url));
}

class QuotaExhausted extends Error {}

// `undefined` = not tried yet, `null` = unavailable, so the main-thread path
// is only ever a fallback for a browser without module workers.
let encoderWorker: Worker | null | undefined;
let nextJobId = 1;
const pendingJobs = new Map<number, (result: EncodeResult) => void>();

function failPendingJobs(): void {
  for (const [id, resolve] of pendingJobs) resolve({ id, written: 0 });
  pendingJobs.clear();
}

function getEncoderWorker(): Worker | null {
  if (encoderWorker !== undefined) return encoderWorker;

  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    encoderWorker = null;
    return null;
  }

  try {
    const worker = new Worker(new URL('./artworkEncode.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', (event: MessageEvent<EncodeResult>) => {
      const resolve = pendingJobs.get(event.data.id);
      if (!resolve) return;
      pendingJobs.delete(event.data.id);
      resolve(event.data);
    });
    worker.addEventListener('error', (err) => {
      console.warn('[ArtworkPrefetch] Encoder worker failed; falling back to main thread:', err);
      encoderWorker = null;
      failPendingJobs();
      worker.terminate();
    });
    encoderWorker = worker;
  } catch (err) {
    console.warn('[ArtworkPrefetch] Encoder worker unavailable; encoding on main thread:', err);
    encoderWorker = null;
  }

  return encoderWorker;
}

function warmInWorker(worker: Worker, group: WarmGroup): Promise<EncodeResult> {
  const id = nextJobId++;
  return new Promise<EncodeResult>((resolve) => {
    pendingJobs.set(id, resolve);
    worker.postMessage({
      id,
      cacheName: IMAGE_CACHE,
      source: group.source,
      targets: group.targets,
    } satisfies EncodeRequest);
  });
}

async function warmBatch(cache: Cache, groups: WarmGroup[]): Promise<number> {
  const worker = getEncoderWorker();
  if (worker) {
    const results = await Promise.all(groups.map((group) => warmInWorker(worker, group)));
    if (results.some((r) => r.quota)) throw new QuotaExhausted();
    return results.reduce((sum, r) => sum + r.written, 0);
  }
  return warmBatchOnMainThread(cache, groups);
}

/** Used only where a module worker or OffscreenCanvas isn't available. */
async function warmBatchOnMainThread(cache: Cache, groups: WarmGroup[]): Promise<number> {
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
          const encoded = await encodeBitmap(bitmap, target.px);
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
    if (await throttledQuotaHeadroom() <= 0) {
      dispatchProgress({ ...progress, stage: 'quota-limited' });
      return false;
    }

    try {
      progress.cached += await warmBatch(cache, groups.slice(i, i + concurrency));
    } catch (err) {
      if (err instanceof QuotaExhausted) {
        invalidateQuotaHeadroom();
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

// Warm every artwork URL in the manifest, on-screen first. Safe to call
// repeatedly: already-cached URLs are skipped.
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
  } catch (err) {
    console.warn('[ArtworkPrefetch] Prefetch pipeline encountered an error:', err);
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

// Re-cache one hero at 768 from the original upload, under the URL the UI
// already requests. Idempotent per session; safe on every overlay open.
export async function upgradeHeroArtwork(url: string | null): Promise<void> {
  if (!url || upgraded.has(url) || !('caches' in window) || !navigator.onLine) return;
  upgraded.add(url);

  const source = originalSourceUrl(url);
  if (!source) return;

  try {
    if ((await throttledQuotaHeadroom()) <= 0) return;

    const response = await fetch(source, { mode: 'cors', cache: 'no-store' });
    if (!response.ok) return;

    const cache = await caches.open(IMAGE_CACHE);
    await cache.put(url, await reencode(response, HERO_UPGRADE_PX));
  } catch (err) {
    console.warn('[ArtworkPrefetch] Failed to upgrade hero artwork for', url, err);
  }
}
