import { isArtistsOwnCover } from './resolve-artwork/normalize.js';

export function artworkCacheKey(type, name, artistName = '') {
  if (type === 'track') return `track:${name}|${artistName}`;
  if (type === 'album') return `album:${name}|${artistName}`;
  if (type === 'artist') return `artist:${name}`;
  return `${name}|${artistName}`;
}

export function resolveLegacyArtworkKey(type, name, artistName = '') {
  if (type === 'artist') return name;
  return `${name}|${artistName}`;
}

/** Write prefixed + legacy keys so daily sync and backfill stay compatible. */
export function storeArtworkInCache(cache, type, name, artistName, url) {
  cache[artworkCacheKey(type, name, artistName)] = url;
  cache[resolveLegacyArtworkKey(type, name, artistName)] = url;

  // Rebuild artist entries from album art when missing (sync no longer fetches
  // artist keys) — but never from a compilation the artist merely appears on.
  if (type === 'album' && artistName && isArtistsOwnCover(name, artistName)) {
    const artistKey = artworkCacheKey('artist', artistName);
    const artistLegacy = resolveLegacyArtworkKey('artist', artistName);
    if (!cache[artistKey] && !cache[artistLegacy]) {
      cache[artistKey] = url;
      cache[artistLegacy] = url;
    }
  }
}

/** Last.fm's grey star: worse than no artwork at all. */
export const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

/** A scrobble's image fills gaps only: it must not replace a cover the
 *  resolver validated, and the placeholder star is not artwork. */
export function harvestScrobbleArtwork(cache, { trackName, artistName, albumName, url }) {
  if (!url || url.includes(LASTFM_PLACEHOLDER)) return;
  if (albumName && !cache[artworkCacheKey('album', albumName, artistName)]) storeArtworkInCache(cache, 'album', albumName, artistName, url);
  if (trackName && !cache[artworkCacheKey('track', trackName, artistName)]) storeArtworkInCache(cache, 'track', trackName, artistName, url);
}

/** Artist artwork: direct key → any cached album for this artist. */
export function resolveArtistArtworkFromCache(name, cache) {
  const direct = cache[artworkCacheKey('artist', name)] ?? cache[resolveLegacyArtworkKey('artist', name)];
  if (direct) return direct;

  const suffix = `|${name}`;
  const own = (key, prefix) => isArtistsOwnCover(key.slice(prefix.length, key.length - suffix.length), name);
  for (const [key, url] of Object.entries(cache)) {
    if (key.startsWith('album:') && key.endsWith(suffix) && own(key, 'album:')) return url;
  }

  for (const [key, url] of Object.entries(cache)) {
    if (!key.includes(':') && key.includes('|') && key.endsWith(suffix) && own(key, '')) return url;
  }

  return null;
}

/** Removes artist images that are a compilation's cover the artist only
 *  appears on — left by album → artist promotion before it knew better — so
 *  the artist falls back to their own releases or gets resolved properly.
 *  Returns how many artists were cleared. */
export function sanitizeArtistArtwork(cache) {
  const compilationCovers = new Map();
  const ownCovers = new Map();
  for (const [key, url] of Object.entries(cache)) {
    const match = /^album:(.*)\|([^|]*)$/.exec(key);
    if (!match || typeof url !== 'string') continue;
    const [, album, artist] = match;
    if (isArtistsOwnCover(album, artist)) {
      if (!ownCovers.has(artist)) ownCovers.set(artist, new Set());
      ownCovers.get(artist).add(url);
    } else {
      if (!compilationCovers.has(url)) compilationCovers.set(url, []);
      compilationCovers.get(url).push(album);
    }
  }
  let cleared = 0;
  for (const [key, url] of Object.entries(cache)) {
    if (!key.startsWith('artist:')) continue;
    const name = key.slice('artist:'.length);
    const albums = compilationCovers.get(url);
    if (!albums || ownCovers.get(name)?.has(url) || albums.some(album => isArtistsOwnCover(album, name))) continue;
    delete cache[key];
    if (cache[name] === url) delete cache[name];
    cleared++;
  }
  return cleared;
}

export function rawArtistNamesForCanonical(canonicalId, meta) {
  const names = [];
  const mapping = meta.rawToCanonical;
  if (!mapping) return names;

  for (let rawId = 0; rawId < mapping.length; rawId++) {
    const targets = mapping[rawId];
    if (!targets?.includes(canonicalId)) continue;
    const name = meta.artists[rawId];
    if (name) names.push(name);
  }

  return names;
}

export function resolveArtistArtworkFromCandidates(names, cache) {
  const seen = new Set();
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const url = resolveArtistArtworkFromCache(name, cache);
    if (url) return url;
  }
  return null;
}

/** Copy existing raw-artist artwork onto canonical display names when missing. */
export function promoteCanonicalArtworkCache(cache, canonicalArtists, meta) {
  if (!canonicalArtists?.length || !meta?.rawToCanonical) return 0;

  let promoted = 0;
  for (let cId = 0; cId < canonicalArtists.length; cId++) {
    const name = canonicalArtists[cId];
    if (resolveArtistArtworkFromCache(name, cache)) continue;

    const fallbacks = rawArtistNamesForCanonical(cId, meta);
    const url = resolveArtistArtworkFromCandidates([name, ...fallbacks], cache);
    if (url) {
      storeArtworkInCache(cache, 'artist', name, '', url);
      promoted++;
    }
  }

  return promoted;
}
