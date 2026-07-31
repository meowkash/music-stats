export interface MetaData {
  artists: string[];
  albums: string[];
  tracks: [string, number, number][];
}

export interface YearlyTotals {
  [year: string]: number[];
}

export interface RecentScrobble {
  uts: number;
  artist: string;
  album: string;
  track: string;
  trackId: number;
}

export type DayRecord = [number, number][];
export type YearData = Record<string, DayRecord>;

export type EntityType = 'artist' | 'album' | 'track';
export type CategoryTab = 'tracks' | 'albums' | 'artists' | 'songs';
