import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const source = path.resolve('scripts/fetch-lastfm.js');
const initial = 'uts,artist,album,track\n1700000000,A,Album,Older\n1702000000,A,Album,Recent\n';
for (const scenario of ['api-error', 'missing-page', 'incomplete', 'suspicious-shrink', 'valid', 'empty']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'music-sync-regression-'));
  fs.mkdirSync(path.join(directory, 'src/data'), { recursive: true });
  const csv = path.join(directory, 'src/data/scrobbles.csv');
  const original = scenario === 'suspicious-shrink' ? 'uts,artist,album,track\n' + Array.from({ length: 25 }, (_, i) => `${1702000000 + i},A,Album,Recent`).join('\n') + '\n' : initial;
  fs.writeFileSync(csv, original);
  fs.writeFileSync(path.join(directory, 'src/data/artwork.json'), JSON.stringify({ 'artist:A': 'https://example.com/a.jpg', 'album:Album|A': 'https://example.com/a.jpg' }));
  const mock = `globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.get('method') !== 'user.getrecenttracks') return new Response('{}');
    const page = Number(url.searchParams.get('page'));
    if (${JSON.stringify(scenario)} === 'api-error' || (${JSON.stringify(scenario)} === 'missing-page' && page === 2)) return new Response(JSON.stringify({error:11,message:'Service Offline'}));
    const track = {name:'Recent',artist:{'#text':'A'},album:{'#text':'Album'},date:{uts:'1702000000'}};
    const total = ${JSON.stringify(scenario)} === 'empty' ? 0 : ${JSON.stringify(scenario)} === 'incomplete' ? 2 : 1;
    return new Response(JSON.stringify({recenttracks:{'@attr':{page:String(page),totalPages:${JSON.stringify(scenario)} === 'missing-page' ? '2':'1',total:String(total)},track: total ? [track] : []}}));
  };`;
  fs.writeFileSync(path.join(directory, 'mock.mjs'), mock);
  const result = spawnSync(process.execPath, ['--import', path.join(directory, 'mock.mjs'), source], { cwd: directory, env: { PATH: process.env.PATH, LASTFM_API_KEY: 'fixture-key', LASTFM_USERNAME: 'fixture' }, encoding: 'utf8' });
  if (['api-error', 'missing-page', 'incomplete', 'suspicious-shrink'].includes(scenario)) {
    assert.notEqual(result.status, 0, scenario);
    assert.equal(fs.readFileSync(csv, 'utf8'), original, `${scenario}: canonical history changed`);
  } else {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(`${csv}.previous`, 'utf8'), initial);
    assert.equal(fs.readFileSync(csv, 'utf8').trim().split('\n').length, scenario === 'empty' ? 2 : 3);
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('Sync regressions passed: API errors, partial pagination, count mismatch, complete snapshots, backups, and legitimate empty ranges.');
