import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { QuantizerCelebi, Score, argbFromRgb, themeFromSourceColor } from '@material/material-color-utilities';
import { isStaticArtworkUrl, normalizeStaticArtworkUrl } from './artwork-utils.js';
import {
  extractBottomSurfaceColor,
  BOTTOM_COLOR_VERSION,
} from './color-utils.js';

const DATA_DIR = path.resolve('src/data');
const PUBLIC_DATA_DIR = path.resolve('public/data');
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork.json');
const COLORS_PATH = path.join(PUBLIC_DATA_DIR, 'colors.json');
const refresh = process.argv.includes('--refresh');

function pixelsFromRaw(data, info) {
  const pixels = [];
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = info.channels === 4 ? data[i + 3] : 255;
    if (a < 128) continue;
    pixels.push(argbFromRgb(r, g, b));
  }
  return pixels;
}

function rgbFromArgb(argb) {
  return {
    r: (argb >> 16) & 255,
    g: (argb >> 8) & 255,
    b: argb & 255,
  };
}

function quantizePrimary(pixels) {
  if (pixels.length === 0) return null;
  const result = QuantizerCelebi.quantize(pixels, 128);
  const ranked = Score.score(result);
  if (ranked.length === 0) return null;

  const theme = themeFromSourceColor(ranked[0]);
  return rgbFromArgb(theme.schemes.dark.primary);
}

function quantizeDominant(pixels) {
  if (pixels.length === 0) return null;
  const result = QuantizerCelebi.quantize(pixels, 64);
  const ranked = Score.score(result);
  if (ranked.length === 0) return null;
  return rgbFromArgb(ranked[0]);
}

function averageRgb(data, info) {
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = info.channels === 4 ? data[i + 3] : 255;
    if (a < 128) continue;
    rSum += r;
    gSum += g;
    bSum += b;
    count++;
  }

  if (count === 0) return null;
  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count),
  };
}

async function extractMaterialColor(url) {
  const staticUrl = normalizeStaticArtworkUrl(url) || url;
  if (!isStaticArtworkUrl(staticUrl)) {
    throw new Error('Animated or unsupported artwork URL');
  }

  const response = await fetch(staticUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  const meta = await sharp(buffer).metadata();
  if (meta.format === 'gif' || (meta.pages != null && meta.pages > 1)) {
    throw new Error('Animated image');
  }

  const fullImage = sharp(buffer).resize(100, 100);
  const { data: fullData, info: fullInfo } = await fullImage.raw().toBuffer({ resolveWithObject: true });
  const primary = quantizePrimary(pixelsFromRaw(fullData, fullInfo));
  if (!primary) throw new Error('No colors found');

  const height = meta.height || 100;
  const width = meta.width || 100;
  const stripHeight = Math.max(1, Math.floor(height * 0.18));

  const bottomImage = sharp(buffer).extract({
    left: 0,
    top: height - stripHeight,
    width,
    height: stripHeight,
  }).resize(64, 64);

  const { data: bottomData, info: bottomInfo } = await bottomImage.raw().toBuffer({ resolveWithObject: true });
  const bottomPixels = pixelsFromRaw(bottomData, bottomInfo);

  // Dominant hue from bottom edge; fall back to average if quantizer fails
  const bottomSource = quantizeDominant(bottomPixels) || averageRgb(bottomData, bottomInfo) || primary;
  const bottom = extractBottomSurfaceColor(bottomSource);

  return { ...primary, bottom, bottomVersion: BOTTOM_COLOR_VERSION };
}

function colorEntryNeedsProcessing(url, existingColors) {
  if (refresh) return true;
  const entry = existingColors[url];
  if (!entry) return true;
  if (entry.bottom == null) return true;
  return entry.bottomVersion !== BOTTOM_COLOR_VERSION;
}

async function extractColors() {
  console.log(refresh
    ? 'Re-extracting all artwork colors (Material You + dark surface tint)...'
    : 'Starting incremental artwork color extraction (Material You + dark surface tint)...');

  if (!fs.existsSync(ARTWORK_PATH)) {
    console.log('No artwork.json found, skipping extraction.');
    return;
  }

  if (!fs.existsSync(PUBLIC_DATA_DIR)) {
    fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
  }

  const artworkCache = JSON.parse(fs.readFileSync(ARTWORK_PATH, 'utf-8'));
  let existingColors = {};
  if (fs.existsSync(COLORS_PATH)) {
    existingColors = JSON.parse(fs.readFileSync(COLORS_PATH, 'utf-8'));
  }

  const uniqueUrls = new Set(
    Object.values(artworkCache)
      .filter((url) => typeof url === 'string' && isStaticArtworkUrl(url))
      .map((url) => normalizeStaticArtworkUrl(url) || url),
  );

  const urlsToProcess = Array.from(uniqueUrls).filter((url) => colorEntryNeedsProcessing(url, existingColors));
  console.log(`Found ${urlsToProcess.length} artworks to extract colors for.`);

  const newColors = refresh ? {} : { ...existingColors };
  let processed = 0;
  let failed = 0;
  const concurrency = 20;

  for (let i = 0; i < urlsToProcess.length; i += concurrency) {
    const chunk = urlsToProcess.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (url) => {
      try {
        const color = await extractMaterialColor(url);
        newColors[url] = color;
        processed++;
      } catch (err) {
        console.error(`Failed to process ${url}:`, err.message);
        failed++;
      }
    }));

    if (i % 100 === 0 && i > 0) {
      console.log(`Processed ${i}/${urlsToProcess.length} artworks...`);
      fs.writeFileSync(COLORS_PATH, JSON.stringify(newColors), 'utf-8');
    }
  }

  fs.writeFileSync(COLORS_PATH, JSON.stringify(newColors), 'utf-8');
  console.log(`Extraction complete! Extracted ${processed} colors, ${failed} failed.`);
}

extractColors().catch(console.error);
