// HTTP client for the relay API, shared by the CLI, the MCP server and the
// programmatic library. Every call has a deadline and fails with a message
// that says what to check, not just an errno.

import { networkErrorKind } from '../lib/errors.mjs';

const REQUEST_TIMEOUT_MS = 15_000; // unreachable/black-holed relay → error in seconds, not a hang
const EXECUTE_TIMEOUT_MS = 135_000; // the relay allows snippets up to 120s

export const toHttpBase = (host) => host.replace(/^ws/, 'http');

export class RelayError extends Error {
  constructor(message, { network = false, status } = {}) {
    super(message);
    this.network = network; // true when the relay could not be reached at all
    this.status = status;
  }
}

function describeNetworkError(e, host) {
  const kind = networkErrorKind(e);
  switch (kind) {
    case 'connection refused':
      return `relay not reachable at ${host} (connection refused). Is it running? Start it with: tailbrowser relay  (or check TAILBROWSER_HOST)`;
    case 'network unreachable':
      return `relay ${host} unreachable at network level. Is a VPN/proxy intercepting the tailnet range?`;
    case 'timeout':
      return `relay ${host} timed out. Black-holed address? Verify: curl -m 5 ${toHttpBase(host)}/health`;
    case 'DNS failure':
      return `cannot resolve relay host ${host} (DNS); check TAILBROWSER_HOST`;
    default:
      return `relay ${host}: ${kind}`;
  }
}

export function createClient({ host, token = process.env.TAILBROWSER_TOKEN || '' }) {
  const base = toHttpBase(host);
  const query = token ? `?token=${encodeURIComponent(token)}` : '';

  async function request(path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    let res, text;
    try {
      res = await fetch(`${base}${path}${query}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw new RelayError(`${describeNetworkError(e, host)} [${path}]`, { network: true });
    }
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (res.status === 401) throw new RelayError(`relay ${host} rejected the token; set TAILBROWSER_TOKEN to the relay's --token`, { status: 401 });
    if (!res.ok) throw new RelayError(`relay ${host} answered HTTP ${res.status} on ${path}: ${data?.error || text}`, { status: res.status });
    if (data === null) throw new RelayError(`relay ${host} sent a non-JSON answer on ${path}. Is that a tailbrowser relay?`);
    return data;
  }

  return {
    host,
    health: () => request('/health'),
    scope: () => request('/scope'),
    newSession: () => request('/session', { method: 'POST' }),
    listSessions: () => request('/session'),
    resetSession: (sessionId) => request('/session/reset', { method: 'POST', body: { sessionId } }),
    // → { ok, sessionId, result, logs } or { ok: false, sessionId, error, logs }
    execute: (code, sessionId) => request('/execute', {
      method: 'POST',
      body: sessionId ? { code, sessionId } : { code },
      timeoutMs: EXECUTE_TIMEOUT_MS,
    }),
  };
}
