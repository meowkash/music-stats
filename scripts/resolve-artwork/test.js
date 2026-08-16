import { buildLadder, resolveArtwork } from './index.js';
import { parseEpisodic, stripDecorations } from './normalize.js';

const CASES = [
  { type: 'album', name: 'A State of Trance 1234', artistName: 'Armin van Buuren' },
  { type: 'album', name: 'A State of Trance Episode 1200', artistName: 'Armin van Buuren' },
  { type: 'album', name: 'Group Therapy 500', artistName: 'Above & Beyond' },
  { type: 'track', name: 'Black Room Boy - Original Mix', artistName: 'Above & Beyond' },
  { type: 'track', name: 'Finesse - Remix; feat. Cardi B', artistName: 'Bruno Mars' },
  { type: 'album', name: 'Hyperdrama', artistName: 'Justice' },
  { type: 'album', name: "Short n' Sweet (Deluxe)", artistName: 'Sabrina Carpenter' },
  { type: 'album', name: 'Take Care (Deluxe)', artistName: 'Drake' },
  { type: 'album', name: '+-=÷× (TOUR COLLECTION)', artistName: 'Ed Sheeran' },
  // Must NOT match: nonsense that the old resolver would have cached anyway.
  { type: 'album', name: 'Zzzqqq Nonexistent Album 9999', artistName: 'Nobody At All' },
];

console.log('=== normalization ===');
for (const c of CASES) {
  const ep = parseEpisodic(c.name);
  console.log(
    `${c.name.padEnd(42)} strip="${stripDecorations(c.name)}"` +
      (ep ? `  series="${ep.series}" #${ep.number}` : ''),
  );
}

console.log('\n=== ladder (A State of Trance 1234) ===');
for (const rung of buildLadder(CASES[0])) {
  console.log(`  ${rung.label.padEnd(16)} term="${rung.term}"`);
}

console.log('\n=== live resolution ===');
const seriesCache = new Map();
const lastfmKey = process.env.LASTFM_API_KEY;

for (const c of CASES) {
  const attempts = [];
  const result = await resolveArtwork(c, {
    lastfmKey,
    seriesCache,
    onAttempt: (a) => attempts.push(a),
  });

  const trail = attempts
    .map((a) => `${a.label}${a.accepted ? '✓' : `×${a.candidates ?? 0}`}`)
    .join(' → ');

  if (result) {
    console.log(
      `✓ ${c.name}\n    via=${result.via} source=${result.source} ` +
        `score=${result.score.toFixed(2)}\n    ${result.url.slice(0, 92)}\n    [${trail}]`,
    );
  } else {
    console.log(`✗ ${c.name}\n    no confident match  [${trail}]`);
  }
}

console.log(`\nseries cache entries: ${seriesCache.size}`);
for (const [key, value] of seriesCache) {
  console.log(`  ${key} -> ${value ? value.url.slice(0, 70) : 'no match'}`);
}
