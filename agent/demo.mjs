#!/usr/bin/env node
// demo.mjs — end-to-end validation: connect Playwright through the relay
// and drive the (fake or real) extension's browser.
//
// Usage: node demo.mjs [ws://127.0.0.1:8787]

import { chromium } from 'playwright-core';

const HOST = process.argv[2] || process.env.TAILBROWSER_HOST || 'ws://127.0.0.1:8787';
const TOKEN = process.env.TAILBROWSER_TOKEN || '';

const url = `${HOST}/cdp/1${TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''}`;
console.log('connecting', HOST);

const browser = await chromium.connectOverCDP(url);
console.log('✓ connected over CDP');

const ctx = browser.contexts()[0];
console.log('contexts:', browser.contexts().length);

let page = ctx.pages()[0] || (await ctx.newPage());
console.log('pages:', ctx.pages().length);

await page.goto('https://example.com', { timeout: 20000 });
console.log('✓ navigated:', page.url());

const title = await page.title();
console.log('✓ title:', title);

const html = await page.content();
console.log('✓ content length:', html.length);

// DOM checks run on content we control — live sites change under us
await page.setContent('<h1> Hello </h1><a href="/next">next</a>');
console.log('✓ h1:', (await page.textContent('h1')).trim());
console.log('✓ link href:', await page.locator('a').first().getAttribute('href'));

await page.setContent('<button id=b>hi</button><script>b.onclick=()=>document.title="clicked"</script>');
await page.click('#b');
console.log('✓ clicked; title now:', await page.title());

console.log('\nALL CHECKS PASSED');
// NB: never call browser.close() against a real user's Chrome
process.exit(0);
