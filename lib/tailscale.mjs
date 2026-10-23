// Thin wrapper over the tailscale CLI (PATH first, then the macOS app bundle).

import { execFileSync } from 'node:child_process';

const TAILSCALE_BINARIES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// stdout of `tailscale <args>`, or null if no CLI is available / it failed
function runTailscale(args) {
  for (const bin of TAILSCALE_BINARIES) {
    try {
      return execFileSync(bin, args, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {}
  }
  return null;
}

// this machine's tailnet IPv4, or null
export function tailscaleIPv4() {
  const ip = runTailscale(['ip', '-4'])?.trim().split('\n')[0].trim();
  return ip && IPV4.test(ip) ? ip : null;
}

// [{ ip, hostName, online, self }] for this machine and every peer (IPv4 only);
// empty if the CLI is unavailable or not connected
export function tailscalePeers() {
  let status;
  try { status = JSON.parse(runTailscale(['status', '--json'])); } catch { return []; }
  if (!status) return [];
  const peers = [];
  const add = (node, self) => {
    for (const ip of node.TailscaleIPs || []) {
      if (!IPV4.test(ip)) continue;
      peers.push({ ip, hostName: node.HostName || ip, online: self || node.Online !== false, self });
    }
  };
  if (status.Self) add(status.Self, true);
  for (const peer of Object.values(status.Peer || {})) add(peer, false);
  return peers;
}
