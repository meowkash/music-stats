import fs from 'fs';
import sharp from 'sharp';
import { QuantizerCelebi, Score, argbFromRgb } from '@material/material-color-utilities';

async function test() {
  const url = 'https://i.scdn.co/image/ab67616d00001e0274154b9d031e2ec23d11b3ec'; // Example artwork
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  
  const image = sharp(Buffer.from(buffer)).resize(100, 100);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  
  const pixels = [];
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i+1];
    const b = data[i+2];
    const a = info.channels === 4 ? data[i+3] : 255;
    if (a < 255) continue;
    pixels.push(argbFromRgb(r, g, b));
  }
  
  const result = QuantizerCelebi.quantize(pixels, 128);
  const ranked = Score.score(result);
  
  console.log("Ranked colors:", ranked.map(c => {
    return { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
  }));
}

test().catch(console.error);
