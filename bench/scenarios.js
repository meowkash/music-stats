// Each scenario drives the real built app against the real data set and reports
// frame pacing. They are written against user-visible affordances (a row, a tab
// button, a drag) rather than internals, so they keep measuring the right thing
// when the implementation underneath changes.

const VIEWPORT = { width: 393, height: 852 }; // iPhone 15 Pro

async function waitForBoot(page) {
  await page.waitForFunction(
    () => document.getElementById('pwa-splash-screen')?.classList.contains('hidden') === true,
    null,
    { timeout: 30000 },
  );
  // First real content, not just the splash going away.
  await page.waitForFunction(
    () => {
      const el = document.getElementById('stat-total-scrobbles');
      return Boolean(el && el.textContent && el.textContent.trim() !== '-');
    },
    null,
    { timeout: 30000 },
  );
}

const ROW_SELECTOR = '#leaderboardListSongs .scrobble-row.clickable-entity';

/**
 * Rankings defaults to a 7-day window, which is empty whenever the newest
 * scrobble is older than that. All Time is both always populated and the
 * heaviest board to build, so it is the honest thing to measure.
 */
async function openRankings(page) {
  await page.click('.tab-btn[data-tab="rankings"]');
  await page.waitForSelector('.range-btn[data-range="all"]', { timeout: 30000 });
  await page.click('.range-btn[data-range="all"]');
  await page.waitForFunction(
    (selector) => document.querySelector(selector) !== null,
    ROW_SELECTOR,
    { timeout: 30000 },
  );
}

/**
 * Resolves on the first frame the sheet's transform actually differs from where
 * it sat at tap time. Comparing against a snapshot rather than testing for
 * "non-identity" matters: a closed sheet already sits at translate3d(0,100%,0),
 * so an identity test reports movement before anything has moved.
 */
async function armFirstMoveProbe(page) {
  await page.evaluate(() => {
    const panel = document.getElementById('detailsOverlayPanel');
    const initial = getComputedStyle(panel).transform;
    window.__bench.mark('tap');

    window.__benchFirstMove = new Promise((resolve) => {
      const start = performance.now();
      const check = () => {
        if (getComputedStyle(panel).transform !== initial) {
          window.__bench.mark('firstMove');
          resolve(performance.now() - start);
          return;
        }
        if (performance.now() - start > 10000) {
          resolve(-1);
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  });
}

/** Drag the sheet down from `fromY` and release, as a finger would. */
async function dragSheetDown(page, { fromY, toY, steps = 20 }) {
  const x = VIEWPORT.width / 2;
  await page.mouse.move(x, fromY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, fromY + ((toY - fromY) * i) / steps);
  }
  await page.mouse.up();
}

export const scenarios = [
  {
    name: 'boot-cold',
    description: 'First ever load: empty IndexedDB, everything downloaded.',
    coldProfile: true,
    async run(page, { origin, record }) {
      await record(async () => {
        await page.goto(origin, { waitUntil: 'commit' });
        await page.evaluate(() => window.__bench.mark('navigated'));
        await waitForBoot(page);
        await page.evaluate(() => window.__bench.mark('contentPainted'));
      });
    },
  },

  {
    name: 'boot-warm',
    description: 'Return visit: generation already in IndexedDB.',
    async run(page, { origin, record }) {
      // Prime the store, then measure the second load.
      await page.goto(origin, { waitUntil: 'commit' });
      await waitForBoot(page);
      await page.waitForTimeout(2000); // let the backfill sweep land

      await record(async () => {
        await page.reload({ waitUntil: 'commit' });
        await page.evaluate(() => window.__bench.mark('navigated'));
        await waitForBoot(page);
        await page.evaluate(() => window.__bench.mark('contentPainted'));
      });
    },
  },

  {
    name: 'sheet-open-warm',
    description: 'Detail sheet opens with data already in memory.',
    async run(page, { origin, record }) {
      await page.goto(origin, { waitUntil: 'commit' });
      await waitForBoot(page);
      await openRankings(page);
      await page.waitForTimeout(1500);

      await record(async () => {
        await armFirstMoveProbe(page);

        await page.click(ROW_SELECTOR);
        await page.evaluate(() => window.__benchFirstMove);
        await page.waitForTimeout(700); // let the entrance finish
        await page.evaluate(() => window.__bench.mark('settled'));
      });
    },
  },

  {
    name: 'sheet-open-during-sync',
    description: 'Detail sheet opens while a background data sweep is in flight.',
    coldProfile: true,
    latencyMs: 80,
    async run(page, { origin, record }) {
      // No settle wait: the backfill worker is deliberately still downloading.
      await page.goto(origin, { waitUntil: 'commit' });
      await waitForBoot(page);
      await openRankings(page);

      await record(async () => {
        await page.click(ROW_SELECTOR);
        await page.waitForTimeout(900);
      });
    },
  },

  {
    // The scenario the original implementation failed. Warm caches hide the
    // problem entirely: it only appears when the hero artwork for the tapped
    // entity is not yet cached and the network is not instant, which is the
    // ordinary case on a phone.
    name: 'sheet-open-cold-artwork',
    description: 'Sheet opens on a deep, un-prefetched row over a slow network.',
    coldProfile: true,
    latencyMs: 80,
    // The whole point: hero artwork takes 600ms to arrive. An implementation
    // that awaits it before showing the sheet reports firstMove >= 600ms.
    artworkLatencyMs: 600,
    async run(page, { origin, record }) {
      await page.goto(origin, { waitUntil: 'commit' });
      await waitForBoot(page);
      await openRankings(page);

      // Far enough down that the play-count-weighted artwork prefetch has not
      // warmed this entity.
      await page.hover(ROW_SELECTOR);
      for (let i = 0; i < 25; i++) await page.mouse.wheel(0, 900);
      await page.waitForTimeout(600);

      const deepRow = `${ROW_SELECTOR}:nth-last-child(3)`;
      await page.waitForSelector(deepRow, { timeout: 30000 });

      await record(async () => {
        await armFirstMoveProbe(page);

        await page.click(deepRow);
        await page.evaluate(() => window.__benchFirstMove);
        await page.waitForTimeout(900);
      });
    },
  },

  {
    name: 'sheet-dismiss',
    description: 'Swipe the detail sheet down to dismiss.',
    async run(page, { origin, record }) {
      await page.goto(origin, { waitUntil: 'commit' });
      await waitForBoot(page);
      await openRankings(page);
      await page.click(ROW_SELECTOR);
      await page.waitForTimeout(1200);

      await record(async () => {
        await dragSheetDown(page, { fromY: 120, toY: 700 });
        await page.waitForTimeout(600);
      });
    },
  },

  {
    name: 'tab-swipe',
    description: 'Move across all four tabs and back.',
    async run(page, { origin, record }) {
      await page.goto(origin, { waitUntil: 'commit' });
      await waitForBoot(page);
      await page.waitForTimeout(1500);

      await record(async () => {
        for (const tab of ['rankings', 'recents', 'statistics', 'dashboard']) {
          await page.click(`.tab-btn[data-tab="${tab}"]`);
          await page.waitForTimeout(450);
        }
      });
    },
  },

  {
    name: 'leaderboard-scroll',
    description: 'Fling the rankings list, exercising infinite scroll.',
    async run(page, { origin, record }) {
      await page.goto(origin, { waitUntil: 'commit' });
      await waitForBoot(page);
      await openRankings(page);
      await page.waitForTimeout(1200);

      await record(async () => {
        await page.hover(ROW_SELECTOR);
        for (let i = 0; i < 12; i++) {
          await page.mouse.wheel(0, 600);
          await page.waitForTimeout(90);
        }
      });
    },
  },
];

export { VIEWPORT };
