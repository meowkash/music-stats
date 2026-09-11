import type { MetaData, YearData } from '../types/music';

export type ArtistRollupMode = 'canonical' | 'raw';
import { fetchAppJson, onPathsUpdated } from './dataStore';

const yearCache: Record<string, YearData> = {};

/** Fallback when meta.json carries no duration for a track. */
const DEFAULT_DURATION_MS = 210000;

interface ArtistTally { count: number; playtimeMs: number }
interface AlbumTally { count: number; playtimeMs: number; artistId: number }

export interface RollupItem {
  id: number;
  name: string;
  subtitle?: string;
  count: number;
  playtimeMs: number;
  artistId?: number;
  albumId?: number;
  artistName?: string;
  albumName?: string;
}

/**
 * One collator for every comparator in this module. A bare localeCompare call
 * may construct a fresh ICU collator each time, and ties are common here
 * because play counts cluster hard at low values.
 */
export const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

function byCountThenName<T extends { count: number; name: string }>(a: T, b: T): number {
  return b.count - a.count || nameCollator.compare(a.name, b.name);
}

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
  if (!startStr || !endStr) return [];
  const startYear = parseInt(startStr.split('-')[0], 10);
  const endYear = parseInt(endStr.split('-')[0], 10);
  if (isNaN(startYear) || isNaN(endYear)) return [];

  const years: string[] = [];
  for (let y = startYear; y <= endYear; y++) {
    years.push(String(y));
  }
  return years;
}

/** Lexical YYYY-MM-DD comparison matches chronological order. */

function creditArtistRollup(
  counts: Map<number, ArtistTally>,
  trackId: number,
  rawArtistId: number,
  playCount: number,
  playtimeMs: number,
  meta: MetaData,
  mode: ArtistRollupMode = 'canonical',
): void {
  const credit = (id: number) => {
    const tally = counts.get(id);
    if (tally) {
      tally.count += playCount;
      tally.playtimeMs += playtimeMs;
    } else {
      counts.set(id, { count: playCount, playtimeMs });
    }
  };

  if (mode === 'raw' || !meta.canonicalArtists) {
    credit(rawArtistId);
    return;
  }
  const ids = meta.trackToCanonical?.[trackId] ?? meta.rawToCanonical?.[rawArtistId] ?? [rawArtistId];
  for (const cId of ids) credit(cId);
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

/**
 * Reverse of meta.rawToCanonical, built once per MetaData object.
 *
 * This sits on the render path of every artist row, and the forward mapping has
 * one entry per raw artist — scanning it per row made painting the leaderboard
 * quadratic in the artist count.
 */
const rawNamesByCanonical = new WeakMap<MetaData, Map<number, string[]>>();

function rawNameIndex(meta: MetaData): Map<number, string[]> {
  let index = rawNamesByCanonical.get(meta);
  if (index) return index;

  index = new Map<number, string[]>();
  const mapping = meta.rawToCanonical;
  if (mapping) {
    for (let rawId = 0; rawId < mapping.length; rawId++) {
      const targets = mapping[rawId];
      if (!targets) continue;
      const name = meta.artists[rawId];
      if (!name) continue;
      for (const canonicalId of targets) {
        const names = index.get(canonicalId);
        if (names) names.push(name);
        else index.set(canonicalId, [name]);
      }
    }
  }

  rawNamesByCanonical.set(meta, index);
  return index;
}

const NO_RAW_NAMES: string[] = [];

/** Raw scrobble artist strings that map to a canonical artist ID. */
export function rawArtistNamesForCanonical(canonicalId: number, meta: MetaData): string[] {
  return rawNameIndex(meta).get(canonicalId) ?? NO_RAW_NAMES;
}

/**
 * A Map rather than a plain object so track ids stay numeric end to end: an
 * object forces every downstream rollup through Object.entries + parseInt,
 * which on a full-history range is ~13k string allocations per rollup.
 */
export function aggregateTrackCounts(
  years: string[],
  startStr: string,
  endStr: string,
  cache: Record<string, YearData> = yearCache,
): Map<number, number> {
  const scrobbleCounts = new Map<number, number>();

  for (const year of years) {
    const yearData = cache[year];
    if (!yearData) continue;

    // for-in rather than Object.entries: a year is ~365 keys and only the
    // requested window is wanted, so materialising the pair array is waste.
    for (const dateStr in yearData) {
      if (dateStr < startStr || dateStr > endStr) continue;
      for (const [trackId, count] of yearData[dateStr]) {
        scrobbleCounts.set(trackId, (scrobbleCounts.get(trackId) ?? 0) + count);
      }
    }
  }

  return scrobbleCounts;
}

export function rollupByCategory(
  trackCounts: Map<number, number>,
  meta: MetaData,
  category: 'tracks' | 'artists' | 'albums',
  options?: { artistMode?: ArtistRollupMode },
): Array<{ id: number; name: string; subtitle?: string; count: number; playtimeMs: number; artistId?: number; albumId?: number; artistName?: string; albumName?: string }> {
  if (category === 'tracks') {
    const tracks: RollupItem[] = [];
    for (const [tId, count] of trackCounts) {
      const trackInfo = meta.tracks[tId];
      // A year file can reference a track id meta.json doesn't carry yet — that
      // is what a partially-applied generation looks like. Skip rather than throw.
      if (!trackInfo) continue;
      const [trackName, artistId, albumId, duration = DEFAULT_DURATION_MS] = trackInfo;
      tracks.push({
        id: tId,
        name: trackName,
        subtitle: `${meta.artists[artistId]} • ${meta.albums[albumId]}`,
        artistId,
        albumId,
        artistName: meta.artists[artistId],
        albumName: meta.albums[albumId],
        count,
        playtimeMs: count * duration,
      });
    }
    return tracks;
  }

  if (category === 'artists') {
    const artistMode = options?.artistMode ?? 'canonical';
    const artistCounts = new Map<number, ArtistTally>();
    for (const [tId, count] of trackCounts) {
      const trackInfo = meta.tracks[tId];
      if (!trackInfo) continue;
      const artistId = trackInfo[1];
      const duration = trackInfo[3] ?? DEFAULT_DURATION_MS;
      creditArtistRollup(artistCounts, tId, artistId, count, count * duration, meta, artistMode);
    }
    const artists: RollupItem[] = [];
    for (const [artistId, data] of artistCounts) {
      artists.push({
        id: artistId,
        name: artistDisplayName(meta, artistId, artistMode),
        count: data.count,
        playtimeMs: data.playtimeMs,
      });
    }
    return artists;
  }

  const albumCounts = new Map<number, AlbumTally>();
  for (const [tId, count] of trackCounts) {
    const trackInfo = meta.tracks[tId];
    if (!trackInfo) continue;
    const [, artistId, albumId, duration = DEFAULT_DURATION_MS] = trackInfo;
    if (!isValidAlbum(meta, albumId)) continue;
    const tally = albumCounts.get(albumId);
    if (tally) {
      tally.count += count;
      tally.playtimeMs += count * duration;
    } else {
      albumCounts.set(albumId, { count, playtimeMs: count * duration, artistId });
    }
  }
  const albums: RollupItem[] = [];
  for (const [albumId, data] of albumCounts) {
    albums.push({
      id: albumId,
      name: meta.albums[albumId],
      subtitle: meta.artists[data.artistId],
      artistId: data.artistId,
      count: data.count,
      playtimeMs: data.playtimeMs,
    });
  }
  return albums;
}

export function rollupTopCounts(
  trackCounts: Map<number, number>,
  meta: MetaData,
): {
  artists: Array<{ id: number; name: string; count: number; playtimeMs: number }>;
  tracks: Array<{ id: number; name: string; artistName: string; albumName: string; artistId: number; albumId: number; count: number; playtimeMs: number }>;
  albums: Array<{ id: number; name: string; artistName: string; artistId: number; count: number; playtimeMs: number }>;
} {
  const artistCounts = new Map<number, ArtistTally>();
  const albumCounts = new Map<number, AlbumTally>();
  const tracks: Array<{ id: number; name: string; artistName: string; albumName: string; artistId: number; albumId: number; count: number; playtimeMs: number }> = [];

  // trackCounts is already keyed uniquely by track id, so the track list is a
  // straight projection of it — no intermediate accumulator needed.
  for (const [trackId, count] of trackCounts) {
    const trackInfo = meta.tracks[trackId];
    if (!trackInfo) continue;
    const [trackName, artistId, albumId, duration = DEFAULT_DURATION_MS] = trackInfo;
    const playtimeMs = count * duration;

    tracks.push({
      id: trackId,
      name: trackName,
      artistName: meta.artists[artistId] || 'Unknown Artist',
      albumName: meta.albums[albumId] || 'Unknown Album',
      artistId,
      albumId,
      count,
      playtimeMs,
    });

    creditArtistRollup(artistCounts, trackId, artistId, count, playtimeMs, meta);

    if (isValidAlbum(meta, albumId)) {
      const tally = albumCounts.get(albumId);
      if (tally) {
        tally.count += count;
        tally.playtimeMs += playtimeMs;
      } else {
        albumCounts.set(albumId, { count, playtimeMs, artistId });
      }
    }
  }

  const artists: Array<{ id: number; name: string; count: number; playtimeMs: number }> = [];
  for (const [artistId, data] of artistCounts) {
    artists.push({
      id: artistId,
      name: artistDisplayName(meta, artistId),
      count: data.count,
      playtimeMs: data.playtimeMs,
    });
  }

  const albums: Array<{ id: number; name: string; artistName: string; artistId: number; count: number; playtimeMs: number }> = [];
  for (const [albumId, data] of albumCounts) {
    albums.push({
      id: albumId,
      name: meta.albums[albumId] || 'Unknown Album',
      artistName: meta.artists[data.artistId] || 'Unknown Artist',
      artistId: data.artistId,
      count: data.count,
      playtimeMs: data.playtimeMs,
    });
  }

  return {
    artists: artists.sort(byCountThenName),
    tracks: tracks.sort(byCountThenName),
    albums: albums.sort(byCountThenName),
  };
}


onPathsUpdated([/^\/data\/year-\d+\.json$/], ({ path, data }) => {
  const match = path.match(/^\/data\/year-(\d+)\.json$/);
  if (match) yearCache[match[1]] = data as YearData;
});
