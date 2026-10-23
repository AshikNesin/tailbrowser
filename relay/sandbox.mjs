// Snippet sessions: isolated `state` per session, one shared Playwright
// connection (through this relay's own /cdp endpoint) for all of them. Tabs
// are shared, state is not.

import vm from 'node:vm';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { errorMessage } from '../lib/errors.mjs';
import { log } from './log.mjs';

const SNIPPET_TIMEOUT_MS = 120_000;
const SYNC_COMPILE_TIMEOUT_MS = 10_000;

// ---------- sessions ----------

export class SessionStore {
  #sessions = new Map(); // id -> { id, created, lastUsed, state, page }
  #nextId = 1;

  constructor({ idleMs = 30 * 60_000 } = {}) {
    setInterval(() => this.#sweep(idleMs), 60_000).unref();
  }

  get size() {
    return this.#sessions.size;
  }

  // New session with a fresh numeric id (skipping ids a client already claimed).
  create() {
    let id;
    do id = String(this.#nextId++); while (this.#sessions.has(id));
    return this.getOrCreate(id);
  }

  getOrCreate(id) {
    let session = this.#sessions.get(id);
    if (!session) {
      session = { id, created: Date.now(), lastUsed: Date.now(), state: {}, page: null };
      this.#sessions.set(id, session);
    }
    return session;
  }

  // false if there is no such session
  reset(id) {
    const session = this.#sessions.get(id);
    if (!session) return false;
    session.state = {};
    session.page = null;
    return true;
  }

  list() {
    return [...this.#sessions.values()].map((s) => ({ id: s.id, created: s.created, stateKeys: Object.keys(s.state) }));
  }

  #sweep(idleMs) {
    const now = Date.now();
    for (const s of this.#sessions.values()) if (now - s.lastUsed > idleMs) this.#sessions.delete(s.id);
  }
}

// ---------- snippet execution ----------

// A failed snippet; carries the console output captured before the failure.
export class SnippetError extends Error {
  constructor(message, logs = []) {
    super(message);
    this.logs = logs;
  }
}

function formatLogArg(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

// make a snippet result safe to put in a JSON response
export function toJsonSafe(value) {
  try { return JSON.parse(JSON.stringify(value === undefined ? null : value)); } catch { return String(value); }
}

async function ariaSnapshot(page) {
  try { return await page.locator('body').ariaSnapshot(); } catch {}
  try { return JSON.stringify(await page.accessibility.snapshot(), null, 1); } catch { return null; }
}

// node builtins + this package's dependencies
const sandboxRequire = createRequire(new URL('../package.json', import.meta.url));

export class SnippetRunner {
  #cdpUrl;
  #extension;
  #browser = null;
  #browserGeneration = -1; // extension generation the cached browser belongs to
  #connecting = null; // in-flight connectOverCDP, shared by concurrent callers

  constructor({ cdpUrl, extension }) {
    this.#cdpUrl = cdpUrl;
    this.#extension = extension;
  }

  // The cached Playwright browser, recycled whenever the extension reconnects:
  // after a flap the old object graph points at targets that no longer exist.
  async #getBrowser() {
    const generation = this.#extension.generation;
    if (this.#browser && this.#browserGeneration !== generation) {
      log('extension generation changed, recycling cached Playwright connection');
      const stale = this.#browser;
      this.#browser = null;
      try { await stale.close(); } catch {} // closes only its ws to this relay
    }
    if (this.#browser) return this.#browser;

    this.#connecting ??= chromium.connectOverCDP(this.#cdpUrl)
      .then((browser) => {
        this.#browser = browser;
        this.#browserGeneration = generation;
        browser.on('disconnected', () => {
          if (this.#browser === browser) this.#browser = null;
        });
        return browser;
      })
      .finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async run(session, code) {
    session.lastUsed = Date.now();
    const logs = [];
    const fail = (e) => new SnippetError(errorMessage(e), logs);

    if (!this.#extension.connected) {
      throw fail('TB_ERR: extension not connected. Is the Chrome device up? (popup: relay status)');
    }
    let timer;
    try {
      const browser = await this.#getBrowser();
      const context = browser.contexts()[0];
      if (!context) throw new Error('TB_ERR: no browser context; attach a tab first (or use full-browser mode)');

      const scope = buildScope({ session, context, logs });
      const snippet = vm.runInNewContext(`(async (require, import_) => {\n${code}\n})`, scope, { timeout: SYNC_COMPILE_TIMEOUT_MS });
      const result = await Promise.race([
        snippet(sandboxRequire, (spec) => import(spec)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`TB_TIMEOUT: snippet exceeded ${SNIPPET_TIMEOUT_MS / 1000}s`)), SNIPPET_TIMEOUT_MS);
        }),
      ]);
      return { result, logs };
    } catch (e) {
      // anything can be thrown (`throw "x"`, `throw null`), so normalize it
      throw fail(e);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Globals visible to a snippet.
function buildScope({ session, context, logs }) {
  const capture = (...args) => logs.push(args.map(formatLogArg).join(' '));
  const pageOf = (arg) => arg?.page || arg || scope.page;
  const scope = {
    console: { log: capture, info: capture, warn: capture, error: capture, debug: capture },
    state: session.state,
    context,
    pages: () => context.pages(),
    snapshot: async (arg) => ariaSnapshot(pageOf(arg)),
    screenshot: async (arg) => (await pageOf(arg).screenshot({ type: 'png' })).toString('base64'),
    newPage: () => context.newPage(), // relay answers TB_SCOPE unless full-browser mode
  };
  Object.defineProperty(scope, 'page', {
    // Heals across extension flaps: a stale stored Page (from before the
    // connection was recycled) falls through to a live page automatically.
    get() {
      const stored = session.page;
      if (stored && !stored.isClosed()) { try { if (stored.context() === context) return stored; } catch {} }
      const first = context.pages()[0];
      if (first) return first;
      throw new Error('TB_ERR: no page available; opt in a tab in the extension popup, or set scope to Entire browser');
    },
    set(value) { session.page = value; },
    configurable: true,
  });
  return scope;
}
