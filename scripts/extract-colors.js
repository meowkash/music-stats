import fs from 'fs';
import path from 'path';
import { getAverageColor } from 'fast-average-color-node';

const DATA_DIR = path.resolve('src/data');
const PUBLIC_DATA_DIR = path.resolve('public/data');
const ARTWORK_PATH = path.join(DATA_DIR, 'artwork.json');
const COLORS_PATH = path.join(PUBLIC_DATA_DIR, 'colors.json');

async function extractColors() {
  console.log("Starting artwork color extraction...");
  
  if (!fs.existsSync(ARTWORK_PATH)) {
    console.log("No artwork.json found, skipping color extraction.");
    return;
  }
  
  const artworkCache = JSON.parse(fs.readFileSync(ARTWORK_PATH, 'utf-8'));
  
  let existingColors = {};
  if (fs.existsSync(COLORS_PATH)) {
    existingColors = JSON.parse(fs.readFileSync(COLORS_PATH, 'utf-8'));
  }
  
  // Get all unique URLs
  const urls = new Set(Object.values(artworkCache));
  const newColors = { ...existingColors };
  let processed = 0;
  let total = urls.size;
  let failed = 0;
  
  console.log(`Found ${total} unique images.`);
  
  // Limit concurrency to avoid memory/network issues
  const concurrency = 10;
  const urlsArr = Array.from(urls);
  
  for (let i = 0; i < urlsArr.length; i += concurrency) {
    const chunk = urlsArr.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (url) => {
      // Skip if already processed
      if (newColors[url]) return;
      
      try {
        const color = await getAverageColor(url, {
          algorithm: 'dominant'
        });
        
        let r = color.value[0];
        let g = color.value[1];
        let b = color.value[2];
        
        // Boost brightness/saturation if too dark for glow
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        if (brightness < 60) {
          const factor = 1.8;
          r = Math.min(255, Math.round(r * factor));
          g = Math.min(255, Math.round(g * factor));
          b = Math.min(255, Math.round(b * factor));
        }
        
        newColors[url] = { r, g, b };
        processed++;
      } catch (err) {
        // Fallback for CORS or missing
        newColors[url] = { r: 255, g: 107, b: 138 };
        failed++;
      }
    }));
    
    if (i % 50 === 0 && i > 0) {
      console.log(`Processed ${i}/${total} colors...`);
      fs.writeFileSync(COLORS_PATH, JSON.stringify(newColors), 'utf-8');
    }
  }
  
  fs.writeFileSync(COLORS_PATH, JSON.stringify(newColors), 'utf-8');
  console.log(`Color extraction complete! Processed ${processed} new colors, ${failed} failed. Total cached: ${Object.keys(newColors).length}`);
}

extractColors().catch(console.error);
