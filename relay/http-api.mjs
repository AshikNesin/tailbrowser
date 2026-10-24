// HTTP API: session management, snippet execution and status endpoints.
// Fault-isolated: nothing a client sends may throw past the handler: bad
// input degrades to a 4xx/5xx answer, never a dead daemon.

import { errorMessage } from '../lib/errors.mjs';
import { log } from './log.mjs';
import { toJsonSafe } from './sandbox.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// bounded reader: a huge/mangled POST can't wedge or OOM us
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON body must be an object');
  return body;
}

export function createHttpHandler({ auth, sessions, runner, extension }) {
  // "METHOD /path" -> (req, url) => [status, body]
  const routes = {
    'GET /health': () => [200, {
      ok: true,
      extension: extension.connected,
      targets: extension.targets().length,
      sessions: sessions.size,
    }],

    'GET /json/version': (req, url) => {
      const token = url.searchParams.get('token');
      return [200, {
        Browser: 'Chrome/131.0.0.0',
        'Protocol-Version': '1.3',
        'User-Agent': 'tailbrowser-relay',
        webSocketDebuggerUrl: `ws://${req.headers.host}/cdp/browser${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      }];
    },

    'GET /scope': () => [200, extension.connected
      ? { ...extension.scope, targets: extension.targets() }
      : { connected: false }],

    'POST /session': () => {
      const { id } = sessions.create();
      log('session created', id);
      return [200, { sessionId: id }];
    },

    'GET /session': () => [200, sessions.list()],

    'POST /session/reset': async (req) => {
      const { sessionId } = await readJson(req);
      if (!sessions.reset(String(sessionId))) return [404, { error: 'no such session' }];
      log('session reset', sessionId);
      return [200, { ok: true }];
    },

    'POST /execute': async (req) => {
      const body = await readJson(req);
      if (typeof body.code !== 'string' || !body.code) return [400, { ok: false, error: 'missing "code" string' }];
      const session = body.sessionId ? sessions.getOrCreate(String(body.sessionId)) : sessions.create();
      try {
        const { result, logs } = await runner.run(session, body.code);
        return [200, { sessionId: session.id, ok: true, result: toJsonSafe(result), logs }];
      } catch (e) {
        return [200, { sessionId: session.id, ok: false, error: errorMessage(e), logs: e.logs || [] }];
      }
    },
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://relay');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!auth.ipAllowed(req)) {
        log('rejected', req.socket.remoteAddress, '(not in --allow list)');
        return send(403, { error: 'source ip not allowed' });
      }
      // /health stays open so discovery can find the relay before it knows the token
      if (url.pathname !== '/health' && !auth.tokenOk(req, url)) return send(401, { error: 'bad token' });
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(404, { error: 'not found' });
      const [status, body] = await route(req, url);
      send(status, body);
    } catch (e) {
      log('http handler error', req.method, url.pathname, errorMessage(e));
      if (!res.headersSent) return send(e.status || 500, { ok: false, error: errorMessage(e) });
      try { res.end(); } catch {}
    }
  };
}
