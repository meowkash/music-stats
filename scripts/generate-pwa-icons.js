import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const publicDir = path.resolve('public');
const iconsDir = path.join(publicDir, 'icons');
const splashDir = path.join(publicDir, 'splash');
const svgPath = path.join(publicDir, 'favicon.svg');
const glyphPath = path.join(publicDir, 'logo-mark.svg');
const splashTagsPath = path.resolve('src/layouts/splash-tags.html');

// Keep in sync with public/favicon.svg and the loading overlay in Layout.astro.
const ICON_BACKGROUND = '#121212';

const SIZES = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-32.png', size: 32 },
];

/** Sizes packed into favicon.ico — covers tab, bookmark bar and Windows taskbar. */
const ICO_SIZES = [16, 32, 48];

// CSS points → device media query. Without a matching apple-touch-startup-image
// iOS shows a white screen, including as the swipe-to-Home snapshot.
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

// Apple composites transparent pixels onto white, and favicon.svg's squircle
// leaves the corners clear. Ship a full-bleed opaque square; iOS masks it.
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
  // Flatten onto the icon background so residual alpha cannot turn white.
  return sharp(fullBleedIconSvg(svg))
    .resize(size, size)
    .flatten({ background: ICON_BACKGROUND })
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

  // Safari probes /apple-touch-icon.png at the site root when adding to Home
  // Screen, even when <link rel="apple-touch-icon"> points elsewhere.
  const rootTouchIcon = path.join(publicDir, 'apple-touch-icon.png');
  fs.copyFileSync(path.join(iconsDir, 'apple-touch-icon.png'), rootTouchIcon);
  console.log(`Wrote ${path.relative(process.cwd(), rootTouchIcon)}`);

  // Older iOS probes the -precomposed name by convention. As a hand-committed
  // copy the two diverged the first time the logo changed.
  const precomposed = path.join(publicDir, 'apple-touch-icon-precomposed.png');
  fs.copyFileSync(rootTouchIcon, precomposed);
  console.log(`Wrote ${path.relative(process.cwd(), precomposed)}`);
}

// Browsers request /favicon.ico by path regardless of <link rel="icon">, so the
// template default leaks Astro's logo into tabs, bookmarks and the PWA title bar.
function packIco(images) {
  const HEADER = 6;
  const ENTRY = 16;

  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = HEADER + ENTRY * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(ENTRY);
    // 256 is encoded as 0; every size we emit is smaller, but keep it honest.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size (0 = truecolour)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

async function generateFavicon(svg) {
  const images = [];
  for (const size of ICO_SIZES) {
    images.push({ size, data: await renderOpaqueIcon(svg, size) });
  }

  const out = path.join(publicDir, 'favicon.ico');
  fs.writeFileSync(out, packIco(images));
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${ICO_SIZES.join(', ')}px)`);
}

// Share sheets use og:image, so it tracks the app icon rather than a stale mark.
// Background matches the flat charcoal app icon and launch screen.
async function generateOgImage(svg) {
  const width = 1200;
  const height = 630;
  const iconSize = 420;
  const iconLeft = Math.round((width - iconSize) / 2);
  const iconTop = Math.round((height - iconSize) / 2);

  // Keep the squircle for the OG banner; the matching background hides its edges.
  const icon = await sharp(svg).resize(iconSize, iconSize).png().toBuffer();

  const background = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${ICON_BACKGROUND}"/>
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

// Mirrors #pwa-splash-screen in src/layouts/Layout.astro: the launch image is
// replaced by that overlay on first paint, so any difference reads as a flash.
// Change SPLASH_GLYPH_PT in the overlay too.
const SPLASH_GLYPH_PT = 76;

function splashBackgroundSvg(width, height) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${ICON_BACKGROUND}"/>
    </svg>
  `);
}

async function generateSplashScreens() {
  fs.mkdirSync(splashDir, { recursive: true });
  const glyphSvg = fs.readFileSync(glyphPath);

  // Unique portrait + landscape pixel sizes derived from the media queries.
  const sizes = new Map();
  for (const { w, h, dpr } of SPLASH_MEDIA) {
    const width = Math.round(w * dpr);
    const height = Math.round(h * dpr);
    sizes.set(`${width}x${height}`, { width, height, dpr });
    sizes.set(`${height}x${width}`, { width: height, height: width, dpr });
  }

  for (const { width, height, dpr } of sizes.values()) {
    const glyphSize = Math.round(SPLASH_GLYPH_PT * dpr);
    // logo-mark.svg is a 24-unit viewBox; rasterise at the target density
    // rather than upscaling a 24px render.
    const glyph = await sharp(glyphSvg, { density: (72 * glyphSize) / 24 })
      .resize(glyphSize, glyphSize)
      .png()
      .toBuffer();
    const out = path.join(splashDir, splashName(width, height));
    await sharp(splashBackgroundSvg(width, height))
      .composite([
        {
          input: glyph,
          left: Math.round((width - glyphSize) / 2),
          top: Math.round((height - glyphSize) / 2),
        },
      ])
      .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toFile(out);
  }

  console.log(`Wrote ${sizes.size} splash screens → ${path.relative(process.cwd(), splashDir)}`);
}

function writeSplashTags() {
  const lines = [
    '<!-- Auto-generated by scripts/generate-pwa-icons.js — do not edit by hand. -->',
    '<!-- Launch images match the #pwa-splash-screen overlay so iOS never falls back to white + icon (also used as the home-gesture snapshot). -->',
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
  await generateFavicon(svg);
  await generateOgImage(svg);
  await generateSplashScreens();
  writeSplashTags();
}

generateIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
