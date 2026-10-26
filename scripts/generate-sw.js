import fs from 'node:fs';
import path from 'node:path';
const version = (process.env.CACHE_VERSION || String(Math.floor(Date.now() / 1000))).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
const source = fs.readFileSync(path.resolve('src/service-worker.js'), 'utf8')
  .replaceAll('__SHELL_CACHE__', `music-stats-shell-${version}`)
  .replaceAll('__DATA_CACHE__', `music-stats-data-${version}`)
  .replaceAll('__CACHE_VERSION__', version);
fs.writeFileSync('public/sw.js', source);
fs.writeFileSync('public/cache-version.json', JSON.stringify({ version }));
console.log(`Generated service worker ${version}`);
