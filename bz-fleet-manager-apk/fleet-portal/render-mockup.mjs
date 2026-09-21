import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(new URL('../mockups/north-american-control-tower.html', import.meta.url).href, { waitUntil: 'networkidle' });
await page.screenshot({ path: '../mockups/north-american-control-tower.png', fullPage: true });
console.log('Saved mockups/north-american-control-tower.png');
await browser.close();
