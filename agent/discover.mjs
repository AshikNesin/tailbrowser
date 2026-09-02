// host resolution for tailbrowser clients (CLI + MCP)
// Priority: TAILBROWSER_HOST env → ~/.tailbrowser/config.json cache (liveness-checked)
// → scan tailnet via `tailscale status --json` → localhost fallback.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 8787;

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

export function tailscaleIps() {
  const cmds = [
    'tailscale status --json',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json',
  ];
  for (const cmd of cmds) {
    try {
      const out = execSync(cmd, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const j = JSON.parse(out);
      const ips = [];
      const push = (peer) => { for (const ip of peer.TailscaleIPs || []) if (ip.includes('.')) ips.push(ip); };
      if (j.Self) push(j.Self);
      for (const p of Object.values(j.Peer || {})) push(p);
      return [...new Set(ips)];
    } catch {}
  }
  return [];
}

// probe http(s)://host:port/health — resolves to the base URL if it answers like a tailbrowser relay
export async function probe(httpBase, ms = 1500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    const res = await fetch(`${httpBase}/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = await res.json().catch(() => null);
    return !!(j && j.ok === true);
  } catch {
    return false;
  }
}

// scan the tailnet for a live relay; returns ws://host:port or null
export async function discover({ port = Number(process.env.TAILBROWSER_PORT || DEFAULT_PORT), save = true, log = () => {} } = {}) {
  const ips = tailscaleIps();
  if (!ips.length) { log(`discovery: no tailscale peers found (tailscale CLI unavailable or not connected)`); return null; }
  log(`discovery: probing ${ips.length} tailnet IPs on :${port} …`);
  const hits = await Promise.all(ips.map(async (ip) => {
    const ok = await probe(`http://${ip}:${port}`);
    if (ok) log(`discovery: ✓ relay at ${ip}:${port}`);
    return ok ? ip : null;
  }));
  const ip = hits.find(Boolean);
  if (!ip) { log(`discovery: no relay found on the tailnet (start one with: tailbrowser relay)`); return null; }
  const host = `ws://${ip}:${port}`;
  if (save) saveCache({ host, discoveredAt: new Date().toISOString() });
  return host;
}

export async function resolveHost({ force = false, log = () => {} } = {}) {
  if (process.env.TAILBROWSER_HOST) {
    return { host: process.env.TAILBROWSER_HOST, source: 'env' };
  }
  const cache = loadCache();
  if (!force && cache?.host) {
    const httpBase = cache.host.replace(/^ws/, 'http');
    if (await probe(httpBase, 1000)) {
      return { host: cache.host, source: 'cache' };
    }
    log(`cached relay ${cache.host} is down — re-discovering…`);
  }
  const found = await discover({ log });
  if (found) return { host: found, source: 'discovered' };
  return { host: `ws://127.0.0.1:${DEFAULT_PORT}`, source: 'default' };
}
