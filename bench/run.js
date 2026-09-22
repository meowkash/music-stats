import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { startServer } from './server.js';
import { scenarios, VIEWPORT } from './scenarios.js';
import { RECORDER_SOURCE, summarize } from './metrics.js';
import { runDataBenchmarks } from './data-bench.js';

const BENCH_DIR = path.resolve('bench');
const BASELINE_PATH = path.join(BENCH_DIR, 'baseline.json');
const RECORDS_DIR = path.join(BENCH_DIR, 'records');

// Regression gates. Frame pacing is noisy on a busy machine, so these are
// deliberately loose enough not to cry wolf and tight enough to catch the class
// of change that made the bottom sheet unusable.
const BUDGETS = {
  p95Frame: { tolerance: 1.4, floor: 4 },
  maxFrame: { tolerance: 1.6, floor: 16 },
  stalls: { tolerance: 1.5, floor: 2 },
  droppedFrames: { tolerance: 1.5, floor: 4 },
  longTaskMs: { tolerance: 1.5, floor: 60 },
  timeToFirstMove: { tolerance: 1.5, floor: 60 },
  timeToContent: { tolerance: 1.4, floor: 150 },
};

const args = process.argv.slice(2);
const flags = {
  update: args.includes('--update'),
  json: args.includes('--json'),
  repeat: Number(args.find((a) => a.startsWith('--repeat='))?.split('=')[1] ?? 3),
  only: args.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null,
  headed: args.includes('--headed'),
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Derived timings that are easier to reason about than raw marks. */
function deriveMarks(summary) {
  const { marks } = summary;
  const derived = {};
  if (marks.navigated !== undefined && marks.contentPainted !== undefined) {
    derived.timeToContent = Math.round(marks.contentPainted - marks.navigated);
  }
  if (marks.tap !== undefined && marks.firstMove !== undefined) {
    derived.timeToFirstMove = Math.round(marks.firstMove - marks.tap);
  }
  return derived;
}

// 1x1 PNG. Artwork only has to decode; its pixels never matter to frame pacing.
const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Album art lives on an external CDN, so without a stub the benchmark either
 * depends on the open internet or — worse — fails instantly and makes a
 * network-blocked code path look fast. Serving it locally with a fixed delay is
 * what makes "did the sheet wait for artwork?" a question with a stable answer.
 */
async function stubArtworkCdn(context, delayMs) {
  await context.route(
    (url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({ status: 200, contentType: 'image/png', body: STUB_PNG });
    },
  );
}

async function runScenario(browser, scenario, origin) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });

  // Always stubbed, so no scenario silently depends on outbound connectivity.
  await stubArtworkCdn(context, scenario.artworkLatencyMs ?? 20);

  // Every run starts from a known storage state unless the scenario is
  // explicitly about a warm one.
  await context.addInitScript(RECORDER_SOURCE);
  await context.addInitScript(() => window.__bench.start());

  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`  ! page error: ${err.message}`));

  let summary = null;
  const record = async (body) => {
    await page.evaluate(() => window.__bench.start());
    await body();
    const raw = await page.evaluate(() => window.__bench.stop());
    summary = summarize(raw);
  };

  try {
    await scenario.run(page, { origin, record });
  } finally {
    await context.close();
  }

  if (!summary) throw new Error(`${scenario.name} never called record()`);
  return { ...summary, ...deriveMarks(summary) };
}

function aggregate(runs) {
  const keys = [
    'frameCount',
    'p50Frame',
    'p95Frame',
    'maxFrame',
    'droppedFrames',
    'stalls',
    'longTaskCount',
    'longTaskMs',
    'timeToContent',
    'timeToFirstMove',
  ];

  const out = { runs: runs.length };
  for (const key of keys) {
    const values = runs.map((r) => r[key]).filter((v) => typeof v === 'number');
    if (values.length) out[key] = Math.round(median(values) * 10) / 10;
  }
  return out;
}

function compare(name, current, baseline) {
  if (!baseline) return { name, status: 'new', failures: [] };

  const failures = [];
  for (const [metric, { tolerance, floor }] of Object.entries(BUDGETS)) {
    const now = current[metric];
    const was = baseline[metric];
    if (typeof now !== 'number' || typeof was !== 'number') continue;

    // The floor stops a metric that is small in absolute terms from failing on
    // a large relative swing — 2ms to 4ms is noise, not a regression.
    const limit = Math.max(was * tolerance, floor);
    if (now > limit) {
      failures.push({ metric, was, now, limit: Math.round(limit * 10) / 10 });
    }
  }

  return { name, status: failures.length ? 'regressed' : 'ok', failures };
}

function formatRow(name, current, baseline, verdict) {
  const cell = (metric, unit = 'ms') => {
    const now = current[metric];
    if (typeof now !== 'number') return '—';
    const was = baseline?.[metric];
    if (typeof was !== 'number') return `${now}${unit}`;
    const delta = now - was;
    const sign = delta > 0 ? '+' : '';
    return `${now}${unit} (${sign}${Math.round(delta * 10) / 10})`;
  };

  const status = verdict.status === 'regressed' ? 'FAIL' : verdict.status === 'new' ? 'new ' : 'ok  ';
  return [
    `  ${status} ${name.padEnd(26)}`,
    `p95 ${cell('p95Frame').padEnd(16)}`,
    `max ${cell('maxFrame').padEnd(16)}`,
    `stalls ${String(current.stalls ?? '—').padEnd(5)}`,
    current.timeToFirstMove !== undefined ? `firstMove ${cell('timeToFirstMove')}` : '',
    current.timeToContent !== undefined ? `content ${cell('timeToContent')}` : '',
  ]
    .join(' ')
    .trimEnd();
}

async function main() {
  if (!fs.existsSync(path.resolve('dist', 'index.html'))) {
    console.error('dist/ not built. Run `npm run build` first.');
    process.exit(1);
  }

  const baseline = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'))
    : { scenarios: {}, data: null };

  console.log('\nData pipeline');
  const data = runDataBenchmarks();
  for (const [name, stats] of Object.entries(data.merge)) {
    console.log(
      `  ${name.padEnd(16)} ${String(stats.shards).padStart(3)} shards  ` +
        `${String(stats.totalKB).padStart(5)} KB  parse ${stats.parseMs}ms  merge ${stats.mergeMs}ms`,
    );
  }
  for (const [shape, d] of Object.entries(data.dailyDelta ?? {})) {
    console.log(
      `  delta/${shape.padEnd(11)} ${String(d.changedShards).padStart(2)}/${d.totalShards} shards  ` +
        `${String(d.deltaKB).padStart(4)} KB of ${d.wholeDatasetKB} KB ` +
        `(${(d.deltaRatio * 100).toFixed(1)}%, ${d.scrobbles} plays)`,
    );
  }

  const selected = flags.only
    ? scenarios.filter((s) => s.name.includes(flags.only))
    : scenarios;

  const browser = await chromium.launch({ headless: !flags.headed });
  const results = {};
  const verdicts = [];

  console.log(`\nScenarios (median of ${flags.repeat})`);

  try {
    for (const scenario of selected) {
      const server = await startServer({ latencyMs: scenario.latencyMs ?? 0 });
      const runs = [];
      try {
        for (let i = 0; i < flags.repeat; i++) {
          runs.push(await runScenario(browser, scenario, server.origin));
        }
      } catch (err) {
        console.log(`  ERR  ${scenario.name}: ${err.message}`);
        continue;
      } finally {
        await server.close();
      }

      const current = aggregate(runs);
      results[scenario.name] = current;

      const verdict = compare(scenario.name, current, baseline.scenarios?.[scenario.name]);
      verdicts.push(verdict);
      console.log(formatRow(scenario.name, current, baseline.scenarios?.[scenario.name], verdict));
      for (const f of verdict.failures) {
        console.log(`         ${f.metric}: ${f.was} -> ${f.now} (budget ${f.limit})`);
      }
    }
  } finally {
    await browser.close();
  }

  const record = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    scenarios: results,
    data,
  };

  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  const stamp = record.recordedAt.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(RECORDS_DIR, `${stamp}.json`), JSON.stringify(record, null, 2));

  if (flags.update) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(record, null, 2));
    console.log(`\nBaseline updated -> ${path.relative(process.cwd(), BASELINE_PATH)}`);
  }

  if (flags.json) console.log(JSON.stringify(record, null, 2));

  const regressed = verdicts.filter((v) => v.status === 'regressed');
  if (regressed.length && !flags.update) {
    console.log(`\n${regressed.length} scenario(s) regressed.`);
    process.exit(1);
  }

  console.log('\nNo regressions.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
