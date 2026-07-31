import sharp from 'sharp';

const ANIMATED_URL_PATTERN = /\.gif(\?|$)|[?&]animated=|\/animated\//i;

/** Reject URLs that are known to serve animated artwork. */
export function isStaticArtworkUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return !ANIMATED_URL_PATTERN.test(url);
}

/** Prefer highest-res static JPEG from iTunes / Last.fm CDN URLs. */
export function normalizeStaticArtworkUrl(url) {
  if (!url || !isStaticArtworkUrl(url)) return null;

  if (url.includes('mzstatic.com')) {
    return url
      .replace(/\/\d+x\d+bb\.(jpg|png)$/, '/1000x1000bb.jpg')
      .replace(/\/\d+x\d+\.(jpg|png)$/, '/1000x1000bb.jpg');
  }

  if (url.includes('lastfm') || url.includes('freetls')) {
    return url
      .replace('/300x300/', '/500x500/')
      .replace('/174s/', '/500x500/')
      .replace('/64s/', '/500x500/');
  }

  return url;
}

/** Ordered static sources: highest resolution first. */
export function getStaticArtworkSources(url) {
  const normalized = normalizeStaticArtworkUrl(url);
  if (!normalized) return [];

  if (normalized.includes('mzstatic.com')) {
    const high = normalized.replace(/\/\d+x\d+bb\.jpg$/, '/1000x1000bb.jpg');
    const mid = high.replace('/1000x1000bb.jpg', '/600x600bb.jpg');
    const low = high.replace('/1000x1000bb.jpg', '/300x300bb.jpg');
    return [...new Set([high, mid, low].filter(isStaticArtworkUrl))];
  }

  const high = normalized.replace('/300x300/', '/500x500/');
  const low = normalized.replace('/500x500/', '/300x300/');
  return high === low ? [high] : [high, low];
}

/** Verify downloaded bytes are a single static frame (not animated GIF/WebP). */
export async function verifyStaticImageBuffer(buffer) {
  const meta = await sharp(buffer).metadata();
  if (meta.format === 'gif') return false;
  if (meta.pages != null && meta.pages > 1) return false;
  return true;
}

/** Fetch and validate static artwork; returns normalized URL on success. */
export async function fetchValidatedStaticArtwork(url) {
  const sources = getStaticArtworkSources(url);
  if (sources.length === 0 && isStaticArtworkUrl(url)) sources.push(url);

  for (const src of sources) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!(await verifyStaticImageBuffer(buffer))) continue;
      return normalizeStaticArtworkUrl(src) || src;
    } catch {
      /* try next source */
    }
  }
  return null;
}
