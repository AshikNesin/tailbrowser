// The relay's end of the Chrome-extension pipe (/extension, JSON envelopes).
//
// Holds at most one extension connection. Every new connection bumps
// `generation`, which tells the snippet sandbox its cached Playwright graph is
// stale. Target lifecycle is surfaced as events for the CDP bridge:
//   'attached'          (target)                      new agent-visible tab
//   'targetInfoChanged' (target)                      url/title changed
//   'detached'          (targetId)                    tab gone / extension dropped
//   'cdpEvent'          (targetId, method, params)    CDP event from a tab

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { errorMessage } from '../lib/errors.mjs';
import { log, debugLog } from './log.mjs';

const PING_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;

export class ExtensionLink extends EventEmitter {
  #conn = null; // { ws, targets: Map<targetId, target>, scope, pending: Map<id, {resolve, reject, timer}>, lastSeen, pingTimer }
  #nextRequestId = 1;
  #deadAfterMs;

  generation = 0;

  constructor({ deadAfterMs }) {
    super();
    this.#deadAfterMs = deadAfterMs;
  }

  get connected() {
    return !!this.#conn;
  }

  get scope() {
    return this.#conn?.scope ?? null;
  }

  targets() {
    return this.#conn ? [...this.#conn.targets.values()] : [];
  }

  getTarget(targetId) {
    return this.#conn?.targets.get(targetId);
  }

  // Send an envelope and await the matching `cdpResult`.
  request(msg) {
    const conn = this.#conn;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('TB_ERR: extension not connected'));
    }
    return new Promise((resolve, reject) => {
      const id = this.#nextRequestId++;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`TB_TIMEOUT: extension did not answer ${msg.method || msg.t}`));
      }, REQUEST_TIMEOUT_MS);
      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  sendCdp(targetId, method, params) {
    return this.request({ t: 'cdp', targetId, method, params });
  }

  closeTab(targetId) {
    return this.request({ t: 'closeTab', targetId });
  }

  accept(ws) {
    if (this.#conn) this.#drop('replaced');
    this.generation++;
    const conn = { ws, targets: new Map(), scope: { mode: 'unknown' }, pending: new Map(), lastSeen: Date.now() };
    this.#conn = conn;
    log('extension connected');

    conn.pingTimer = setInterval(() => {
      if (Date.now() - conn.lastSeen > this.#deadAfterMs) {
        // half-open socket (extension machine slept, network dropped): kill
        // it so CDP clients fail fast instead of stalling on a dead pipe
        log(`extension silent > ${Math.round(this.#deadAfterMs / 1000)}s — terminating half-open connection`);
        try { ws.terminate(); } catch {}
        return;
      }
      try { ws.ping(); } catch {}
    }, PING_MS);

    ws.on('message', (data) => {
      conn.lastSeen = Date.now();
      // every frame is isolated: a malformed message hurts no one
      try { this.#onMessage(conn, String(data)); } catch (e) {
        log('ext message handler error (isolated):', errorMessage(e));
      }
    });
    ws.on('pong', () => { conn.lastSeen = Date.now(); });
    ws.on('close', () => { if (this.#conn === conn) this.#drop('disconnected'); });
    ws.on('error', (e) => log('ext socket error (continuing):', errorMessage(e)));
    ws.send(JSON.stringify({ t: 'hello' }));
  }

  // Forget the current connection: fail in-flight requests immediately (don't
  // make agents wait 30s on a dead pipe) and detach all its targets.
  #drop(reason) {
    const conn = this.#conn;
    this.#conn = null;
    clearInterval(conn.pingTimer);
    for (const { reject, timer } of conn.pending.values()) {
      clearTimeout(timer);
      reject(new Error(`TB_ERR: extension disconnected (${reason})`));
    }
    conn.pending.clear();
    if (reason === 'replaced') { try { conn.ws.close(4009, 'replaced'); } catch {} }
    log(`extension ${reason}`);
    for (const targetId of conn.targets.keys()) this.emit('detached', targetId);
  }

  #onMessage(conn, raw) {
    if (raw === 'ping') return conn.ws.send('pong');
    if (raw === 'pong') return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    debugLog('ext ◄', msg);

    switch (msg.t) {
      case 'scope':
        conn.scope = { mode: msg.mode, allowlist: msg.allowlist || [] };
        log('scope', JSON.stringify(conn.scope));
        return;

      case 'attached': {
        if (!msg.targetId) return;
        const known = conn.targets.get(msg.targetId);
        const target = { targetId: msg.targetId, tabId: msg.tabId, url: msg.url || '', title: msg.title || '' };
        conn.targets.set(target.targetId, target);
        if (known) {
          // re-advertisement of a target we already have: an update, not a new tab
          this.emit('targetInfoChanged', target);
          return;
        }
        log('target attached', target.targetId, target.url);
        this.emit('attached', target);
        return;
      }

      case 'targetInfoChanged': {
        // a just-closed tab can emit one last change; ignore unknown targets
        const target = conn.targets.get(msg.targetId);
        if (!target) return;
        if (msg.url != null) target.url = msg.url;
        if (msg.title != null) target.title = msg.title;
        this.emit('targetInfoChanged', target);
        return;
      }

      case 'detached':
        if (!conn.targets.delete(msg.targetId)) return;
        log('target detached', msg.targetId, `(${msg.reason})`);
        this.emit('detached', msg.targetId);
        return;

      case 'cdpResult': {
        const pending = conn.pending.get(msg.id);
        if (!pending) return;
        conn.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error || 'extension error'));
        return;
      }

      case 'cdpEvent':
        this.emit('cdpEvent', msg.targetId, msg.method, msg.params);
        return;
    }
  }
}
