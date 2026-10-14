import { buildArtistAttribution } from './artist-resolve.js';
import { albumGroupingKey, canonicalAlbumTitle, isCompilationAlbum, normalizeForCompare } from './resolve-artwork/normalize.js';

// Track artists may include guests, reordered credits, or aliases. Connect
// credits within each album title before allocating IDs, rather than giving
// every spelling its own release. Named compilations intentionally span artists.
export function createAlbumGroups(rows, overrides) {
  const titles = new Map();
  const artists = new Set();
  const tracks = [];
  const seenTracks = new Set();
  for (const { artist, album, track = '' } of rows) {
    const title = normalizeForCompare(canonicalAlbumTitle(album));
    if (!title) continue;
    let entry = titles.get(title);
    if (!entry) titles.set(title, entry = { artists: new Set(), tracks: [], compilation: false });
    entry.artists.add(artist);
    entry.compilation ||= isCompilationAlbum(album);
    artists.add(artist);
    const trackKey = `${title}\0${artist}\0${track}`;
    if (!seenTracks.has(trackKey)) {
      seenTracks.add(trackKey);
      entry.tracks.push(tracks.length);
      tracks.push({ artist, track });
    }
  }
  const rawArtists = [...artists];
  const artistIds = new Map(rawArtists.map((name, i) => [name, i]));
  const { canonicalArtists, rawToCanonical, trackToCanonical } = buildArtistAttribution(
    rawArtists, overrides, [], tracks.map(({ artist, track }) => [track, artistIds.get(artist), 0]),
  );
  const credits = new Map(rawArtists.map((name, i) => [name, rawToCanonical[i]]));
  const keys = new Map();
  for (const [title, entry] of titles) {
    const parent = new Map();
    const find = (id) => {
      if (!parent.has(id)) parent.set(id, id);
      if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
      return parent.get(id);
    };
    for (const artist of entry.artists) {
      const ids = credits.get(artist);
      for (const id of ids) parent.set(find(id), find(ids[0]));
    }
    // A featured album artist can be present only in the song title, e.g.
    // Wiz Khalifa — See You Again (feat. Charlie Puth) on Nine Track Mind.
    for (const index of entry.tracks) {
      const ids = trackToCanonical[index];
      for (const id of ids) parent.set(find(id), find(ids[0]));
    }
    const members = new Map();
    for (const id of parent.keys()) {
      const root = find(id);
      const name = normalizeForCompare(canonicalArtists[id]);
      if (!members.has(root) || name < members.get(root)) members.set(root, name);
    }
    const titleKeys = new Map();
    for (const artist of entry.artists) {
      const owner = entry.compilation ? 'compilation' : members.get(find(credits.get(artist)[0]));
      titleKeys.set(artist, `${owner}|${title}`);
    }
    keys.set(title, titleKeys);
  }
  return (artist, album) => keys.get(normalizeForCompare(canonicalAlbumTitle(album)))?.get(artist)
    ?? albumGroupingKey(artist, album);
}
