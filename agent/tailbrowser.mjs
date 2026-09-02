#!/usr/bin/env node
// tailbrowser CLI (M1)
// Usage:
//   tailbrowser relay [...]          start the relay server (prints config)
//   tailbrowser discover            find a relay on the tailnet (or use TAILBROWSER_HOST)
//   tailbrowser session new|list|reset <id>
//   tailbrowser -s <id> -e 'await page.goto("...")'
//   tailbrowser scope|health

import fs from 'node:fs';
import path from 'node:path';
import { resolveHost, discover, configPath } from './discover.mjs';

let HOST = null;
const TOKEN = process.env.TAILBROWSER_TOKEN || '';

const qs = () => (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

async function api(path, opts = {}) {
  const httpBase = HOST.replace(/^ws/, 'http');
  const res = await fetch(`${httpBase}${path}${path.includes('?') ? '&' : '?'}${qs().slice(1)}`, {
    ...opts,
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function execute(sessionId, code) {
  const body = { code };
  if (sessionId) body.sessionId = sessionId;
  const r = await api('/execute', { method: 'POST', body: JSON.stringify(body) });
  for (const l of r.logs || []) console.log('  |', l);
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    process.exit(1);
  }
  if (r.result !== null && r.result !== undefined) console.log(JSON.stringify(r.result, null, 2));
  return r;
}

const args = process.argv.slice(2);

// -e / --code
const eIdx = args.indexOf('-e') !== -1 ? args.indexOf('-e') : args.indexOf('--code');
const sIdx = args.indexOf('-s') !== -1 ? args.indexOf('-s') : args.indexOf('--session');

if (args[0] === 'relay') {
  // start the relay in-process; remaining flags pass through (--port, --bind, --token)
  process.argv = [process.argv[0], 'relay', ...args.slice(1)];
  await import('../relay/relay.mjs');
} else if (args.includes('--mcp')) {
  await import('./tailbrowser.mcp.mjs');
} else if (args[0] === 'discover') {
  if (process.env.TAILBROWSER_HOST) {
    console.log(`TAILBROWSER_HOST is set → ${process.env.TAILBROWSER_HOST} (env overrides discovery)`);
  } else {
    const found = await discover({ log: console.error });
    if (found) console.log(`found + cached: ${found} → ${configPath()}`);
    else { console.error('no relay found — start one with: tailbrowser relay'); process.exit(1); }
  }
} else {
  // every other command talks to a relay: resolve first (env → cache → scan)
  const { host, source } = await resolveHost({ log: console.error });
  HOST = host;
  if (source !== 'env') console.error(`→ relay ${host} (${source})`);
  if (eIdx !== -1) {
    const code = args[eIdx + 1];
    let sessionId = sIdx !== -1 ? args[sIdx + 1] : null;
    // sticky default session: no -s → reuse (or lazily create) this machine's default
    const wantNew = args.includes('--new');
    if (!sessionId) {
      const cfg = loadConfig();
      if (wantNew || !cfg.defaultSession) {
        const r = await api('/session', { method: 'POST' });
        sessionId = r.sessionId;
        saveConfig({ ...cfg, defaultSession: sessionId });
        console.error(`→ session ${sessionId} (new default, saved)`);
      } else {
        sessionId = cfg.defaultSession;
      }
    }
    if (!code) { console.error('usage: tailbrowser -s <id> -e <code>'); process.exit(1); }
    await execute(sessionId, code);
  } else if (args[0] === 'session') {
    if (args[1] === 'new') {
      const r = await api('/session', { method: 'POST' });
      console.log(r.sessionId);
    } else if (args[1] === 'list') {
      const r = await api('/session');
      for (const s of r) console.log(`#${s.id}  state: ${s.stateKeys.join(', ') || '-'}`);
    } else if (args[1] === 'reset') {
      if (!args[2]) { console.error('usage: tailbrowser session reset <id>'); process.exit(1); }
      await api('/session/reset', { method: 'POST', body: JSON.stringify({ sessionId: args[2] }) });
      console.log('reset');
    } else {
      console.error('usage: tailbrowser session new|list|reset <id>'); process.exit(1);
    }
  } else if (args[0] === 'scope') {
    console.log(JSON.stringify(await api('/scope'), null, 2));
  } else if (args[0] === 'health') {
    console.log(JSON.stringify(await api('/health'), null, 2));
  } else {
    console.log(`tailbrowser — let agents control a tailnet Chrome
relay discovery: TAILBROWSER_HOST env → ~/.tailbrowser/config.json → scan tailnet (tailscale status)
usage:
  tailbrowser relay [--port 8787] [--bind ip] [--token x]   start the relay server on this machine
  tailbrowser discover             find + cache a relay on the tailnet
  tailbrowser session new          create a session (prints id)
  tailbrowser -s 1 -e 'code'       run a JS snippet (full Playwright in scope)
  tailbrowser session list         list sessions
  tailbrowser session reset <id>   clear a session's state
  tailbrowser scope                show scope + attached targets
  tailbrowser health

snippet scope: page, context, state (persists per session), pages(), snapshot(), screenshot(), newPage()
env: TAILBROWSER_HOST (override discovery), TAILBROWSER_TOKEN (optional), TAILBROWSER_PORT (scan port, default 8787)`);
  }
}
