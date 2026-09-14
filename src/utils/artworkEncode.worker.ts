/// <reference lib="webworker" />

// Fetch → decode → downscale → cache, off the main thread: ~1,500 uninterruptible
// encodes otherwise compete with scrolling for the whole first session.

import { encodeBitmap } from './encodeBitmap';

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
        const encoded = await encodeBitmap(bitmap, target.px);
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
