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

  // Rebuild artist entries from album art when missing (sync no longer fetches artist keys)
  if (type === 'album' && artistName) {
    const artistKey = artworkCacheKey('artist', artistName);
    const artistLegacy = resolveLegacyArtworkKey('artist', artistName);
    if (!cache[artistKey] && !cache[artistLegacy]) {
      cache[artistKey] = url;
      cache[artistLegacy] = url;
    }
  }
}
