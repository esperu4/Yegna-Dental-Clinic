// Renders public/icons/icon.svg to the PNG sizes the web manifest needs.
// Run from apps/pwa after changing the SVG: node build/icons.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const dir = join(import.meta.dirname, '..', 'public', 'icons');
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, padding] of [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  // Maskable: the platform may crop to a circle, so keep the tooth inside the central 80%.
  ['icon-maskable-512.png', 512, 0.1],
]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = size * (1 - 2 * padding);
  await page.setContent(
    `<body style="margin:0;background:#1f7a4d;display:grid;place-items:center;width:${size}px;height:${size}px">
       <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div>
     </body>`,
  );
  await page.screenshot({ path: join(dir, name) });
}
await browser.close();
process.stdout.write(`icons written to ${dir}\n`);
