#!/usr/bin/env node
// tailbrowser relay, hardened for long-running unattended use.
//   /extension          the Chrome extension connects here (JSON envelopes)   → extension-link.mjs
//   /cdp/:label         Playwright/CDP clients connect here (raw CDP)          → cdp-bridge.mjs
//   /session /execute   HTTP session + snippet management                      → http-api.mjs, sandbox.mjs
//   /health /scope /json/version
//
// Stability rules:
//   1. No request, socket message, or snippet can kill the process; every
//      entry point is fault-isolated (bad JSON -> 400, bad envelope -> drop).
//   2. The relay is the long-lived piece; browsers/extensions flap, it must not.
//   3. Fail fast + loudly: agents get typed TB_ERR/TB_TIMEOUT errors, the log
//      gets timestamps so "why was it down" is answerable from nohup output.

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { errorMessage } from '../lib/errors.mjs';
import { loadRelayConfig, selfHost } from './config.mjs';
import { createAuth } from './auth.mjs';
import { log } from './log.mjs';
import { ExtensionLink } from './extension-link.mjs';
import { CdpBridge } from './cdp-bridge.mjs';
import { SessionStore, SnippetRunner } from './sandbox.mjs';
import { createHttpHandler } from './http-api.mjs';

let config;
try {
  config = loadRelayConfig(process.argv.slice(2));
} catch (e) {
  console.error(`relay: ${e.message}`);
  process.exit(1);
}
const { port, bind, token, allowList } = config;

if (config.bindSource === 'tailscale') console.log('[relay] auto-detected tailscale IP:', bind);
if (config.bindSource === 'loopback') console.log('[relay] no tailscale IP found, binding loopback. Pass --bind <ip> or install the tailscale CLI.');
if (!token) console.log('[relay] tokenless mode: tailnet membership is the only gate (fine for a personal tailnet)');
if (config.bindSource === 'flag' && exposedBeyondTailnet(bind) && !token && !allowList.some((e) => !e.endsWith('/0'))) {
  console.log(`[relay] WARNING: bound to ${bind} with no --token and no --allow; devices outside your tailnet may be able to connect`);
}

// Does this bind address accept connections from beyond loopback and the
// tailnet? Hostnames can't be classified without resolving them: no warning.
function exposedBeyondTailnet(address) {
  const a = address.toLowerCase();
  if (a === '0.0.0.0' || a === '::') return true; // all interfaces
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return !/^(127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a); // loopback, tailnet CGNAT
  if (a.includes(':')) return !(a === '::1' || a.startsWith('fd7a:115c:a1e0:')); // loopback, tailnet IPv6
  return false;
}

// ---------- process-level safety net ----------
// The relay is a daemon: a surprise exception must never take it down. Log
// loudly and keep serving; there is no corruptible state a restart would fix.
process.on('uncaughtException', (e) => log('UNCAUGHT (survived):', e?.stack || e));
process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION (survived):', e?.stack || e));

// Event-loop stall watchdog: a synchronous infinite loop inside a snippet
// freezes the whole relay (vm timeouts cannot guard async code). We can't stop
// it from inside, but we leave a breadcrumb so "relay hangs" is diagnosable.
let lastTick = Date.now();
setInterval(() => {
  const drift = Date.now() - lastTick;
  if (drift > 5000) log(`EVENT LOOP STALLED ${Math.round(drift / 1000)}s: a synchronous snippet is likely blocking the relay`);
  lastTick = Date.now();
}, 1000).unref();

// ---------- wiring ----------

const auth = createAuth({ token, allowList });
const extension = new ExtensionLink({ deadAfterMs: config.extensionDeadAfterMs });
const cdpBridge = new CdpBridge({ extension });
const sessions = new SessionStore();
const runner = new SnippetRunner({
  cdpUrl: `ws://${selfHost(bind)}:${port}/cdp/sandbox?internal=${auth.internalKey}`,
  extension,
});

const server = http.createServer(createHttpHandler({ auth, sessions, runner, extension }));
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const reject = (status) => { socket.write(`HTTP/1.1 ${status}\r\n\r\n`); socket.destroy(); };
  try {
    const url = new URL(req.url, 'http://relay');
    if (!auth.isInternal(url)) {
      if (!auth.ipAllowed(req)) {
        log('rejected ws', req.socket.remoteAddress, '(not in --allow list)');
        return reject('403 Forbidden');
      }
      if (!auth.tokenOk(req, url)) return reject('401 Unauthorized');
    }
    const cdpMatch = url.pathname.match(/^\/cdp\/([^/]+)$/);
    if (url.pathname !== '/extension' && !cdpMatch) return reject('404 Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (cdpMatch) cdpBridge.accept(ws, decodeURIComponent(cdpMatch[1]));
      else extension.accept(ws);
    });
  } catch (e) {
    log('upgrade error', errorMessage(e));
    try { socket.destroy(); } catch {}
  }
});

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    console.error(`\n  ✗ port ${port} is already in use on ${bind}.\n`);
    console.error(`    A relay is probably already running. Health-check it:  curl http://${selfHost(bind)}:${port}/health`);
    console.error(`    If it should be dead:  lsof -ti :${port} | xargs kill\n`);
    process.exit(1);
  }
  log('server error', errorMessage(e));
});

server.listen(port, bind, printBanner);

function printBanner() {
  const host = bind === '0.0.0.0' ? '<this-machine-ip>' : bind;
  const shortToken = token && `${token.slice(0, 4)}…${token.slice(-4)}`;
  const rule = (l, r) => `  ${l}${'─'.repeat(52)}${r}`;
  const row = (text) => `  │  ${text}`.padEnd(55) + '│';
  console.log([
    '',
    rule('┌', '┐'),
    row('tailbrowser relay is up'),
    rule('├', '┤'),
    row(`listening      ws://${bind}:${port}`),
    row(`auth           ${token ? 'token (pass --token to agents)' : 'tokenless (tailnet membership is the gate)'}`),
    row(`sources        ${allowList.length ? `allowlist ${allowList.join(',')}` : 'any tailnet device'}`),
    rule('├', '┤'),
    row('Extension popup (on the Chrome device):'),
    row(`  Relay:  ws://${host}:${port}`),
    row(`  Token:  ${shortToken || '(leave blank)'}`),
    rule('├', '┤'),
    row('Agents (on any tailnet machine):'),
    row(`  export TAILBROWSER_HOST=ws://${host}:${port}`),
    row(token ? `  export TAILBROWSER_TOKEN=${token.slice(0, 4)}…` : '  # no token needed'),
    row('  tailbrowser -e "await page.goto(…)"'),
    rule('└', '┘'),
    '',
  ].join('\n'));
}
