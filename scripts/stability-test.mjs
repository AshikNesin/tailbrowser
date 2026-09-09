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

const ROOT = path.resolve(import.meta.dirname, '..');
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
const post = async (body) => {
  try {
    const r = await fetch(`${BASE}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e) }; }
};
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
  const ext = run('node', ['agent/fake-extension.mjs', '--relay', `ws://127.0.0.1:${PORT}`, '--url', 'https://example.com', '--scope', 'full'], 'ext1.log');
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

  const ext2 = run('node', ['agent/fake-extension.mjs', '--relay', `ws://127.0.0.1:${PORT}`, '--url', 'https://example.com', '--scope', 'full'], 'ext2.log');
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
    const ext3 = run('node', ['agent/fake-extension.mjs', '--relay', `ws://127.0.0.1:${PORT}`, '--url', 'https://example.com', '--scope', 'full'], 'ext3.log');
    (await waitExt(true)) || bad('extension did not come back for section 7');
  }
  const r1 = await post({ sessionId: 'p1', code: 'throw new Error("boom")' });
  const r2 = await post({ sessionId: 'p1', code: 'state.n = (state.n || 0) + 1; return state.n' });
  (!r1.ok && r2.ok && r2.result === 1)
    ? ok('session survives a throwing snippet') : bad(`throwing snippet poisoned session: ${JSON.stringify(r2)}`);
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

await cleanup();
console.log(`\nRESULT: ${pass} passed, ${fail} failed  (logs: ${LOGDIR})`);
process.exit(fail === 0 ? 0 : 1);
