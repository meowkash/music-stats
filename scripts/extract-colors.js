import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { QuantizerCelebi, Score, argbFromRgb, themeFromSourceColor } from '@material/material-color-utilities';

const DATA_DIR = path.resolve('src/data');
const PUBLIC_DATA_DIR = path.resolve('public/data');
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork.json');
const COLORS_PATH = path.join(PUBLIC_DATA_DIR, 'colors.json');

async function extractMaterialColor(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  
  const image = sharp(Buffer.from(buffer)).resize(100, 100);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  
  const pixels = [];
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i+1];
    const b = data[i+2];
    const a = info.channels === 4 ? data[i+3] : 255;
    if (a < 128) continue;
    pixels.push(argbFromRgb(r, g, b));
  }
  
  const result = QuantizerCelebi.quantize(pixels, 128);
  const ranked = Score.score(result);
  
  if (ranked.length > 0) {
    const theme = themeFromSourceColor(ranked[0]);
    const primaryArgb = theme.schemes.dark.primary;
    
    const r = (primaryArgb >> 16) & 255;
    const g = (primaryArgb >> 8) & 255;
    const b = primaryArgb & 255;
    return { r, g, b };
  }
  
  throw new Error("No colors found");
}

async function extractColors() {
  console.log("Starting incremental artwork color extraction using Material You...");
  
  if (!fs.existsSync(ARTWORK_PATH)) {
    console.log("No artwork.json found, skipping extraction.");
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
  
  // Create a Set of all unique URLs from artwork.json
  const uniqueUrls = new Set(Object.values(artworkCache));
  
  // Only process URLs we haven't seen before
  const urlsToProcess = Array.from(uniqueUrls).filter(url => !existingColors[url]);
  
  console.log(`Found ${urlsToProcess.length} new artworks to extract colors for.`);
  
  const newColors = { ...existingColors };
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
      console.log(`Processed ${i}/${urlsToProcess.length} new artworks...`);
      // Intermittent saves in case of failure
      fs.writeFileSync(COLORS_PATH, JSON.stringify(newColors), 'utf-8');
    }
  }
  
  fs.writeFileSync(COLORS_PATH, JSON.stringify(newColors), 'utf-8');
  console.log(`Extraction complete! Extracted ${processed} new colors, ${failed} failed.`);
}

extractColors().catch(console.error);
