import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArtistAttribution } from './artist-resolve.js';
import { chunkArrays, mergeShards, writeDataset } from './data-files.js';

// Clients keep every body they have downloaded, keyed by hash, so what a new
// build costs a device is exactly the bytes whose hashes changed. These checks
// keep a normal daily update from re-shipping data that did not change.
//
//   node scripts/test-data-churn.mjs          synthetic data (npm test)
//   node scripts/test-data-churn.mjs --real   the real dataset in src/data

const scripts = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(scripts);

function run(cwd, script) {
  const result = spawnSync(process.execPath, [path.join(scripts, script)], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${script} failed:\n${result.stderr}`);
}
const manifestAt = dir => JSON.parse(fs.readFileSync(path.join(dir, 'public/data/manifest.json'), 'utf8'));
function changes(before, after) {
  const old = new Map(before.files.map(file => [file.path, file.hash]));
  const changed = after.files.filter(file => old.get(file.path) !== file.hash);
  return { changed, bytes: changed.reduce((sum, file) => sum + file.bytes, 0), total: after.files.reduce((sum, file) => sum + file.bytes, 0) };
}

function synthetic() {
  // Chunks are index ranges: appending ids touches only the tail.
  const meta = n => ({ tracks: Array.from({ length: n }, (_, i) => [`Track ${i}`, i % 40, i % 90]), artists: Array.from({ length: 40 }, (_, i) => `Artist ${i}`) });
  const a = chunkArrays(meta(1300), 512), b = chunkArrays(meta(1306), 512);
  assert.deepEqual(mergeShards(b, 'arrays'), meta(1306));
  assert.equal(JSON.stringify(a.slice(0, -1)), JSON.stringify(b.slice(0, -1)), 'Appending ids rewrote earlier meta chunks');

  // Canonical ids must be append-only too. A credit that only appears in a
  // title (feat. Guest) used to be numbered after every raw artist, so a day's
  // new artist shifted it and rewrote every meta chunk and catalog shard.
  const attribute = (artists, tracks) => buildArtistAttribution(artists, { singleEntities: [], aliases: {} }, [], tracks, []);
  const day1 = attribute(['A'], [['Song (feat. Guest)', 0]]);
  const day2 = attribute(['A', 'B'], [['Song (feat. Guest)', 0], ['New', 1]]);
  for (const key of ['canonicalArtists', 'rawToCanonical', 'trackToCanonical']) {
    assert.deepEqual(day2[key].slice(0, day1[key].length), day1[key], `A new artist renumbered existing ${key}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-churn-'));
  try {
    const data = path.join(dir, 'public/data');
    fs.mkdirSync(data, { recursive: true });
    const albums = count => Object.fromEntries(Array.from({ length: 300 }, (_, i) => [i, { name: `Album ${i}`, artistName: `Artist ${i % 40}`, artistId: i % 40, scrobbles: i === 7 ? count : 5 + i }]));
    const artwork = extra => Object.fromEntries([...Array.from({ length: 300 }, (_, i) => [`album:Album ${i}|Artist ${i % 40}`, `https://lastfm.freetls.fastly.net/i/u/500x500/${i}.jpg`]), ...extra]);
    const write = (tracks, plays, extra = []) => {
      fs.writeFileSync(path.join(data, 'meta.json'), JSON.stringify(meta(tracks)));
      writeDataset(data, 'artwork.json', artwork(extra));
      writeDataset(data, 'catalog.json', { albums: albums(plays), artists: {}, canonicalArtists: {}, tracks: {} }, { meta: meta(tracks) });
      fs.writeFileSync(path.join(data, 'recent.json'), JSON.stringify([{ uts: tracks }]));
      run(dir, 'generate-manifest.js');
      return manifestAt(dir);
    };
    const before = write(1300, 10);
    // A day: six new tracks, one more play of an album, one new cover.
    const after = write(1306, 11, [['album:New Album|Artist 3', 'https://lastfm.freetls.fastly.net/i/u/500x500/new.jpg']]);
    const { changed } = changes(before, after);
    const paths = changed.map(file => file.path);
    assert.ok(!paths.includes('/data/meta.json') && !paths.includes('/data/artwork-urls.json'), 'Monoliths must not ship');
    assert.equal(paths.filter(p => p.startsWith('/data/meta/')).length, 1, `Only the tail meta chunk may change: ${paths}`);
    assert.equal(paths.filter(p => p.startsWith('/data/artwork-urls/')).length, 1, `One new cover is one prefetch shard: ${paths}`);
    assert.equal(paths.filter(p => p.startsWith('/data/artwork/')).length, 1, `One new cover is one artwork shard: ${paths}`);
    assert.ok(paths.filter(p => p.startsWith('/data/catalog/')).length <= 1, `One album's plays is one catalog shard: ${paths}`);
    const again = write(1306, 11, [['album:New Album|Artist 3', 'https://lastfm.freetls.fastly.net/i/u/500x500/new.jpg']]);
    assert.deepEqual(changes(after, again).changed, [], 'Rebuilding identical data must change nothing');
    return { synthetic: 'A day of new tracks, plays and covers rewrites only the files that hold them', changed: paths };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function real() {
  const csv = path.join(project, 'src/data/scrobbles.csv');
  assert.ok(fs.existsSync(csv), 'src/data/scrobbles.csv is required for --real');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-churn-real-'));
  try {
    fs.cpSync(path.join(project, 'src/data'), path.join(dir, 'src/data'), { recursive: true });
    fs.cpSync(path.join(project, 'public/data'), path.join(dir, 'public/data'), { recursive: true, filter: source => !source.includes(`${path.sep}versions`) });
    const rows = fs.readFileSync(csv, 'utf8').trimEnd().split('\n');
    const latest = rows.slice(1).reduce((max, row) => Math.max(max, Number(row.split(',')[0]) || 0), 0);
    const earlier = [rows[0], ...rows.slice(1).filter(row => Number(row.split(',')[0]) < latest - 86400)];
    const build = lines => {
      fs.writeFileSync(path.join(dir, 'src/data/scrobbles.csv'), `${lines.join('\n')}\n`);
      for (const script of ['process-data.js', 'generate-recaps.js', 'generate-manifest.js']) run(dir, script);
      return manifestAt(dir);
    };
    const before = build(earlier), after = build(rows);
    const { changed, bytes, total } = changes(before, after);
    const share = bytes / total;
    const summary = { newScrobbles: rows.length - earlier.length, changedFiles: changed.length, changedKB: Math.round(bytes / 1024), totalKB: Math.round(total / 1024), share: `${(share * 100).toFixed(1)}%` };
    // 0.44 MB of 10.6 MB for a day's listening when this was written; whole
    // monoliths re-shipping put it at 2 MB.
    assert.ok(share < 0.1, `A day of scrobbles re-ships ${summary.share} of the data: ${changed.map(f => f.path).join(', ')}`);
    return { real: 'A day of scrobbles re-ships only a small share of the data', ...summary };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('Data churn checks passed:', process.argv.includes('--real') ? real() : synthetic());
