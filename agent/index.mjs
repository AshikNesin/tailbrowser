// programmatic client library for tailbrowser
import { resolveHost, discover, tailscaleIps, probe, configPath } from './discover.mjs';

export { resolveHost, discover, tailscaleIps, probe, configPath };

export async function connect({ host, token } = {}) {
  const resolved = host ? { host, source: 'arg' } : await resolveHost({ log: () => {} });
  const h = resolved.host;
  const httpBase = h.replace(/^ws/, 'http');
  const api = async (path, opts = {}) => {
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    const res = await fetch(`${httpBase}${path}${q}`, {
      ...opts,
      headers: { 'content-type': 'application/json' },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  };
  return {
    host: h,
    health: () => api('/health'),
    scope: () => api('/scope'),
    newSession: () => api('/session', { method: 'POST' }),
    listSessions: () => api('/session'),
    resetSession: (id) => api('/session/reset', { method: 'POST', body: JSON.stringify({ sessionId: id }) }),
    execute: async (code, sessionId) => {
      const body = { code };
      if (sessionId) body.sessionId = sessionId;
      return api('/execute', { method: 'POST', body: JSON.stringify(body) });
    },
  };
}
