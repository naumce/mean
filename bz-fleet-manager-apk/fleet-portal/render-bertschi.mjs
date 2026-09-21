import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1020 } });
await page.goto(new URL('../mockups/bertschi-master-cockpit.html', import.meta.url).href, { waitUntil: 'networkidle' });
await page.screenshot({ path: '../mockups/bertschi-master-cockpit.png', fullPage: true });
console.log('Saved mockups/bertschi-master-cockpit.png');
await browser.close();
