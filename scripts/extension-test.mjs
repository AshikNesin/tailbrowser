#!/usr/bin/env node
// tailbrowser extension e2e: loads the REAL unpacked extension (extension/)
// into Chromium, configures it through the popup, and drives tabs through the
// relay. Covers what the fake extension can't: chrome.debugger attach
// semantics, scope modes, popup flows, revoke.
//
// Needs a full Chromium build (not the headless shell), found via CHROME_BIN
// or Playwright's browser cache. Pages are served locally; no internet needed.
//
// Run: node scripts/extension-test.mjs [--screenshots <dir>]

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flagReader } from '../lib/args.mjs';
import { findChromium } from '../lib/find-chromium.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const RELAY_PORT = Number(process.env.TB_TEST_PORT || 18970);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const SHOTS = flagReader(process.argv.slice(2))('screenshots', null);
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ext-'));

let pass = 0, fail = 0;
const check = (cond, msg, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !detail ? '' : `: ${detail}`}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 10_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await wait(250)) if (await pred()) return true;
  return false;
}

// ---------- fixtures: local pages + relay ----------

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

const relayLog = fs.openSync(path.join(LOGDIR, 'relay.log'), 'w');
const relay = spawn('node', ['relay/relay.mjs', '--port', String(RELAY_PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', relayLog, relayLog] });
process.on('exit', () => relay.kill());
await until(async () => { try { return (await fetch(`${RELAY}/health`)).ok; } catch { return false; } });

const health = async () => (await fetch(`${RELAY}/health`)).json();
const execute = async (code, sessionId = 'ext-test') => (await fetch(`${RELAY}/execute`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, sessionId }),
})).json();

// ---------- browser with the extension loaded ----------

const executablePath = findChromium({ allowHeadlessShell: false });
if (!executablePath) {
  console.error('no full Chromium build found (set CHROME_BIN); the headless shell cannot load extensions');
  process.exit(1);
}
const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ext-profile-')), {
  executablePath,
  headless: true,
  args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`, '--no-sandbox'],
});
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
worker.on('console', (m) => fs.appendFileSync(path.join(LOGDIR, 'worker.log'), m.text() + '\n'));
const extensionId = new URL(worker.url()).host;

const sitePage = await context.newPage();
await sitePage.goto(`${SITE}/home`);
const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 640 });
await popup.goto(`chrome-extension://${extensionId}/popup.html`);

// talk to the service worker the way the popup does
const send = (msg) => popup.evaluate((m) => chrome.runtime.sendMessage(m), msg);
const status = () => send({ t: 'getStatus' });
const siteTabId = await popup.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${SITE}/home`);
async function screenshot(name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await popup.bringToFront();
  await wait(2200); // one live-refresh tick
  await popup.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

console.log(`▸ extension ${extensionId} (logs: ${LOGDIR})`);
await screenshot('1-setup');

console.log('▸ 1. configure through the popup form');
{
  const bad = await send({ t: 'saveOpts', opts: { relay: 'not a url' } });
  check(bad.ok === false && /Relay URL/.test(bad.error), 'invalid relay URL is rejected with a message', JSON.stringify(bad));
  await popup.fill('#relay', `ws://127.0.0.1:${RELAY_PORT}`);
  await popup.click('#save');
  check(await until(async () => (await health()).extension), 'extension connects to the relay');
  const st = await status();
  check(st.state === 'connected' && st.scopeMode === 'tab' && st.attached.length === 0, 'tab mode shares nothing by default', JSON.stringify(st));
}

console.log('▸ 2. tab mode: opt in and drive a tab');
{
  const r = await send({ t: 'optIn', tabId: siteTabId });
  check(r.ok && await until(async () => (await health()).targets === 1), 'opted-in tab is advertised', JSON.stringify(r));
  let x = await execute('return await page.title()');
  check(x.ok && x.result === 'Page /home', 'snippet reads the page via chrome.debugger', JSON.stringify(x));
  x = await execute(`await page.goto(${JSON.stringify(`${SITE}/next`)}); await page.setContent('<button onclick="document.title=1">b</button>'); await page.click('button'); return await page.title()`);
  check(x.ok && x.result === '1', 'navigate, setContent, click', JSON.stringify(x));
  x = await execute('return await newPage()');
  check(!x.ok && /TB_SCOPE/.test(x.error), 'newPage() refused outside full mode', JSON.stringify(x));
  await screenshot('2-tab-mode');
}

console.log('▸ 3. full mode: every tab, agent-created tabs');
{
  await send({ t: 'setScope', scopeMode: 'full' });
  check(await until(async () => (await health()).targets >= 2), 'all tabs attached');
  const x = await execute('const p = await newPage(); await p.setContent("<b>n</b>"); const text = await p.textContent("b"); const before = pages().length; await p.close(); return [text, before, pages().length]');
  check(x.ok && x.result[0] === 'n' && x.result[2] === x.result[1] - 1, 'newPage() works and page.close() completes', JSON.stringify(x));
  const tabCount = await popup.evaluate(async () => (await chrome.tabs.query({})).length);
  const st = await status();
  check(st.attached.length === tabCount, `one attachment per tab (${st.attached.length}/${tabCount})`);
  await screenshot('3-full-mode');
}

console.log('▸ 4. narrowing scope detaches');
{
  await send({ t: 'setScope', scopeMode: 'tab' });
  const st = await status();
  check(st.attached.length === 1 && st.attached[0].tabId === siteTabId, 'back to tab mode: only the opted-in tab remains', JSON.stringify(st.attached));

  // overlapping changes: widen, then narrow before the widen has finished attaching
  for (let i = 0; i < 2; i++) await context.newPage().then((p) => p.goto(`${SITE}/extra-${i}`));
  // Narrow while attaches are in flight. Headless attaches finish in a few ms,
  // so slow chrome.debugger.attach down inside the worker to hold the window open.
  await worker.evaluate(() => {
    globalThis.__realAttach = chrome.debugger.attach.bind(chrome.debugger);
    chrome.debugger.attach = async (...args) => { await new Promise((r) => setTimeout(r, 300)); return globalThis.__realAttach(...args); };
  });
  const widen = send({ t: 'setScope', scopeMode: 'full' });
  await wait(100); // the first slowed attach is now in flight
  await send({ t: 'setScope', scopeMode: 'tab' });
  await widen;
  await wait(1200); // let every in-flight attach finish
  await worker.evaluate(() => { chrome.debugger.attach = globalThis.__realAttach; });
  const leaked = (await status()).attached.filter((t) => t.tabId !== siteTabId);
  check(!leaked.length, 'no tab stays attached when the scope narrows mid-attach', JSON.stringify(leaked.map((t) => t.url)));
  const after = await status();
  // tabs this extension really holds a debugger on: only those accept its CDP commands
  // (getTargets().attached is no good here, since Playwright is attached to every page too)
  const debugged = await popup.evaluate(async () => {
    let held = 0;
    for (const tab of await chrome.tabs.query({})) {
      try { await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.evaluate', { expression: '1' }); held++; } catch {}
    }
    return held;
  });
  check(after.attached.length === 1 && after.attached[0].tabId === siteTabId && debugged === 1,
    'overlapping full→tab change leaves only the opted-in tab attached', `${JSON.stringify(after.attached.map((t) => t.url))}, debugger attached to ${debugged}`);
  check((await health()).targets === 1, 'relay sees only that tab');

  // keyboard: the scope group is one tab stop, arrows move the selection
  await popup.reload();
  await popup.waitForFunction(() => document.querySelector('[data-scope][aria-checked="true"]')); // first status render
  const stops = await popup.evaluate(() => [...document.querySelectorAll('[data-scope]')].map((b) => b.tabIndex));
  check(JSON.stringify(stops) === '[0,-1,-1]', 'scope options form one tab stop', JSON.stringify(stops));
  await popup.focus('[data-scope="tab"]');
  await popup.keyboard.press('ArrowDown');
  check(await until(async () => (await status()).scopeMode === 'allowlist', 8000), 'ArrowDown selects the next scope (Allowlist)');
  await popup.keyboard.press('ArrowUp');
  check(await until(async () => (await status()).scopeMode === 'tab', 8000), 'ArrowUp selects it back (Tabs I pick)');
}

console.log('▸ 5. allowlist mode: auto-attach on navigation');
{
  await send({ t: 'optOut', tabId: siteTabId });
  await send({ t: 'setScope', scopeMode: 'allowlist', allowlist: [`${SITE}/in/*`, `${SITE}/q?x`] });
  check((await status()).attached.length === 0, 'opted-out tab stays detached');
  const page = await context.newPage();
  await page.goto(`${SITE}/in/one`);
  check(await until(async () => (await status()).attached.some((t) => t.url.startsWith(`${SITE}/in/`))), 'tab navigating into the allowlist is attached');
  await page.goto(`${SITE}/qx`);
  check(await until(async () => (await status()).attached.length === 0), 'navigating out detaches ("?" in a pattern is literal)');
  await screenshot('4-allowlist');
}

console.log('▸ 6. revoke');
{
  await send({ t: 'setScope', scopeMode: 'full' });
  await until(async () => (await health()).targets >= 2);
  await send({ t: 'disconnectAgent' });
  check(await until(async () => !(await health()).extension), 'revoke drops the relay link');
  const st = await status();
  check(st.state === 'revoked' && st.attached.length === 0, 'revoke detaches every tab', JSON.stringify(st));
  const { tbRevoked } = await popup.evaluate(() => chrome.storage.local.get('tbRevoked'));
  check(tbRevoked === true, 'revoke is persisted across worker restarts');
  await popup.reload();
  await screenshot('5-revoked');
  await send({ t: 'reconnect' });
  check(await until(async () => (await health()).extension), 'reconnect restores the link');
}

await context.close();
site.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed  (logs: ${LOGDIR})`);
process.exit(fail === 0 ? 0 : 1);
