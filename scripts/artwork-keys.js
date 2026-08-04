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

/** Artist artwork: direct key → any cached album for this artist. */
export function resolveArtistArtworkFromCache(name, cache) {
  const direct = cache[artworkCacheKey('artist', name)] ?? cache[resolveLegacyArtworkKey('artist', name)];
  if (direct) return direct;

  const suffix = `|${name}`;
  for (const [key, url] of Object.entries(cache)) {
    if (key.startsWith('album:') && key.endsWith(suffix)) return url;
  }

  for (const [key, url] of Object.entries(cache)) {
    if (!key.includes(':') && key.includes('|') && key.endsWith(suffix)) return url;
  }

  return null;
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
