#!/usr/bin/env node
// fake-extension.mjs — simulates the real extension for local testing.
// Talks the same /extension envelope protocol as extension/background.js,
// but instead of chrome.debugger it drives a REAL headless Chromium over CDP
// (launched with --remote-debugging-port). This validates the whole
// relay + Playwright chain on a server with no GUI Chrome.
//
// Usage: node fake-extension.mjs --relay ws://127.0.0.1:8787 [--token X] [--url https://example.com]
//                                [--scope full|tab] [--chrome /path/to/chrome]

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagReader } from '../lib/args.mjs';
import { errorMessage } from '../lib/errors.mjs';
import { findChromium } from '../lib/find-chromium.mjs';

const flag = flagReader(process.argv.slice(2));
const RELAY = flag('relay', 'ws://127.0.0.1:8787');
const TOKEN = flag('token', '');
const START_URL = flag('url', 'https://example.com');
const SCOPE_MODE = flag('scope', 'full');
const TAB_ID = 1; // the fake has no real tab ids; the relay only echoes them

const log = (...a) => console.log('[fake-ext]', ...a);

// ---------- launch headless chromium ----------

async function launchChromium() {
  const exe = findChromium({ explicit: flag('chrome', '') });
  if (!exe || !fs.statSync(exe).isFile()) {
    console.error(`no chromium found${exe ? ` at ${exe}` : ''}; install one or pass --chrome / CHROME_BIN`);
    process.exit(1);
  }
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fake-'));
  const proc = spawn(exe, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome did not report its devtools endpoint')), 15000);
    proc.stderr.on('data', (d) => {
      const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  log('chromium up', wsUrl, `(${path.basename(exe)})`);
  return { proc, wsUrl };
}

// minimal raw CDP client on the browser endpoint
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    const p = msg.id && pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else {
      for (const fn of listeners) fn(msg);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    onEvent(fn) { listeners.add(fn); },
    // first event matching `predicate`, or null after `ms`
    waitForEvent(predicate, ms) {
      return new Promise((resolve) => {
        const done = (value) => { clearTimeout(timer); listeners.delete(fn); resolve(value); };
        const fn = (msg) => { if (predicate(msg)) done(msg); };
        const timer = setTimeout(() => done(null), ms);
        listeners.add(fn);
      });
    },
    close: () => ws.close(),
  };
}

// ---------- browser setup ----------

const { proc, wsUrl } = await launchChromium();
const browser = await connectCdp(wsUrl);

const { targetInfos } = await browser.send('Target.getTargets');
const initialTargetId = targetInfos.find((t) => t.type === 'page').targetId; // real id: Playwright uses it as the main frame id

const isPageAttach = (msg) => msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'page';
const initialAttach = browser.waitForEvent((m) => isPageAttach(m) && m.params.targetInfo.targetId === initialTargetId, 10000);
await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const initialSession = (await initialAttach).params.sessionId;
log('page target', initialTargetId, 'session', initialSession);

// every target we advertise to the relay: targetId -> { sessionId, url }
const targets = new Map([[initialTargetId, { sessionId: initialSession, url: START_URL }]]);

// pump page-session events back to the relay
browser.onEvent((msg) => {
  if (!msg.method || !msg.sessionId) return;
  for (const [targetId, t] of targets) {
    if (t.sessionId === msg.sessionId) relaySend({ t: 'cdpEvent', targetId, method: msg.method, params: msg.params });
  }
});

// ---------- bridge to the relay ----------

let relay;
const relaySend = (msg) => { if (relay?.readyState === WebSocket.OPEN) relay.send(JSON.stringify(msg)); };
const advertise = (targetId, url) => relaySend({ t: 'attached', tabId: TAB_ID, targetId, url, title: '' });

function connectRelay() {
  const query = TOKEN ? `token=${encodeURIComponent(TOKEN)}&v=1` : 'v=1';
  const ws = new WebSocket(`${RELAY}/extension?${query}`);
  relay = ws;
  let heartbeat;
  ws.on('open', () => {
    log('connected to relay');
    relaySend({ t: 'scope', mode: SCOPE_MODE, allowlist: [] });
    // re-advertise all known targets (post-reconnect, like the real extension)
    for (const [targetId, t] of targets) advertise(targetId, t.url);
    heartbeat = setInterval(() => ws.send('ping'), 20000);
  });
  ws.on('message', (data) => {
    const raw = String(data);
    if (raw === 'ping') return ws.send('pong');
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t !== 'cdp' && msg.t !== 'closeTab') return;
    handleRequest(msg)
      .then((result) => relaySend({ t: 'cdpResult', id: msg.id, ok: true, result }))
      .catch((e) => {
        log('request error', msg.method || msg.t, errorMessage(e));
        relaySend({ t: 'cdpResult', id: msg.id, ok: false, error: errorMessage(e) });
      });
  });
  ws.on('close', () => {
    clearInterval(heartbeat);
    log('relay disconnected; retry in 2s');
    setTimeout(connectRelay, 2000);
  });
  ws.on('error', (e) => log('ws error', e.message));
}

function sessionFor(targetId) {
  const t = targets.get(targetId);
  if (!t) throw new Error(`TB_SCOPE: unknown or unpermitted target ${targetId}`);
  return t.sessionId;
}

async function closeTab(targetId) {
  sessionFor(targetId);
  await browser.send('Target.closeTarget', { targetId });
  targets.delete(targetId);
  relaySend({ t: 'detached', tabId: TAB_ID, targetId, reason: 'closed' });
  return { success: true };
}

async function createTab(params) {
  // Mirror the real extension: create, attach, ADVERTISE, then answer with
  // the real CDP targetId. The attachedToTarget event can arrive BEFORE the
  // createTarget response — listen first or we miss it (classic CDP race).
  const url = params?.url || 'about:blank';
  const attachedEvent = browser.waitForEvent(isPageAttach, 8000);
  const { targetId } = await browser.send('Target.createTarget', { ...params, url });
  const ev = await attachedEvent;
  if (ev?.params.targetInfo.targetId === targetId) {
    const { sessionId } = ev.params;
    targets.set(targetId, { sessionId, url });
    advertise(targetId, url);
    await browser.send('Page.enable', {}, sessionId).catch(() => {});
    await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }
  return { targetId, newTab: true };
}

async function handleRequest(msg) {
  if (msg.t === 'closeTab') return closeTab(msg.targetId);
  const { targetId, method, params } = msg;
  if (method === 'Target.createTarget') return createTab(params);
  const result = await browser.send(method, params, sessionFor(targetId));
  if (method === 'Page.navigate') {
    targets.get(targetId).url = params.url;
    relaySend({ t: 'targetInfoChanged', targetId, url: params.url });
  }
  return result;
}

connectRelay();

// open the start URL so there's real content
await browser.send('Page.enable', {}, initialSession);
await browser.send('Page.navigate', { url: START_URL }, initialSession).catch((e) => log('initial nav', e.message));
log('ready — target', initialTargetId, '→', START_URL);

const shutdown = () => { try { browser.close(); proc.kill(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
