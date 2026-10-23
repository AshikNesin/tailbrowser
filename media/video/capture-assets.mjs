#!/usr/bin/env node
// Capture the real footage used by the product video: the demo page as the
// agent sees it (its own screenshot() output, through relay + extension), the
// CLI output of the demo snippet, and the extension popup in each scope mode.
//
// Run: node media/video/capture-assets.mjs   (writes media/video/assets/)

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from '../../lib/find-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const ASSETS = path.join(HERE, 'assets');
// Chromium resolves these names to the local servers (--host-resolver-rules),
// so the footage shows a realistic MagicDNS-style setup instead of 127.0.0.1.
const RELAY_HOST = 'mac-mini';
const DEMO_HOST = 'ops.acme.test';
const RELAY_PORT = 8787;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(ASSETS, { recursive: true });

// demo app on a local server (port 80 so the URL has no port; needs root)
const demoHtml = fs.readFileSync(path.join(HERE, 'demo-app.html'));
// a letter-on-tile favicon, so the tab lists look like real sites
const favicon = (bg, text) => `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${bg}"/>`
  + `<text x="16" y="22" font-family="Arial" font-weight="700" font-size="17" fill="white" text-anchor="middle">${text}</text></svg>`,
)}">`;
const page = (title, icon) => `<!doctype html><meta charset="utf-8">${icon}<title>${title}</title><h1>${title}</h1>`;
const PAGES = {
  '/orders': demoHtml,
  '/handbook': page('Team Handbook', favicon('#3f6fb0', 'H')),
  '/calendar': page('Calendar · October', favicon('#2f8a5b', '31')),
};
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGES[req.url] || PAGES['/orders']);
});
await new Promise((r) => site.listen(80, '127.0.0.1', r));
const DEMO = `http://${DEMO_HOST}/orders`;

const relay = spawn('node', ['relay/relay.mjs', '--port', String(RELAY_PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => relay.kill());
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${RELAY}/health`)).ok) break; } catch {} await wait(250); }

const ext = path.join(ROOT, 'extension');
const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-video-')), {
  executablePath: findChromium({ allowHeadlessShell: false }),
  headless: true,
  viewport: { width: 1280, height: 760 },
  deviceScaleFactor: 2,
  args: [
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox',
    `--host-resolver-rules=MAP ${RELAY_HOST} 127.0.0.1, MAP ${DEMO_HOST} 127.0.0.1`,
    '--no-proxy-server', // an env proxy would swallow the mapped hostnames; the capture needs no internet
  ],
});
for (const page of context.pages()) await page.close(); // the initial about:blank
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const demo = await context.newPage();
await demo.goto(DEMO);
const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 600 });
await popup.goto(`chrome-extension://${extensionId}/popup.html`);
const send = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), msg);
const demoTabId = await popup.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, DEMO);

// Opened as a tab, the popup would describe and list itself; make it behave
// as it does when opened from the toolbar over the demo tab.
const asToolbarPopup = () => popup.evaluate((tabId) => {
  const query = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = (q) => (q && q.active ? chrome.tabs.get(tabId).then((t) => [t]) : query(q));
  const realCall = window.call;
  window.call = async (...args) => {
    const r = await realCall(...args);
    if (r && Array.isArray(r.attached)) r.attached = r.attached.filter((t) => !t.url.startsWith('chrome-extension://'));
    return r;
  };
}, demoTabId);

await send({ t: 'saveOpts', opts: { relay: `ws://${RELAY_HOST}:${RELAY_PORT}` } });
for (let i = 0; i < 40 && !(await (await fetch(`${RELAY}/health`)).json()).extension; i++) await wait(250);
await send({ t: 'optIn', tabId: demoTabId });
await wait(500);

const execute = async (code) => {
  const r = await (await fetch(`${RELAY}/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, sessionId: 'video' }),
  })).json();
  if (!r.ok) throw new Error(r.error);
  return r.result;
};
const agentShot = async (name) => {
  const png = await execute('return await screenshot()'); // the agent's own view of the tab
  fs.writeFileSync(path.join(ASSETS, name), Buffer.from(png, 'base64'));
  console.log('  ', name);
};

// demo: exactly the snippet shown in the video, one step per frame
await agentShot('demo-1-start.png');
await execute('await page.fill("#order", "A-1042")');
await agentShot('demo-2-filled.png');
await execute('await page.click("text=Look up")');
await agentShot('demo-3-result.png');
const status = await execute('return await page.textContent(".status")');
const geometry = await execute(`return await page.evaluate(() => Object.fromEntries(['#order', '#lookup', '.status'].map((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return [s, { x: r.x + r.width / 2, y: r.y + r.height / 2, w: innerWidth, h: innerHeight }];
})))`);
fs.writeFileSync(path.join(ASSETS, 'demo.json'), JSON.stringify({ status, geometry }, null, 2) + '\n');
console.log('   demo.json  status =', JSON.stringify(status));

// popup in each scope mode (reloaded so the relay settings start collapsed)
for (const p of ['/handbook', '/calendar']) await (await context.newPage()).goto(`http://${DEMO_HOST}${p}`);
const popupShot = async (name) => {
  await popup.reload();
  await asToolbarPopup();
  await popup.evaluate(() => refresh());
  await wait(500);
  await popup.screenshot({ path: path.join(ASSETS, name), fullPage: true });
  console.log('  ', name);
};
await popupShot('popup-tab.png');
await send({ t: 'setScope', scopeMode: 'allowlist', allowlist: [`http://${DEMO_HOST}/orders*`] });
await popupShot('popup-allowlist.png');
await send({ t: 'setScope', scopeMode: 'full' });
await wait(800);
await popupShot('popup-full.png');

await context.close();
site.close();
process.exit(0);
