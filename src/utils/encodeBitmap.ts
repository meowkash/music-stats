// Downscale a decoded bitmap into a non-opaque WebP Response. Shared by the
// encode worker and the main-thread fallback so the two can't drift.
export async function encodeBitmap(bitmap: ImageBitmap, px: number): Promise<Response | null> {
  try {
    const size = Math.min(px, Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, size, size);

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    return new Response(blob, { headers: { 'Content-Type': 'image/webp' } });
  } catch (err) {
    console.warn('[Artwork] Failed to encode bitmap at size', px, err);
    return null;
  }
}
