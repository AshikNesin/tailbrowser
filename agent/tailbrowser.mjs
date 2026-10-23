#!/usr/bin/env node
// tailbrowser CLI. See USAGE below.

import { resolveHost, discover } from './discover.mjs';
import { configPath, loadConfig, updateConfig } from './config.mjs';
import { createClient } from './client.mjs';

const USAGE = `tailbrowser: let agents control a tailnet Chrome
relay discovery: TAILBROWSER_HOST env → ~/.tailbrowser/config.json → scan tailnet (tailscale status)
usage:
  tailbrowser relay [--port 8787] [--bind ip] [--token x] [--allow ips]   start the relay server on this machine
  tailbrowser discover             find + cache a relay on the tailnet
  tailbrowser -e 'code'            run a JS snippet in this machine's sticky default session
  tailbrowser -s 1 -e 'code'       run a JS snippet in a specific session
  tailbrowser -e 'code' --new      run in a fresh session (becomes the new default)
  tailbrowser session new          create a session (prints id)
  tailbrowser session list         list sessions
  tailbrowser session reset <id>   clear a session's state
  tailbrowser scope                show scope + attached targets
  tailbrowser health
  tailbrowser --mcp                run the MCP server (stdio)

snippet scope: page, context, state (persists per session), pages(), snapshot(), screenshot(), newPage()
env: TAILBROWSER_HOST (override discovery), TAILBROWSER_TOKEN (optional), TAILBROWSER_PORT (scan port, default 8787)`;

const args = process.argv.slice(2);

// value after the first matching flag: undefined = flag absent, null = flag without a value
function option(...names) {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i !== -1) return args[i + 1] ?? null;
  }
  return undefined;
}

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// every relay-facing command resolves the host first (env → cache → scan);
// a cached-but-dead relay is re-discovered live instead of erroring out
async function connectClient() {
  let resolved;
  try {
    resolved = await resolveHost({ log: console.error, rediscover: true });
  } catch (e) {
    die(e.message);
  }
  if (resolved.source !== 'env') console.error(`→ relay ${resolved.host} (${resolved.source})`);
  return createClient({ host: resolved.host });
}

// sticky default session: no -s → reuse (or lazily create) this machine's default
async function defaultSession(client, { fresh }) {
  const { defaultSession } = loadConfig();
  if (defaultSession && !fresh) return defaultSession;
  const { sessionId } = await client.newSession();
  updateConfig({ defaultSession: sessionId });
  console.error(`→ session ${sessionId} (new default, saved)`);
  return sessionId;
}

async function runSnippet(code) {
  if (!code) die("usage: tailbrowser [-s <id>] -e '<code>'");
  const client = await connectClient();
  const sessionId = option('-s', '--session') || (await defaultSession(client, { fresh: args.includes('--new') }));
  const r = await client.execute(code, sessionId);
  for (const line of r.logs || []) console.log('  |', line);
  if (!r.ok) die(r.error);
  if (r.result !== null && r.result !== undefined) console.log(JSON.stringify(r.result, null, 2));
}

async function runSession(sub, id) {
  if (!['new', 'list', 'reset'].includes(sub)) die('usage: tailbrowser session new|list|reset <id>');
  if (sub === 'reset' && !id) die('usage: tailbrowser session reset <id>');
  const client = await connectClient();
  if (sub === 'new') {
    console.log((await client.newSession()).sessionId);
  } else if (sub === 'list') {
    for (const s of await client.listSessions()) console.log(`#${s.id}  state: ${s.stateKeys.join(', ') || '-'}`);
  } else {
    await client.resetSession(id);
    console.log('reset');
  }
}

async function runDiscover() {
  if (process.env.TAILBROWSER_HOST) {
    console.log(`TAILBROWSER_HOST is set → ${process.env.TAILBROWSER_HOST} (env overrides discovery)`);
    return;
  }
  const found = await discover({ log: console.error });
  if (!found) die('no relay found; start one with: tailbrowser relay');
  console.log(`found + cached: ${found} → ${configPath()}`);
}

async function main() {
  const code = option('-e', '--code');
  if (args[0] === 'relay') {
    // run the relay in-process; remaining flags pass through (--port, --bind, --token, --allow)
    process.argv = [process.argv[0], 'relay', ...args.slice(1)];
    await import('../relay/relay.mjs');
  } else if (args.includes('--mcp')) {
    await import('./tailbrowser.mcp.mjs');
  } else if (args[0] === 'discover') {
    await runDiscover();
  } else if (code !== undefined) {
    await runSnippet(code);
  } else if (args[0] === 'session') {
    await runSession(args[1], args[2]);
  } else if (args[0] === 'scope' || args[0] === 'health') {
    const client = await connectClient();
    console.log(JSON.stringify(await (args[0] === 'scope' ? client.scope() : client.health()), null, 2));
  } else {
    console.log(USAGE);
  }
}

main().catch((e) => die(e.message));
