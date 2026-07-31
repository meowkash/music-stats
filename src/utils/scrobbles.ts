import type { MetaData, YearData } from '../types/music';

export type ArtistRollupMode = 'canonical' | 'raw';
import { fetchAppJson, onPathsUpdated } from './dataStore';

const yearCache: Record<string, YearData> = {};

export async function loadYearData(year: string): Promise<YearData | null> {
  if (yearCache[year]) return yearCache[year];
  try {
    yearCache[year] = await fetchAppJson<YearData>(`/data/year-${year}.json`);
    return yearCache[year];
  } catch (err) {
    console.warn(`Year data for ${year} could not be loaded:`, err);
    return null;
  }
}

export async function loadYearsData(years: string[]): Promise<void> {
  await Promise.all(years.map((y) => loadYearData(y)));
}

export function getYearsInRange(startStr: string, endStr: string): string[] {
  const startYear = parseInt(startStr.split('-')[0], 10);
  const endYear = parseInt(endStr.split('-')[0], 10);
  const years: string[] = [];
  for (let y = startYear; y <= endYear; y++) {
    years.push(String(y));
  }
  return years;
}

/** Lexical YYYY-MM-DD comparison matches chronological order. */

function creditArtistRollup(
  counts: Record<number, number>,
  trackId: number,
  rawArtistId: number,
  playCount: number,
  meta: MetaData,
  mode: ArtistRollupMode = 'canonical',
): void {
  if (mode === 'raw') {
    counts[rawArtistId] = (counts[rawArtistId] || 0) + playCount;
    return;
  }
  const trackMap = meta.trackToCanonical;
  const mapping = meta.rawToCanonical;
  const canonical = meta.canonicalArtists;
  if (canonical) {
    const ids = trackMap?.[trackId] ?? mapping?.[rawArtistId] ?? [rawArtistId];
    for (const cId of ids) {
      counts[cId] = (counts[cId] || 0) + playCount;
    }
    return;
  }
  counts[rawArtistId] = (counts[rawArtistId] || 0) + playCount;
}

function isValidAlbum(meta: MetaData, albumId: number): boolean {
  const name = meta.albums[albumId];
  return albumId > 0 && typeof name === 'string' && name.trim() !== '';
}

function artistDisplayName(meta: MetaData, artistId: number, mode: ArtistRollupMode = 'canonical'): string {
  if (mode === 'raw') return meta.artists[artistId];
  if (meta.canonicalArtists?.[artistId]) return meta.canonicalArtists[artistId];
  return meta.artists[artistId];
}

/** Raw scrobble artist strings that map to a canonical artist ID. */
export function rawArtistNamesForCanonical(canonicalId: number, meta: MetaData): string[] {
  const names: string[] = [];
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

export function aggregateTrackCounts(
  years: string[],
  startStr: string,
  endStr: string,
  cache: Record<string, YearData> = yearCache,
): Record<number, number> {
  const scrobbleCounts: Record<number, number> = {};

  for (const year of years) {
    const yearData = cache[year];
    if (!yearData) continue;

    for (const [dateStr, dayTracks] of Object.entries(yearData)) {
      if (dateStr >= startStr && dateStr <= endStr) {
        for (const [trackId, count] of dayTracks) {
          scrobbleCounts[trackId] = (scrobbleCounts[trackId] || 0) + count;
        }
      }
    }
  }

  return scrobbleCounts;
}

export function rollupByCategory(
  trackCounts: Record<number, number>,
  meta: MetaData,
  category: 'tracks' | 'artists' | 'albums',
  options?: { artistMode?: ArtistRollupMode },
): Array<{ id: number; name: string; subtitle?: string; count: number; artistId?: number; albumId?: number; artistName?: string; albumName?: string }> {
  if (category === 'tracks') {
    return Object.entries(trackCounts).map(([tIdStr, count]) => {
      const tId = parseInt(tIdStr, 10);
      const trackInfo = meta.tracks[tId];
      const trackName = trackInfo[0];
      const artistId = trackInfo[1];
      const albumId = trackInfo[2];
      return {
        id: tId,
        name: trackName,
        subtitle: `${meta.artists[artistId]} • ${meta.albums[albumId]}`,
        artistId,
        albumId,
        artistName: meta.artists[artistId],
        albumName: meta.albums[albumId],
        count,
      };
    });
  }

  if (category === 'artists') {
    const artistMode = options?.artistMode ?? 'canonical';
    const artistCounts: Record<number, number> = {};
    for (const [tIdStr, count] of Object.entries(trackCounts)) {
      const tId = parseInt(tIdStr, 10);
      const artistId = meta.tracks[tId][1];
      creditArtistRollup(artistCounts, tId, artistId, count, meta, artistMode);
    }
    return Object.entries(artistCounts).map(([artIdStr, count]) => ({
      id: parseInt(artIdStr, 10),
      name: artistDisplayName(meta, parseInt(artIdStr, 10), artistMode),
      count,
    }));
  }

  const albumCounts: Record<number, { count: number; artistId: number }> = {};
  for (const [tIdStr, count] of Object.entries(trackCounts)) {
    const tId = parseInt(tIdStr, 10);
    const albumId = meta.tracks[tId][2];
    const artistId = meta.tracks[tId][1];
    if (!isValidAlbum(meta, albumId)) continue;
    if (!albumCounts[albumId]) {
      albumCounts[albumId] = { count: 0, artistId };
    }
    albumCounts[albumId].count += count;
  }
  return Object.entries(albumCounts).map(([albIdStr, data]) => ({
    id: parseInt(albIdStr, 10),
    name: meta.albums[parseInt(albIdStr, 10)],
    subtitle: meta.artists[data.artistId],
    artistId: data.artistId,
    count: data.count,
  }));
}

export function rollupDashboardCounts(
  trackCounts: Record<number, number>,
  meta: MetaData,
): {
  artists: Array<{ id: number; name: string; count: number }>;
  tracks: Array<{ id: number; name: string; artistName: string; albumName: string; artistId: number; albumId: number; count: number }>;
  albums: Array<{ id: number; name: string; artistName: string; artistId: number; count: number }>;
} {
  const artistCounts: Record<number, number> = {};
  const albumCounts: Record<number, { count: number; artistId: number }> = {};
  const songCounts: Record<number, number> = {};

  for (const [trackIdStr, count] of Object.entries(trackCounts)) {
    const trackId = parseInt(trackIdStr, 10);
    const trackInfo = meta.tracks[trackId];
    if (!trackInfo) continue;
    const [, artistId, albumId] = trackInfo;

    songCounts[trackId] = (songCounts[trackId] || 0) + count;
    creditArtistRollup(artistCounts, trackId, artistId, count, meta);
    if (isValidAlbum(meta, albumId)) {
      if (!albumCounts[albumId]) {
        albumCounts[albumId] = { count: 0, artistId };
      }
      albumCounts[albumId].count += count;
    }
  }

  return {
    artists: Object.entries(artistCounts)
      .map(([id, count]) => ({ id: parseInt(id, 10), name: artistDisplayName(meta, parseInt(id, 10)), count }))
      .sort((a, b) => b.count - a.count),
    tracks: Object.entries(songCounts)
      .map(([id, count]) => {
        const [trackName, artistId, albumId] = meta.tracks[parseInt(id, 10)];
        return {
          id: parseInt(id, 10),
          name: trackName,
          artistName: meta.artists[artistId],
          albumName: meta.albums[albumId],
          artistId,
          albumId,
          count,
        };
      })
      .sort((a, b) => b.count - a.count),
    albums: Object.entries(albumCounts)
      .map(([id, data]) => ({
        id: parseInt(id, 10),
        name: meta.albums[parseInt(id, 10)],
        artistName: meta.artists[data.artistId],
        artistId: data.artistId,
        count: data.count,
      }))
      .sort((a, b) => b.count - a.count),
  };
}

export function clearYearCache(): void {
  for (const key of Object.keys(yearCache)) {
    delete yearCache[key];
  }
}

onPathsUpdated([/^\/data\/year-\d+\.json$/], ({ path, data }) => {
  const match = path.match(/^\/data\/year-(\d+)\.json$/);
  if (match) yearCache[match[1]] = data as YearData;
});
