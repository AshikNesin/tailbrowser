// Relay configuration: CLI flags > env > defaults. Throws on invalid input so
// the entrypoint can print one clear line and exit.

import { flagReader } from '../lib/args.mjs';
import { tailscaleIPv4 } from '../lib/tailscale.mjs';

export const DEFAULT_PORT = 8787;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function requireValue(name, value) {
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

export function loadRelayConfig(argv, env = process.env) {
  const flag = flagReader(argv);

  const port = Number(requireValue('port', flag('port', DEFAULT_PORT)));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${flag('port')}`);

  const token = flag('token', env.TAILBROWSER_TOKEN || '');
  if (token === true) throw new Error('--token requires a value (or omit --token for tokenless tailnet-only mode)');

  const allow = String(requireValue('allow', flag('allow', env.TAILBROWSER_ALLOW || '')));
  const allowList = allow.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of allowList) parseAllowEntry(entry); // validate early

  // bind: explicit --bind > autodetected tailscale IP > loopback
  let bind = requireValue('bind', flag('bind', null));
  let bindSource = 'flag';
  if (!bind) {
    bind = tailscaleIPv4();
    bindSource = bind ? 'tailscale' : 'loopback';
    bind ||= '127.0.0.1';
  }

  return {
    port,
    bind,
    bindSource,
    token,
    allowList,
    extensionDeadAfterMs: Number(env.TB_TEST_EXT_DEAD_MS) || 75_000,
  };
}

// address this process can use to reach its own listener
export function selfHost(bind) {
  return bind === '0.0.0.0' ? '127.0.0.1' : bind;
}

// ---------- source-IP allowlist ----------

const ipToLong = (ip) => ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);

// "100.1.2.3" or "100.64.0.0/10" -> { base, mask }
function parseAllowEntry(entry) {
  const [base, bitsRaw] = entry.split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!IPV4.test(base) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`invalid --allow entry "${entry}" (expected IPv4 or CIDR, e.g. 100.64.0.0/10)`);
  }
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (ipToLong(base) & mask) >>> 0, mask };
}

// (remoteAddress) => boolean; an empty list allows any source
export function createIpFilter(allowList) {
  if (!allowList.length) return () => true;
  const rules = allowList.map(parseAllowEntry);
  return (remoteAddress) => {
    const ip = String(remoteAddress || '').replace(/^::ffff:/, '');
    if (!IPV4.test(ip)) return false;
    const n = ipToLong(ip);
    return rules.some(({ base, mask }) => ((n & mask) >>> 0) === base);
  };
}
