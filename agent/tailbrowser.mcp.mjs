#!/usr/bin/env node
// tailbrowser MCP server (M1) — stdio, single `execute` tool with sticky session.
// Config: TAILBROWSER_HOST (default ws://127.0.0.1:8787), TAILBROWSER_TOKEN (optional)
// Register (Claude Code / Cursor):
//   { "mcpServers": { "tailbrowser": { "command": "node", "args": ["/path/to/agent/tailbrowser.mcp.mjs"] } } }

import readline from 'node:readline';
import { resolveHost } from './discover.mjs';

let HOST = null;
const TOKEN = process.env.TAILBROWSER_TOKEN || '';
const httpBase = () => HOST.replace(/^ws/, 'http');

const TOOL = {
  name: 'execute',
  description: `Run a JavaScript snippet in a stateful Playwright session against the user's REAL Chrome (on their tailnet, via tailbrowser relay). Full Playwright Page API.
In scope: page (current Page), context, state (object persisted across calls within a session), pages() (all agent-visible tabs), snapshot({page}) (YAML aria snapshot), screenshot({page}) (base64 png), newPage().
Examples:
  await page.goto('https://example.com')
  console.log(await page.title())
  state.links = await page.$$eval('a', as => as.map(a => a.href))
  const p2 = await newPage(); await p2.goto('...'); state.p2 = p2
  const snap = await snapshot({ page })
Rules: NEVER call browser.close() (it would close the user's Chrome). Store anything you need later in state. Prefer snapshot() over screenshot() when reading content.`,
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JavaScript snippet (async, top-level await ok). Runs wrapped in (async () => { ... })()' },
      sessionId: { type: 'string', description: 'Sticky session id. Omit on first call or when starting a new task; reuse the returned sessionId for follow-ups to keep state.' },
    },
    required: ['code'],
  },
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function callExecute({ code, sessionId }) {
  if (!HOST) {
    const { host, source } = await resolveHost({ log: console.error });
    HOST = host;
    console.error(`[tailbrowser] relay ${host} (${source})`);
  }
  const body = { code };
  if (sessionId) body.sessionId = sessionId;
  const res = await fetch(`${httpBase()}/execute${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  (async () => {
    if (msg.method === 'initialize') {
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tailbrowser', version: '0.2.0' } } });
    }
    if (msg.method === 'notifications/initialized') return;
    if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'tools/list') {
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } });
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'execute') {
      try {
        const r = await callExecute(msg.params.arguments || {});
        const text = [
          ...(r.logs || []).map((l) => `[log] ${l}`),
          r.ok ? `[result] ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)}` : `[error] ${r.error}`,
          `[session] ${r.sessionId}`,
        ].join('\n');
        return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: !r.ok } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });
      }
    }
    if (msg.id) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
  })().catch((e) => {
    if (msg.id) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
  });
});
