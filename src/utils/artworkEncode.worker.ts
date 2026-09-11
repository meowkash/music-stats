/// <reference lib="webworker" />

/**
 * Fetch → decode → downscale → cache, off the main thread.
 *
 * The sweep is ~730 covers at two sizes each, so ~1,500 decodes and WebP
 * encodes. An individual encode isn't interruptible, so running them on the
 * main thread meant the background sweep competed with scrolling for the whole
 * first session no matter how much idle time was left between batches.
 *
 * createImageBitmap, OffscreenCanvas and the Cache API are all available here,
 * so the entire pipeline moves across and the main thread keeps only the
 * batching, quota accounting and progress reporting.
 */

export interface EncodeTarget {
  url: string;
  px: number;
}

export interface EncodeRequest {
  id: number;
  cacheName: string;
  source: string;
  targets: EncodeTarget[];
}

export interface EncodeResult {
  id: number;
  written: number;
  /** Storage is full — the caller stops the sweep rather than retrying. */
  quota?: boolean;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

async function encodeAt(bitmap: ImageBitmap, px: number): Promise<Response | null> {
  try {
    const size = Math.min(px, Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(size, size);
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return null;
    canvasCtx.drawImage(bitmap, 0, 0, size, size);

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    return new Response(blob, { headers: { 'Content-Type': 'image/webp' } });
  } catch (err) {
    console.warn('[ArtworkEncoder] Failed to encode bitmap at size', px, err);
    return null;
  }
}

async function warm(request: EncodeRequest): Promise<EncodeResult> {
  try {
    // no-store keeps the full-size original out of the HTTP disk cache —
    // otherwise every image is retained twice, once at source size.
    const response = await fetch(request.source, { mode: 'cors', cache: 'no-store' });
    if (!response.ok) return { id: request.id, written: 0 };

    const cache = await caches.open(request.cacheName);

    // Decode once, then write every size derived from it.
    const bitmap = await createImageBitmap(await response.blob());
    let written = 0;
    try {
      for (const target of request.targets) {
        const encoded = await encodeAt(bitmap, target.px);
        if (!encoded) continue;
        await cache.put(target.url, encoded);
        written++;
      }
    } finally {
      bitmap.close();
    }
    return { id: request.id, written };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      return { id: request.id, written: 0, quota: true };
    }
    /* transient failure — the next sweep retries it */
    return { id: request.id, written: 0 };
  }
}

ctx.addEventListener('message', (event: MessageEvent<EncodeRequest>) => {
  void warm(event.data).then((result) => ctx.postMessage(result));
});
