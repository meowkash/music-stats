/**
 * Artwork sources, each normalized to a common candidate shape:
 *   { name, artistName, url, source }
 *
 * iTunes, Deezer and MusicBrainz/Cover Art Archive all need no API key.
 * Last.fm is last: it's the origin of the problem (its database genuinely has
 * no image for one-off episodic releases), so it only fills gaps.
 */

const USER_AGENT = 'music-stats/1.0 (+https://music.aakashkap.com)';

async function getJson(url, { headers } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** iTunes artworkUrl100 → highest static size. */
function upscaleItunes(url) {
  return url
    ?.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/1000x1000bb.jpg')
    .replace(/\/\d+x\d+\.(jpg|png)$/, '/1000x1000bb.jpg');
}

/**
 * `limit=25` and `media=music` rather than the old `limit=1`: the caller scores
 * the whole candidate list instead of trusting position one.
 */
export async function searchItunes(term, entity) {
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&entity=${entity}&media=music&country=US&limit=25`;

  const data = await getJson(url);

  // The field to compare against depends on the entity: for a song search
  // collectionName is the *album*, so scoring a track title against it fails
  // every time (that's what made "Black Room Boy" unmatchable).
  const nameFor = (result) => {
    if (entity === 'song') return result.trackName ?? result.collectionName ?? '';
    if (entity === 'musicArtist') return result.artistName ?? '';
    return result.collectionName ?? result.trackName ?? '';
  };

  return (data.results ?? [])
    .map((result) => ({
      name: nameFor(result),
      artistName: result.artistName ?? '',
      url: upscaleItunes(result.artworkUrl100),
      source: 'itunes',
    }))
    .filter((candidate) => candidate.url);
}

export async function searchDeezer(term, type) {
  const url = `https://api.deezer.com/search/${type}?q=${encodeURIComponent(term)}&limit=25`;
  const data = await getJson(url);

  return (data.data ?? [])
    .map((result) => ({
      name: result.title ?? result.name ?? '',
      artistName: result.artist?.name ?? result.name ?? '',
      // xl is 1000x1000 for albums, 1000x1000 for artist pictures
      url: result.cover_xl ?? result.picture_xl ?? result.album?.cover_xl ?? null,
      source: 'deezer',
    }))
    .filter((candidate) => candidate.url);
}

/**
 * MusicBrainz release-groups + Cover Art Archive. Strong on compilations and DJ
 * mixes that the commercial stores never listed.
 */
export async function searchMusicBrainz(term, artistName) {
  const query = artistName
    ? `releasegroup:"${term}" AND artist:"${artistName}"`
    : `releasegroup:"${term}"`;
  const url =
    `https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(query)}` +
    `&fmt=json&limit=10`;

  const data = await getJson(url);
  const groups = data['release-groups'] ?? [];
  const candidates = [];

  for (const group of groups.slice(0, 5)) {
    candidates.push({
      name: group.title ?? '',
      artistName: group['artist-credit']?.[0]?.name ?? '',
      // CAA redirects to the real image; existence is confirmed on download.
      url: `https://coverartarchive.org/release-group/${group.id}/front-500`,
      source: 'musicbrainz',
    });
  }

  return candidates;
}

function lastfmImage(images) {
  if (!Array.isArray(images)) return null;
  const image =
    images.find((i) => i.size === 'mega') ??
    images.find((i) => i.size === 'extralarge') ??
    images.find((i) => i.size === 'large');
  const url = image?.['#text'];
  // Last.fm's placeholder star hash — worse than no artwork at all.
  if (!url || url.includes('2a96cbd8b46e442fc41c2b86b821562f')) return null;
  return url;
}

export async function searchLastfm(apiKey, { type, name, artistName }) {
  if (!apiKey) return [];

  const base = `https://ws.audioscrobbler.com/2.0/?api_key=${apiKey}&format=json`;
  let url;
  if (type === 'album') {
    url = `${base}&method=album.getinfo&artist=${encodeURIComponent(artistName)}&album=${encodeURIComponent(name)}`;
  } else if (type === 'artist') {
    url = `${base}&method=artist.getinfo&artist=${encodeURIComponent(name)}`;
  } else {
    url = `${base}&method=track.getinfo&artist=${encodeURIComponent(artistName)}&track=${encodeURIComponent(name)}`;
  }

  const data = await getJson(url);

  if (type === 'album') {
    const image = lastfmImage(data.album?.image);
    return image
      ? [{ name: data.album?.name ?? name, artistName: data.album?.artist ?? artistName, url: image, source: 'lastfm' }]
      : [];
  }
  if (type === 'artist') {
    const image = lastfmImage(data.artist?.image);
    return image
      ? [{ name: data.artist?.name ?? name, artistName: data.artist?.name ?? name, url: image, source: 'lastfm' }]
      : [];
  }

  const image = lastfmImage(data.track?.album?.image) ?? lastfmImage(data.track?.image);
  return image
    ? [{ name: data.track?.name ?? name, artistName: data.track?.artist?.name ?? artistName, url: image, source: 'lastfm' }]
    : [];
}
