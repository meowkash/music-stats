import { spawnSync } from 'child_process';

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

run('Process scrobbles → JSON', 'node', ['scripts/process-data.js']);

const hasLastfm = process.env.LASTFM_API_KEY && process.env.LASTFM_USERNAME;
if (hasLastfm && refresh) {
  run('Refresh all artwork', 'node', ['scripts/backfill-artwork.js', '--refresh']);
} else if (hasLastfm) {
  run('Backfill missing artwork', 'node', ['scripts/backfill-artwork.js']);
}

run('Generate PWA icons', 'node', ['scripts/generate-pwa-icons.js']);
run('Generate service worker', 'node', ['scripts/generate-sw.js']);
run(
  refresh ? 'Re-extract all colors' : 'Extract new colors',
  'npx',
  ['tsx', 'scripts/extract-colors.js', ...(refresh ? ['--refresh'] : [])],
);
run('Astro build', 'npx', ['astro', 'build']);

console.log('\n✓ Build complete');
