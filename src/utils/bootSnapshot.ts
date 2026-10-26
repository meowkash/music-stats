// Build-time only: useful content is part of the document, before JS/network.
import fs from 'node:fs';
import path from 'node:path';
import { readDataset } from '../../scripts/data-files.js';
import { aggregateTrackCounts, rollupTopCounts, type RollupItem } from './musicQueries';
import type { MetaData, YearData, YearlyTotals } from '../types/music';
import { generateScrobbleRowHTML, getArtworkUrl, getArtistArtworkUrl } from './ui';
import { buildReport } from './reports';
import { buildYearStory } from './yearBlurb';
let snapshot: ReturnType<typeof build> | undefined;
function build() {
  const directory = path.resolve('public/data');
  const read = <T>(name: string): T => readDataset(directory, name) as T;
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const totals = read<YearlyTotals>('yearly-totals.json');
  const meta = read<MetaData>('meta.json');
  const recent = read<Array<{ uts: number }>>('recent.json');
  const recaps = read<{ years: Array<{ year: number; topArtist: string }> }>('recaps.json');
  const artwork = read<Record<string, string>>('artwork.json') ?? {};
  const years = Object.keys(totals);
  const cache = Object.fromEntries(years.map(y => [y, read<YearData>(`year-${y}.json`)]));
  const latest = (recent[0]?.uts ?? Date.now() / 1000) * 1000;
  const window = (end: number, days: number) => rollupTopCounts(aggregateTrackCounts(years, new Date(end - (days - 1) * 86400000).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10), cache), meta);
  const monthly = window(latest, 28), rankings = window(Date.now(), 7);
  let total = 0, activeDays = 0, days = 0;
  for (const values of Object.values(totals)) for (const n of values) { total += n; days++; if (n) activeDays++; }
  const yearlyStats = read<Record<string, { tracks?: [number, number][]; albums?: [number, number][]; artists?: [number, number][] }>>('yearly-stats.json');
  const albumArtists = new Map<number, number>();
  for (const track of meta.tracks) if (!albumArtists.has(track[2])) albumArtists.set(track[2], track[1]);
  const stories = years.sort().reverse().map(y => `<div class="year-story-page">${buildYearStory(y, yearlyStats[y], meta, albumArtists, '#22c55e').html}</div>`).join('');
  const stats = { total, activeDays, dailyAverage: days ? Math.round(total / days * 10) / 10 : 0, currentYear: (totals[String(new Date().getUTCFullYear())] ?? []).reduce((a, b) => a + b, 0) };
  const rows = (items: RollupItem[], type: 'track' | 'album' | 'artist') => items.slice(0, 25).map((item, index) => generateScrobbleRowHTML({ type, id: item.id, rank: index + 1, name: item.name, subtitle: item.artistName ?? item.subtitle ?? '', count: item.count, imgUrl: type === 'artist' ? getArtistArtworkUrl(item.name, artwork) : getArtworkUrl(type, item.name, item.artistName ?? '', item.albumName ?? item.name, artwork), artistCatalog: type === 'artist' ? 'canonicalArtists' : undefined })).join('') || '<div class="no-data-message">No plays recorded in this period.</div>';
  return {
    manifest: { ...manifest, artwork: [] }, stats, recaps, monthly, rankings, rows, stories,
    report: buildReport(totals, [], 'week', 1),
    data: { '/data/yearly-totals.json': totals, '/data/yearly-stats.json': read('yearly-stats.json'), '/data/recent.json': recent, '/data/recaps.json': recaps },
  };
}
export function getBootSnapshot() { return snapshot ??= build(); }
export function safeJSON(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c'); }
