import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const publicDir = path.resolve('public');
const iconsDir = path.join(publicDir, 'icons');
const svgPath = path.join(publicDir, 'favicon.svg');

const SIZES = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-32.png', size: 32 },
];

async function generateAppIcons(svg) {
  fs.mkdirSync(iconsDir, { recursive: true });

  for (const { name, size } of SIZES) {
    const out = path.join(iconsDir, name);
    await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
    console.log(`Wrote ${path.relative(process.cwd(), out)}`);
  }
}

/**
 * Share sheets (iMessage, iOS Share → Add to Home Screen preview, Slack, etc.)
 * use og:image — keep it in sync with the app icon, not a stale brand mark.
 * Background matches favicon.svg / splash-icon-bg radial gradient.
 */
async function generateOgImage(svg) {
  const width = 1200;
  const height = 630;
  const iconSize = 420;
  const iconLeft = Math.round((width - iconSize) / 2);
  const iconTop = Math.round((height - iconSize) / 2);

  const icon = await sharp(svg).resize(iconSize, iconSize).png().toBuffer();

  // Same stops / focal point as public/favicon.svg and .splash-icon-bg.
  const background = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="50%" cy="36%" r="88%">
          <stop offset="0%" stop-color="#241c3a"/>
          <stop offset="50%" stop-color="#110e18"/>
          <stop offset="100%" stop-color="#07050d"/>
        </radialGradient>
        <radialGradient id="ellipseGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#a855f7" stop-opacity="0.22"/>
          <stop offset="70%" stop-color="#ff2d55" stop-opacity="0.06"/>
          <stop offset="100%" stop-color="#07050d" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>
      <ellipse cx="${width / 2}" cy="${Math.round(height * 0.54)}" rx="480" ry="280" fill="url(#ellipseGlow)"/>
    </svg>
  `);

  const out = path.join(publicDir, 'og-image.png');
  await sharp(background)
    .composite([{ input: icon, left: iconLeft, top: iconTop }])
    .png({ compressionLevel: 9 })
    .toFile(out);

  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

async function generateIcons() {
  if (!fs.existsSync(svgPath)) {
    console.error('Missing public/favicon.svg');
    process.exit(1);
  }

  const svg = fs.readFileSync(svgPath);
  await generateAppIcons(svg);
  await generateOgImage(svg);
}

generateIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
