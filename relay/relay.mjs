#!/usr/bin/env node
// tailbrowser M0 relay
// - /extension   : the Chrome extension connects here (JSON envelope protocol)
// - /cdp/:sess   : Playwright/CDP clients connect here (raw CDP wire protocol)
// - /session     : HTTP session management (implicit in M0)
// - /health /scope /json/version : HTTP helpers
//
// The relay synthesizes the browser-level CDP surface that Playwright's
// connectOverCDP expects (Target.setDiscoverTargets / setAutoAttach flows)
// and multiplexes flat per-page sessions onto the extension pipe.

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const PORT = Number(flag('port', 8787));
const TOKEN = flag('token', process.env.TAILBROWSER_TOKEN || '');
const ALLOW = String(flag('allow', process.env.TAILBROWSER_ALLOW || ''));
const DEBUG = !!process.env.TB_DEBUG;

// ---- bind address: explicit --bind > autodetected tailscale IP > loopback ----
function detectTailscaleIP() {
  const cmds = [
    'tailscale ip -4',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4',
  ];
  for (const cmd of cmds) {
    try {
      const out = execSync(cmd, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split('\n')[0].trim();
      if (/^100\.(6[4-9]|[1-9]\d?|1[2-8]\d|12[0-7])\./.test(out) || /^100\.\d+\./.test(out)) return out;
    } catch {}
  }
  return null;
}

const BIND_FLAG = flag('bind', null);
let BIND = BIND_FLAG;
if (!BIND) {
  BIND = detectTailscaleIP() || '127.0.0.1';
  if (BIND_FLAG === null) {
    if (BIND !== '127.0.0.1') console.log('[relay] auto-detected tailscale IP:', BIND);
    else console.log('[relay] no tailscale IP found — binding loopback. Pass --bind <ip> or install the tailscale CLI.');
  }
}

if (TOKEN === true) { // --token given with no value
  console.error('relay: --token requires a value (or omit --token for tokenless tailnet-only mode)');
  process.exit(1);
}

// client IP allowlist: comma-separated exact IPs or CIDRs (e.g. 100.101.102.103,100.64.0.0/10)
// empty = allow any source (tailnet membership + token are the gate)
const allowList = ALLOW ? ALLOW.split(',').map((s) => s.trim()).filter(Boolean) : null;

function ipAllowed(ip) {
  if (!allowList) return true;
  const norm = (ip || '').replace(/^::ffff:/, '');
  return allowList.some((entry) => {
    if (entry.includes('/')) return cidrMatch(norm, entry);
    return norm === entry;
  });
}

function cidrMatch(ip, cidr) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [base, bits] = cidr.split('/');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
  const toLong = (s) => s.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
  const b = parseInt(bits, 10);
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return ((toLong(ip) & mask) >>> 0) === ((toLong(base) & mask) >>> 0);
}

if (!TOKEN) {
  console.log('[relay] tokenless mode: tailnet membership is the only gate (fine for a personal tailnet)');
}

const log = (...a) => console.log('[relay]', ...a);
const dlog = (...a) => DEBUG && console.log('[debug]', ...a);

// ---------- state ----------

const sessions = new Map(); // id -> { id, created, lastUsed, state: {} }
let nextSessionId = 1;

// extension connection (single device in M0)
let ext = null; // { ws, targets: Map<targetId, {targetId, tabId, url, title}>, scope: {mode, allowlist} }

// CDP client connections
const cdpConns = new Set(); // { ws, pending: Map<corrId,{conn,id}>, sessionMap, targetSessions, autoAttach, nextSess }

function extSend(msg) {
  if (ext && ext.ws.readyState === WebSocket.OPEN) ext.ws.send(JSON.stringify(msg));
}

let extCorr = 1;
function extCommand(targetId, method, params, meta) {
  if (!ext || ext.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('TB_ERR: extension not connected'));
  }
  return new Promise((resolve, reject) => {
    const id = extCorr++;
    const timer = setTimeout(() => {
      meta.pending.delete(id);
      reject(new Error('TB_TIMEOUT: extension did not answer ' + method));
    }, 30000);
    meta.pending.set(id, { resolve, reject, timer });
    extSend({ t: 'cdp', id, targetId, method, params });
  });
}

// ---------- snippet sandbox (M1) ----------

let sharedBrowser = null; // one Playwright connection for all sessions; tabs shared, state isolated

async function getBrowser() {
  if (!sharedBrowser) {
    const selfHost = BIND === '0.0.0.0' ? '127.0.0.1' : BIND;
    sharedBrowser = await chromium.connectOverCDP(`ws://${selfHost}:${PORT}/cdp/sandbox`);
  }
  return sharedBrowser;
}

function fmtVal(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

async function executeSnippet(sessionId, code) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { id: sessionId, created: Date.now(), lastUsed: Date.now(), state: {} });
  }
  const session = sessions.get(sessionId);
  session.lastUsed = Date.now();

  const logs = [];
  const push = (...a) => logs.push(a.map(fmtVal).join(' '));

  const b = await getBrowser();
  const ctx = b.contexts()[0];
  if (!ctx) throw new Error('TB_ERR: no browser context — attach a tab first (or use full-browser mode)');

  async function ariaSnapshot(p) {
    try { return await p.locator('body').ariaSnapshot(); } catch {}
    try { return JSON.stringify(await p.accessibility.snapshot(), null, 1); } catch { return null; }
  }

  const scope = {
    console: { log: push, info: push, warn: push, error: push, debug: push },
    state: session.state,
    context: ctx,
    pages: () => ctx.pages(),
    snapshot: async (arg) => {
      const p = arg?.page || arg || scope.page;
      return ariaSnapshot(p);
    },
    screenshot: async (arg) => {
      const p = arg?.page || arg || scope.page;
      return (await p.screenshot({ type: 'png' })).toString('base64');
    },
    newPage: () => ctx.newPage(), // throws TB_SCOPE via relay unless full-browser mode
  };
  Object.defineProperty(scope, 'page', {
    get() { return session.state.__page || ctx.pages()[0]; },
    set(v) { session.state.__page = v; },
    configurable: true,
  });

  const logsRef = logs;
  const importMeta = { url: `data:tailbrowser-snippet,` };
  const asyncFn = vm.runInNewContext(`(async (require, import_) => {\n${code}\n})`, scope, { timeout: 10000 });
  try {
    const result = await Promise.race([
      asyncFn(makeRequire(), (spec) => import(spec)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TB_TIMEOUT: snippet exceeded 120s')), 120_000)),
    ]);
    return { result, logs: logsRef };
  } catch (e) {
    e.logs = logsRef;
    throw e;
  }
}

// minimal require for the sandbox: node builtins + project node_modules relative to the relay
import { createRequire } from 'node:module';
const makeRequire = () => createRequire(new URL('../package.json', import.meta.url));

function safeJson(v) {
  try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch { return String(v); }
}

// ---------- synthetic browser CDP ----------

const BROWSER_TARGET_ID = 'tb-browser';
const DEFAULT_CONTEXT_ID = 'tb-default-browser-context';

function targetInfo(t, attached = false) {
  return {
    targetId: t.targetId,
    type: 'page',
    title: t.title || '',
    url: t.url || '',
    attached,
    browserContextId: DEFAULT_CONTEXT_ID, // Playwright asserts this is present
  };
}

function cdpSend(conn, obj) {
  if (conn.ws.readyState === WebSocket.OPEN) {
    dlog('cdp ►', JSON.stringify(obj).slice(0, 300));
    conn.ws.send(JSON.stringify(obj));
  }
}

function emitTargetCreated(conn, t) {
  cdpSend(conn, { method: 'Target.targetCreated', params: { targetInfo: targetInfo(t) } });
}

function emitAttachedToTarget(conn, t) {
  // flat session: one sessionId per (conn, target)
  let sess = conn.targetSessions.get(t.targetId);
  if (!sess) {
    sess = 'tbS-' + conn.nextSess++;
    conn.sessionMap.set(sess, t.targetId);
    conn.targetSessions.set(t.targetId, sess);
  }
  cdpSend(conn, {
    method: 'Target.attachedToTarget',
    params: { sessionId: sess, targetInfo: targetInfo(t, true), waitingForDebugger: false },
  });
}

function emitDetachedFromTarget(conn, targetId) {
  const sess = conn.targetSessions.get(targetId);
  if (!sess) return;
  conn.targetSessions.delete(targetId);
  conn.sessionMap.delete(sess);
  cdpSend(conn, { method: 'Target.detachedFromTarget', params: { sessionId: sess, targetId } });
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  if (!ipAllowed(req.socket.remoteAddress)) {
    log('rejected', req.socket.remoteAddress, '(not in --allow list)');
    return json(403, { error: 'source ip not allowed' });
  }

  if (url.pathname === '/health') {
    return json(200, { ok: true, extension: !!ext, targets: ext ? ext.targets.size : 0, sessions: sessions.size });
  }

  const auth = !TOKEN || (url.searchParams.get('token') === TOKEN) || (req.headers.authorization === 'Bearer ' + TOKEN);
  if (!auth) return json(401, { error: 'bad token' });

  if (url.pathname === '/json/version') {
    return json(200, {
      Browser: 'Chrome/131.0.0.0',
      'Protocol-Version': '1.3',
      'User-Agent': 'tailbrowser-relay',
      webSocketDebuggerUrl: `ws://${req.headers.host}/cdp/browser`,
    });
  }

  const readBody = () => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => b += c);
    req.on('end', () => resolve(b));
  });

  if (url.pathname === '/session' && req.method === 'POST') {
    const id = String(nextSessionId++);
    sessions.set(id, { id, created: Date.now(), lastUsed: Date.now(), state: {} });
    log('session created', id);
    return json(200, { sessionId: id });
  }

  if (url.pathname === '/session' && req.method === 'GET') {
    return json(200, [...sessions.values()].map(s => ({ id: s.id, created: s.created, stateKeys: Object.keys(s.state) })));
  }

  if (url.pathname === '/session/reset' && req.method === 'POST') {
    const body = JSON.parse((await readBody()) || '{}');
    const s = sessions.get(body.sessionId);
    if (!s) return json(404, { error: 'no such session' });
    s.state = {};
    log('session reset', s.id);
    return json(200, { ok: true });
  }

  if (url.pathname === '/execute' && req.method === 'POST') {
    const body = JSON.parse((await readBody()) || '{}');
    const id = body.sessionId || String(nextSessionId++);
    try {
      const { result, logs } = await executeSnippet(id, String(body.code || ''));
      return json(200, { sessionId: id, ok: true, result: safeJson(result), logs });
    } catch (e) {
      return json(200, { sessionId: id, ok: false, error: String((e && e.message) || e), logs: e.logs || [] });
    }
  }

  if (url.pathname === '/scope') {
    return json(200, ext ? { ...ext.scope, targets: [...ext.targets.values()] } : { connected: false });
  }

  res.writeHead(404); res.end('not found');
});

// ---------- WebSocket servers ----------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (!ipAllowed(req.socket.remoteAddress)) {
    log('rejected ws', req.socket.remoteAddress, '(not in --allow list)');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (TOKEN) {
    const token = url.searchParams.get('token');
    if (token !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/extension') return onExtensionWs(ws, url);
    const m = url.pathname.match(/^\/cdp\/([^/]+)$/);
    if (m) return onCdpWs(ws, decodeURIComponent(m[1]));
    ws.close(4404, 'not found');
  });
});

// ---------- extension pipe ----------

const EXT_PING_MS = 20_000;       // ping the extension pipe this often
const EXT_DEAD_AFTER_MS = Number(process.env.TB_TEST_EXT_DEAD_MS) || 75_000; // no traffic for this long => treat as dead

function onExtensionWs(ws) {
  if (ext) {
    // replace the old one (device restarted chrome etc.)
    try { ext.ws.close(4009, 'replaced'); } catch {}
  }
  ext = { ws, targets: new Map(), scope: { mode: 'unknown' }, pending: new Map(), lastSeen: Date.now() };
  const extPing = setInterval(() => {
    if (!ext || ext.ws !== ws) return clearInterval(extPing);
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(extPing);
    if (Date.now() - ext.lastSeen > EXT_DEAD_AFTER_MS) {
      // half-open socket (extension machine slept, network dropped): kill it
      // so CDP clients fail fast instead of stalling on a dead pipe
      log('extension silent > 75s — terminating half-open connection');
      try { ws.terminate(); } catch {}
      return clearInterval(extPing);
    }
    try { ws.ping(); } catch {}
  }, EXT_PING_MS);
  log('extension connected');
  ws.on('message', (data) => {
    const raw = String(data);
    ext.lastSeen = Date.now();
    if (raw === 'ping') return ws.send('pong');
    if (raw === 'pong') return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    dlog('ext ◄', JSON.stringify(msg).slice(0, 300));
    switch (msg.t) {
      case 'scope':
        ext.scope = { mode: msg.mode, allowlist: msg.allowlist || [] };
        log('scope', JSON.stringify(ext.scope));
        return;
      case 'attached': {
        const t = { targetId: msg.targetId, tabId: msg.tabId, url: msg.url, title: msg.title };
        ext.targets.set(t.targetId, t);
        log('target attached', t.targetId, t.url);
        for (const conn of cdpConns) {
          emitTargetCreated(conn, t);
          if (conn.autoAttach) emitAttachedToTarget(conn, t);
        }
        return;
      }
      case 'targetInfoChanged': {
        const t = ext.targets.get(msg.targetId);
        if (t) { t.url = msg.url; }
        for (const conn of cdpConns) cdpSend(conn, { method: 'Target.targetInfoChanged', params: { targetInfo: targetInfo(t) } });
        return;
      }
      case 'detached': {
        ext.targets.delete(msg.targetId);
        log('target detached', msg.targetId, `(${msg.reason})`);
        for (const conn of cdpConns) emitDetachedFromTarget(conn, msg.targetId);
        return;
      }
      case 'cdpResult': {
        const p = ext.pending.get(msg.id);
        if (!p) return;
        ext.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'extension error'));
        return;
      }
      case 'cdpEvent': {
        // forward to every CDP conn that has a session for this target
        for (const conn of cdpConns) {
          const sess = conn.targetSessions.get(msg.targetId);
          if (sess) cdpSend(conn, { method: msg.method, params: msg.params, sessionId: sess });
        }
        return;
      }
    }
  });
  ws.on('pong', () => { if (ext && ext.ws === ws) ext.lastSeen = Date.now(); });
  ws.on('close', () => {
    if (ext && ext.ws === ws) {
      // fail pending extension commands immediately — don't make agents wait 30s
      for (const [, p] of ext.pending) { clearTimeout(p.timer); p.reject(new Error('TB_ERR: extension disconnected')); }
      ext.pending.clear();
      ext = null;
      log('extension disconnected');
      for (const conn of cdpConns) for (const [tid] of conn.targetSessions) emitDetachedFromTarget(conn, tid);
    }
  });
  ws.on('error', () => {});
  ws.send(JSON.stringify({ t: 'hello' }));
}

// ---------- CDP client pipe (Playwright side) ----------

async function onCdpWs(ws, sessionId) {
  const conn = {
    ws,
    sessionId,
    pending: new Map(),
    sessionMap: new Map(), // cdp sessionId -> targetId
    targetSessions: new Map(), // targetId -> cdp sessionId
    autoAttach: false,
    nextSess: 1,
  };
  cdpConns.add(conn);
  log('cdp client connected', `session=${sessionId}`);
  if (!sessions.has(sessionId)) sessions.set(sessionId, { id: sessionId, created: Date.now(), lastUsed: Date.now(), state: {} });

  const reply = (id, result, sessionId) => cdpSend(conn, sessionId ? { id, result, sessionId } : { id, result });
  const fail = (id, error, sessionId) => cdpSend(conn, sessionId ? { id, error: { code: -32000, message: error }, sessionId } : { id, error: { code: -32000, message: error } });

  ws.on('message', async (data) => {
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    dlog('cdp ◄', JSON.stringify(msg).slice(0, 300));
    const { id, method, params = {} } = msg;
    const cdpSessionId = msg.sessionId; // flat protocol
    try {
      // --- browser-session commands (no sessionId) ---
      if (!cdpSessionId) {
        switch (method) {
          case 'Target.setDiscoverTargets':
            reply(id, {});
            // push current world state
            cdpSend(conn, { method: 'Target.targetCreated', params: { targetInfo: { targetId: BROWSER_TARGET_ID, type: 'browser', title: '', url: '', attached: true } } });
            if (ext) for (const t of ext.targets.values()) emitTargetCreated(conn, t);
            return;
          case 'Target.setAutoAttach':
            conn.autoAttach = true;
            reply(id, {});
            if (ext) for (const t of ext.targets.values()) emitAttachedToTarget(conn, t);
            return;
          case 'Target.getBrowserContexts':
            reply(id, { browserContextIds: [DEFAULT_CONTEXT_ID] });
            return;
          case 'Target.getTargets':
            reply(id, { targetInfos: ext ? [...ext.targets.values()].map(t => targetInfo(t)) : [] });
            return;
          case 'Target.attachToTarget': {
            const t = ext && ext.targets.get(params.targetId);
            if (!t) return fail(id, 'TB_SCOPE: unknown or unpermitted target');
            reply(id, {}); // placeholder replaced below
            // emit flat attach via synthetic flow
            emitAttachedToTarget(conn, t);
            // NOTE: real CDP returns {sessionId} in the response; we emulate via event
            return;
          }
          case 'Target.createTarget': {
            if (!ext) return fail(id, 'TB_ERR: extension not connected');
            if (ext.scope.mode !== 'full') return fail(id, 'TB_SCOPE: creating tabs requires full-browser mode');
            const r = await extCommand(null, 'Target.createTarget', params, ext);
            reply(id, r);
            return;
          }
          case 'Target.closeTarget': {
            if (ext.scope.mode !== 'full') return fail(id, 'TB_SCOPE: closing tabs requires full-browser mode');
            extSend({ t: 'closeTab', targetId: params.targetId });
            reply(id, { success: true });
            return;
          }
          case 'Target.getTargetInfo': {
            const t = ext && ext.targets.get(params.targetId);
            if (t) return reply(id, targetInfo(t, true));
            if (!params.targetId) return reply(id, { targetId: BROWSER_TARGET_ID, type: 'browser', title: '', url: '', attached: true });
            return fail(id, 'TB_SCOPE: unknown or unpermitted target');
          }
          case 'Browser.getVersion':
            reply(id, { protocolVersion: '1.3', product: 'Chrome/131.0.0.0', userAgent: 'tailbrowser', jsVersion: '131' });
            return;
          default:
            // Permissive for browser-session extras Playwright sends during init
            // (Browser.setDownloadBehavior, Target.setRemoteLocations, ...).
            // Anything requiring real semantics is handled explicitly above.
            dlog('browser-session ok-fallback', method);
            reply(id, {});
            return;
        }
      }

      // --- page-session commands (flat sessionId) ---
      const targetId = conn.sessionMap.get(cdpSessionId);
      if (!targetId) return fail(id, 'TB_ERR: unknown sessionId ' + cdpSessionId);

      if (method === 'Runtime.runIfWaitingForDebugger') {
        // our targets are never paused; avoid deadlock
        return reply(id, {}, cdpSessionId);
      }
      if (method === 'Target.setAutoAttach') {
        // swallow page-level auto-attach (OOPIF) in M0: main-frame ops work
        return reply(id, {}, cdpSessionId);
      }

      if (!ext) return fail(id, 'TB_ERR: extension not connected', cdpSessionId);
      const result = await extCommand(targetId, method, params, ext);
      reply(id, result ?? {}, cdpSessionId);
    } catch (e) {
      fail(id, String(e && e.message || e), cdpSessionId);
    }
  });

  ws.on('close', () => {
    cdpConns.delete(conn);
    log('cdp client disconnected', `session=${sessionId}`);
  });
  ws.on('error', () => {});
}

// session idle sweep
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (now - s.lastUsed > 30 * 60_000) sessions.delete(s.id);
}, 60_000);

server.listen(PORT, BIND, () => {
  const selfHost = BIND === '0.0.0.0' ? '<this-machine-ip>' : BIND;
  console.log('');
  console.log('  ┌────────────────────────────────────────────────────┐');
  console.log('  │  tailbrowser relay is up                            │');
  console.log('  ├────────────────────────────────────────────────────┤');
  console.log(`  │  listening      ws://${BIND}:${PORT}`.padEnd(55) + '│');
  console.log(`  │  auth            ${TOKEN ? 'token (pass --token to agents)' : 'tokenless — tailnet membership is the gate'}`.padEnd(55) + '│');
  console.log(`  │  mode            ${allowList ? 'allowlist ' + allowList.join(',') : 'any tailnet device'}`.padEnd(55) + '│');
  console.log('  ├────────────────────────────────────────────────────┤');
  console.log('  │  Extension popup (on the Chrome device):           │');
  console.log(`  │    Relay:  ws://${selfHost}:${PORT}`.padEnd(55) + '│');
  console.log(`  │    Token:  ${TOKEN ? TOKEN.slice(0, 4) + '…' + TOKEN.slice(-4) : '(leave blank)'}`.padEnd(55) + '│');
  console.log('  ├────────────────────────────────────────────────────┤');
  console.log('  │  Agents (on any tailnet machine):                  │');
  console.log(`  │    export TAILBROWSER_HOST=ws://${selfHost}:${PORT}`.padEnd(55) + '│');
  console.log(`  │    ${TOKEN ? `export TAILBROWSER_TOKEN=${TOKEN.slice(0, 4)}…` : '# no token needed'}`.padEnd(55) + '│');
  console.log('  │    node tailbrowser.mjs -s 1 -e "await page.goto(…)" │');
  console.log('  └────────────────────────────────────────────────────┘');
  console.log('');
});
