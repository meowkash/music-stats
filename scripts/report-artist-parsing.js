import fs from 'fs';
import path from 'path';
import { buildArtistAttribution, loadOverrides, parseArtistCredits } from './artist-resolve.js';

const META_PATH = path.resolve('public/data/meta.json');
const REPORT_PATH = path.resolve('src/data/artist-parsing-report.json');

function main() {
  if (!fs.existsSync(META_PATH)) {
    console.error('Run process-data.js first to generate meta.json');
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  const overrides = loadOverrides();
  const { canonicalArtists, rawToCanonical, parseReport } = buildArtistAttribution(meta.artists, overrides);

  const split = parseReport.filter((r) => r.credits.length > 1);
  const unchanged = parseReport.filter((r) => r.credits.length === 1 && r.credits[0] === r.raw);

  const topCanonical = canonicalArtists
    .map((name, id) => {
      let count = 0;
      for (let rawId = 0; rawId < meta.artists.length; rawId++) {
        if ((rawToCanonical[rawId] ?? []).includes(id)) {
          // approximate from catalog if available
        }
      }
      return { id, name, count: 0 };
    });

  const catalogPath = path.resolve('public/data/catalog.json');
  if (fs.existsSync(catalogPath)) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    for (const [id, info] of Object.entries(catalog.artists)) {
      const entry = topCanonical[parseInt(id, 10)];
      if (entry) entry.count = info.scrobbles;
    }
  }

  topCanonical.sort((a, b) => b.count - a.count);

  const report = {
    generated: new Date().toISOString(),
    summary: {
      rawArtists: meta.artists.length,
      canonicalArtists: canonicalArtists.length,
      splitStrings: split.length,
      unchangedStrings: unchanged.length,
    },
    topCanonical: topCanonical.slice(0, 30),
    sampleSplits: split.slice(0, 50).map((r) => ({
      raw: r.raw,
      credits: r.credits,
      canonical: r.canonicalIds.map((id) => canonicalArtists[id]),
    })),
    parenthetical: meta.artists.filter((a) => /\(\s*(?:feat|ft|featuring)/i.test(a)),
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${REPORT_PATH}`);
  console.log(`  ${split.length} strings split into multiple credits`);
  console.log(`  ${canonicalArtists.length} canonical artists (from ${meta.artists.length} raw)`);
  console.log('\nTop 10 canonical artists:');
  for (const a of topCanonical.slice(0, 10)) {
    console.log(`  ${a.name}: ${a.count.toLocaleString()} plays`);
  }
}

main();
