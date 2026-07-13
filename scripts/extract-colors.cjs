const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { QuantizerCelebi, Score, argbFromRgb, themeFromSourceColor } = require('@material/material-color-utilities');

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
    // Generate a Material You theme based on the best seed color
    const theme = themeFromSourceColor(ranked[0]);
    
    // Choose the primary color for a dark theme (guarantees great contrast on black)
    const primaryArgb = theme.schemes.dark.primary;
    
    const r = (primaryArgb >> 16) & 255;
    const g = (primaryArgb >> 8) & 255;
    const b = primaryArgb & 255;
    return { r, g, b };
  }
  
  throw new Error("No colors found");
}

async function extractColors() {
  console.log("Starting artwork color extraction using Material You...");
  
  if (!fs.existsSync(ARTWORK_PATH)) {
    console.log("No artwork.json found, skipping color extraction.");
    return;
  }
  
  const artworkCache = JSON.parse(fs.readFileSync(ARTWORK_PATH, 'utf-8'));
  
  let existingColors = {};
  if (fs.existsSync(COLORS_PATH)) {
    existingColors = JSON.parse(fs.readFileSync(COLORS_PATH, 'utf-8'));
  }
  
  const urls = new Set(Object.values(artworkCache));
  const newColors = {}; // Refresh cache to replace old colors with new algorithm
  let processed = 0;
  let total = urls.size;
  let failed = 0;
  
  console.log(`Found ${total} unique images. Re-extracting all to apply new algorithm.`);
  
  const concurrency = 20;
  const urlsArr = Array.from(urls);
  
  for (let i = 0; i < urlsArr.length; i += concurrency) {
    const chunk = urlsArr.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (url) => {
      try {
        const color = await extractMaterialColor(url);
        newColors[url] = color;
        processed++;
      } catch (err) {
        newColors[url] = { r: 255, g: 107, b: 138 };
        failed++;
      }
    }));
    
    if (i % 100 === 0 && i > 0) {
      console.log(`Processed ${i}/${total} colors...`);
      fs.writeFileSync(COLORS_PATH, JSON.stringify(newColors), 'utf-8');
    }
  }
  
  fs.writeFileSync(COLORS_PATH, JSON.stringify(newColors), 'utf-8');
  console.log(`Color extraction complete! Processed ${processed} new colors, ${failed} failed.`);
}

extractColors().catch(console.error);
