#!/usr/bin/env node
// Render the extension icon PNGs from the SVG masters in extension/icons/.
// Chrome extensions need PNG icons; small sizes use a simplified master so
// the toolbar icon stays legible at 16px.
//
// Run: node scripts/build-icons.mjs   (needs Chromium — CHROME_BIN or Playwright's cache)

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from '../lib/find-chromium.mjs';

const ICONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension/icons');
const OUTPUTS = [
  { size: 16, master: 'icon-small.svg' },
  { size: 32, master: 'icon-small.svg' },
  { size: 48, master: 'icon.svg' },
  { size: 128, master: 'icon.svg' },
];

const executablePath = findChromium();
if (!executablePath) {
  console.error('no Chromium found (set CHROME_BIN)');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
for (const { size, master } of OUTPUTS) {
  const svg = fs.readFileSync(path.join(ICONS, master), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const out = path.join(ICONS, `icon-${size}.png`);
  await page.screenshot({ path: out, omitBackground: true });
  console.log(`  ${path.relative(process.cwd(), out)}  (${master})`);
}
await browser.close();
