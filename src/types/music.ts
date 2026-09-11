export interface MetaData {
  artists: string[];
  albums: string[];
  tracks: [string, number, number, number?][];
  canonicalArtists?: string[];
  rawToCanonical?: number[][];
  trackToCanonical?: number[][];
}

export interface YearlyTotals {
  [year: string]: number[];
}

export type DayRecord = [number, number][];
export type YearData = Record<string, DayRecord>;

export type EntityType = 'artist' | 'album' | 'track';
