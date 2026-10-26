import assert from 'node:assert/strict';
import { devices } from 'playwright';

// Synthetic touch paths exercise WebKit's gesture handlers; taps and pointer
// capture use real browser input. No timing assertion depends on network speed.
export async function checkMobileMotion(browser, origin) {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await context.routeWebSocket('**', socket => socket.close());
  const page = await context.newPage(), errors = [], evidence = [], failedScripts = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('requestfailed', request => { if (request.resourceType() === 'script') failedScripts.push({ url: request.url(), error: request.failure() }); });
  await context.route(url => url.hostname !== new URL(origin).hostname, route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));
  async function tab(name) {
    await page.locator(`.tab-btn[data-tab="${name}"]`).tap();
    await page.waitForFunction(name => document.body.dataset.activeTab === name && !document.querySelector('.nav-animating'), name);
  }
  async function touch(type, selector, x, y) {
    await page.locator(selector).evaluate((target, { type, x, y }) => {
      const point = { clientX: x, clientY: y, screenX: x, screenY: y, identifier: 1, target };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [point] }, changedTouches: { value: [point] } });
      target.dispatchEvent(event);
    }, { type, x, y });
    await page.waitForTimeout(18);
  }
  async function motionFrames(duration = 150) {
    return page.evaluate(duration => new Promise(resolve => {
      const frames = [], start = performance.now();
      function frame() {
        const live = document.getElementById('overlayScrollContainer'), old = document.querySelector('.overlay-navigation-snapshot');
        if (old) {
          const a = getComputedStyle(live), b = getComputedStyle(old);
          frames.push({ x: new DOMMatrix(a.transform).m41, oldX: new DOMMatrix(b.transform).m41, opacity: +a.opacity, oldOpacity: +b.opacity });
        }
        if (performance.now() - start < duration) requestAnimationFrame(frame); else resolve(frames);
      }
      requestAnimationFrame(frame);
    }), duration);
  }
  async function sheetGeometry() {
    return page.evaluate(() => {
      const root = document.getElementById('overlayScrollContainer');
      const cards = [...document.querySelectorAll('#overlayAlbumsList .overlay-album-card')];
      const a = cards[0]?.getBoundingClientRect(), b = cards[1]?.getBoundingClientRect();
      return { overflow: root.scrollHeight - root.clientHeight, gap: a && b ? b.left - a.right : null, cssGap: parseFloat(getComputedStyle(document.getElementById('overlayAlbumsList')).columnGap), cards: cards.length,
        viewport: [innerWidth, innerHeight], root: root.clientHeight,
        header: root.querySelector('.overlay-header').getBoundingClientRect().height,
        content: root.querySelector('.overlay-content-wrapper').getBoundingClientRect().height,
        heroMin: getComputedStyle(root.querySelector('.overlay-header')).minHeight,
        rail: document.getElementById('overlayAlbumsList').getBoundingClientRect().height,
        cardWidth: a?.width,
      };
    });
  }
  async function openSong() {
    const row = page.locator('#monthlyListTracks .scrobble-row').first();
    const title = await row.locator('.scrobble-row-title').textContent();
    await row.tap();
    await page.waitForFunction(title => document.getElementById('overlayTitle').textContent === title && document.querySelector('#overlayAlbumsList .overlay-album-card'), title);
    await page.waitForTimeout(300);
    return title;
  }
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await tab('recents');
    const row = page.locator('#monthlyListTracks .scrobble-row').first();
    await row.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 9, isPrimary: true, clientX: 100, clientY: 250 });
    await page.waitForTimeout(100);
    const pressed = await row.evaluate(el => ({ opacity: +getComputedStyle(el).opacity, scale: new DOMMatrix(getComputedStyle(el).transform).a }));
    assert.ok(pressed.opacity > 0.95 && pressed.scale < 1 && pressed.scale > 0.96);
    await row.dispatchEvent('pointercancel', { pointerType: 'touch', pointerId: 9 });
    const title = await openSong();
    const first = await sheetGeometry();
    assert.ok(first.overflow <= 2, JSON.stringify(first));
    assert.equal(first.cssGap, 16);
    if (first.gap !== null) assert.ok(Math.abs(first.gap - 16) < 1);
    await page.screenshot({ path: '/tmp/music-sheet-phone.png' });
    await page.locator('#overlaySubtitle [data-type="artist"]').tap();
    await page.waitForSelector('.overlay-navigation-snapshot');
    const forward = await motionFrames();
    assert.ok(forward.some(frame => frame.x > 0 && frame.oldX < 0 && frame.opacity > 0 && frame.opacity < 1));
    await page.waitForFunction(() => !document.querySelector('.overlay-navigation-snapshot'));
    const panel = await page.locator('#detailsOverlayPanel').boundingBox();
    await touch('touchstart', '#detailsOverlayPanel', 3, panel.y + 100);
    for (let i = 1; i <= 5; i++) await touch('touchmove', '#detailsOverlayPanel', 3 + i * 12, panel.y + 100);
    await touch('touchend', '#detailsOverlayPanel', 63, panel.y + 100);
    const back = await motionFrames();
    assert.ok(back.some(frame => frame.x < 0 && frame.oldX > 0 && frame.opacity > 0 && frame.opacity < 1));
    await page.waitForFunction(() => !document.querySelector('.overlay-navigation-snapshot'));
    assert.equal(await page.locator('#overlayTitle').textContent(), title);
    const rebuilt = await sheetGeometry();
    assert.equal(rebuilt.cssGap, 16);
    if (rebuilt.gap !== null) assert.ok(Math.abs(rebuilt.gap - 16) < 1);
    evidence.push({ sheet: 'Native cover gap survives rebuilding; song content fits without vertical scrolling', geometry: first, pressed });
    evidence.push('Forward and edge-back navigation paint overlapping slide/fade frames in opposite directions');

    await touch('touchstart', '#detailsOverlayPanel', 180, panel.y + 80);
    for (let i = 1; i <= 10; i++) { await touch('touchmove', '#detailsOverlayPanel', 180, panel.y + 80 + i * 12); await page.waitForTimeout(20); }
    await touch('touchend', '#detailsOverlayPanel', 180, panel.y + 200);
    const closeFrames = await page.evaluate(() => new Promise(resolve => {
      const frames = [], start = performance.now();
      function frame() {
        const panel = document.getElementById('detailsOverlayPanel');
        frames.push({ top: panel.getBoundingClientRect().top, height: innerHeight, title: document.getElementById('overlayTitle').textContent });
        if (performance.now() - start < 400) requestAnimationFrame(frame); else resolve(frames);
      }
      requestAnimationFrame(frame);
    }));
    assert.ok(closeFrames.every(frame => frame.top >= frame.height - 1 || frame.title === title), 'Text must survive every visible exit frame');
    await page.waitForFunction(() => !document.querySelector('.sheet-closing'));
    assert.equal(await page.locator('#detailsOverlayPanel .overlay-navigation-snapshot').count(), 0);
    evidence.push('Swipe-close retains the title until the sheet is offscreen and removes temporary layers');

    await page.setViewportSize({ width: 375, height: 568 });
    await openSong();
    const short = await sheetGeometry();
    assert.ok(short.overflow <= 2, JSON.stringify(short));
    await page.screenshot({ path: '/tmp/music-sheet-short.png' });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(100);
    const landscape = await sheetGeometry();
    assert.ok(landscape.overflow <= 2, JSON.stringify(landscape));
    await page.locator('#overlayCloseBtn').tap();
    await page.waitForFunction(() => !document.querySelector('.sheet-closing'));
    await page.setViewportSize({ width: 390, height: 844 });
    evidence.push({ shortPhone: short });
    evidence.push({ landscapePhone: landscape });

    async function dragControl(selector, attr, expected) {
      const group = page.locator(selector), buttons = group.locator(':scope > button');
      const from = await buttons.first().boundingBox(), to = await buttons.last().boundingBox();
      const input = browser.browserType().name() === 'chromium' ? await context.newCDPSession(page) : null;
      const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
      if (input) await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
      await page.waitForTimeout(240);
      const scale = await group.locator('.sliding-highlight').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
      assert.ok(scale > 1.1, `${selector} must lift on hold`);
      if (input) {
        try {
          for (let i = 1; i <= 8; i++) {
            await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * i / 8, y: start.y + (end.y - start.y) * i / 8 }] });
            await page.waitForTimeout(16);
          }
          await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } finally { await input.detach(); }
      } else { await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up(); }
      await page.waitForFunction(({ selector, attr, expected }) => document.querySelector(`${selector} > button.active, ${selector} > button.is-active`)?.getAttribute(attr) === expected, { selector, attr, expected });
      await page.waitForTimeout(230);
      assert.equal(await group.evaluate(el => el.classList.contains('segmented-lens')), false);
    }
    await tab('dashboard'); await dragControl('.reports-range', 'data-range', 'year');
    await tab('recents'); await dragControl('.monthly-range', 'data-cat', 'artists');
    await tab('rankings'); await dragControl('.leaderboard-tab-group', 'data-tab', 'artists');
    evidence.push('Home, Recents, and Rankings selectors lift, drag, select once, and settle');
    const group = page.locator('.leaderboard-tab-group');
    await group.evaluate(el => el.addEventListener('pointerdown', event => { el.dataset.testPointer = String(event.pointerId); }, { once: true }));
    const selected = await group.locator('button.active').boundingBox(), other = await group.locator('button').first().boundingBox();
    await page.mouse.move(selected.x + selected.width / 2, selected.y + selected.height / 2); await page.mouse.down();
    await page.waitForTimeout(180); await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2, { steps: 6 });
    await group.dispatchEvent('pointercancel', { pointerId: Number(await group.getAttribute('data-test-pointer')), pointerType: 'mouse', isPrimary: true });
    await page.mouse.up(); await page.waitForTimeout(230);
    assert.equal(await group.locator('button.active').getAttribute('data-tab'), 'artists');
    assert.equal(await group.evaluate(el => el.classList.contains('segmented-lens')), false);
    evidence.push('Cancelling a selector drag restores its selection and removes the lifted state');

    const positions = {};
    for (const name of ['dashboard', 'recents', 'statistics']) {
      const rect = await page.locator(`.tab-btn[data-tab="${name}"]`).boundingBox();
      positions[name] = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    for (const name of ['statistics', 'dashboard', 'recents']) { await page.touchscreen.tap(positions[name].x, positions[name].y); await page.waitForTimeout(40); }
    const lastTap = Date.now();
    await page.waitForFunction(() => document.body.dataset.activeTab === 'recents' && !document.querySelector('.nav-animating'));
    const settleMs = Date.now() - lastTap;
    assert.ok(settleMs < 600, `Retargeted navbar took ${settleMs}ms`);
    const from = positions.recents, to = positions.statistics;
    const pagePose = () => page.evaluate(() => ({
      color: document.documentElement.style.getPropertyValue('--status-bar-color'),
      meta: document.querySelector('meta[name="theme-color"]').content,
      active: document.body.dataset.activeTab,
      paging: !!document.querySelector('.nav-paging'),
      panels: [...document.querySelectorAll('.panel-section')].map(el => `${el.id}:${el.style.transform}:${el.style.visibility}`).join(' '),
      wash: [...document.querySelectorAll('#app-bg-gradient .bg-layer')].map(el => el.style.opacity).join(','),
    }));
    const before = await pagePose();
    await touch('touchstart', '.bottom-nav-container', from.x, from.y);
    for (let i = 1; i <= 6; i++) await touch('touchmove', '.bottom-nav-container', from.x + (to.x - from.x) * i / 8, from.y);
    await page.waitForTimeout(260);
    // Scrubbing the lens is the control alone: no panel, wash or chrome work
    // until the finger lifts on a choice.
    const during = await pagePose();
    assert.deepEqual(during, before, 'The page must not move while the lens is held');
    const lensState = await page.evaluate(() => ({ optics: !!document.querySelector('#navSliderHighlight .lens-optics'), holes: [...document.querySelectorAll('.tab-btn')].filter(el => el.style.clipPath).length }));
    assert.ok(lensState.optics && lensState.holes > 0, JSON.stringify(lensState));
    for (let i = 7; i <= 8; i++) await touch('touchmove', '.bottom-nav-container', from.x + (to.x - from.x) * i / 8, from.y);
    await touch('touchend', '.bottom-nav-container', to.x, to.y);
    await page.waitForFunction(() => document.body.dataset.activeTab === 'statistics' && !document.querySelector('.nav-animating'));
    const landed = await page.evaluate(() => ({ color: document.documentElement.style.getPropertyValue('--status-bar-color'), meta: document.querySelector('meta[name="theme-color"]').content, optics: document.querySelectorAll('.lens-optics').length, holes: [...document.querySelectorAll('.tab-btn')].filter(el => el.style.clipPath).length }));
    assert.notEqual(landed.color, before.color); assert.equal(landed.meta, landed.color);
    assert.equal(landed.optics, 0); assert.equal(landed.holes, 0);
    const settledColor = await page.evaluate(() => getComputedStyle(document.querySelector('.status-bar-shield')).backgroundColor);
    await touch('touchstart', '.bottom-nav-container', to.x, to.y);
    await touch('touchmove', '.bottom-nav-container', to.x - 40, to.y);
    await touch('touchcancel', '.bottom-nav-container', to.x - 40, to.y);
    await page.waitForFunction(() => !document.querySelector('.nav-animating'));
    assert.equal(await page.evaluate(() => document.body.dataset.activeTab), 'statistics');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.status-bar-shield')).backgroundColor), settledColor);
    evidence.push({ navbar: 'Rapid retargeting settles; a held lens leaves panels, wash and chrome untouched until release', settleMs });

    // A long jump glides straight from the current tab to the destination.
    await tab('dashboard');
    const seen = page.evaluate(() => new Promise(resolve => {
      const ids = new Set(), start = performance.now();
      function frame() {
        for (const el of document.querySelectorAll('.panel-section')) {
          const r = el.getBoundingClientRect();
          if (getComputedStyle(el).visibility === 'visible' && r.right > 1 && r.left < innerWidth - 1) ids.add(el.id);
        }
        if (performance.now() - start < 500) requestAnimationFrame(frame); else resolve([...ids].sort());
      }
      requestAnimationFrame(frame);
    }));
    await page.locator('.tab-btn[data-tab="statistics"]').tap();
    assert.deepEqual(await seen, ['view-dashboard', 'view-statistics']);
    await page.waitForFunction(() => document.body.dataset.activeTab === 'statistics' && !document.querySelector('.nav-animating'));
    evidence.push('Home to Stats never reveals Rankings or Recents');
    // The navigation settle deliberately does not await this lazy import, but
    // finish observing its outcome before destroying the isolated browser.
    await page.waitForFunction(() => document.getElementById('yearlyCompareChart').style.display === 'block' || !document.getElementById('chartLoadStatus').hidden);
    assert.deepEqual(errors, [], JSON.stringify({ errors, failedScripts }));
    return evidence;
  } finally { page.removeAllListeners('pageerror'); await context.close(); }
}
