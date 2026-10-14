import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDataset } from './data-files.js';
import { buildLadder, resolveArtwork } from './resolve-artwork/index.js';
import { albumGroupingKey, isCompilationAlbum } from './resolve-artwork/normalize.js';
import { createAlbumGroups } from './album-groups.js';

// Synthetic releases ensure the rules don't depend on known artist/album names.
const syntheticKey = createAlbumGroups([
  { artist: 'Artist Alpha', album: 'Shared Title', track: 'First' },
  { artist: 'Artist Alpha & Guest Beta', album: 'Shared Title (Deluxe)', track: 'Second' },
  { artist: 'Artist Gamma', album: 'Shared Title', track: 'Third' },
  { artist: 'Artist Alpha', album: 'Night Radio Episode 321 (DJ Mix)' },
  { artist: 'Artist Gamma', album: 'Night Radio Episode 321 (DJ Mix)' },
], { singleEntities: [], aliases: {} });
assert.equal(syntheticKey('Artist Alpha', 'Shared Title'), syntheticKey('Artist Alpha & Guest Beta', 'Shared Title (Deluxe)'));
assert.notEqual(syntheticKey('Artist Alpha', 'Shared Title'), syntheticKey('Artist Gamma', 'Shared Title'));
assert.equal(syntheticKey('Artist Alpha', 'Night Radio Episode 321 (DJ Mix)'), syntheticKey('Artist Gamma', 'Night Radio Episode 321 (DJ Mix)'));
assert.equal(isCompilationAlbum('Unfamiliar Label Yearbook 2030'), true);
assert.equal(isCompilationAlbum('Greatest Hits'), false);

const groupKey = createAlbumGroups([
  { artist: 'Ruben de Ronde & HALIENE', album: 'Different' },
  { artist: 'Elevven & Ruben de Ronde', album: 'Different' },
  { artist: 'Maître Gims', album: 'Le Fléau' },
  { artist: 'Gims', album: 'Le Fléau' },
  { artist: 'Charlie Puth', album: 'Nine Track Mind', track: 'Suffer' },
  { artist: 'Wiz Khalifa', album: 'Nine Track Mind', track: 'See You Again (feat. Charlie Puth)' },
], { singleEntities: [], aliases: { 'Maître Gims': 'Gims' } });
assert.equal(groupKey('Ruben de Ronde & HALIENE', 'Different'), groupKey('Elevven & Ruben de Ronde', 'Different'));
assert.equal(groupKey('Maître Gims', 'Le Fléau'), groupKey('Gims', 'Le Fléau'));
assert.equal(groupKey('Charlie Puth', 'Nine Track Mind'), groupKey('Wiz Khalifa', 'Nine Track Mind'));

assert.equal(albumGroupingKey('SG Lewis & Nile Rodgers', 'times'), albumGroupingKey('SG Lewis & Lastlings', 'times'));
assert.equal(albumGroupingKey('Tove Lo', 'Dirt Femme'), albumGroupingKey('Tove Lo & SG Lewis', 'Dirt Femme (Deluxe)'));
assert.equal(albumGroupingKey('Armin van Buuren & Argy', 'Asot 1274 - A State of Trance Episode 1274 (DJ Mix)'), albumGroupingKey('Airbase', 'Asot 1274 - A State of Trance Episode 1274 (DJ Mix)'));
assert.equal(albumGroupingKey('Pitbull & J Balvin', 'Fast & Furious 8: The Album'), albumGroupingKey('J Balvin & Pitbull', 'Fast & Furious 8: The Album'));
assert.notEqual(albumGroupingKey('Katy Perry', 'Smile'), albumGroupingKey('Simon Webbe', 'Smile'));

// Run the real aggregation pipeline in an isolated fixture directory.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'music-album-ranking-'));
try {
  fs.mkdirSync(path.join(fixture, 'src/data'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src/data/scrobbles.csv'), [
    'uts,artist,album,track',
    '1767225600,Hurts,Desire,Beautiful Ones',
    '1767225601,Dosem,Desire,Ethernal',
    '1767225602,Dosem,Desire,Ethernal',
    '1767225603,Dosem,Desire (Deluxe),Ethernal',
    '1767225604,Dosem,,Unknown release',
  ].join('\n'));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./process-data.js', import.meta.url))], {
    cwd: fixture, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const publicDir = path.join(fixture, 'public/data');
  const meta = JSON.parse(fs.readFileSync(path.join(publicDir, 'meta.json'), 'utf8'));
  const catalog = readDataset(publicDir, 'catalog.json');
  const albums = Object.values(catalog.albums) as Array<{ name: string; artistName: string; scrobbles: number }>;
  assert.deepEqual(albums.map(a => [a.artistName, a.name, a.scrobbles]), [
    ['Hurts', 'Desire', 1], ['Dosem', 'Desire', 3],
  ]);
  assert.equal(catalog.artists[0].albums[0].id, 0);
  assert.equal(catalog.canonicalArtists[0].albums[0].id, 0);
  const recent = JSON.parse(fs.readFileSync(path.join(publicDir, 'recent.json'), 'utf8'));
  for (const item of recent) assert.equal(meta.tracks[item.trackId][0], item.track);

  // The browser rollups must keep album zero and omit the empty album.
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  const { aggregateTrackCounts, rollupByCategory, rollupTopCounts } = await import('../src/utils/scrobbles.ts');
  const year = JSON.parse(fs.readFileSync(path.join(publicDir, 'year-2026.json'), 'utf8'));
  const counts = aggregateTrackCounts(['2026'], '2026-01-01', '2026-12-31', { '2026': year });
  assert.deepEqual(rollupByCategory(counts, meta, 'albums').map(a => a.count), [1, 3]);
  assert.deepEqual(rollupTopCounts(counts, meta).albums.map(a => [a.artistName, a.count]), [['Dosem', 3], ['Hurts', 1]]);

  const artistFixture = {
    artists: ['Artist Alpha', 'Alpha Alias', 'Artist Alpha & Guest Beta'],
    canonicalArtists: ['Artist Alpha', 'Guest Beta'],
    rawToCanonical: [[0], [0], [0, 1]],
    trackToCanonical: [[0], [0], [0, 1], [0, 1]],
    albums: ['Shared Title', 'Shared Title', 'Shared Title (Deluxe)'],
    tracks: [['Solo', 0, 0], ['Alias song', 1, 1], ['Duet', 2, 2], ['Featured song', 0, 0]],
  };
  const artistPlayCounts = new Map([[0, 3], [1, 2], [2, 4], [3, 1]]);
  assert.deepEqual(rollupByCategory(artistPlayCounts, artistFixture as typeof meta, 'artists').map(a => [a.name, a.count]),
    [['Artist Alpha', 10], ['Guest Beta', 5]]);
  assert.deepEqual(rollupTopCounts(artistPlayCounts, artistFixture as typeof meta).artists.map(a => [a.name, a.count]),
    [['Artist Alpha', 10], ['Guest Beta', 5]]);

  const entity = { type: 'album', name: 'Desire', artistName: 'Dosem' };
  assert.equal(buildLadder(entity).find(r => r.label === 'title-only')?.expect.artistName, 'Dosem');
  // Irrelevant iTunes results must not prevent checking another catalog.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('itunes.apple.com')) return new Response(JSON.stringify({ results: [{
      collectionName: 'Desire', artistName: 'Hurts', artworkUrl100: 'https://example.com/wrong.jpg',
    }] }));
    if (url.includes('api.deezer.com')) return new Response(JSON.stringify({ data: [{
      title: 'Desire', artist: { name: 'Dosem' }, cover_xl: 'https://example.com/correct.jpg',
    }] }));
    throw new Error(`Unexpected catalog request: ${url}`);
  };
  try {
    assert.equal((await resolveArtwork(entity))?.url, 'https://example.com/correct.jpg');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('Album grouping, zero ID, recent track IDs, and artwork artist matching passed.');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
