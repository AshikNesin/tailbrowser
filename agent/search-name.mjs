#!/usr/bin/env node
// search-name.mjs — drive the user's REAL Chrome through the relay: google a name, read results.
// Usage: TAILBROWSER_HOST=ws://... node search-name.mjs ["Query"]

import { chromium } from 'playwright-core';

const HOST = process.env.TAILBROWSER_HOST || 'ws://127.0.0.1:8787';
const QUERY = process.argv[2] || 'Ashik Nesin';

const browser = await chromium.connectOverCDP(`${HOST}/cdp/1`);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log('pages visible to agent:', pages.length, pages.map(p => p.url().slice(0, 60)));
if (!pages.length) { console.error('no attached targets — opt in a tab or use full-browser mode'); process.exit(1); }

const page = pages[0];
await page.goto(`https://www.google.com/search?q=${encodeURIComponent(QUERY)}&num=10`, { timeout: 30000 });
await page.waitForSelector('h3', { timeout: 10000 }).catch(() => {});
console.log('✓ searched for:', QUERY);
console.log('✓ url:', page.url());

// organic results: h3 inside a parent link
const results = await page.$$eval('a h3', (els) =>
  els.map((e, i) => {
    const a = e.closest('a');
    return { n: i + 1, title: e.textContent.trim(), href: a ? a.href : '' };
  }).filter(r => r.title).slice(0, 10)
).catch(() => []);

if (results.length) {
  for (const r of results) console.log(`  ${r.n}. ${r.title}\n     ${r.href}`);
} else {
  const body = (await page.textContent('body') || '').slice(0, 400);
  console.log('no <a><h3> results; page text:', body);
}

// consent page? (EU) — detect and report
if (/before you continue to google/i.test(await page.textContent('body').catch(() => '') || '')) {
  console.log('⚠ Google consent wall detected — click "Accept" once on the Mac mini, then rerun.');
}

console.log('\nDONE');
process.exit(0);
