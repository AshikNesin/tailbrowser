// tailbrowser extension service worker.
// Connects to the relay over WS and pipes CDP between it and chrome.debugger,
// exposing only the tabs the current scope allows:
//   tab        tabs the user opts in from the popup
//   allowlist  tabs whose URL matches a pattern (auto-attached on navigation)
//   full       every tab, plus agent-created tabs
//
// LIFETIME MODEL (why this file looks the way it does):
// Chrome terminates MV3 service workers ~30s after their last event. Since
// Chrome 116, WebSocket traffic does NOT reset that timer, so a worker holding
// the relay connection silently dies when Chrome is not focused. Keep-alive
// is layered:
//   1. offscreen keepalive port (20s pings): primary; resets the idle timer
//      even with Chrome fully in the background
//   2. chrome.alarms (every 30s): wakes the worker if it died anyway (memory
//      pressure, crash, manual stop); on wake it reconnects the WS if needed
//   3. app-level WS ping (20s) with a 75s silence deadline: detects half-open
//      TCP (sleep/wake, network change) and forces a clean reconnect
//
// Everything that must survive a cold restart is persisted:
//   - opts, opted-in tabs, revoke flag  -> chrome.storage.local
//   - attached targets, dismissed tabs  -> chrome.storage.session (cleared on browser restart)
// Event listeners are registered synchronously at top level (MV3 rule) and
// wait for `ready()` before touching state.

const DEFAULT_OPTS = { relay: 'ws://localhost:8787', token: '', configured: false, scopeMode: 'tab', allowlist: [] };
const SCOPE_MODES = ['tab', 'allowlist', 'full'];
const DISCOVERY_CANDIDATES = ['http://localhost:8787', 'http://127.0.0.1:8787'];

const KEEPALIVE_PORT_NAME = 'tb-keepalive';
const KEEPALIVE_ALARM = 'tb-keepalive-alarm';
const PING_INTERVAL_MS = 20_000;
const SILENCE_DEADLINE_MS = 75_000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30_000;

// never exposed in allowlist mode, whatever the patterns say
const PRIVILEGED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

const BADGE = { gray: '#666', red: '#c0392b', green: '#1a9f47' };

// ---------- state ----------

let opts = { ...DEFAULT_OPTS };
let revoked = false; // "Disconnect agent": stay dark until settings are saved again
const optedIn = new Set(); // tabIds the user opted in
const dismissed = new Set(); // tabIds the user dismissed the debugger banner on / opted out of; never auto-attach
const attached = new Map(); // tabId -> CDP targetId
const attaching = new Map(); // tabId -> Promise<targetId>, so concurrent attaches share one

const relay = { ws: null, connected: false, lastHeardAt: 0, retryDelay: RETRY_MIN_MS, retryTimer: 0, lastError: null };
let keepalivePort = null; // port from the offscreen document

const log = (...args) => console.log('[tb]', ...args);
const errorMessage = (e) => String((e && e.message) || e);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- boot ----------

let bootPromise = null;

// Resolves once persisted state is restored. Runs on every cold start of the
// worker (extension load, browser restart, worker restart after termination).
function ready() {
  bootPromise ??= boot().catch((e) => {
    // a failed boot must not leave the worker dark, so retry
    log('boot failed, retrying in 5s', errorMessage(e));
    bootPromise = null;
    setTimeout(() => ready().catch(() => {}), 5000);
    throw e;
  });
  return bootPromise;
}

async function boot() {
  const local = await chrome.storage.local.get(['tbOpts', 'tbOptedIn', 'tbRevoked']);
  opts = { ...DEFAULT_OPTS, ...local.tbOpts };
  for (const tabId of local.tbOptedIn || []) optedIn.add(tabId);
  revoked = !!local.tbRevoked;
  await restoreAttached();
  log('boot', opts.relay, opts.configured ? '(configured)' : '(unconfigured)', `attached=${attached.size}`);
  await ensureKeepalive();
  connect();
}

// run an event handler once state is restored; never let it throw into Chrome
function whenReady(handler) {
  ready().then(handler).catch((e) => log('handler error', errorMessage(e)));
}

// ---------- persistence ----------

function persistLocal() {
  return chrome.storage.local.set({ tbOpts: opts, tbOptedIn: [...optedIn], tbRevoked: revoked });
}

function persistSession() {
  const targets = [...attached].map(([tabId, targetId]) => ({ tabId, targetId }));
  return chrome.storage.session.set({ tbRuntime: { targets, dismissed: [...dismissed] } }).catch(() => {});
}

// chrome.debugger attachments outlive worker restarts. Re-adopt tabs we had
// attached before (recorded in storage.session) that are still attached,
// never tabs someone else (e.g. DevTools) happens to be debugging.
async function restoreAttached() {
  const { tbRuntime } = await chrome.storage.session.get('tbRuntime');
  for (const tabId of tbRuntime?.dismissed || []) dismissed.add(tabId);
  const previous = new Set((tbRuntime?.targets || []).map((t) => t.tabId));
  if (!previous.size) return;
  for (const t of await chrome.debugger.getTargets()) {
    if (t.attached && previous.has(t.tabId)) attached.set(t.tabId, t.id);
  }
  persistSession();
}

// ---------- scope ----------

function globToRegExp(pattern) {
  return new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

function matchesAllowlist(url) {
  if (!url || PRIVILEGED_URL.test(url)) return false;
  return opts.allowlist.some((pattern) => globToRegExp(pattern).test(url));
}

// may this tab be exposed to agents under the current scope?
function inScope(tab) {
  switch (opts.scopeMode) {
    case 'full': return true;
    case 'allowlist': return matchesAllowlist(tab.url || tab.pendingUrl);
    default: return optedIn.has(tab.id);
  }
}

// attach without the user asking? (scope allows it and they haven't said no)
function shouldAttach(tab) {
  return relay.connected && !dismissed.has(tab.id) && inScope(tab);
}

function requireFullScope(action) {
  if (opts.scopeMode !== 'full') throw new Error(`TB_SCOPE: ${action} requires full-browser mode`);
}

// Bring attachments in line with the scope: detach what it no longer allows,
// attach what it now allows. Called on connect and on every settings change.
async function reconcileScope() {
  for (const tab of await chrome.tabs.query({})) {
    if (attached.has(tab.id)) {
      if (!inScope(tab)) await detachTab(tab.id, 'out-of-scope');
    } else if (shouldAttach(tab)) {
      await attachTab(tab.id).catch((e) => log('auto-attach skipped', tab.id, errorMessage(e)));
    }
  }
  log(`scope ${opts.scopeMode}: ${attached.size} tab(s) attached`);
}

// ---------- attach / detach ----------

// in-flight attaches are shared, and only settle once the relay has been told
function attachTab(tabId) {
  if (attaching.has(tabId)) return attaching.get(tabId);
  if (attached.has(tabId)) return Promise.resolve(attached.get(tabId));
  const pending = doAttach(tabId).finally(() => attaching.delete(tabId));
  attaching.set(tabId, pending);
  return pending;
}

async function doAttach(tabId) {
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (e) {
    // our own stale attach (worker restarted and lost track of it): take it over
    if (!errorMessage(e).includes('Another debugger is already attached')) throw e;
    try { await chrome.debugger.detach(debuggee); } catch {}
    await chrome.debugger.attach(debuggee, '1.3');
  }
  const targetId = await resolveTargetId(tabId);
  attached.set(tabId, targetId);
  persistSession();
  refreshBadge();
  await advertise(tabId, targetId);
  return targetId;
}

// The REAL CDP targetId. Playwright treats it as the main frame id, so a
// synthetic id breaks every frame op. A brand-new tab can take a moment to
// show up in getTargets, so retry briefly.
async function resolveTargetId(tabId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const target = (await chrome.debugger.getTargets()).find((t) => t.tabId === tabId);
      if (target?.id) return target.id;
    } catch (e) { log('getTargets failed', errorMessage(e)); }
    await sleep(100);
  }
  try { await chrome.debugger.detach({ tabId }); } catch {}
  throw new Error(`TB_ERR: could not resolve CDP target for tab ${tabId} (is the tab still alive?)`);
}

// drop our record of a tab and tell the relay; the debugger itself is untouched
function forgetTab(tabId, reason) {
  const targetId = attached.get(tabId);
  if (!targetId) return;
  attached.delete(tabId);
  persistSession();
  refreshBadge();
  send({ t: 'detached', tabId, targetId, reason });
}

async function detachTab(tabId, reason) {
  if (!attached.has(tabId)) return;
  forgetTab(tabId, reason);
  try { await chrome.debugger.detach({ tabId }); } catch {}
}

// announce a target to the relay; awaited by attach so the relay always
// hears 'attached' before any reply that mentions the target (Playwright
// looks the page up the moment createTarget answers)
async function advertise(tabId, targetId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    send({ t: 'attached', tabId, targetId, url: tab.url || '', title: tab.title || '' });
  } catch {}
}

function tabForTarget(targetId) {
  for (const [tabId, id] of attached) if (id === targetId) return tabId;
  return null;
}

// ---------- relay connection ----------

function send(msg) {
  if (relay.ws?.readyState === WebSocket.OPEN) relay.ws.send(JSON.stringify(msg));
}

function closeSocket(code, reason) {
  const sock = relay.ws;
  relay.ws = null; // its onclose sees it was superseded and stays quiet
  relay.connected = false;
  if (sock) { try { sock.close(code, reason); } catch {} }
}

// (Re)dial the relay with the current settings.
function connect() {
  clearTimeout(relay.retryTimer);
  closeSocket();
  refreshBadge();
  if (!opts.configured || revoked) return;

  let sock;
  try {
    sock = new WebSocket(`${opts.relay}/extension?token=${encodeURIComponent(opts.token)}&v=1`);
  } catch (e) {
    relay.lastError = `invalid relay URL: ${errorMessage(e)}`;
    log(relay.lastError);
    return;
  }
  log('connecting', opts.relay);
  sock.openedAt = Date.now(); // for stuck-CONNECTING detection
  relay.ws = sock;

  sock.onopen = () => {
    if (relay.ws !== sock) return;
    relay.connected = true;
    relay.retryDelay = RETRY_MIN_MS;
    relay.lastHeardAt = Date.now();
    relay.lastError = null;
    log('connected to relay');
    refreshBadge();
    startPingLoop(sock);
    send({ t: 'scope', mode: opts.scopeMode, allowlist: opts.allowlist });
    for (const [tabId, targetId] of attached) advertise(tabId, targetId); // post-restart re-advertise
    reconcileScope().catch((e) => log('reconcile failed', errorMessage(e)));
  };
  sock.onclose = () => {
    if (relay.ws !== sock) return; // superseded by a newer socket
    relay.ws = null;
    relay.connected = false;
    relay.lastError ??= 'relay closed the connection';
    refreshBadge();
    if (revoked || !opts.configured) return;
    // mild backoff so a dead relay doesn't spin the CPU; alarms are the backstop
    relay.retryTimer = setTimeout(connect, relay.retryDelay);
    relay.retryDelay = Math.min(relay.retryDelay * 1.7, RETRY_MAX_MS);
  };
  sock.onerror = () => {
    relay.lastError = 'relay unreachable (or token rejected)';
    try { sock.close(); } catch {}
  };
  sock.onmessage = (ev) => {
    relay.lastHeardAt = Date.now(); // any traffic proves liveness
    handleRelayMessage(String(ev.data)).catch((e) => log('relay message error', errorMessage(e)));
  };
}

// app-level ping bound to one socket instance; dies with it
function startPingLoop(sock) {
  const timer = setInterval(() => {
    if (relay.ws !== sock || sock.readyState !== WebSocket.OPEN) return clearInterval(timer);
    if (Date.now() - relay.lastHeardAt > SILENCE_DEADLINE_MS) {
      clearInterval(timer);
      log('relay silent (half-open socket), reconnecting');
      return connect();
    }
    sock.send('ping');
  }, PING_INTERVAL_MS);
}

// Idempotent health check from alarm ticks: no-op when healthy, otherwise
// recycle a half-open / stuck socket or redial.
function ensureConnection() {
  if (revoked || !opts.configured) return;
  const sock = relay.ws;
  if (!sock) return connect();
  const now = Date.now();
  if (relay.connected && now - relay.lastHeardAt > SILENCE_DEADLINE_MS) {
    log(`relay silent ${Math.round((now - relay.lastHeardAt) / 1000)}s (half-open socket), reconnecting`);
    return connect();
  }
  // a half-open TCP endpoint can sit in CONNECTING forever
  if (sock.readyState === WebSocket.CONNECTING && now - sock.openedAt > SILENCE_DEADLINE_MS) {
    log('socket stuck in CONNECTING, reconnecting');
    connect();
  }
}

// ---------- relay protocol ----------

async function handleRelayMessage(raw) {
  if (raw === 'ping' || raw === 'pong') return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg?.t) {
    case 'cdp': return answer(msg.id, () => runCdp(msg));
    case 'closeTab': return answer(msg.id, () => closeTabForAgent(msg.targetId));
    // 'hello' and anything unknown: nothing to do
  }
}

// Always answer a request id: a throw must never leave the relay hanging.
async function answer(id, fn) {
  try {
    send({ t: 'cdpResult', id, ok: true, result: await fn() });
  } catch (e) {
    send({ t: 'cdpResult', id, ok: false, error: errorMessage(e) });
  }
}

async function runCdp({ targetId, method, params }) {
  if (method === 'Target.createTarget' && targetId == null) return createTabForAgent(params);
  const tabId = tabForTarget(targetId);
  if (tabId == null) throw new Error(`TB_SCOPE: unknown or unpermitted target ${targetId}`);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function createTabForAgent(params) {
  requireFullScope('creating new tabs');
  const tab = await chrome.tabs.create({ url: params?.url || 'about:blank', active: false });
  return { targetId: await attachTab(tab.id), newTab: true };
}

async function closeTabForAgent(targetId) {
  requireFullScope('closing tabs');
  const tabId = tabForTarget(targetId);
  if (tabId == null) throw new Error('TB_SCOPE: unknown target');
  await chrome.tabs.remove(tabId);
  return { success: true };
}

// ---------- keepalive ----------

async function ensureKeepalive() {
  await ensureOffscreen();
  await ensureAlarm();
}

// The offscreen document holds a runtime.Port to this worker and posts a
// message every 20s; each message resets the worker's idle timer. Offscreen
// documents are never throttled, which is exactly why they can do this job.
async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Holds a keepalive port so the service worker (and its relay WebSocket) stays alive while Chrome is in the background',
    });
  } catch (e) {
    log('offscreen create failed', errorMessage(e));
  }
}

// Safety net under the offscreen port: if the worker is terminated anyway,
// the alarm restarts it and the handler verifies the connection.
async function ensureAlarm() {
  try {
    if (await chrome.alarms.get(KEEPALIVE_ALARM)) return;
    await chrome.alarms.create(KEEPALIVE_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  } catch (e) {
    log('alarm create failed', errorMessage(e));
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT_NAME) return;
  keepalivePort = port;
  port.onMessage.addListener((msg) => {
    if (msg?.t === 'ping') { try { port.postMessage({ t: 'pong' }); } catch {} }
  });
  port.onDisconnect.addListener(() => {
    if (keepalivePort === port) keepalivePort = null;
    setTimeout(ensureOffscreen, 1000); // offscreen doc went away; recreate it
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  whenReady(() => {
    if (!keepalivePort) ensureOffscreen();
    ensureConnection();
  });
});

// ---------- badge ----------

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}

function refreshBadge() {
  if (!opts.configured) return setBadge('SETUP', BADGE.gray);
  if (revoked) return setBadge('OFF', BADGE.red);
  if (!relay.connected) return setBadge('OFF', BADGE.gray);
  setBadge(attached.size ? String(attached.size) : '', BADGE.green);
}

// ---------- chrome events ----------

chrome.debugger.onEvent.addListener((source, method, params) => {
  const targetId = attached.get(source.tabId);
  if (targetId) send({ t: 'cdpEvent', targetId, method, params });
});

chrome.debugger.onDetach.addListener(({ tabId }, reason) => whenReady(async () => {
  if (reason === 'canceled_by_user') {
    // the user dismissed Chrome's debugging banner: that tab is out of scope until they opt it in again
    dismissed.add(tabId);
    optedIn.delete(tabId);
    await persistLocal();
  }
  forgetTab(tabId, reason === 'canceled_by_user' ? 'dismissed' : 'browser');
}));

chrome.tabs.onCreated.addListener((tab) => whenReady(async () => {
  if (shouldAttach(tab)) await attachTab(tab.id);
}));

chrome.tabs.onRemoved.addListener((tabId) => whenReady(async () => {
  forgetTab(tabId, 'closed');
  if (optedIn.delete(tabId)) await persistLocal();
  if (dismissed.delete(tabId)) persistSession();
}));

chrome.tabs.onUpdated.addListener((tabId, change, tab) => whenReady(async () => {
  if (change.url === undefined && change.title === undefined) return;
  if (attached.has(tabId)) {
    if (!inScope(tab)) return detachTab(tabId, 'out-of-scope');
    send({ t: 'targetInfoChanged', targetId: attached.get(tabId), url: tab.url, title: tab.title });
  } else if (change.url && shouldAttach(tab)) {
    await attachTab(tabId); // allowlist mode: the tab navigated into scope
  }
}));

// ---------- popup API ----------

function normalizeRelayUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '').replace(/^http(s?):/i, 'ws$1:');
  if (!/^wss?:\/\/[^/\s]+$/i.test(url)) throw new Error('Relay URL must look like ws://<host>:8787');
  return url;
}

// relay connection settings: (re)authorizes the agent and redials
async function saveSettings(incoming = {}) {
  const next = { ...opts };
  if (incoming.relay !== undefined) {
    next.relay = normalizeRelayUrl(incoming.relay);
    next.configured = true;
  }
  if (typeof incoming.token === 'string') next.token = incoming.token.trim(); // undefined = keep the stored token
  opts = next;
  return resume();
}

// lift a revoke and reconnect with the current settings
async function resume() {
  revoked = false;
  relay.retryDelay = RETRY_MIN_MS;
  relay.lastError = null;
  await persistLocal();
  await ensureKeepalive();
  connect(); // re-advertises + reconciles scope once open
  return { ok: true };
}

// scope settings: applied in place: the relay is told, no reconnect needed
async function setScope({ scopeMode, allowlist }) {
  if (scopeMode !== undefined) {
    if (!SCOPE_MODES.includes(scopeMode)) throw new Error(`unknown scope mode: ${scopeMode}`);
    opts.scopeMode = scopeMode;
  }
  if (Array.isArray(allowlist)) opts.allowlist = allowlist.map((p) => String(p).trim()).filter(Boolean);
  await persistLocal();
  send({ t: 'scope', mode: opts.scopeMode, allowlist: opts.allowlist });
  await reconcileScope(); // detaches whatever the new scope no longer allows
  return { ok: true };
}

async function probeRelay(base) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

async function discoverRelay() {
  for (const base of DISCOVERY_CANDIDATES) {
    if (await probeRelay(base)) {
      const relayUrl = base.replace(/^http/, 'ws');
      await saveSettings({ relay: relayUrl });
      return { ok: true, relay: relayUrl };
    }
  }
  return { ok: false, error: 'No relay found on this machine. Start one with `npx tailbrowser relay` or enter its URL.' };
}

async function optIn(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (opts.scopeMode === 'allowlist' && !matchesAllowlist(tab.url)) {
    throw new Error("This tab's URL doesn't match the allowlist");
  }
  optedIn.add(tabId);
  dismissed.delete(tabId);
  await persistLocal();
  try {
    await attachTab(tabId);
  } catch (e) {
    optedIn.delete(tabId);
    await persistLocal();
    throw e;
  }
  return { ok: true };
}

async function optOut(tabId) {
  optedIn.delete(tabId);
  dismissed.add(tabId); // don't let full/allowlist mode re-attach it behind the user's back
  await persistLocal();
  await detachTab(tabId, 'user');
  persistSession();
  return { ok: true };
}

// hard revoke: drop the relay link and every debugger attachment, and stay
// down (across worker restarts) until settings are saved again
async function revoke() {
  revoked = true;
  await persistLocal();
  closeSocket(4000, 'revoked');
  clearTimeout(relay.retryTimer);
  for (const tabId of [...attached.keys()]) await detachTab(tabId, 'revoked');
  refreshBadge();
  return { ok: true };
}

async function getStatus() {
  const tabs = await Promise.all([...attached.keys()].map(async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      return { tabId, url: tab.url || '', title: tab.title || '', favIconUrl: tab.favIconUrl || '' };
    } catch {
      return { tabId, url: '', title: '' };
    }
  }));
  return {
    state: !opts.configured ? 'setup' : revoked ? 'revoked' : relay.connected ? 'connected' : 'connecting',
    relay: opts.relay,
    hasToken: !!opts.token,
    scopeMode: opts.scopeMode,
    allowlist: opts.allowlist,
    attached: tabs,
    lastError: relay.connected ? null : relay.lastError,
    keepalive: { port: !!keepalivePort, lastHeardAgoMs: relay.lastHeardAt ? Date.now() - relay.lastHeardAt : null },
  };
}

const popupHandlers = {
  getStatus: () => getStatus(),
  saveOpts: (msg) => saveSettings(msg.opts),
  setScope: (msg) => setScope(msg),
  reconnect: () => resume(),
  discover: () => discoverRelay(),
  optIn: (msg) => optIn(msg.tabId),
  optOut: (msg) => optOut(msg.tabId),
  disconnectAgent: () => revoke(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = popupHandlers[msg?.t];
  if (!handler) return false;
  ready()
    .then(() => handler(msg))
    .then(sendResponse, (e) => sendResponse({ ok: false, error: errorMessage(e) }));
  return true; // async sendResponse
});

ready().catch(() => {});
