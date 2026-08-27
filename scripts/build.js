import { spawnSync } from 'child_process';
import { loadEnv } from './lastfm-client.js';

// Without this the Last.fm steps were silently skipped on local builds: the
// credentials live in .env, but the gate below reads process.env, which only CI
// populates.
loadEnv();

const refresh = process.argv.includes('--refresh');

function run(label, command, args = []) {
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

console.log(refresh ? 'Building with media refresh (artwork + colors)' : 'Building');

run('Bootstrap artist overrides', 'node', ['scripts/bootstrap-artist-overrides.js']);
run('Process scrobbles → JSON', 'node', ['scripts/process-data.js']);

const hasLastfm = process.env.LASTFM_API_KEY && process.env.LASTFM_USERNAME;
if (hasLastfm) {
  run('Enrich recap meta (durations + genres)', 'node', ['scripts/enrich-recap-meta.js']);
}
if (hasLastfm && refresh) {
  run('Refresh all artwork', 'node', ['scripts/backfill-artwork.js', '--refresh']);
} else if (hasLastfm) {
  run('Backfill missing artwork', 'node', ['scripts/backfill-artwork.js']);
}

// Runs unconditionally: without enrichment it still produces every recap story
// except the genre ones, rather than leaving the tab empty.
run('Generate yearly recaps', 'node', ['scripts/generate-recaps.js']);

run('Generate PWA icons', 'node', ['scripts/generate-pwa-icons.js']);
run('Generate service worker', 'node', ['scripts/generate-sw.js']);
run(
  refresh ? 'Re-extract all colors' : 'Extract new colors',
  'npx',
  ['tsx', 'scripts/extract-colors.js', ...(refresh ? ['--refresh'] : [])],
);
// Last writer into public/data wins, so the manifest has to hash the files
// after every step that can still modify them.
run('Generate data manifest', 'node', ['scripts/generate-manifest.js']);
run('Astro build', 'npx', ['astro', 'build']);

console.log('\n✓ Build complete');
