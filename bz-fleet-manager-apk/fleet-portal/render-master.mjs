import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1020 } });
await page.goto(new URL('../mockups/master-control-tower.html', import.meta.url).href, { waitUntil: 'networkidle' });
await page.screenshot({ path: '../mockups/master-control-tower.png', fullPage: true });
console.log('Saved mockups/master-control-tower.png');
await browser.close();
