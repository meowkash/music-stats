import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const publicDir = path.resolve('public');
const iconsDir = path.join(publicDir, 'icons');
const splashDir = path.join(publicDir, 'splash');
const svgPath = path.join(publicDir, 'favicon.svg');
const splashTagsPath = path.resolve('src/layouts/splash-tags.html');

const SIZES = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-32.png', size: 32 },
];

/**
 * CSS points → device media query (width/height in CSS px, DPR).
 * Without a matching apple-touch-startup-image, iOS shows a white screen +
 * the apple-touch-icon — including as the snapshot when swiping to Home.
 */
const SPLASH_MEDIA = [
  { w: 320, h: 568, dpr: 2 },
  { w: 375, h: 667, dpr: 2 },
  { w: 414, h: 736, dpr: 3 },
  { w: 375, h: 812, dpr: 3 },
  { w: 414, h: 896, dpr: 2 },
  { w: 414, h: 896, dpr: 3 },
  { w: 390, h: 844, dpr: 3 },
  { w: 393, h: 852, dpr: 3 },
  { w: 428, h: 926, dpr: 3 },
  { w: 430, h: 932, dpr: 3 },
  { w: 402, h: 874, dpr: 3 },
  { w: 420, h: 912, dpr: 3 },
  { w: 440, h: 956, dpr: 3 },
  { w: 360, h: 780, dpr: 3 },
  { w: 744, h: 1133, dpr: 2 },
  { w: 768, h: 1024, dpr: 2 },
  { w: 810, h: 1080, dpr: 2 },
  { w: 820, h: 1180, dpr: 2 },
  { w: 834, h: 1112, dpr: 2 },
  { w: 834, h: 1194, dpr: 2 },
  { w: 834, h: 1210, dpr: 2 },
  { w: 1024, h: 1366, dpr: 2 },
  { w: 1032, h: 1376, dpr: 2 },
];

/**
 * Apple (and iOS 26 home/multitasking transitions) composite transparent
 * pixels onto white. Our favicon.svg bakes in a squircle (`rx`) which leaves
 * the four corners transparent — that reads as a white plate behind the icon.
 * Provide a full-bleed opaque square; iOS applies its own mask.
 */
function fullBleedIconSvg(svg) {
  // Only drop the baked-in squircle on the background rect — keep ellipse rx/ry.
  return Buffer.from(
    svg
      .toString('utf8')
      .replace(
        /<rect width="512" height="512" rx="\d+"/,
        '<rect width="512" height="512"',
      ),
  );
}

async function renderOpaqueIcon(svg, size) {
  // Flatten onto the logo's outer stop so any residual alpha can't go white.
  return sharp(fullBleedIconSvg(svg))
    .resize(size, size)
    .flatten({ background: { r: 7, g: 5, b: 13 } })
    .png({ compressionLevel: 9, force: true })
    .toBuffer();
}

async function generateAppIcons(svg) {
  fs.mkdirSync(iconsDir, { recursive: true });

  for (const { name, size } of SIZES) {
    const out = path.join(iconsDir, name);
    await sharp(await renderOpaqueIcon(svg, size)).toFile(out);
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

  // Keep the squircle for the OG banner (sits on our own gradient, not iOS chrome).
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

function splashName(width, height) {
  return `apple-splash-${width}-${height}.jpg`;
}

async function generateSplashScreens(svg) {
  fs.mkdirSync(splashDir, { recursive: true });

  // Unique portrait + landscape pixel sizes derived from the media queries.
  const sizes = new Map();
  for (const { w, h, dpr } of SPLASH_MEDIA) {
    const width = Math.round(w * dpr);
    const height = Math.round(h * dpr);
    sizes.set(`${width}x${height}`, { width, height });
    sizes.set(`${height}x${width}`, { width: height, height: width });
  }

  for (const { width, height } of sizes.values()) {
    const iconSize = Math.round(Math.min(width, height) * 0.22);
    // Opaque full-bleed mark — same asset as the home-screen icon.
    const icon = await renderOpaqueIcon(svg, iconSize);
    const out = path.join(splashDir, splashName(width, height));
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite([
        {
          input: icon,
          left: Math.round((width - iconSize) / 2),
          top: Math.round((height - iconSize) / 2),
        },
      ])
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(out);
  }

  console.log(`Wrote ${sizes.size} splash screens → ${path.relative(process.cwd(), splashDir)}`);
}

function writeSplashTags() {
  const lines = [
    '<!-- Auto-generated by scripts/generate-pwa-icons.js — do not edit by hand. -->',
    '<!-- Black launch images so iOS never falls back to white + icon (also used as the home-gesture snapshot). -->',
  ];

  for (const { w, h, dpr } of SPLASH_MEDIA) {
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    const base = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr})`;
    lines.push(
      `<link rel="apple-touch-startup-image" href="/splash/${splashName(pw, ph)}" media="${base} and (orientation: portrait)">`,
    );
    lines.push(
      `<link rel="apple-touch-startup-image" href="/splash/${splashName(ph, pw)}" media="${base} and (orientation: landscape)">`,
    );
  }

  fs.writeFileSync(splashTagsPath, `${lines.join('\n')}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), splashTagsPath)}`);
}

async function generateIcons() {
  if (!fs.existsSync(svgPath)) {
    console.error('Missing public/favicon.svg');
    process.exit(1);
  }

  const svg = fs.readFileSync(svgPath);
  await generateAppIcons(svg);
  await generateOgImage(svg);
  await generateSplashScreens(svg);
  writeSplashTags();
}

generateIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
