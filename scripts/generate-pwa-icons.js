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
];

async function generateIcons() {
  if (!fs.existsSync(svgPath)) {
    console.error('Missing public/favicon.svg');
    process.exit(1);
  }

  fs.mkdirSync(iconsDir, { recursive: true });
  const svg = fs.readFileSync(svgPath);

  for (const { name, size } of SIZES) {
    const out = path.join(iconsDir, name);
    await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
    console.log(`Wrote ${path.relative(process.cwd(), out)}`);
  }
}

generateIcons().catch((err) => {
  console.error(err);
  process.exit(1);
});
