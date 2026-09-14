const ANIMATED_URL_PATTERN = /\.gif(\?|$)|[?&]animated=|\/animated\//i;

export function isStaticArtworkUrl(url: string | null): boolean {
  if (!url) return false;
  return !ANIMATED_URL_PATTERN.test(url);
}

/** Prefer highest-res static JPEG from iTunes / Last.fm CDN URLs. */
export function normalizeStaticArtworkUrl(url: string): string | null {
  if (!isStaticArtworkUrl(url)) return null;

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
export function getStaticArtworkSources(url: string): string[] {
  const normalized = normalizeStaticArtworkUrl(url);
  if (!normalized) return [];

  if (normalized.includes('mzstatic.com')) {
    const high = normalized.replace(/\/\d+x\d+bb\.jpg$/, '/1000x1000bb.jpg');
    const mid = high.replace('/1000x1000bb.jpg', '/600x600bb.jpg');
    const low = high.replace('/1000x1000bb.jpg', '/300x300bb.jpg');
    return [...new Set([high, mid, low].filter(isStaticArtworkUrl))];
  }

  if (normalized.includes('lastfm') || normalized.includes('freetls')) {
    const low = normalized.replace('/500x500/', '/300x300/');
    const sources = [normalized];
    if (url !== normalized && isStaticArtworkUrl(url)) sources.push(url);
    if (low !== normalized) sources.push(low);
    return [...new Set(sources.filter(isStaticArtworkUrl))];
  }

  const high = normalized.replace('/300x300/', '/500x500/');
  const low = normalized.replace('/500x500/', '/300x300/');
  return high === low ? [high] : [high, low];
}

// Smallest first for ~44px list thumbnails, which have no use for a 500px
// bitmap. Retries escalate instead of starting big.
export function getThumbArtworkSources(url: string): string[] {
  return getStaticArtworkSources(url).reverse();
}

/** Legacy URL normalization for size-variant matching. */
export function artworkIdentity(url: string | null): string {
  const normalized = url ? normalizeStaticArtworkUrl(url) || url : '';
  return normalized.replace('/1000x1000bb.jpg', '/500x500/')
    .replace('/600x600bb.jpg', '/500x500/')
    .replace('/500x500/', '/300x300/');
}

// Content hash: the same image across song/album/artist, or across different
// CDN URLs, resolves to one hash.
export function artworkContentHash(url: string | null): string {
  if (!url) return '';

  try {
    const parsed = new URL(url, 'https://local.placeholder');
    const path = decodeURIComponent(parsed.pathname);

    const mzThumb = path.match(/\/image\/thumb\/(.+?)\/\d+x\d+bb?\.(jpg|png|webp)$/i);
    if (mzThumb) return `mz:${mzThumb[1]}`;

    const lfHash = path.match(/\/i\/u\/[^/]+\/([a-f0-9]{8,}(?:-[a-f0-9]+)*)/i);
    if (lfHash) return `lf:${lfHash[1]}`;

    const fileHash = path.match(/\/([a-f0-9]{32})\.(jpg|png|webp)$/i);
    if (fileHash) return `lf:${fileHash[1]}`;

    const stripped = path
      .replace(/\/\d+x\d+bb?\.(jpg|png|webp)$/i, '')
      .replace(/\/\d+x\d+\.(jpg|png|webp)$/i, '')
      .replace(/\/\d+s\//g, '/');

    return `path:${stripped}`;
  } catch (err) {
    console.warn('[Artwork] Failed to extract content hash for url:', url, err);
    return artworkIdentity(url);
  }
}

export type ArtworkEntityType = 'track' | 'album' | 'artist';

export function artworkCacheKey(
  type: ArtworkEntityType | string,
  name: string,
  artistName = '',
): string {
  if (type === 'track') return `track:${name}|${artistName}`;
  if (type === 'album') return `album:${name}|${artistName}`;
  if (type === 'artist') return `artist:${name}`;
  return `${name}|${artistName}`;
}

/** Resolve cache key with legacy (unprefixed) fallback for same entity type only. */
export function resolveArtworkFromCache(
  type: ArtworkEntityType | string,
  name: string,
  artistName: string,
  cache: Record<string, string>,
): string | null {
  const key = artworkCacheKey(type, name, artistName);
  if (cache[key]) return cache[key];

  if (type === 'track') {
    const legacy = cache[`${name}|${artistName}`];
    if (legacy) return legacy;
  } else if (type === 'album') {
    const legacy = cache[`${name}|${artistName}`];
    if (legacy) return legacy;
  } else if (type === 'artist') {
    const legacy = cache[name];
    if (legacy && !name.includes('|')) return legacy;
  }

  return null;
}

/** Try artist artwork for each name in order (canonical display + raw spellings). */
export function resolveArtistArtworkFromCandidates(
  names: string[],
  cache: Record<string, string>,
): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const url = resolveArtistArtwork(name, cache);
    if (url) return url;
  }
  return null;
}

// Built once per cache object: without them a miss scanned all ~10k entries
// twice via Object.entries, and a row missing on all three fields did it 4x.
interface ArtworkFallbackIndex {
  byArtist: Map<string, string>;
  /** Keyed by normalized `album|artist` — never album alone (see resolveAlbumArtwork). */
  byAlbumName: Map<string, string>;
}

/** Case/punctuation-insensitive form, so "Short n' Sweet" matches "Short N Sweet". */
function looseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const fallbackIndexes = new WeakMap<Record<string, string>, ArtworkFallbackIndex>();

function getFallbackIndex(cache: Record<string, string>): ArtworkFallbackIndex {
  const existing = fallbackIndexes.get(cache);
  if (existing) return existing;

  const byArtist = new Map<string, string>();
  const byAlbumName = new Map<string, string>();

  for (const key in cache) {
    const url = cache[key];
    if (!url) continue;

    const isPrefixed = key.startsWith('album:');
    // Legacy (pre-prefix) album keys are bare `album|artist` pairs.
    if (!isPrefixed && (key.includes(':') || !key.includes('|'))) continue;

    const body = isPrefixed ? key.slice('album:'.length) : key;
    const split = body.lastIndexOf('|');
    if (split === -1) continue;

    const albumName = body.slice(0, split);
    const artistName = body.slice(split + 1);

    // First write wins, matching the original "first match in key order" scans.
    if (artistName && !byArtist.has(artistName)) byArtist.set(artistName, url);
    if (albumName && artistName) {
      const key = `${looseKey(albumName)}|${looseKey(artistName)}`;
      if (!byAlbumName.has(key)) byAlbumName.set(key, url);
    }
  }

  const index = { byArtist, byAlbumName };
  fallbackIndexes.set(cache, index);
  return index;
}

/** Artist artwork: direct key → any cached album for this artist. */
export function resolveArtistArtwork(
  name: string,
  cache: Record<string, string>,
): string | null {
  const direct = resolveArtworkFromCache('artist', name, name, cache);
  if (direct) return direct;

  return getFallbackIndex(cache).byArtist.get(name) ?? null;
}

// Exact key, then a tolerant match on album *and* artist. Matching on title
// alone let "Greatest Hits" take an unrelated artist's cover.
export function resolveAlbumArtwork(
  albumName: string,
  artistName: string,
  cache: Record<string, string>,
): string | null {
  const direct = resolveArtworkFromCache('album', albumName, artistName, cache);
  if (direct) return direct;

  if (!artistName) return null;
  const key = `${looseKey(albumName)}|${looseKey(artistName)}`;
  return getFallbackIndex(cache).byAlbumName.get(key) ?? null;
}

/** Track artwork: exact track → album → artist (broad fallback last). */
export function resolveTrackArtwork(
  name: string,
  artistName: string,
  albumName: string,
  cache: Record<string, string>,
): string | null {
  return (
    resolveArtworkFromCache('track', name, artistName, cache) ??
    (albumName ? resolveAlbumArtwork(albumName, artistName, cache) : null) ??
    resolveArtistArtwork(artistName, cache)
  );
}
