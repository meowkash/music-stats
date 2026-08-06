import type { MetaData, YearData } from '../types/music';
import { aggregateTrackCounts, rollupDashboardCounts } from './scrobbles';

/** Fallback when Last.fm duration is unavailable for a track. */
export const AVG_TRACK_MINUTES = 3.5;

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface RecapEntity {
  id: number;
  name: string;
  count: number;
  artistName?: string;
  albumName?: string;
  artistId?: number;
  albumId?: number;
}

export interface RecapMonth {
  month: number;
  label: string;
  count: number;
}

export interface RecapGenre {
  name: string;
  count: number;
  pct: number;
}

export interface RecapMetaData {
  tracks: Record<string, { duration: number | null; tags?: string[] }>;
  artists: Record<string, { tags?: string[] }>;
}

export interface RecapStats {
  year: string;
  totalPlays: number;
  listeningMinutes: number;
  listeningMinutesEstimated: boolean;
  activeDays: number;
  longestStreak: number;
  biggestDay: { date: string; label: string; count: number } | null;
  uniqueArtists: number;
  uniqueAlbums: number;
  uniqueTracks: number;
  topArtists: RecapEntity[];
  topTracks: RecapEntity[];
  topAlbums: RecapEntity[];
  topGenres: RecapGenre[];
  monthlyPlays: RecapMonth[];
  topMonth: RecapMonth | null;
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function computeStreaks(dates: string[]): { longest: number; activeDays: number } {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return { longest: 0, activeDays: 0 };

  let longest = 1;
  let current = 1;

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(`${sorted[i - 1]}T12:00:00`).getTime();
    const curr = new Date(`${sorted[i]}T12:00:00`).getTime();
    const diffDays = Math.round((curr - prev) / 86_400_000);
    if (diffDays === 1) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }

  return { longest, activeDays: sorted.length };
}

export function formatListeningTime(minutes: number): { primary: string; secondary?: string } {
  if (minutes >= 120) {
    const hours = Math.round(minutes / 60);
    return {
      primary: `${hours.toLocaleString()} hours`,
      secondary: `${Math.round(minutes).toLocaleString()} minutes total`,
    };
  }
  return { primary: `${Math.round(minutes).toLocaleString()} minutes` };
}

function computeListeningMinutes(
  trackCounts: Record<number, number>,
  meta: MetaData,
  recapMeta?: RecapMetaData,
): { minutes: number; estimated: boolean } {
  if (!recapMeta) {
    const plays = Object.values(trackCounts).reduce((s, c) => s + c, 0);
    return { minutes: Math.round(plays * AVG_TRACK_MINUTES), estimated: true };
  }

  let totalSeconds = 0;
  let coveredPlays = 0;
  let totalPlays = 0;

  for (const [trackIdStr, count] of Object.entries(trackCounts)) {
    totalPlays += count;
    const dur = recapMeta.tracks[trackIdStr]?.duration;
    if (dur && dur > 0) {
      totalSeconds += dur * count;
      coveredPlays += count;
    }
  }

  if (coveredPlays === 0) {
    return { minutes: Math.round(totalPlays * AVG_TRACK_MINUTES), estimated: true };
  }

  const missingPlays = totalPlays - coveredPlays;
  totalSeconds += missingPlays * AVG_TRACK_MINUTES * 60;

  return {
    minutes: Math.round(totalSeconds / 60),
    estimated: missingPlays > 0,
  };
}

function computeTopGenres(
  trackCounts: Record<number, number>,
  meta: MetaData,
  recapMeta?: RecapMetaData,
): RecapGenre[] {
  if (!recapMeta) return [];

  const genreCounts: Record<string, number> = {};
  let totalTagged = 0;

  for (const [trackIdStr, count] of Object.entries(trackCounts)) {
    const trackId = parseInt(trackIdStr, 10);
    const trackInfo = meta.tracks[trackId];
    if (!trackInfo) continue;

    const [, artistId] = trackInfo;
    const artistName = meta.artists[artistId];
    const trackTags = recapMeta.tracks[trackIdStr]?.tags;
    const artistTags = recapMeta.artists[artistName]?.tags;
    const tag = trackTags?.[0] || artistTags?.[0];
    if (!tag) continue;

    genreCounts[tag] = (genreCounts[tag] || 0) + count;
    totalTagged += count;
  }

  return Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({
      name,
      count,
      pct: totalTagged > 0 ? Math.round((count / totalTagged) * 100) : 0,
    }));
}

export function computeRecapStats(
  year: string,
  yearData: YearData,
  meta: MetaData,
  recapMeta?: RecapMetaData,
): RecapStats {
  const startStr = `${year}-01-01`;
  const endStr = `${year}-12-31`;
  const trackCounts = aggregateTrackCounts([year], startStr, endStr, { [year]: yearData });
  const rolled = rollupDashboardCounts(trackCounts, meta);

  let totalPlays = 0;
  const activeDates: string[] = [];
  const monthlyCounts = Array.from({ length: 12 }, () => 0);
  let biggestDay: { date: string; count: number } | null = null;

  for (const [dateStr, dayTracks] of Object.entries(yearData)) {
    const dayTotal = dayTracks.reduce((sum, [, count]) => sum + count, 0);
    if (dayTotal <= 0) continue;

    totalPlays += dayTotal;
    activeDates.push(dateStr);

    const month = parseInt(dateStr.split('-')[1], 10) - 1;
    if (month >= 0 && month < 12) monthlyCounts[month] += dayTotal;

    if (!biggestDay || dayTotal > biggestDay.count) {
      biggestDay = { date: dateStr, count: dayTotal };
    }
  }

  const { longest: longestStreak, activeDays } = computeStreaks(activeDates);
  const { minutes: listeningMinutes, estimated: listeningMinutesEstimated } = computeListeningMinutes(
    trackCounts,
    meta,
    recapMeta,
  );

  const monthlyPlays: RecapMonth[] = monthlyCounts.map((count, i) => ({
    month: i + 1,
    label: MONTH_LABELS[i],
    count,
  }));

  const topMonth = monthlyPlays.reduce<RecapMonth | null>(
    (best, m) => (!best || m.count > best.count ? m : best),
    null,
  );

  const uniqueArtists = new Set<number>();
  const uniqueAlbums = new Set<number>();
  const uniqueTracks = new Set<number>();

  for (const [trackIdStr, count] of Object.entries(trackCounts)) {
    if (count <= 0) continue;
    const trackId = parseInt(trackIdStr, 10);
    const trackInfo = meta.tracks[trackId];
    if (!trackInfo) continue;
    const [, artistId, albumId] = trackInfo;
    uniqueTracks.add(trackId);
    uniqueArtists.add(artistId);
    if (albumId > 0 && meta.albums[albumId]?.trim()) uniqueAlbums.add(albumId);
  }

  return {
    year,
    totalPlays,
    listeningMinutes,
    listeningMinutesEstimated,
    activeDays,
    longestStreak,
    biggestDay: biggestDay
      ? { ...biggestDay, label: formatDayLabel(biggestDay.date) }
      : null,
    uniqueArtists: uniqueArtists.size,
    uniqueAlbums: uniqueAlbums.size,
    uniqueTracks: uniqueTracks.size,
    topGenres: computeTopGenres(trackCounts, meta, recapMeta),
    topArtists: rolled.artists.slice(0, 10).map((a) => ({
      id: a.id,
      name: a.name,
      count: a.count,
    })),
    topTracks: rolled.tracks.slice(0, 10).map((t) => ({
      id: t.id,
      name: t.name,
      count: t.count,
      artistName: t.artistName,
      albumName: t.albumName,
      artistId: t.artistId,
      albumId: t.albumId,
    })),
    topAlbums: rolled.albums.slice(0, 10).map((a) => ({
      id: a.id,
      name: a.name,
      count: a.count,
      artistName: a.artistName,
      artistId: a.artistId,
    })),
    monthlyPlays,
    topMonth,
  };
}
