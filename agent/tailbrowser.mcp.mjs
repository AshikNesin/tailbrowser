#!/usr/bin/env node
// tailbrowser MCP server: stdio JSON-RPC, single `execute` tool with sticky sessions.
// Config: TAILBROWSER_HOST (overrides discovery), TAILBROWSER_TOKEN (optional)
// Register (Claude Code / Cursor):
//   { "mcpServers": { "tailbrowser": { "command": "node", "args": ["/path/to/agent/tailbrowser.mcp.mjs"] } } }
// stdout carries the protocol; all diagnostics go to stderr.

import readline from 'node:readline';
import { createRequire } from 'node:module';
import { resolveHost } from './discover.mjs';
import { createClient } from './client.mjs';

const { version } = createRequire(import.meta.url)('../package.json');
const PROTOCOL_VERSION = '2024-11-05';

const EXECUTE_TOOL = {
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

let client = null;

async function getClient() {
  if (!client) {
    const { host, source } = await resolveHost({ log: console.error });
    console.error(`[tailbrowser] relay ${host} (${source})`);
    client = createClient({ host });
  }
  return client;
}

const toolResult = (text, isError) => ({ content: [{ type: 'text', text }], isError });

async function callExecute({ code, sessionId } = {}) {
  if (typeof code !== 'string' || !code) return toolResult('[error] missing "code" string', true);
  let r;
  try {
    r = await (await getClient()).execute(code, sessionId);
  } catch (e) {
    if (e.network) client = null; // relay moved or restarted elsewhere: re-resolve on the next call
    return toolResult(`[error] ${e.message}`, true);
  }
  const lines = (r.logs || []).map((l) => `[log] ${l}`);
  lines.push(r.ok
    ? `[result] ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)}`
    : `[error] ${r.error}`);
  lines.push(`[session] ${r.sessionId}`);
  return toolResult(lines.join('\n'), !r.ok);
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const handlers = {
  initialize: () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'tailbrowser', version },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: [EXECUTE_TOOL] }),
  'tools/call': (params) => {
    if (params?.name !== EXECUTE_TOOL.name) throw new RpcError(-32602, `unknown tool: ${params?.name}`);
    return callExecute(params.arguments);
  },
};

const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');

async function handleLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    return send({ id: null, error: { code: -32700, message: 'parse error' } });
  }
  const isRequest = msg.id !== undefined && msg.id !== null; // notifications get no reply
  const handler = handlers[msg.method];
  if (!handler) {
    if (isRequest) send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    return;
  }
  try {
    const result = await handler(msg.params);
    if (isRequest) send({ id: msg.id, result });
  } catch (e) {
    if (isRequest) send({ id: msg.id, error: { code: e instanceof RpcError ? e.code : -32603, message: e.message || String(e) } });
  }
}

readline.createInterface({ input: process.stdin, terminal: false }).on('line', handleLine);
