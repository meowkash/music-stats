import assert from 'node:assert/strict';
import { devices } from 'playwright';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Covers that could not load at first must appear once they can, without a
 *  relaunch: both a failed image and a failed artwork index recover. */
export async function checkArtworkRecovery(browser, origin) {
  const evidence = [];
  const manifest = await fetch(`${origin}/data/manifest.json`).then(response => response.json());
  const artworkBodies = new Set((manifest.datasets?.['/data/artwork.json']?.files ?? ['/data/artwork.json'])
    .map(p => manifest.files.find(file => file.path === p)).filter(Boolean).flatMap(file => [file.path, file.url]));
  const thumbs = page => page.evaluate(() => {
    const all = [...document.querySelectorAll('#view-recents .scrobble-row-thumb')];
    return { total: all.length, loaded: all.filter(el => el.classList.contains('artwork-loaded')).length, failed: all.filter(el => el.classList.contains('artwork-error')).length, placeholders: all.filter(el => !el.querySelector('img')).length };
  });
  async function open(context) {
    await context.routeWebSocket('**', socket => socket.close());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.locator('.tab-btn[data-tab="recents"]').tap();
    await page.waitForFunction(() => document.body.dataset.activeTab === 'recents' && document.querySelector('#view-recents .scrobble-row-thumb'));
    return { page, errors };
  }

  // 1. The image CDN is unreachable at launch, then comes back. No 'online'
  //    event fires for a CDN blip, so this must recover on its own.
  {
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    let reachable = false;
    await context.route(url => url.hostname !== new URL(origin).hostname, route => reachable
      ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
      : route.abort('internetdisconnected'));
    try {
      const { page, errors } = await open(context);
      await page.waitForFunction(() => document.querySelectorAll('#view-recents .scrobble-row-thumb.artwork-error').length > 0, null, { timeout: 20000 });
      const down = await thumbs(page);
      reachable = true;
      await page.waitForFunction(() => {
        const visible = [...document.querySelectorAll('#view-recents .scrobble-row-thumb')].filter(el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
        return visible.length > 0 && visible.every(el => el.classList.contains('artwork-loaded'));
      }, null, { timeout: 20000 }).catch(async error => { throw new Error(`Covers stayed blank after the CDN came back: ${JSON.stringify(await thumbs(page))}`, { cause: error }); });
      const up = await thumbs(page);
      assert.equal(up.failed, 0, `Covers still on the placeholder: ${JSON.stringify(up)}`);
      assert.deepEqual(errors, []);
      evidence.push({ artwork: 'Covers that failed while the CDN was unreachable load once it is back, without a relaunch', down, up });
    } finally { await context.close(); }
  }

  // 2. The artwork index itself fails to download at launch, so rows render
  //    placeholders with no image at all; once it arrives they must repaint.
  {
    const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    let blocked = true;
    await context.route(url => url.hostname !== new URL(origin).hostname, route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await context.route(url => artworkBodies.has(url.pathname), route => blocked ? route.fulfill({ status: 503, body: 'outage' }) : route.continue());
    try {
      const { page } = await open(context);
      await page.waitForTimeout(1500);
      const before = await thumbs(page);
      assert.ok(before.placeholders > 0, `Expected placeholders while the index is unavailable: ${JSON.stringify(before)}`);
      blocked = false;
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('#view-recents .scrobble-row-thumb')].slice(0, 6);
        return rows.length > 0 && rows.every(el => el.querySelector('img'));
      }, null, { timeout: 20000 }).catch(async error => { throw new Error(`Rows never picked up the artwork index: ${JSON.stringify(await thumbs(page))}`, { cause: error }); });
      evidence.push({ artworkIndex: 'Rows painted before the artwork index loaded pick up covers when it arrives', before, after: await thumbs(page) });
    } finally { await context.close(); }
  }
  return evidence;
}
