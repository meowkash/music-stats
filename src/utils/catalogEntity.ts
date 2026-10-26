export interface CatalogEntitySelection {
  type: string;
  id: number;
  artistCatalog?: 'artists' | 'canonicalArtists';
  artistId?: number;
}
interface CatalogArtist { name: string; scrobbles: number; albums: Array<{ id: number; name: string; scrobbles: number }>; tracks: Array<{ name: string; count: number }> }
interface CatalogAlbum { name: string; artistName: string; artistId: number; scrobbles: number; tracks: Record<string, { name: string; count: number }>; sortedTracks?: Array<{ name: string; count: number }> }
export interface EntityCatalog {
  artists: Record<string, CatalogArtist>;
  canonicalArtists: Record<string, CatalogArtist>;
  albums: Record<string, CatalogAlbum>;
  tracks: Record<string, number>;
}
/** Only selected detail data crosses the worker boundary. The full catalog
 * stays in the repository worker, including its pre-sorted artist track lists. */
export function selectCatalogEntity(catalog: EntityCatalog, selection: CatalogEntitySelection): EntityCatalog {
  const result: EntityCatalog = { artists: {}, canonicalArtists: {}, albums: {}, tracks: {} };
  const bucket = selection.artistCatalog ?? 'canonicalArtists';
  const album = selection.type === 'album' ? catalog.albums[selection.id] : undefined;
  const artistId = selection.type === 'artist' ? selection.id : album?.artistId ?? selection.artistId;
  const artistBucket = selection.type === 'artist' && catalog[bucket] ? bucket : 'artists';
  const artist = artistId === undefined ? undefined : catalog[artistBucket]?.[artistId];
  if (artist && artistId !== undefined) {
    result[artistBucket][artistId] = selection.type === 'artist' ? artist : { ...artist, tracks: [] };
    for (const related of artist.albums ?? []) if (catalog.albums[related.id]) {
      // Related cards need title/attribution/count; no related track dictionaries.
      result.albums[related.id] = { ...catalog.albums[related.id], tracks: {} };
    }
  }
  if (album) result.albums[selection.id] = { ...album, sortedTracks: Object.values(album.tracks).sort((a, b) => b.count - a.count) };
  if (selection.type === 'track') result.tracks[selection.id] = catalog.tracks[selection.id] ?? 0;
  return result;
}
