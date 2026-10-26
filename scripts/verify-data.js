import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2] || 'dist/data');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const manifest = read('manifest.json');
assert.ok(manifest.generation && manifest.files.length && manifest.schemaVersion === 2, 'Invalid manifest');
for (const file of manifest.files) {
  const name = file.path.replace(/^\/data\//, '');
  const bytes = fs.readFileSync(path.join(directory, name));
  assert.equal(bytes.length, file.bytes, `Size mismatch: ${name}`);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16), file.hash, `Hash mismatch: ${name}`);
  assert.ok(bytes.equals(fs.readFileSync(path.join(directory, file.url.replace(/^\/data\//, '')))), `Immutable body mismatch: ${name}`);
}
const meta = read('meta.json');
assert.ok(Array.isArray(meta.tracks) && meta.tracks.length > 0);
for (const [name, artist, album, duration] of meta.tracks) {
  assert.equal(typeof name, 'string');
  assert.equal(typeof meta.artists[artist], 'string');
  assert.equal(typeof meta.albums[album], 'string');
  assert.ok(duration === undefined || (Number.isFinite(duration) && duration > 0));
}
const totals = read('yearly-totals.json');
let plays = 0;
for (const year of Object.keys(totals)) {
  const days = read(`year-${year}.json`);
  for (const [date, entries] of Object.entries(days)) {
    let sum = 0;
    for (const [id, count] of entries) {
      assert.ok(Number.isInteger(id) && meta.tracks[id], `Unknown track on ${date}`);
      assert.ok(Number.isInteger(count) && count > 0, `Invalid count on ${date}`);
      sum += count;
    }
    const index = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.UTC(Number(year), 0, 1)) / 86400000);
    assert.equal(totals[year][index], sum, `Daily total mismatch: ${date}`);
    plays += sum;
  }
  assert.equal(Object.values(days).reduce((sum, entries) => sum + entries.reduce((n, [, count]) => n + count, 0), 0), totals[year].reduce((sum, n) => sum + n, 0), `Year total mismatch: ${year}`);
}
for (const recent of read('recent.json')) assert.equal(meta.tracks[recent.trackId]?.[0], recent.track);
console.log(`Verified generation ${manifest.generation}: ${manifest.files.length} hashes, immutable bodies, ${meta.tracks.length} tracks, ${plays} plays, and daily/year totals.`);
