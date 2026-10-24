// programmatic client library for tailbrowser
import { resolveHost, discover, tailscaleIps, probe } from './discover.mjs';
import { configPath } from './config.mjs';
import { createClient } from './client.mjs';

export { resolveHost, discover, tailscaleIps, probe, configPath, createClient };

// Connect to a relay (discovered when `host` is omitted). Token defaults to TAILBROWSER_TOKEN.
export async function connect({ host, token } = {}) {
  const resolved = host || (await resolveHost()).host;
  return createClient({ host: resolved, token });
}
