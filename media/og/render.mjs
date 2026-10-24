#!/usr/bin/env node
// Render og.html to the repository's social preview image (1280x640, 2x).
// Run: npm run build:og   -> media/og-image.png (upload it in GitHub: Settings → Social preview)

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChromium } from '../../lib/find-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../og-image.png');

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(path.join(HERE, 'og.html')).href);
await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode())]));
await page.screenshot({ path: OUT });
await browser.close();
// the website serves a copy for its og:image tag
fs.copyFileSync(OUT, path.resolve(HERE, '../../website/assets/og-image.png'));
console.log(`  ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
