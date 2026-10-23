// /cdp/:label — speaks the raw CDP wire protocol to Playwright (or any CDP
// client) and maps it onto the extension pipe.
//
// The relay synthesizes the browser-level session (Target.* domain) from the
// extension's target list, so tabs outside the extension's scope simply do
// not exist from the client's point of view. Page-level commands (flat
// sessionId) are forwarded to the owning tab via the extension.

import { WebSocket } from 'ws';
import { errorMessage } from '../lib/errors.mjs';
import { log, debugLog } from './log.mjs';

const BROWSER_TARGET_ID = 'tb-browser';
const DEFAULT_CONTEXT_ID = 'tb-default-browser-context';
const BROWSER_TARGET_INFO = { targetId: BROWSER_TARGET_ID, type: 'browser', title: '', url: '', attached: true };

function targetInfo(target, attached = false) {
  return {
    targetId: target.targetId,
    type: 'page',
    title: target.title || '',
    url: target.url || '',
    attached,
    browserContextId: DEFAULT_CONTEXT_ID, // Playwright asserts this is present
  };
}

class ScopeError extends Error {}

// One connected CDP client.
class CdpClient {
  ws;
  label;
  autoAttach = false;
  #sessionsByTarget = new Map(); // targetId -> cdp sessionId
  #targetsBySession = new Map(); // cdp sessionId -> targetId
  #nextSession = 1;

  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
  }

  send(obj) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    debugLog('cdp ►', obj);
    this.ws.send(JSON.stringify(obj));
  }

  sessionFor(targetId) {
    return this.#sessionsByTarget.get(targetId);
  }

  targetFor(sessionId) {
    return this.#targetsBySession.get(sessionId);
  }

  targetCreated(target) {
    this.send({ method: 'Target.targetCreated', params: { targetInfo: targetInfo(target) } });
  }

  // Idempotent per target: Playwright asserts on duplicate attachedToTarget.
  attach(target) {
    const existing = this.#sessionsByTarget.get(target.targetId);
    if (existing) return existing;
    const sessionId = `tbS-${this.#nextSession++}`;
    this.#sessionsByTarget.set(target.targetId, sessionId);
    this.#targetsBySession.set(sessionId, target.targetId);
    this.send({
      method: 'Target.attachedToTarget',
      params: { sessionId, targetInfo: targetInfo(target, true), waitingForDebugger: false },
    });
    return sessionId;
  }

  detach(targetId) {
    const sessionId = this.#sessionsByTarget.get(targetId);
    if (!sessionId) return;
    this.#sessionsByTarget.delete(targetId);
    this.#targetsBySession.delete(sessionId);
    this.send({ method: 'Target.detachedFromTarget', params: { sessionId, targetId } });
  }
}

export class CdpBridge {
  #clients = new Set();
  #extension;

  constructor({ extension }) {
    this.#extension = extension;
    extension.on('attached', (target) => {
      for (const client of this.#clients) {
        client.targetCreated(target);
        if (client.autoAttach) client.attach(target);
      }
    });
    extension.on('targetInfoChanged', (target) => {
      for (const client of this.#clients) {
        client.send({ method: 'Target.targetInfoChanged', params: { targetInfo: targetInfo(target) } });
      }
    });
    extension.on('detached', (targetId) => {
      for (const client of this.#clients) client.detach(targetId);
    });
    extension.on('cdpEvent', (targetId, method, params) => {
      for (const client of this.#clients) {
        const sessionId = client.sessionFor(targetId);
        if (sessionId) client.send({ method, params, sessionId });
      }
    });
  }

  accept(ws, label) {
    const client = new CdpClient(ws, label);
    this.#clients.add(client);
    log('cdp client connected', `session=${label}`);

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || msg.id == null) return; // not a command we can answer
      debugLog('cdp ◄', msg);
      const { id, method, params = {}, sessionId } = msg;
      try {
        const result = sessionId
          ? await this.#pageCommand(client, sessionId, method, params)
          : await this.#browserCommand(client, method, params);
        client.send(sessionId ? { id, result, sessionId } : { id, result });
        if (!sessionId) this.#afterBrowserReply(client, method);
      } catch (e) {
        const error = { code: -32000, message: errorMessage(e) };
        client.send(sessionId ? { id, error, sessionId } : { id, error });
      }
    });
    ws.on('close', () => {
      this.#clients.delete(client);
      log('cdp client disconnected', `session=${label}`);
    });
    ws.on('error', (e) => log('cdp socket error (continuing):', errorMessage(e)));
  }

  #requireTarget(targetId) {
    const target = this.#extension.getTarget(targetId);
    if (!target) throw new ScopeError('TB_SCOPE: unknown or unpermitted target');
    return target;
  }

  #requireFullScope(action) {
    const ext = this.#extension;
    if (!ext.connected) throw new Error('TB_ERR: extension not connected');
    if (ext.scope.mode !== 'full') throw new ScopeError(`TB_SCOPE: ${action} requires full-browser mode`);
  }

  // Browser session (no sessionId): synthesized from the extension's targets.
  async #browserCommand(client, method, params) {
    const ext = this.#extension;
    switch (method) {
      case 'Target.setDiscoverTargets':
        return {};
      case 'Target.setAutoAttach':
        client.autoAttach = true;
        return {};
      case 'Target.getBrowserContexts':
        return { browserContextIds: [DEFAULT_CONTEXT_ID] };
      case 'Target.getTargets':
        return { targetInfos: ext.targets().map((t) => targetInfo(t)) };
      case 'Target.attachToTarget':
        // real CDP returns { sessionId } — Playwright destructures it
        return { sessionId: client.attach(this.#requireTarget(params.targetId)) };
      case 'Target.getTargetInfo':
        if (!params.targetId) return { targetInfo: BROWSER_TARGET_INFO };
        return { targetInfo: targetInfo(this.#requireTarget(params.targetId), true) };
      case 'Target.createTarget':
        this.#requireFullScope('creating tabs');
        return ext.sendCdp(null, 'Target.createTarget', params);
      case 'Target.closeTarget':
        this.#requireFullScope('closing tabs');
        this.#requireTarget(params.targetId);
        return ext.closeTab(params.targetId);
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: 'Chrome/131.0.0.0', userAgent: 'tailbrowser', jsVersion: '131' };
      default:
        // Permissive for browser-session extras Playwright sends during init
        // (Browser.setDownloadBehavior, Target.setRemoteLocations, ...).
        // Anything needing real semantics is handled explicitly above.
        debugLog('browser-session ok-fallback', method);
        return {};
    }
  }

  // Push the current world state once the client has its reply.
  #afterBrowserReply(client, method) {
    const targets = this.#extension.targets();
    if (method === 'Target.setDiscoverTargets') {
      client.send({ method: 'Target.targetCreated', params: { targetInfo: BROWSER_TARGET_INFO } });
      for (const target of targets) client.targetCreated(target);
    } else if (method === 'Target.setAutoAttach') {
      for (const target of targets) client.attach(target);
    }
  }

  // Page session (flat sessionId): forwarded to the tab via the extension.
  async #pageCommand(client, sessionId, method, params) {
    const targetId = client.targetFor(sessionId);
    if (!targetId) throw new Error(`TB_ERR: unknown sessionId ${sessionId}`);
    switch (method) {
      case 'Runtime.runIfWaitingForDebugger': // our targets are never paused; avoid deadlock
      case 'Target.setAutoAttach': // page-level auto-attach (OOPIFs) is not supported; main-frame ops work
        return {};
      default:
        return (await this.#extension.sendCdp(targetId, method, params)) ?? {};
    }
  }
}
