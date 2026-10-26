import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { checkMobileSurfaces } from './mobile-checks.mjs';
const project = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'music-browser-regression-'));
const dist = path.join(directory, 'dist');
const result = spawnSync(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build', '--outDir', dist], { stdio: 'inherit' });
assert.equal(result.status, 0, 'Astro build failed');
await build({ stdin: { contents: `export * from './src/utils/dataStore.ts'; export * from './src/utils/infiniteScroll.ts'; export { saveActiveManifest, loadActiveManifest } from './src/utils/persist/generations.ts';`, resolveDir: project }, bundle: true, format: 'esm', outfile: path.join(dist, 'fixture.js'), logLevel: 'silent' });
let manifestDelay = 0;
const overrides = new Map();
const failPaths = new Set();
const requests = [];
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  requests.push(pathname);
  if (failPaths.has(pathname)) { response.writeHead(503); response.end('Simulated outage'); return; }
  if (pathname === '/fixture') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html><body></body></html>'); return; }
  const filename = path.join(dist, pathname === '/' ? 'index.html' : pathname);
  const send = () => {
    try {
      const body = overrides.get(pathname) ?? fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': pathname === '/' ? 'text/html' : pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.json') ? 'application/json' : 'image/png', 'Cache-Control': 'no-store' }); response.end(body);
    } catch { response.writeHead(404); response.end('Not found'); }
  };
  setTimeout(send, pathname === '/data/manifest.json' ? manifestDelay : 0);
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.BENCH_BROWSER_CHANNEL ? { channel: process.env.BENCH_BROWSER_CHANNEL } : {}) });
const evidence = [];
async function context(options = {}) {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, serviceWorkers: 'block', ...options });
  await context.route(url => url.hostname !== '127.0.0.1', route => route.abort());
  return context;
}
async function fixture(test) {
  const c = await context(), p = await c.newPage(); await p.goto(origin + '/fixture');
  const result = await p.evaluate(test); await c.close(); return result;
}
try {
  const noJS = await context({ javaScriptEnabled: false }), raw = await noJS.newPage();
  await raw.goto(origin);
  assert.notEqual(await raw.locator('#stat-total-scrobbles').textContent(), '-');
  assert.ok(await raw.locator('.recap-story').count()); assert.ok(await raw.locator('#monthlyListTracks .scrobble-row').count());
  assert.notEqual(await raw.locator('#monthlyPageTracks').evaluate(el => getComputedStyle(el).display), 'none');
  await noJS.close(); evidence.push('Useful content exists without JavaScript');

  manifestDelay = 6000;
  const cold = await context();
  await cold.addInitScript(() => localStorage.setItem('last-music-stats-tab', 'recents'));
  const slow = await cold.newPage();
  await slow.goto(origin, { waitUntil: 'domcontentloaded' });
  assert.ok((await slow.locator('#stat-total-scrobbles').textContent()).trim().match(/\d/));
  assert.equal(await slow.locator('#monthlyPageTracks').isVisible(), true);
  await slow.waitForTimeout(6200);
  assert.equal(requests.filter(p => ['/data/artwork.json', '/data/colors.json', '/data/catalog.json'].includes(p)).length, 0);
  await cold.close(); manifestDelay = 0; evidence.push('Six-second manifest latency preserves content and never requests missing monoliths');

  const lanAddress = Object.values(os.networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address;
  assert.ok(lanAddress, 'A LAN address is required to test HTTP without Web Crypto');
  evidence.push(...await checkMobileSurfaces(browser, `http://${lanAddress}:${server.address().port}`, { insecure: true }));

  for (const storage of [true, false]) {
    const c = await context(), p = await c.newPage(); await p.goto(origin + '/fixture');
    const value = await p.evaluate(async storage => {
      Object.defineProperty(window, 'Worker', { value: undefined });
      if (!storage) Object.defineProperty(window, 'indexedDB', { value: undefined });
      const store = await import('/fixture.js'); let generation = 1, fail = false;
      const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
      window.fetch = async input => {
        if (fail) throw new Error('Simulated network failure');
        const body = JSON.stringify({ value: generation });
        return new Response(String(input).includes('manifest.json') ? JSON.stringify({ generation: String(generation), builtAt: '2026-10-22', files: [{ path: '/data/recent.json', hash: await hash(body), bytes: body.length }], artwork: [] }) : body);
      };
      await store.hydrateFromStore(); const first = await store.fetchAppJson('/data/recent.json');
      fail = true; const failed = await store.refreshAppData(); fail = false; generation = 2;
      const a = store.refreshAppData(), b = store.refreshAppData(); const same = a === b; const updated = await a;
      return { first, failed: failed.status, same, updated: updated.status, final: await store.fetchAppJson('/data/recent.json'), hint: JSON.parse(localStorage.getItem('music-stats-boot')) };
    }, storage);
    assert.equal(value.failed, 'failed'); assert.equal(value.same, true); assert.equal(value.updated, 'updated'); assert.equal(value.final.value, 2); assert.equal(value.hint.complete, storage);
    await c.close(); evidence.push({ storage, ...value });
  }
  const race = await fixture(async () => {
    Object.defineProperty(window, 'Worker', { value: undefined });
    const store = await import('/fixture.js'); let generation = 1, release, started;
    const gate = new Promise(resolve => release = resolve), start = new Promise(resolve => started = resolve);
    const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    window.fetch = async input => {
      const value = generation, url = String(input), body = JSON.stringify({ value });
      if (url.includes('manifest.json')) return new Response(JSON.stringify({ generation: String(value), files: [{ path: '/data/slow.json', hash: await hash(body), bytes: body.length }], artwork: [] }));
      if (value === 1) { started(); await gate; }
      return new Response(body);
    };
    await store.hydrateFromStore(); const pending = store.fetchAppJson('/data/slow.json'); await start;
    generation = 2; await store.stageUpdate(); release();
    return { pending: await pending, next: await store.fetchAppJson('/data/slow.json') };
  });
  assert.equal(race.pending.value, 2); assert.equal(race.next.value, 2); evidence.push({ race });

  const durable = await fixture(async () => {
    const { saveActiveManifest, loadActiveManifest } = await import('/fixture.js');
    const older = { generation: 'older', builtAt: '2026-10-21', files: [], artwork: [] };
    const newer = { ...older, generation: 'newer', builtAt: '2026-10-22' };
    await Promise.all([saveActiveManifest(newer), saveActiveManifest(older)]);
    await saveActiveManifest(older);
    return (await loadActiveManifest()).generation;
  });
  assert.equal(durable, 'newer'); evidence.push('Concurrent or late persistence cannot downgrade the durable generation');

  const virtual = await fixture(async () => {
    const { createInfiniteScroll } = await import('/fixture.js');
    document.body.innerHTML = '<div id="root" style="position:relative;height:400px;overflow:auto"><div id="list"></div></div>';
    const root = document.getElementById('root'), container = document.getElementById('list');
    let disconnected = 0; const Original = window.ResizeObserver;
    window.ResizeObserver = class extends Original { disconnect() { disconnected++; super.disconnect(); } };
    const controller = createInfiniteScroll({ root, container, chunkSize: 50, items: Array.from({ length: 10000 }, (_, i) => i), renderItem: i => `<div class="row" style="height:40px" data-id="${i}">${i}</div>` });
    await new Promise(resolve => setTimeout(resolve, 100)); root.scrollTop = 320000;
    root.dispatchEvent(new Event('scroll')); await new Promise(resolve => setTimeout(resolve, 100));
    const count = container.querySelectorAll('.row').length, first = Number(container.querySelector('.row').dataset.id);
    root.scrollTop = 0; root.dispatchEvent(new Event('scroll')); await new Promise(resolve => setTimeout(resolve, 100));
    const restored = Number(container.querySelector('.row').dataset.id); controller.destroy();
    return { count, first, restored, disconnected };
  });
  assert.ok(virtual.count <= 150); assert.ok(virtual.first > 7900); assert.equal(virtual.restored, 0); assert.equal(virtual.disconnected, 1); evidence.push({ virtual });

  const c = await context(), p = await c.newPage(); const errors = []; p.on('pageerror', error => errors.push(error.message));
  await p.goto(origin, { waitUntil: 'domcontentloaded' });
  await p.click('.tab-btn[data-tab="rankings"]');
  await p.waitForFunction(() => document.body.dataset.activeTab === 'rankings');
  await p.click('.quick-ranges [data-range="all"]');
  await p.waitForSelector('#leaderboardListSongs .scrobble-row');
  await p.click('.tab-btn[data-tab="statistics"]');
  await p.waitForFunction(() => document.body.dataset.activeTab === 'statistics');
  const chartFile = fs.readdirSync(path.join(dist, '_astro')).find(f => f.startsWith('chart.'));
  // waitForFunction does not await an async predicate (a pending Promise is
  // truthy), so load Chart.js into the page once and poll synchronously.
  await p.evaluate(async url => { window.__Chart = (await import(url)).Chart; }, `/_astro/${chartFile}`);
  await p.waitForFunction(() => window.__Chart.getChart('yearlyCompareChart')?.data.datasets.length > 0);
  await p.click('#yearsFilterBtn');
  await p.locator('#yearsFilterPopover label[data-year="2023"]').click();
  await p.click('#yearsFilterBtn');
  const before = await p.evaluate(async url => { const { Chart } = await import(url); return Chart.getChart('yearlyCompareChart').data.datasets.find(d => d.label === '2026').data.at(-1); }, `/_astro/${chartFile}`);
  const next = JSON.parse(fs.readFileSync(path.join(dist, 'data/manifest.json'), 'utf8'));
  const { createHash } = await import('node:crypto');
  for (const pathname of ['/data/yearly-totals.json', '/data/meta.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(dist, pathname), 'utf8'));
    if (pathname.includes('totals')) data['2026'][data['2026'].length - 1] += 123;
    else data.tracks = data.tracks.map(t => ['UPDATED ' + t[0], ...t.slice(1)]);
    const body = JSON.stringify(data), hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    const file = next.files.find(f => f.path === pathname); Object.assign(file, { hash, bytes: Buffer.byteLength(body), url: `/data/versions/${hash}.json` }); overrides.set(file.url, body);
  }
  next.generation = 'fixture-next-generation'; overrides.set('/data/manifest.json', JSON.stringify(next));
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForFunction(expected => window.__Chart.getChart('yearlyCompareChart')?.data.datasets.find(d => d.label === '2026')?.data.at(-1) === expected, before + 123, { timeout: 30000 });
  assert.equal(await p.locator('#yearsFilterPopover input[value="2023"]').isChecked(), false);
  await p.click('.tab-btn[data-tab="rankings"]'); await p.waitForFunction(() => document.body.dataset.activeTab === 'rankings');
  await p.waitForFunction(() => document.querySelector('#leaderboardListSongs .scrobble-row-title')?.textContent.startsWith('UPDATED '));
  await p.click('#leaderboardListSongs .scrobble-row-title >> nth=0');
  await p.waitForFunction(() => document.querySelector('#detailsOverlayPanel')?.classList.contains('visible'));
  await p.waitForFunction(() => document.querySelector('#overlayTitle')?.textContent.length > 0);
  await p.locator('#overlaySubtitle [data-type="artist"]').click();
  await p.waitForTimeout(500);
  const detailRows = await p.locator('#overlaySongsList .scrobble-row').count();
  assert.ok(detailRows > 0 && detailRows <= 72);
  assert.ok(await p.locator('#overlayAlbumsList .overlay-album-card').count() <= 60);
  // The sheet releases its lists once its exit has played out; wait for that
  // rather than a fixed time, so retiming the exit cannot break the check.
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => document.querySelectorAll('#overlaySongsList .scrobble-row').length === 0, null, { timeout: 2000 });
  assert.deepEqual(errors, []); evidence.push('A real generation swap refreshes chart/rankings, preserves filters, and details release bounded lists on close'); await c.close();

  // Exercise the real service worker: all lazy bundles must survive offline,
  // and a failed critical download must never replace a working controller.
  overrides.clear();
  const swContext = await browser.newContext({ viewport: { width: 393, height: 852 }, serviceWorkers: 'allow' });
  const swPage = await swContext.newPage(); await swPage.goto(origin + '/fixture');
  await swPage.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  const cacheNames = await swPage.evaluate(() => caches.keys());
  assert.ok(cacheNames.some(name => name.startsWith('music-stats-shell-')));
  await swPage.goto(origin);
  await swPage.waitForFunction(() => JSON.parse(localStorage.getItem('music-stats-boot') || '{}').complete, null, { timeout: 30000 });
  await swContext.setOffline(true); await swPage.reload({ waitUntil: 'domcontentloaded' });
  assert.ok((await swPage.locator('#stat-total-scrobbles').textContent()).match(/\d/));
  await swPage.click('.tab-btn[data-tab="rankings"]'); await swPage.waitForFunction(() => document.body.dataset.activeTab === 'rankings');
  await swPage.click('.quick-ranges [data-range="all"]'); await swPage.waitForSelector('#leaderboardListSongs .scrobble-row');
  await swContext.setOffline(false);
  const swSource = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
  const version = swSource.match(/const CACHE_VERSION = '([^']+)'/)[1];
  overrides.set('/sw.js', swSource.replaceAll(version, 'test-next-version'));
  failPaths.add('/_astro/' + fs.readdirSync(path.join(dist, '_astro')).find(file => file.startsWith('dataStore.')));
  const update = await swPage.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const outcome = new Promise(resolve => registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve('rejected'); });
    }, { once: true }));
    await registration.update(); return await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('timeout'), 20000))]);
  });
  assert.equal(update, 'rejected');
  assert.ok((await swPage.evaluate(() => caches.keys())).some(name => cacheNames.includes(name)));
  evidence.push('Offline launch and lazy ranking queries work; incomplete service-worker updates are rejected');
  await swContext.close();

  fs.mkdirSync('Verification/Runtime', { recursive: true }); fs.writeFileSync('Verification/Runtime/regressions.json', JSON.stringify(evidence, null, 2));
  console.log('Browser regressions passed:', evidence);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
}
