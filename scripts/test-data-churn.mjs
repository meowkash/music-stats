import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArtistAttribution, normalizeName } from './artist-resolve.js';
import { parseCSVLine } from './scrobble-source.js';
import { CHUNKED_DATASETS, SHARD_COUNT, chunkArrays, mergeShards, readDataset, shardFileName, writeDataset } from './data-files.js';

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

// A soundtrack belongs to the artist who introduced it. It used to take the
// artist of its newest track (catalog) or newest scrobble (recaps), so the
// first play of another artist's song on it re-attributed the album, moved its
// catalog shard and lost its cover, which was stored under the old artist.
function albumOwnership() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-album-owner-'));
  try {
    fs.mkdirSync(path.join(dir, 'src/data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'public/data'), { recursive: true });
    const soundtrack = 'Big Night (Original Motion Picture Soundtrack)';
    const cover = 'https://lastfm.freetls.fastly.net/i/u/500x500/soundtrack.jpg';
    const start = Date.UTC(2025, 5, 1) / 1000;
    const plays = [
      ...Array.from({ length: 450 }, (_, i) => [start + i * 600, 'Filler', 'Filler Album', `Filler ${i % 20}`]),
      ...Array.from({ length: 6 }, (_, i) => [start + 300000 + i * 600, 'Nick Jonas', soundtrack, 'Opening']),
    ];
    const later = [[start + 400000, 'ZAYN', soundtrack, 'Closing'], [start + 400600, 'ZAYN', soundtrack, 'Closing']];
    const csv = rows => `uts,artist,album,track\n${rows.map(row => row.join(',')).join('\n')}\n`;
    const build = rows => {
      fs.writeFileSync(path.join(dir, 'src/data/scrobbles.csv'), csv(rows));
      for (const script of ['process-data.js', 'generate-recaps.js']) run(dir, script);
      const catalog = readDataset(path.join(dir, 'public/data'), 'catalog.json');
      const [id, album] = Object.entries(catalog.albums).find(([, value]) => value.name.startsWith('Big Night'));
      const shard = fs.readdirSync(path.join(dir, 'public/data/catalog')).find(file => JSON.parse(fs.readFileSync(path.join(dir, 'public/data/catalog', file), 'utf8')).albums[id]);
      const recap = JSON.parse(fs.readFileSync(path.join(dir, 'public/data/recap-2025.json'), 'utf8'));
      return { album, shard, recapArtist: recap.topAlbums.find(entry => entry.name.startsWith('Big Night'))?.artist };
    };
    const first = build(plays);
    // Covers resolved by earlier builds sit under whichever artist the album
    // had then; the soundtrack showed ZAYN's credit before this fix.
    fs.writeFileSync(path.join(dir, 'src/data/artwork.json'), JSON.stringify({ [`album:${first.album.name}|ZAYN`]: cover, [`${first.album.name}|ZAYN`]: cover }));
    const next = build([...plays, ...later]);
    assert.equal(first.album.artistName, 'Nick Jonas');
    assert.equal(next.album.artistName, 'Nick Jonas', 'Another artist\'s first play on a soundtrack re-attributed it');
    assert.equal(next.shard, first.shard, 'Re-attributing the soundtrack moved its catalog shard');
    assert.equal(next.recapArtist, 'Nick Jonas', 'The recap credits a soundtrack to whoever was scrobbled last');
    const published = readDataset(path.join(dir, 'public/data'), 'artwork.json');
    assert.equal(published[`album:${next.album.name}|Nick Jonas`], cover, 'The cover stored under the album\'s previous artist was not carried over');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'src/data/artwork.json'), 'utf8'))[`album:${next.album.name}|Nick Jonas`], cover, 'The carried-over cover must persist, or the backfill re-fetches it');
    return 'A soundtrack keeps the artist who introduced it, its shard and its cover';
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function synthetic() {
  const owner = albumOwnership();
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
    return { synthetic: 'A day of new tracks, plays and covers rewrites only the files that hold them', owner, changed: paths };
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
    const earlierSet = new Set(earlier);
    const data = path.join(dir, 'public/data');
    const json = rel => JSON.parse(fs.readFileSync(path.join(data, rel), 'utf8'));
    const build = lines => {
      fs.writeFileSync(path.join(dir, 'src/data/scrobbles.csv'), `${lines.join('\n')}\n`);
      for (const script of ['process-data.js', 'generate-recaps.js', 'generate-manifest.js']) run(dir, script);
      const shards = name => Array.from({ length: SHARD_COUNT }, (_, i) => { const file = `${name}/${shardFileName(i)}`; return fs.existsSync(path.join(data, file)) ? json(file) : null; });
      return { manifest: manifestAt(dir), meta: json('meta.json'), catalog: shards('catalog'), artworkUrls: shards('artwork-urls') };
    };
    const before = build(earlier), after = build(rows);
    const { changed, bytes, total } = changes(before.manifest, after.manifest);
    const paths = changed.map(file => file.path);
    const summary = { newScrobbles: rows.length - earlier.length, changedFiles: changed.length, changedKB: Math.round(bytes / 1024), totalKB: Math.round(total / 1024), share: `${(bytes / total * 100).toFixed(1)}%` };

    // No byte budget: the input is whatever the last 24h of real listening
    // was, and a day of first listens has to ship every new artist's shard.
    // Replaying past days, 4 of 17 went over the old 10% cap without anything
    // being wrong. These checks catch the regressions that budget was a proxy
    // for (monoliths shipping, ids renumbering, untouched entries rewritten)
    // whatever the day looked like.
    for (const monolith of ['meta.json', 'catalog.json', 'artwork.json', 'artwork-urls.json', 'colors.json']) {
      assert.ok(!paths.includes(`/data/${monolith}`), `${monolith} shipped whole instead of in pieces`);
    }

    // Ids only append: every existing index of every meta array keeps its
    // value. The one sanctioned edit is a canonical artist taking its most
    // played spelling ("Agents Of Time" -> "Agents of Time"), same id.
    const size = CHUNKED_DATASETS['meta.json'].size;
    const renamed = new Set();
    for (const [key, values] of Object.entries(before.meta)) {
      values.forEach((value, i) => {
        const next = after.meta[key]?.[i];
        if (JSON.stringify(value) === JSON.stringify(next)) return;
        assert.ok(key === 'canonicalArtists' && typeof next === 'string' && normalizeName(value) === normalizeName(next), `meta.${key}[${i}] changed (${JSON.stringify(value)} -> ${JSON.stringify(next)}): existing ids must keep their values`);
        renamed.add(Math.floor(i / size));
      });
    }
    for (const file of paths.filter(p => p.startsWith('/data/meta/'))) {
      const chunk = Number(path.basename(file, '.json'));
      const grew = Object.entries(after.meta).some(([key, values]) => values.length > (before.meta[key]?.length ?? 0) && (before.meta[key]?.length ?? 0) < (chunk + 1) * size && values.length > chunk * size);
      assert.ok(grew || renamed.has(chunk), `${file} changed but no array appended into it`);
    }

    // Only what was played may change. Ids that already existed are allowed to
    // change only when the day's scrobbles touch them.
    const day = rows.slice(1).filter(row => !earlierSet.has(row)).map(parseCSVLine);
    const rawIds = new Set(day.map(([, artist]) => after.meta.artists.indexOf(artist)).filter(id => id >= 0));
    const trackIds = new Set(after.meta.tracks.flatMap(([, artist], id) => rawIds.has(artist) ? [id] : []));
    const canonicalIds = new Set([...rawIds].flatMap(id => after.meta.rawToCanonical[id] ?? []));
    for (const id of trackIds) for (const c of after.meta.trackToCanonical[id] ?? []) canonicalIds.add(c);
    for (const [id, owners] of after.meta.rawToCanonical.entries()) if (owners.some(c => canonicalIds.has(c))) rawIds.add(id);
    const albumIds = new Set([...trackIds].map(id => after.meta.tracks[id][2]));
    // Artist entries embed each album's total plays, so a featured artist's
    // entry moves when the album it appears on is played.
    const sharesAlbum = value => value?.albums?.some(album => albumIds.has(album.id));
    const touched = {
      artists: (id, value) => rawIds.has(id) || sharesAlbum(value),
      canonicalArtists: (id, value) => canonicalIds.has(id) || sharesAlbum(value),
      tracks: id => trackIds.has(id),
      albums: (id, value) => albumIds.has(id) || rawIds.has(value?.artistId),
    };
    const entries = (shards, bucket) => new Map(shards.flatMap((shard, i) => Object.entries(shard?.[bucket] ?? {}).map(([id, value]) => [id, { shard: i, text: JSON.stringify(value), value }])));
    const dirtied = new Set();
    for (const bucket of Object.keys(touched)) {
      const old = entries(before.catalog, bucket), next = entries(after.catalog, bucket);
      const existing = before.meta[bucket]?.length ?? Infinity;
      for (const [id, entry] of next) {
        const prior = old.get(id);
        if (prior && prior.shard !== entry.shard) assert.fail(`catalog ${bucket}/${id} moved from shard ${prior.shard} to ${entry.shard}`);
        if (prior?.text === entry.text) continue;
        dirtied.add(entry.shard);
        if (Number(id) < existing) assert.ok(touched[bucket](Number(id), entry.value), `catalog ${bucket}/${id} changed without being played: ${prior?.text} -> ${entry.text}`);
      }
      for (const [id, entry] of old) if (!next.has(id)) dirtied.add(entry.shard);
    }
    // The catalog is placed by canonical artist so a day of plays dirties one
    // shard per artist involved, not one per track (hashing by id put 40 plays
    // of 40 tracks in 28 of 64 shards).
    const priorOwners = entries(before.catalog, 'canonicalArtists');
    const owners = [...entries(after.catalog, 'canonicalArtists')].filter(([id, entry]) => priorOwners.get(id)?.text !== entry.text).length;
    assert.ok(dirtied.size <= owners, `${dirtied.size} catalog shards changed for ${owners} artists: entries are no longer grouped by artist`);
    for (const file of paths.filter(p => p.startsWith('/data/catalog/'))) {
      assert.ok(dirtied.has(Number(path.basename(file, '.json'))), `${file} was rewritten but none of its entries changed`);
    }

    // A cover's weight moves only when its plays do, so a changed URL has to
    // belong to an artist played today.
    const names = new Set([...[...rawIds].map(id => after.meta.artists[id]), ...[...canonicalIds].map(id => after.meta.canonicalArtists[id])]);
    const keysByUrl = new Map();
    for (const [key, url] of Object.entries(readDataset(data, 'artwork.json') ?? {})) (keysByUrl.get(url) ?? keysByUrl.set(url, []).get(url)).push(key);
    const played = url => (keysByUrl.get(url) ?? []).some(key => [...names].some(name => key === `artist:${name}` || key.endsWith(`|${name}`) || key === name));
    // Weights are log2(plays): exact counts would move every played cover.
    for (const shard of after.artworkUrls) for (const [url, weight] of Object.entries(shard ?? {})) assert.ok(Number.isInteger(weight) && weight >= 0 && weight <= 24, `artwork-urls weight for ${url} is ${weight}, not log2 of its plays`);
    for (const [i, shard] of after.artworkUrls.entries()) {
      const prior = before.artworkUrls[i] ?? {};
      const moved = Object.keys({ ...prior, ...shard }).filter(url => prior[url] !== shard?.[url]);
      assert.equal(paths.includes(`/data/artwork-urls/${shardFileName(i)}`), moved.length > 0, `artwork-urls/${shardFileName(i)} hash and contents disagree`);
      for (const url of moved) assert.ok(!(url in prior) || played(url), `Cover weight for ${url} changed (${prior[url]} -> ${shard?.[url]}) though nothing it covers was played`);
    }

    // Everything else that may change is a per-day summary.
    const years = new Set(day.map(([uts]) => new Date(Number(uts) * 1000).getUTCFullYear()));
    const summaries = /^\/data\/(recent|highlights|recaps|yearly-totals|yearly-stats|recap-\d{4})\.json$/;
    for (const file of paths.filter(p => !/^\/data\/(meta|catalog|artwork-urls|artwork|colors)\//.test(p))) {
      const year = file.match(/^\/data\/year-(\d{4})\.json$/)?.[1];
      assert.ok(summaries.test(file) || (year && [...years].some(y => Math.abs(y - Number(year)) <= 1)), `${file} changed though a day of scrobbles has no reason to touch it`);
    }
    return { real: 'A day of scrobbles only appends ids and rewrites the entries it played', ...summary };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('Data churn checks passed:', process.argv.includes('--real') ? real() : synthetic());
