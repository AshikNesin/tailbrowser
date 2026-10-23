#!/usr/bin/env node
// tailbrowser stability suite — regression tests for every failure mode that
// has actually taken the relay down or wedged agents in real use.
// (Process control lives here on purpose: bash $! mis-pins background
// pipelines, which once made this suite kill the wrong process and "fail".)
//
// Run: node scripts/stability-test.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TB_TEST_PORT || 18930);
const BASE = `http://127.0.0.1:${PORT}`;
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-stab-'));

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
function run(cmd, args, logName) {
  const out = fs.openSync(path.join(LOGDIR, logName), 'w');
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', out, out], detached: false });
  procs.push(p);
  return p;
}
async function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  try { spawn('pkill', ['-f', 'tb-fake-']); } catch {}
  await wait(300);
}
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } });

const health = async () => { try { return await (await fetch(`${BASE}/health`)).json(); } catch { return null; } };
const post = async (body, base = BASE, path = '/execute') => {
  try {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
};
const startFakeExt = (logName, ...extra) => run('node', ['agent/fake-extension.mjs', '--relay', `ws://127.0.0.1:${PORT}`, '--url', 'https://example.com', '--scope', 'full', ...extra], logName);
const waitExt = async (want = true) => {
  for (let i = 0; i < 40; i++) { const h = await health(); if (h && h.extension === want) return true; await wait(500); }
  return false;
};

console.log(`— starting relay on :${PORT} (logs: ${LOGDIR})`);
const relay = run('node', ['relay/relay.mjs', '--port', String(PORT), '--bind', '127.0.0.1'], 'relay.log');
for (let i = 0; i < 20; i++) { if (await health()) break; await wait(500); }

console.log('— 1. malformed inputs never kill the relay');
{
  const attempts = [
    ['POST', '/execute', '{invalid json!!'],
    ['POST', '/session/reset', 'garbage'],
    ['POST', '/execute', ''],
    ['POST', '/execute', '{"code": 12345}'], // non-string code
    ['GET', '/execute?x[]=1', null],
  ];
  for (const [m, p, b] of attempts) {
    try { await fetch(`${BASE}${p}`, { method: m, body: b || undefined }); } catch {}
  }
  (await health())?.ok ? ok('malformed/empty bodies isolated') : bad('malformed body killed the relay');
}

console.log('— 2. execute without extension → typed fast error');
{
  const t0 = Date.now();
  const r = await post({ sessionId: 's1', code: 'return await page.title()' });
  const ms = Date.now() - t0;
  r.ok === false && /TB_ERR: extension not connected/.test(r.error || '') && ms < 3000
    ? ok(`typed TB_ERR error (${ms}ms)`) : bad(`expected fast TB_ERR, got (${ms}ms): ${JSON.stringify(r)}`);
}

console.log('— 3. extension flap recovery (no relay restart)');
{
  const ext = startFakeExt('ext1.log');
  (await waitExt(true)) || bad('extension never connected');

  let r = await post({ sessionId: 's1', code: 'return await page.title()' });
  r.ok ? ok('snippet executes') : bad(`snippet failed: ${r.error}`);

  ext.kill('SIGKILL');
  (await waitExt(false)) ? ok('relay detects extension drop') : bad('extension drop not detected');

  const t0 = Date.now();
  r = await post({ sessionId: 's1', code: 'return await page.title()' });
  const ms = Date.now() - t0;
  r.ok === false && /TB_ERR/.test(r.error || '') && ms < 3000
    ? ok(`fails fast while down (${ms}ms)`) : bad(`expected fast TB_ERR, got (${ms}ms): ${JSON.stringify(r)}`);

  startFakeExt('ext2.log');
  (await waitExt(true)) || bad('extension did not reconnect');

  r = await post({ sessionId: 's1', code: 'await page.goto("https://example.com"); return await page.title()' });
  r.ok ? ok('recovers after flap (no relay restart)') : bad(`did not recover after flap: ${r.error}`);
}

console.log('— 4. newPage() end-to-end (full-browser mode)');
{
  const r = await post({ sessionId: 's2', code: 'const p = await newPage(); await p.setContent("<h1>hi</h1>"); state.p2 = p; return await p.textContent("h1")' });
  r.ok && r.result === 'hi' ? ok('newPage() creates + returns a working page') : bad(`newPage failed: ${r.error || JSON.stringify(r.result)}`);
  const r2 = await post({ sessionId: 's2', code: 'return pages().length >= 2' });
  r2.ok && r2.result === true ? ok('new page visible to sessions') : bad(`page visibility: ${r2.error || JSON.stringify(r2.result)}`);
  const r3 = await post({ sessionId: 's2', code: 'const before = pages().length; await state.p2.close(); return [before, pages().length]' });
  r3.ok && r3.result[1] === r3.result[0] - 1 ? ok('page.close() closes the tab') : bad(`page.close: ${r3.error || JSON.stringify(r3.result)}`);
}

console.log('— 5. concurrent load (8 parallel snippets)');
{
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    post({ sessionId: `c${i}`, code: 'await page.setContent("<b>x</b>"); return 1' })));
  rs.every((r) => r.ok) ? ok('8/8 concurrent snippets') : bad(`only ${rs.filter((r) => r.ok).length}/8 ok — ${rs.find((r) => !r.ok)?.error}`);
}

console.log('— 6. relay survives garbage WS frames');
{
  const code = `
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket('ws://127.0.0.1:${PORT}/extension');
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'attached' }));
    ws.send(JSON.stringify({ t: 'targetInfoChanged', targetId: 'nope', url: 'x' }));
    ws.send(JSON.stringify({ t: 'cdpResult', id: 99999 }));
    ws.send(Buffer.from([0xff, 0x00, 0xfe]));
    await new Promise((r) => setTimeout(r, 400));
    ws.close();
    process.exit(0);
  `;
  const p = run('node', ['--input-type=module', '-e', code], 'garbage.log');
  await new Promise((r) => p.on('exit', r));
  (await health())?.ok ? ok('garbage extension frames isolated') : bad('garbage frames hurt relay');
}

console.log('— 7. session survives a throwing snippet (state not poisoned)');
{
  // needs a live extension — restart one if section 3 left it down
  if (!(await health())?.extension) {
    startFakeExt('ext3.log');
    (await waitExt(true)) || bad('extension did not come back for section 7');
  }
  const r1 = await post({ sessionId: 'p1', code: 'throw new Error("boom")' });
  const r2 = await post({ sessionId: 'p1', code: 'state.n = (state.n || 0) + 1; return state.n' });
  (!r1.ok && r2.ok && r2.result === 1)
    ? ok('session survives a throwing snippet') : bad(`throwing snippet poisoned session: ${JSON.stringify(r2)}`);
  const r3 = await post({ sessionId: 'p1', code: 'console.log("before"); throw "boom"' });
  r3.ok === false && r3.error === 'boom' && r3.logs?.[0] === 'before'
    ? ok('non-Error throw reported as-is, logs kept') : bad(`non-Error throw: ${JSON.stringify(r3)}`);
}

console.log('— 7b. auto-assigned session ids never collide with client-chosen ones');
{
  const a = await post({}, BASE, '/session');
  const claimed = String(Number(a.sessionId) + 1);
  await post({ sessionId: claimed, code: 'state.mine = true; return 1' });
  const b = await post({}, BASE, '/session');
  b.sessionId && b.sessionId !== claimed ? ok(`POST /session skips claimed id ${claimed}`) : bad(`session id collision: ${JSON.stringify(b)}`);
}

console.log('— 7c. MCP server: JSON-RPC edge cases');
{
  const mcp = spawn('node', ['agent/tailbrowser.mcp.mjs'], { cwd: ROOT, env: { ...process.env, TAILBROWSER_HOST: `ws://127.0.0.1:${PORT}` }, stdio: ['pipe', 'pipe', 'ignore'] });
  procs.push(mcp);
  const replies = new Map();
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) !== -1; buf = buf.slice(i + 1)) {
      try { const m = JSON.parse(buf.slice(0, i)); replies.set(m.id, m); } catch {}
    }
  });
  const rpc = (msg) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  rpc({ id: 0, method: 'initialize', params: {} });
  rpc({ method: 'notifications/initialized' });
  rpc({ id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  rpc({ id: 2, method: 'tools/call', params: { name: 'execute', arguments: { code: 'return 6 * 7', sessionId: 'mcp' } } });
  rpc({ id: 3, method: 'no/such/method' });
  for (let i = 0; i < 60 && replies.size < 4; i++) await wait(250);
  replies.get(0)?.result?.serverInfo?.name === 'tailbrowser' ? ok('answers request id 0') : bad(`id 0 unanswered: ${JSON.stringify(replies.get(0))}`);
  replies.get(1)?.error?.code === -32602 ? ok('unknown tool → invalid params') : bad(`unknown tool: ${JSON.stringify(replies.get(1))}`);
  /\[result\] 42/.test(replies.get(2)?.result?.content?.[0]?.text || '') ? ok('execute tool round-trips') : bad(`execute via MCP: ${JSON.stringify(replies.get(2))}`);
  replies.get(3)?.error?.code === -32601 ? ok('unknown method → method not found') : bad(`unknown method: ${JSON.stringify(replies.get(3))}`);
  mcp.kill();
}

console.log('— 8. second relay on same port → friendly EADDRINUSE');
{
  const p = spawn('node', ['relay/relay.mjs', '--port', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  const { out, code } = await new Promise((r) => {
    let buf = '';
    const t = setTimeout(() => r({ out: buf, code: null }), 5000);
    p.stdout.on('data', (d) => { buf += d; });
    p.stderr.on('data', (d) => { buf += d; });
    p.on('exit', (c) => { clearTimeout(t); r({ out: buf, code: c }); });
  });
  /already in use/.test(out) && code === 1 ? ok('friendly EADDRINUSE') : bad(`EADDRINUSE not friendly (exit=${code}): ${out.slice(0, 120)}`);
}

console.log('— 9. relay still alive at the end');
{
  const h = await health();
  h?.ok ? ok('relay healthy') : bad('relay died during the suite');
}

console.log('— 10. token mode: snippets work, unauthenticated calls are refused');
{
  const TPORT = PORT + 1;
  const TBASE = `http://127.0.0.1:${TPORT}`;
  const TOKEN = 'stability-secret';
  run('node', ['relay/relay.mjs', '--port', String(TPORT), '--bind', '127.0.0.1', '--token', TOKEN], 'relay-token.log');
  for (let i = 0; i < 20; i++) { try { await fetch(`${TBASE}/health`); break; } catch { await wait(500); } }
  run('node', ['agent/fake-extension.mjs', '--relay', `ws://127.0.0.1:${TPORT}`, '--token', TOKEN, '--url', 'https://example.com', '--scope', 'full'], 'ext-token.log');
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { up = (await (await fetch(`${TBASE}/health`)).json()).targets > 0; } catch {} if (!up) await wait(500); }
  up || bad('fake extension never connected to the token relay');
  const anon = await fetch(`${TBASE}/session`);
  anon.status === 401 ? ok('no token → 401') : bad(`expected 401, got ${anon.status}`);
  const r = await post({ sessionId: 't1', code: 'return await page.title()' }, TBASE, `/execute?token=${TOKEN}`);
  r.ok && r.result === 'Example Domain' ? ok('snippet runs in token mode') : bad(`token mode snippet: ${r.error || JSON.stringify(r)}`);
}

await cleanup();
console.log(`\nRESULT: ${pass} passed, ${fail} failed  (logs: ${LOGDIR})`);
process.exit(fail === 0 ? 0 : 1);
