import assert from 'node:assert/strict';
import { devices } from 'playwright';

/** iOS keeps text autosizing on unless html carries the -webkit- prefixed
 *  property, and neither headless engine can show the bug: desktop WebKit
 *  drops the property from the CSSOM and Chromium aliases it away. So the
 *  built page's CSS is checked as written. Lightning CSS strips the prefix
 *  when the build targets desktop Safari alone (astro.config.mjs). */
export function checkTextSizeAdjust(html) {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  const rules = [...css.matchAll(/(?:^|[}\s,])html\s*\{([^}]*)\}/g)].map(match => match[1]);
  assert.ok(rules.some(body => /-webkit-text-size-adjust\s*:\s*100%/.test(body)),
    'Built CSS lost html { -webkit-text-size-adjust: 100% } — iOS will inflate fonts after a rotation');
  return 'Built CSS keeps -webkit-text-size-adjust on html (rotation font inflation)';
}

/** Regressions that have come back more than once: fonts after a rotation,
 *  iOS zooming into the search field, and the Rankings range pill sweeping
 *  over chips it was never sent to. */
export async function checkLayoutRegressions(browser, origin) {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await context.routeWebSocket('**', socket => socket.close());
  await context.route(url => url.hostname !== new URL(origin).hostname, route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }));
  const page = await context.newPage(), errors = [], evidence = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  const portrait = page.viewportSize();
  async function tab(name) {
    await page.locator(`.tab-btn[data-tab="${name}"]`).tap();
    await page.waitForFunction(name => document.body.dataset.activeTab === name && !document.querySelector('.nav-animating'), name);
  }
  // Computed font size of every visible text element in the active panel,
  // the nav and (when open) the detail sheet, keyed by what it is and says so
  // content that re-renders in between is compared like for like.
  const fontSizes = () => page.evaluate(() => {
    const roots = [document.querySelector('.panel-section.active') ?? document.body, document.querySelector('.bottom-nav-container'), document.getElementById('detailsOverlayPanel')];
    const sizes = {}, seen = {};
    for (const root of roots.filter(Boolean)) {
      for (const el of root.querySelectorAll('*')) {
        const text = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent.trim()).join(' ').trim();
        if (!text || !el.getClientRects().length) continue;
        const base = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')} "${text.slice(0, 24)}"`;
        seen[base] = (seen[base] ?? 0) + 1;
        sizes[`${base} ${seen[base]}`] = getComputedStyle(el).fontSize;
      }
    }
    return sizes;
  });
  async function rotate() {
    await page.setViewportSize({ width: portrait.height, height: portrait.width });
    await page.waitForTimeout(250);
    await page.setViewportSize(portrait);
    await page.waitForTimeout(250);
  }
  function sameSizes(before, after, where) {
    const changed = Object.keys(before).filter(key => key in after && after[key] !== before[key]).map(key => `${key}: ${before[key]} -> ${after[key]}`);
    assert.ok(Object.keys(before).length > 5, `${where}: no text found to compare`);
    assert.deepEqual(changed, [], `${where}: font sizes changed after landscape and back`);
  }
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

    // 1. Rotation round trip leaves every font where it was.
    for (const name of ['dashboard', 'recents', 'rankings', 'statistics']) {
      await tab(name);
      const before = await fontSizes();
      await rotate();
      sameSizes(before, await fontSizes(), name);
    }
    await tab('recents');
    await page.locator('#monthlyListTracks .scrobble-row').first().tap();
    await page.waitForFunction(() => document.getElementById('detailsOverlayPanel').classList.contains('visible') && document.querySelector('#overlayAlbumsList .overlay-album-card, #overlaySongsList .scrobble-row'));
    await page.waitForTimeout(400);
    const sheetBefore = await fontSizes();
    await rotate();
    sameSizes(sheetBefore, await fontSizes(), 'detail sheet');
    await page.locator('#overlayCloseBtn').tap();
    await page.waitForFunction(() => !document.querySelector('.sheet-closing') && !document.getElementById('detailsOverlayPanel').classList.contains('visible'));
    evidence.push('Fonts on every tab and in the detail sheet survive landscape and back');

    // 2. iOS zooms into a focused field under 16px and never zooms back.
    await tab('rankings');
    await page.locator('.quick-ranges > button[data-range="custom"]').tap();
    await page.waitForTimeout(300);
    const small = await page.evaluate(() => [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), select, textarea')]
      .map(el => ({ id: el.id || el.className, size: parseFloat(getComputedStyle(el).fontSize) }))
      .filter(field => field.size < 16));
    assert.deepEqual(small, [], 'Text fields under 16px make iOS zoom the page on focus');
    await page.locator('#leaderboardSearch').tap();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'leaderboardSearch');
    assert.equal(await page.evaluate(() => visualViewport.scale), 1);
    await page.locator('#leaderboardSearch').blur();
    evidence.push('Every text field is at least 16px, so focusing search cannot zoom the page');

    // 3. The range chips wrap onto two rows. Each hop must stay inside the
    // box spanning the chip it left and the chip it lands on — never sweep to
    // a row's end, or to the next row's start, on the way.
    const ranges = page.locator('.quick-ranges');
    const chipRects = await ranges.locator(':scope > button').evaluateAll(buttons => buttons.map(b => ({ range: b.dataset.range, left: b.offsetLeft, top: b.offsetTop, right: b.offsetLeft + b.offsetWidth, bottom: b.offsetTop + b.offsetHeight })));
    assert.ok(new Set(chipRects.map(rect => rect.top)).size > 1, 'Range chips no longer wrap; pick hops that cross a long distance instead');
    const settle = () => ranges.evaluate(el => new Promise((resolve, reject) => {
      const give = setTimeout(() => reject(new Error('range pill never settled')), 3000);
      const check = () => el.classList.contains('segmented-lens') || el.classList.contains('segmented-animating') ? requestAnimationFrame(check) : (clearTimeout(give), resolve());
      check();
    }));
    const rect = range => chipRects.find(chip => chip.range === range);
    const hops = [['7d', 'year'], ['year', '30d'], ['30d', 'custom'], ['custom', 'all'], ['all', '30d'], ['30d', 'all'], ['all', 'year']];
    await page.locator('.quick-ranges > button[data-range="7d"]').tap(); await settle();
    const path = [];
    for (const [from, to] of hops) {
      const frames = page.evaluate(() => new Promise(resolve => {
        const el = document.getElementById('rangeHighlight'), frames = [], start = performance.now();
        (function frame() {
          const m = new DOMMatrix(getComputedStyle(el).transform);
          // Unscaled box: a held lens may grow past its chip, a tap does not lift.
          const left = m.m41 + (el.offsetWidth * (m.a - 1)) / 2, top = m.m42 + (el.offsetHeight * (m.d - 1)) / 2;
          frames.push({ left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight });
          if (performance.now() - start < 800) requestAnimationFrame(frame); else resolve(frames);
        })();
      }));
      await page.locator(`.quick-ranges > button[data-range="${to}"]`).tap();
      const a = rect(from), b = rect(to), slack = 10;
      const box = { left: Math.min(a.left, b.left) - slack, top: Math.min(a.top, b.top) - slack, right: Math.max(a.right, b.right) + slack, bottom: Math.max(a.bottom, b.bottom) + slack };
      const stray = (await frames).filter(f => f.left < box.left || f.top < box.top || f.right > box.right || f.bottom > box.bottom);
      assert.deepEqual(stray.slice(0, 3), [], `Range pill ${from} -> ${to} strayed outside ${JSON.stringify(box)}`);
      await settle();
      assert.equal(await ranges.locator('button.active').getAttribute('data-range'), to);
      path.push(`${from}->${to}`);
    }
    evidence.push({ rangePill: 'Every hop, across and within rows, stays between the chip it left and the one it chose', hops: path });
    assert.deepEqual(errors, []);
    return evidence;
  } finally { page.removeAllListeners('pageerror'); await context.close(); }
}
