import assert from 'node:assert/strict';
import { devices } from 'playwright';
import { checkMobileMotion } from './motion-checks.mjs';

/** Touch-driven checks shared by the build suite and the running dev server. */
export async function checkMobileSurfaces(browser, origin, { insecure = false } = {}) {
  const evidence = [];
  const manifest = await fetch(`${origin}/data/manifest.json`).then(response => response.json());
  const errors = [], failedRequests = [], networkDiagnostics = [];
  let flow = 0;
  async function fresh() {
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    // A dev-server HMR reload must not replace the page halfway through a
    // gesture assertion. Built-app checks have no websocket to intercept.
    await context.routeWebSocket('**', socket => socket.close());
    await context.route(url => url.hostname !== new URL(origin).hostname, route => route.fulfill({
      status: 200, contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    }));
    const page = await context.newPage();
    const current = ++flow;
    page.on('pageerror', error => {
      const detail = { flow: current, stack: error.stack || error.message };
      // WebKit also emits native access-control diagnostics for operations
      // caught by getWorker/networkManifest. Successful flow assertions verify
      // their fallbacks; genuine JS exceptions/rejections still fail below.
      if (/^(Cannot load|Fetch API cannot load) .*due to access control checks\.?$/.test(error.message)) networkDiagnostics.push(detail);
      else errors.push(detail);
    });
    page.on('requestfailed', request => { if (request.url().startsWith(origin)) failedRequests.push({ flow: current, url: request.url(), error: request.failure() }); });
    return { context, page };
  }
  async function visit(page) {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    if (insecure) assert.equal(await page.evaluate(() => !!globalThis.crypto?.subtle), false, 'This check must exercise HTTP without Web Crypto');
  }
  async function openDetail(page) {
    await page.locator('.tab-btn[data-tab="recents"]').tap();
    await page.waitForFunction(() => document.body.dataset.activeTab === 'recents');
    const row = page.locator('#monthlyListTracks .scrobble-row').first();
    const title = await row.locator('.scrobble-row-title').textContent();
    await row.tap();
    return title;
  }

  // No previous view or IDB cache has had a chance to warm either surface.
  {
    const { context, page } = await fresh();
    try {
      await visit(page);
      const title = await openDetail(page);
      await page.waitForFunction(title => document.getElementById('overlayTitle').textContent === title, title);
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#detailsOverlayPanel').evaluate(el => el.classList.contains('visible')), true);
      await page.locator('#overlaySubtitle [data-type="artist"]').tap();
      await page.waitForFunction(title => document.getElementById('overlayTitle').textContent !== title && document.querySelectorAll('#overlaySongsList .scrobble-row').length > 0, title);
      await page.locator('#overlayCloseBtn').tap();
      await page.waitForFunction(title => document.getElementById('overlayTitle').textContent === title, title);
      await page.locator('#overlayCloseBtn').tap();
      await page.waitForFunction(() => !document.getElementById('detailsOverlayPanel').classList.contains('visible'));
      evidence.push('Cold detail survives touch open, artist navigation, back, and close');
    } finally { page.removeAllListeners('pageerror'); await context.close(); }
  }
  {
    const { context, page } = await fresh();
    try {
      await visit(page);
      await page.locator('.recap-story').first().tap();
      await page.waitForFunction(() => !document.getElementById('storyViewer').hidden && document.querySelector('.story-slide.is-active'));
      const stage = await page.locator('#storyStage').boundingBox();
      await page.touchscreen.tap(stage.x + stage.width * 0.8, stage.y + stage.height * 0.5);
      await page.waitForFunction(() => document.querySelectorAll('.story-slide')[1]?.classList.contains('is-active'));
      await page.locator('#storyClose').tap();
      assert.equal(await page.locator('#storyViewer').evaluate(el => el.hidden), true);
      evidence.push('Cold recap opens, advances, and closes with touch input');
    } finally { page.removeAllListeners('pageerror'); await context.close(); }
  }
  {
    const { context, page } = await fresh();
    const media = new Set(manifest.files.filter(file => /^\/data\/(artwork|colors)\//.test(file.path)).map(file => file.url ?? file.path));
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let pending = 0;
    await context.route(url => media.has(url.pathname), async route => {
      pending++;
      await blocked;
      try { await route.continue(); } catch { /* The isolated context may already have closed. */ }
    });
    try {
      await visit(page);
      await page.locator('.recap-story').first().tap();
      await page.waitForFunction(() => !document.getElementById('storyViewer').hidden && document.querySelector('.story-slide.is-active'));
      assert.ok(pending > 0, 'Optional media requests should still be blocked');
      const stage = await page.locator('#storyStage').boundingBox();
      await page.touchscreen.tap(stage.x + stage.width * 0.8, stage.y + stage.height * 0.5);
      await page.waitForFunction(() => document.querySelectorAll('.story-slide')[1]?.classList.contains('is-active'));
      release();
      await page.waitForFunction(() => document.querySelector('#storySlides .story-hero-art img'));
      assert.equal(await page.locator('.story-slide').nth(1).evaluate(el => el.classList.contains('is-active')), true, 'Media readiness must not reset story position');
      await page.locator('#storyClose').tap();
      evidence.push('Recap text opens before blocked media; late artwork preserves playback position');
    } finally { release(); page.removeAllListeners('pageerror'); await context.close(); }
  }
  {
    const { context, page } = await fresh();
    const meta = manifest.files.find(file => file.path === '/data/meta.json');
    let tamper = true;
    await context.route(url => url.pathname === (meta.url ?? meta.path), route => tamper
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"tampered":true}' })
      : route.continue());
    try {
      await visit(page);
      const title = await openDetail(page);
      await page.locator('#overlayRetryBtn').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#detailsOverlayPanel').evaluate(el => el.classList.contains('visible')), true);
      tamper = false;
      await page.locator('#overlayRetryBtn').tap();
      await page.waitForFunction(title => document.getElementById('overlayTitle').textContent === title, title);
      assert.equal(await page.locator('#overlayRetryBtn').isVisible(), false);
      evidence.push('Corrupt data is rejected; the sheet stays open and a touch retry recovers');
    } finally { page.removeAllListeners('pageerror'); await context.close(); }
  }
  assert.deepEqual(errors, [], JSON.stringify({ errors, failedRequests }));
  if (networkDiagnostics.length) evidence.push({ handledWebKitNetworkDiagnostics: networkDiagnostics.length });
  evidence.push(...await checkMobileMotion(browser, origin));
  return evidence;
}
