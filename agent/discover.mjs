// host resolution for tailbrowser clients (CLI + MCP)
// Priority: TAILBROWSER_HOST env → ~/.tailbrowser/config.json cache (liveness-checked)
// → scan tailnet via `tailscale status --json` → localhost fallback.

import { networkErrorKind } from '../lib/errors.mjs';
import { tailscalePeers } from '../lib/tailscale.mjs';
import { configPath, loadConfig, updateConfig } from './config.mjs';

export { configPath, tailscalePeers };

export const DEFAULT_PORT = 8787;
export const PROBE_MS = 2500;

const NOT_A_RELAY = 'answered, but not a tailbrowser relay (/health body)';

// flat list of tailnet IPv4s
export function tailscaleIps() {
  return [...new Set(tailscalePeers().map((p) => p.ip))];
}

// probe http(s)://host:port/health; returns { ok, reason }
export async function probeDetailed(httpBase, ms = PROBE_MS) {
  try {
    const res = await fetch(`${httpBase}/health`, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    return body?.ok === true ? { ok: true, reason: 'ok' } : { ok: false, reason: NOT_A_RELAY };
  } catch (e) {
    return { ok: false, reason: networkErrorKind(e) };
  }
}

export async function probe(httpBase, ms = PROBE_MS) {
  return (await probeDetailed(httpBase, ms)).ok;
}

// troubleshooting lines for a scan that found nothing
function hint(reasons, port) {
  const all = (pred) => reasons.length > 0 && reasons.every(pred);
  const lines = [];
  if (all((r) => r === 'connection refused')) {
    lines.push('every tailnet host refused the connection. Is the relay actually running? (tailbrowser relay)');
  } else if (all((r) => r === 'timeout' || r === 'network unreachable')) {
    lines.push('every tailnet host timed out: this machine cannot open TCP connections over the tailnet.');
    lines.push('  • check: tailscale status   (are peers online? is this device connected?)');
    lines.push('  • a VPN/proxy claiming 100.64.0.0/10 (CGNAT range) will black-hole tailnet IPs; disconnect it or split-tunnel 100.64/10');
    lines.push('  • corporate HTTP(S)_PROXY env does not affect Node fetch, but a transparent proxy might');
  }
  lines.push(`  • verify by hand from this machine:  curl -v -m 3 http://<relay-ip>:${port}/health`);
  lines.push(`  • skip discovery entirely:           export TAILBROWSER_HOST=ws://<relay-ip>:${port}`);
  return lines;
}

// scan the tailnet for a live relay; returns ws://host:port or null
export async function discover({ port = Number(process.env.TAILBROWSER_PORT || DEFAULT_PORT), save = true, log = () => {} } = {}) {
  const peers = tailscalePeers();
  if (!peers.length) {
    log('discovery: no tailscale peers found (tailscale CLI unavailable or not connected)');
    return null;
  }

  // probe online peers first; fall back to the full list if none are online
  const online = peers.filter((p) => p.online);
  const candidates = online.length ? online : peers;

  log(`discovery: probing ${candidates.length} tailnet host${candidates.length === 1 ? '' : 's'} on :${port} (${peers.length - candidates.length} offline skipped)…`);
  const results = await Promise.all(candidates.map(async (peer) => {
    const result = await probeDetailed(`http://${peer.ip}:${port}`);
    if (result.ok) log(`discovery: ✓ relay at ${peer.ip}:${port} (${peer.hostName}${peer.self ? ', this machine' : ''})`);
    return { ...peer, ...result };
  }));

  const hit = results.find((r) => r.ok);
  if (hit) {
    const host = `ws://${hit.ip}:${port}`;
    if (save) updateConfig({ host, discoveredAt: new Date().toISOString() });
    return host;
  }

  // no hit: say WHY, not just "not found"
  const tally = {};
  for (const r of results) tally[r.reason] = (tally[r.reason] || 0) + 1;
  log('discovery: no relay found on the tailnet (start one with: tailbrowser relay)');
  log(`discovery: probe results: ${Object.entries(tally).map(([reason, n]) => `${n}× ${reason}`).join(', ')}`);
  for (const r of results.filter((r) => r.online && !r.self).slice(0, 5)) {
    log(`discovery:   ${r.ip} (${r.hostName}): ${r.reason}`);
  }
  for (const line of hint(results.map((r) => r.reason), port)) log(`discovery: ${line}`);
  return null;
}

// → { host, source: 'env' | 'cache' | 'discovered' | 'stale-cache' | 'default' }
export async function resolveHost({ force = false, rediscover = false, log = () => {} } = {}) {
  if (process.env.TAILBROWSER_HOST) {
    return { host: process.env.TAILBROWSER_HOST, source: 'env' };
  }
  const cached = loadConfig().host;
  if (!force && cached) {
    const r = await probeDetailed(cached.replace(/^ws/, 'http'), 1000);
    if (r.ok) return { host: cached, source: 'cache' };
    log(`cached relay ${cached} is down (${r.reason}), re-discovering…`);
  }
  const found = await discover({ log });
  if (found) return { host: found, source: 'discovered' };
  // nothing live on the tailnet: fall back to the stale cache rather than
  // localhost (localhost is almost always wrong for remote agents), but say so
  if (rediscover && cached) {
    log(`no live relay found, falling back to last known ${cached}`);
    return { host: cached, source: 'stale-cache' };
  }
  return { host: `ws://127.0.0.1:${DEFAULT_PORT}`, source: 'default' };
}
