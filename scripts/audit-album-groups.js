import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createAlbumGroups } from './album-groups.js';
import { loadOverrides } from './artist-resolve.js';
import { readDataset } from './data-files.js';

// Input directory: meta.json and year-YYYY.json downloaded from one deployment.
const [inputDir, outputDir] = process.argv.slice(2);
if (!inputDir || !outputDir) throw new Error('Usage: node scripts/audit-album-groups.js INPUT_DIR OUTPUT_DIR');
const meta = JSON.parse(fs.readFileSync(path.join(inputDir, 'meta.json'), 'utf8'));
const yearFiles = fs.readdirSync(inputDir).filter(name => /^year-\d{4}\.json$/.test(name)).sort();
const keyFor = createAlbumGroups(meta.tracks.map(([track, artist, album]) => ({
  track, artist: meta.artists[artist], album: meta.albums[album],
})), loadOverrides());
const expected = new Map();
const currentYear = String(new Date().getUTCFullYear());
const groupsByOldId = new Map();
const expectedArtists = new Map();
let total = 0;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'music-album-audit-'));
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const canonicalCounts = (dictionary, data) => {
  const counts = new Map();
  for (const day of Object.values(data)) for (const [trackId, count] of day) {
    const artistId = dictionary.tracks[trackId][1];
    for (const id of dictionary.trackToCanonical?.[trackId] ?? dictionary.rawToCanonical[artistId]) {
      const name = dictionary.canonicalArtists[id];
      counts.set(name, (counts.get(name) ?? 0) + count);
    }
  }
  return counts;
};
try {
  fs.mkdirSync(path.join(fixture, 'src/data'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'src/data/artist-overrides.json'), JSON.stringify(loadOverrides()));
  const rows = ['uts,artist,album,track'];
  for (const file of yearFiles) {
    const year = file.match(/\d{4}/)[0];
    const albumCounts = new Map();
    expected.set(year, albumCounts);
    const data = JSON.parse(fs.readFileSync(path.join(inputDir, file), 'utf8'));
    for (const [date, tracks] of Object.entries(data).sort()) {
      const uts = Date.parse(`${date}T12:00:00Z`) / 1000;
      for (const [id, count] of tracks) {
        const [track, artistId, albumId] = meta.tracks[id];
        const artist = meta.artists[artistId];
        const album = meta.albums[albumId];
        total += count;
        expectedArtists.set(artist, (expectedArtists.get(artist) ?? 0) + count);
        for (let n = 0; n < count; n++) rows.push([uts, artist, album, track].map(quote).join(','));
        if (!album?.trim()) continue;
        const key = keyFor(artist, album);
        albumCounts.set(key, (albumCounts.get(key) ?? 0) + count);
        let groups = groupsByOldId.get(albumId);
        if (!groups) groupsByOldId.set(albumId, groups = new Map());
        let group = groups.get(key);
        if (!group) groups.set(key, group = { artists: new Set(), all: 0, current: 0 });
        group.artists.add(artist);
        group.all += count;
        if (year === currentYear) group.current += count;
      }
    }
  }
  fs.writeFileSync(path.join(fixture, 'src/data/scrobbles.csv'), rows.join('\n'));
  // Compare the original aggregation code with the fixed code on identical
  // input and artist overrides. Artist IDs may move; compare display names.
  const repoDir = fileURLToPath(new URL('../', import.meta.url));
  const original = spawnSync('git', ['show', 'HEAD:scripts/process-data.js'], {
    cwd: repoDir, encoding: 'utf8',
  });
  assert.equal(original.status, 0, original.stderr);
  const baselineSource = original.stdout.replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${new URL(relative, new URL('./process-data.js', import.meta.url)).href}'`);
  const baseline = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: fixture, input: baselineSource, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(baseline.status, 0, baseline.stderr);
  const baselineMeta = JSON.parse(fs.readFileSync(path.join(fixture, 'public/data/meta.json'), 'utf8'));
  const baselineArtistCounts = new Map();
  for (const file of yearFiles) {
    baselineArtistCounts.set(file, canonicalCounts(baselineMeta,
      JSON.parse(fs.readFileSync(path.join(fixture, 'public/data', file), 'utf8'))));
  }
  const baselineCatalog = readDataset(path.join(fixture, 'public/data'), 'catalog.json');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./process-data.js', import.meta.url))], {
    cwd: fixture, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const publicDir = path.join(fixture, 'public/data');
  const rebuilt = JSON.parse(fs.readFileSync(path.join(publicDir, 'meta.json'), 'utf8'));
  const catalog = readDataset(publicDir, 'catalog.json');
  const stats = JSON.parse(fs.readFileSync(path.join(publicDir, 'yearly-stats.json'), 'utf8'));
  let rebuiltTotal = 0;
  const actualArtists = new Map();
  const allAlbums = new Map();
  for (const [year, wanted] of expected) {
    const actual = new Map();
    const data = JSON.parse(fs.readFileSync(path.join(publicDir, `year-${year}.json`), 'utf8'));
    assert.deepEqual(canonicalCounts(rebuilt, data), baselineArtistCounts.get(`year-${year}.json`),
      `Unified artist totals changed in ${year}`);
    for (const day of Object.values(data)) for (const [id, count] of day) {
      rebuiltTotal += count;
      const [, artistId, albumId] = rebuilt.tracks[id];
      const artistName = rebuilt.artists[artistId];
      actualArtists.set(artistName, (actualArtists.get(artistName) ?? 0) + count);
      const album = rebuilt.albums[albumId];
      if (!album?.trim()) continue;
      const key = keyFor(rebuilt.artists[artistId], album);
      actual.set(key, (actual.get(key) ?? 0) + count);
      allAlbums.set(albumId, (allAlbums.get(albumId) ?? 0) + count);
    }
    assert.deepEqual(actual, wanted, `Album totals differ in ${year}`);
    assert.deepEqual(stats[year].albums.map(([, count]) => count), [...wanted.values()].sort((a, b) => b - a).slice(0, 5));
  }
  assert.equal(rebuiltTotal, total);
  assert.deepEqual(actualArtists, expectedArtists);
  const artistCatalogTotals = dictionary => new Map(Object.values(dictionary.canonicalArtists)
    .map(artist => [artist.name, artist.scrobbles]));
  assert.deepEqual(artistCatalogTotals(catalog), artistCatalogTotals(baselineCatalog));
  for (const [id, count] of allAlbums) assert.equal(catalog.albums[id].scrobbles, count);
  for (const bucket of ['artists', 'canonicalArtists']) for (const artist of Object.values(catalog[bucket])) {
    for (const album of artist.albums) assert.equal(album.scrobbles, allAlbums.get(album.id));
  }
  const collisions = [...groupsByOldId].filter(([, groups]) => groups.size > 1)
    .sort((a, b) => [...b[1].values()].reduce((sum, g) => sum + g.current, 0) - [...a[1].values()].reduce((sum, g) => sum + g.current, 0));
  fs.mkdirSync(outputDir, { recursive: true });
  const csv = [['old_album_id', 'title', 'artist_credits', 'all_time_plays', `${currentYear}_plays`].map(quote).join(',')];
  for (const [id, groups] of collisions) for (const group of groups.values()) {
    csv.push([id, meta.albums[id], [...group.artists].join(' / '), group.all, group.current].map(quote).join(','));
  }
  fs.writeFileSync(path.join(outputDir, 'album-collision-candidates.csv'), csv.join('\n') + '\n');
  const summary = {
    years: [...expected.keys()], sourceAlbums: meta.albums.length, sourceTracks: meta.tracks.length,
    playsVerified: total, collisionCandidates: collisions.length,
    activeThisYear: collisions.filter(([, groups]) => [...groups.values()].some(g => g.current > 0)).length,
    checks: ['All yearly album totals', 'Yearly top-five counts', 'All-time album catalog counts', 'Artist album references', 'Raw artist totals preserved', 'Unified artist totals unchanged versus original code in every year', 'Unified all-time artist catalog totals unchanged', 'Total plays preserved'],
    limitation: 'Candidate groups are inferred from track artist credits and album titles, not catalog release IDs. Some disconnected groups may be legitimate compilations or incomplete artist credits. Deployed dictionaries have already normalized edition names.',
  };
  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
