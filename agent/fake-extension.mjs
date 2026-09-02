#!/usr/bin/env node
// fake-extension.mjs — simulates the real extension for local testing.
// Talks the same /extension envelope protocol as extension/background.js,
// but instead of chrome.debugger it drives a REAL headless Chromium over CDP
// (launched with --remote-debugging-port). This lets us validate the whole
// relay + Playwright chain on a server with no GUI Chrome.
//
// Usage: node fake-extension.mjs --relay ws://127.0.0.1:8787 --token X --url https://example.com

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const RELAY = flag('relay', 'ws://127.0.0.1:8787');
const TOKEN = flag('token', '');
const START_URL = flag('url', 'https://example.com');
const SCOPE_MODE = flag('scope', 'full');
const CHROME = flag('chrome', '');

const log = (...a) => console.log('[fake-ext]', ...a);

// ---------- launch headless chromium ----------

function findChrome() {
  if (CHROME) return CHROME;
  const cands = [
    process.env.CHROME_BIN,
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-*')] : []),
  ].filter(Boolean);
  const roots = ['/usr/bin', '/usr/local/bin', '/opt/google/chrome/chrome', '/snap/bin', path.join(os.homedir(), '.cache/ms-playwright')];
  for (const r of roots) {
    try {
      for (const e of fs.readdirSync(r)) {
        if (/^(chromium|chrome|google-chrome|chromium-browser|headless_shell|chrome-headless-shell)/.test(e)) {
          return path.join(r, e);
        }
      }
    } catch {}
  }
  return null;
}

// 1) find browser executable (binary or dir containing chrome-linux/...)
async function launch() {
  const bin = findChrome();
  if (!bin) { console.error('no chromium found; install or pass --chrome'); process.exit(1); }
  let exe = bin;
  const st = fs.statSync(bin);
  if (st.isDirectory()) {
    // playwright layout: chromium-1234/chrome-linux/chrome or chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
    const cands = [
      path.join(bin, 'chrome-headless-shell-linux64/chrome-headless-shell'),
      path.join(bin, 'chrome-linux/chrome'),
      path.join(bin, 'chrome-linux/headless_shell'),
      path.join(bin, 'chrome-linux64/chrome'),
    ];
    exe = cands.find((p) => fs.existsSync(p)) || bin;
  }
  if (!fs.statSync(exe).isFile()) { console.error('no chrome binary at', exe); process.exit(1); }
  fs.chmodSync?.(exe, 0o755); // playwright downloads may lack +x on some setups
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fake-'));
  const proc = spawn(exe, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=0`,
    `--user-data-dir=${userDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome did not report devtools port')), 15000);
    proc.stderr.on('data', (d) => {
      const m = String(d).match(/DevTools listening on ws:\/\/(.+):(\d+)\/(.*)/);
      if (m) { clearTimeout(timer); resolve(Number(m[2])); }
    });
    proc.stderr.on('data', () => {});
    proc.stdout.on('data', () => {});
  });
  log('chromium up, cdp port', port, `(${path.basename(exe)})`);
  return { proc, port };
}

// 2) attach raw CDP to the browser endpoint, auto-attach to the initial page
async function attachBrowser(port) {
  const ver = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
  const wsUrl = new URL(ver.webSocketDebuggerUrl);
  wsUrl.hostname = '127.0.0.1'; wsUrl.port = String(port);
  const ws = new WebSocket(wsUrl.toString());
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let corr = 1;
  const pending = new Map();
  const handlers = []; // (msg) => void
  ws.on('message', (d) => {
    const msg = JSON.parse(String(d));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else {
      for (const h of handlers) h(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = corr++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const on = (fn) => handlers.push(fn);
  return { ws, send, on, close: () => ws.close() };
}

// ---------- bridge to the relay ----------

const { proc, port } = await launch();
const browser = await attachBrowser(port);

// find the page target
const { targetInfos } = await browser.send('Target.getTargets');
const page = targetInfos.find((t) => t.type === 'page');
const targetId = page.targetId; // MUST be the real page targetId: Playwright uses it as the main frame id
log('page target', targetId);

// attach flat to the page
let pageSession = null;
const attachedPromise = new Promise((resolve) => {
  const h = (msg) => {
    if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.targetId === targetId && !pageSession) {
      pageSession = msg.params.sessionId;
      resolve(pageSession);
    }
  };
  browser.on(h);
});
await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
pageSession = await attachedPromise;
log('page session', pageSession);

// report scope + target to relay
function reportScope() {
  extSend({ t: 'scope', mode: SCOPE_MODE, allowlist: [] });
}
function reportAttached() {
  extSend({ t: 'attached', tabId: 1, targetId, url: START_URL, title: '' });
}

let ws;
const extSend = (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

const pending = new Map();
let corr = 1;

function connect() {
  const qs = TOKEN ? `token=${encodeURIComponent(TOKEN)}&v=1` : 'v=1';
  ws = new WebSocket(`${RELAY}/extension?${qs}`);
  ws.on('open', () => {
    log('connected to relay');
    reportScope();
    reportAttached();
    const hb = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 20000);
    ws.on('close', () => clearInterval(hb));
  });
  ws.on('message', (d) => {
    const raw = String(d);
    if (raw === 'ping') return ws.send('pong');
    if (raw === 'pong') return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'hello') return;
    if (msg.t === 'cdp') {
      handleCdp(msg).catch((e) => {
        log('cdp error', msg.method, String(e));
        extSend({ t: 'cdpResult', id: msg.id, ok: false, error: String(e && e.message || e) });
      });
    }
  });
  ws.on('close', () => { log('relay disconnected; retry in 2s'); setTimeout(connect, 2000); });
  ws.on('error', (e) => { log('ws error', e.message); });
}

async function handleCdp(msg) {
  const { id, method, params } = msg;
  if (method === 'Target.createTarget') {
    const r = await browser.send('Target.createTarget', params);
    // M0 fake: only one page target reported; treat new target as replacement
    return extSend({ t: 'cdpResult', id, ok: true, result: r });
  }
  if (method === 'Page.navigate') {
    const r = await browser.send('Page.navigate', params, pageSession);
    extSend({ t: 'targetInfoChanged', targetId, url: params.url });
    return extSend({ t: 'cdpResult', id, ok: true, result: r });
  }
  if (method === 'Target.closeTarget') {
    return extSend({ t: 'cdpResult', id, ok: true, result: { success: true } });
  }
  // generic: forward to the page session
  const r = await browser.send(method, params, pageSession);
  extSend({ t: 'cdpResult', id, ok: true, result: r });
  // forward interesting events back
}

// pump all page-session events to the relay
browser.on((msg) => {
  if (msg.method && msg.sessionId === pageSession) {
    extSend({ t: 'cdpEvent', targetId, method: msg.method, params: msg.params });
  }
});

connect();

// open the start URL on the page so there's real content
await browser.send('Page.enable', {}, pageSession);
await browser.send('Page.navigate', { url: START_URL }, pageSession).catch((e) => log('initial nav', e.message));
log('ready — target', targetId, '→', START_URL);

process.on('SIGINT', () => { try { browser.close(); proc.kill(); } catch {} process.exit(0); });
