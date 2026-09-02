// host resolution for tailbrowser clients (CLI + MCP)
// Priority: TAILBROWSER_HOST env → ~/.tailbrowser/config.json cache (liveness-checked)
// → scan tailnet via `tailscale status --json` → localhost fallback.

import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 8787;
export const PROBE_MS = 2500;

export function configPath() {
  return path.join(os.homedir(), '.tailbrowser', 'config.json');
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return null; }
}

function saveCache(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

function tailscaleStatusJson() {
  const cmds = [
    'tailscale status --json',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json',
  ];
  for (const cmd of cmds) {
    try {
      return JSON.parse(execSync(cmd, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    } catch {}
  }
  return null;
}

// rich peer list: [{ ip, hostName, online, self }] — empty if the CLI is unavailable
export function tailscalePeers() {
  const j = tailscaleStatusJson();
  if (!j) return [];
  const out = [];
  const push = (peer, self) => {
    for (const ip of peer.TailscaleIPs || []) {
      if (!ip.includes('.')) continue; // IPv4 only
      out.push({ ip, hostName: peer.HostName || ip, online: self ? true : peer.Online !== false, self });
    }
  };
  if (j.Self) push(j.Self, true);
  for (const p of Object.values(j.Peer || {})) push(p, false);
  return out;
}

// compat: flat list of tailnet IPv4s
export function tailscaleIps() {
  return [...new Set(tailscalePeers().map((p) => p.ip))];
}

function classify(e) {
  const s = String((e && (e.cause?.code || e.code || e.message)) || e || 'unknown error');
  if (/ECONNREFUSED/.test(s)) return 'connection refused';
  if (/ENETUNREACH|EHOSTUNREACH/.test(s)) return 'network unreachable';
  if (/ECONNRESET/.test(s)) return 'connection reset';
  if (/aborted|AbortError|timeout|ETIMEDOUT/i.test(s)) return 'timeout';
  if (/EAI_AGAIN|ENOTFOUND/.test(s)) return 'DNS failure';
  if (/fetch is not defined|not a function/i.test(s)) return 'fetch unavailable';
  return s;
}

// probe http(s)://host:port/health — returns { ok, reason }
export async function probeDetailed(httpBase, ms = PROBE_MS) {
  const url = `${httpBase}/health`;
  // Node >= 18
  if (typeof fetch === 'function') {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ac && setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(url, ac ? { signal: ac.signal } : {});
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      const j = await res.json().catch(() => null);
      return j && j.ok === true ? { ok: true, reason: 'ok' } : { ok: false, reason: 'answered, but not a tailbrowser relay (/health body)' };
    } catch (e) {
      return { ok: false, reason: classify(e) };
    } finally {
      if (t) clearTimeout(t);
    }
  }
  // Node < 18 fallback
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, reason: `HTTP ${res.statusCode}` }); }
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch {}
        resolve(j && j.ok === true ? { ok: true, reason: 'ok' } : { ok: false, reason: 'answered, but not a tailbrowser relay (/health body)' });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, reason: classify(e) }));
  });
}

// boolean wrapper (public API)
export async function probe(httpBase, ms = PROBE_MS) {
  return (await probeDetailed(httpBase, ms)).ok;
}

function hint(reasons, probed, port) {
  const all = (pred) => probed > 0 && reasons.every(pred);
  const lines = [];
  if (all((r) => r === 'connection refused')) {
    lines.push(`every tailnet host refused the connection — is the relay actually running? (tailbrowser relay)`);
  } else if (all((r) => r === 'timeout' || r === 'network unreachable')) {
    lines.push(`every tailnet host timed out — this machine cannot open TCP connections over the tailnet.`);
    lines.push(`  • check: tailscale status   (are peers online? is this device connected?)`);
    lines.push(`  • a VPN/proxy claiming 100.64.0.0/10 (CGNAT range) will black-hole tailnet IPs — disconnect it or split-tunnel 100.64/10`);
    lines.push(`  • corporate HTTP(S)_PROXY env does not affect Node fetch, but a transparent proxy might`);
  } else if (all((r) => r === 'fetch unavailable')) {
    lines.push(`Node's fetch is unavailable — upgrade Node to >= 18`);
  }
  lines.push(`  • verify by hand from this machine:  curl -v -m 3 http://<relay-ip>:${port}/health`);
  lines.push(`  • skip discovery entirely:           export TAILBROWSER_HOST=ws://<relay-ip>:${port}`);
  return lines;
}

// scan the tailnet for a live relay; returns ws://host:port or null
export async function discover({ port = Number(process.env.TAILBROWSER_PORT || DEFAULT_PORT), save = true, log = () => {} } = {}) {
  const peers = tailscalePeers();
  if (!peers.length) { log(`discovery: no tailscale peers found (tailscale CLI unavailable or not connected)`); return null; }

  // probe online peers first; fall back to the full list if none are online
  let candidates = peers.filter((p) => p.online);
  if (!candidates.length) candidates = peers;

  log(`discovery: probing ${candidates.length} tailnet host${candidates.length === 1 ? '' : 's'} on :${port} (${peers.length - candidates.length} offline skipped)…`);
  const results = await Promise.all(candidates.map(async (p) => {
    const r = await probeDetailed(`http://${p.ip}:${port}`);
    if (r.ok) log(`discovery: ✓ relay at ${p.ip}:${port} (${p.hostName}${p.self ? ', this machine' : ''})`);
    return { ...p, ...r };
  }));

  const hit = results.find((r) => r.ok);
  if (hit) {
    const host = `ws://${hit.ip}:${port}`;
    if (save) saveCache({ host, discoveredAt: new Date().toISOString() });
    return host;
  }

  // no hit — say WHY, not just "not found"
  const tally = {};
  for (const r of results) tally[r.reason] = (tally[r.reason] || 0) + 1;
  log(`discovery: no relay found on the tailnet (start one with: tailbrowser relay)`);
  log(`discovery: probe results — ${Object.entries(tally).map(([k, v]) => `${v}× ${k}`).join(', ')}`);
  for (const p of results.filter((r) => !r.ok && r.online && !r.self).slice(0, 5)) {
    log(`discovery:   ${p.ip} (${p.hostName}): ${p.reason}`);
  }
  for (const line of hint(results.map((r) => r.reason), results.length, port)) log(`discovery: ${line}`);
  return null;
}

export async function resolveHost({ force = false, log = () => {} } = {}) {
  if (process.env.TAILBROWSER_HOST) {
    return { host: process.env.TAILBROWSER_HOST, source: 'env' };
  }
  const cache = loadCache();
  if (!force && cache?.host) {
    const httpBase = cache.host.replace(/^ws/, 'http');
    const r = await probeDetailed(httpBase, 1000);
    if (r.ok) {
      return { host: cache.host, source: 'cache' };
    }
    log(`cached relay ${cache.host} is down (${r.reason}) — re-discovering…`);
  }
  const found = await discover({ log });
  if (found) return { host: found, source: 'discovered' };
  return { host: `ws://127.0.0.1:${DEFAULT_PORT}`, source: 'default' };
}
