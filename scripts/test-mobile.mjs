import fs from 'node:fs';
import { chromium, webkit } from 'playwright';
import { checkMobileSurfaces } from './mobile-checks.mjs';
import { checkMobileMotion } from './motion-checks.mjs';

const origin = process.argv[2];
if (!origin) throw new Error('Usage: npm run test:mobile -- http://<LAN-address>:4321');
const engine = process.env.MOBILE_BROWSER ?? 'webkit';
const browser = await (engine === 'webkit' ? webkit : chromium).launch({
  headless: true,
  ...(engine !== 'webkit' && process.env.BENCH_BROWSER_CHANNEL ? { channel: process.env.BENCH_BROWSER_CHANNEL } : {}),
});
try {
  const motionOnly = process.argv.includes('--motion');
  const evidence = await (motionOnly ? checkMobileMotion(browser, origin) : checkMobileSurfaces(browser, origin, { insecure: true }));
  fs.mkdirSync('Verification/Runtime', { recursive: true });
  fs.writeFileSync(`Verification/Runtime/${motionOnly ? 'mobile-motion' : 'mobile'}.json`, JSON.stringify({ engine, connection: 'LAN HTTP without Web Crypto', checks: evidence }, null, 2));
  console.log('Mobile regressions passed:', evidence);
} finally { await browser.close(); }
