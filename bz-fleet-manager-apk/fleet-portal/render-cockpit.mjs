import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1560, height: 980 } });
await page.goto(new URL('../mockups/pro-cockpit-control-tower.html', import.meta.url).href, { waitUntil: 'networkidle' });
await page.screenshot({ path: '../mockups/pro-cockpit-control-tower.png', fullPage: true });
console.log('Saved mockups/pro-cockpit-control-tower.png');
await browser.close();
