// tailbrowser M0 — extension service worker
// Connects to the relay over WS, pipes CDP between relay and chrome.debugger.
// M0 scope = tab mode: only tabs the user opts in via the popup (or icon click).
//
// LIFETIME MODEL (why this file looks the way it does):
// Chrome terminates MV3 service workers ~30s after their last event. Since
// Chrome 116, WebSocket traffic does NOT reset that timer. So a background
// worker holding "the relay connection" silently dies when Chrome is not
// focused — exactly the bug this design fixes. Keep-alive is layered:
//
//   1. offscreen keepalive port (20s pings) — primary; resets the idle timer
//      even with Chrome fully in the background
//   2. chrome.alarms (every 30s)            — wakes the worker if it died
//      anyway (memory pressure, crash, manual stop): on wake it reconnects
//      the WS if needed
//   3. app-level WS ping/pong (20s ping / 75s pong deadline) — detects
//      half-open TCP (sleep/wake, network change) and forces a clean reconnect
//
// Everything that must survive a cold restart is persisted:
//   - opts, optedIn tabs    -> chrome.storage.local
//   - runtime liveness data -> chrome.storage.session (cleared on browser restart)

const DEFAULT_RELAY = 'ws://localhost:8787';

// ---- state (service worker lifetime) ----
let ws = null;
let connected = false;
let opts = null; // { relay, token, scopeMode, allowlist }
let optedIn = new Set(); // tabIds the user opted in
let attached = new Map(); // tabId -> { sessionId, targetId }

// ---- keepalive / connection health ----
const KEEPALIVE_PORT_NAME = 'tb-keepalive';
const PING_INTERVAL_MS = 20_000;
const PONG_DEADLINE_MS = 75_000;
const ALARM_KEEPALIVE = 'tb-keepalive-alarm';

let keepalivePort = null; // port from the offscreen document
let lastPongAt = 0; // last time we heard anything from the relay
let reconnectTimer = 0;
let retryDelay = 2000; // reconnect backoff, reset on successful connect
let booted = false; // guards against re-entrant boot() via alarm firing early
let revoked = false; // true after "Disconnect agent" — stop dialing until re-saved

// ---- persistence ----

async function loadOpts() {
  const { tbOpts } = await chrome.storage.local.get('tbOpts');
  opts = { relay: DEFAULT_RELAY, token: '', configured: false, scopeMode: 'tab', allowlist: [], ...tbOpts };
  if (!tbOpts) await chrome.storage.local.set({ tbOpts: opts });
  return opts;
}

async function saveOpts() {
  await chrome.storage.local.set({ tbOpts: opts });
}

// optedIn tab ids survive worker restarts via storage.local (tab ids are stable
// for the lifetime of the browser process)
async function persistOptedIn() {
  await chrome.storage.local.set({ tbOptedIn: [...optedIn] });
}

async function restoreOptedIn() {
  const { tbOptedIn } = await chrome.storage.local.get('tbOptedIn');
  optedIn = new Set(tbOptedIn || []);
}

// per-run liveness (attached target ids) -> storage.session, so a restarted
// worker re-advertises the same targets without re-attaching (debugger
// attachments outlive worker restarts)
async function persistRuntimeState() {
  const targets = [];
  for (const [tabId, info] of attached) targets.push({ tabId, targetId: info.targetId });
  await chrome.storage.session.set({ tbRuntime: { targets, at: Date.now() } });
}

async function restoreRuntimeState() {
  try {
    const { tbRuntime } = await chrome.storage.session.get('tbRuntime');
    if (tbRuntime && tbRuntime.targets) {
      for (const t of tbRuntime.targets) {
        if (t.tabId != null && !attached.has(t.tabId)) attached.set(t.tabId, { sessionId: 'tb-' + t.tabId, targetId: t.targetId });
      }
    }
  } catch {}
}

// ---- badge ----

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}

async function refreshBadge() {
  if (!connected) return setBadge('OFF', '#666');
  if (attached.size === 0) return setBadge('', '#eaa600');
    return setBadge(String(attached.size), '#1a9f47');
}

// ---- tab mode helpers ----

async function isOptedIn(tabId) {
  if (opts.scopeMode === 'full') return true;
  const tab = await chrome.tabs.get(tabId);
  if (opts.scopeMode === 'allowlist') return matchAllowlist(tab.url || '');
  return optedIn.has(tabId);
}

function matchAllowlist(url) {
  // deny privileged URLs always
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)) return false;
  return opts.allowlist.some((p) => globMatch(p, url));
}

function globMatch(pat, s) {
  const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(s);
}

// ---- keepalive: offscreen document ----

// The offscreen document holds a runtime.Port to this worker and posts a
// message every 20s. Every message received on the port resets the worker's
// idle timer, so the worker never goes idle while the port lives — even when
// Chrome itself is in the background. Offscreen documents are never throttled
// by Chrome, which is exactly why they can do this job.
async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'], // 'WORKERS' is the accepted reason for long-lived background scripting
      justification: 'Holds a keepalive port so the service worker (and its relay WebSocket) stays alive while Chrome is in the background',
    });
  } catch (e) {
    log('offscreen create failed', String((e && e.message) || e));
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT_NAME) return;
  keepalivePort = port;
  port.onMessage.addListener((msg) => {
    // the message itself is the point — receiving it resets the idle timer
    if (msg && msg.t === 'ping') {
      try { port.postMessage({ t: 'pong' }); } catch {}
    }
  });
  port.onDisconnect.addListener(() => {
    if (keepalivePort === port) keepalivePort = null;
    // offscreen doc went away (usually because this worker restarted) — recreate
    setTimeout(ensureOffscreen, 1000);
  });
});

// ---- keepalive: alarms fallback ----

// If the worker is terminated anyway (memory pressure, crash, manual stop),
// the periodic alarm fires, Chrome restarts the worker, and the alarm handler
// verifies the connection chain and reconnects if needed. This is the safety
// net under the offscreen port.
async function ensureAlarm() {
  try {
    await chrome.alarms.clear(ALARM_KEEPALIVE);
    await chrome.alarms.create(ALARM_KEEPALIVE, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  } catch (e) {
    log('alarm create failed', String((e && e.message) || e));
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_KEEPALIVE) return;
  if (!booted) { boot().catch((e) => log('boot (alarm) failed', e)); return; }
  // worker just woke (or was alive): make sure the keepalive chain + WS are healthy
  if (!keepalivePort) ensureOffscreen(); // no await — fire and forget
  ensureConnection(); // healthy connection => no-op
});

// ---- connection supervision ----

// Idempotent health check, called from: alarm ticks, port connects, reconnect
// timers. If connected and the relay answered recently, do nothing. If the
// relay went silent past the pong deadline, the socket is half-open (sleep /
// wake, network switch) — recycle it and redial. If not connected but
// configured, dial.
async function ensureConnection() {
  clearTimeout(reconnectTimer);
  if (revoked) return; // user revoked agent access — intentionally dark
  if (ws && connected) {
    const staleFor = Date.now() - lastPongAt;
    if (staleFor > PONG_DEADLINE_MS) {
      log(`relay silent ${Math.round(staleFor / 1000)}s — half-open socket, recycling`);
      try { ws.close(); } catch {} // onclose handles the redial
      return;
    }
    return; // healthy
  }
  // stuck-CONNECTING socket: a half-open TCP endpoint can sit in CONNECTING
  // forever. Anything older than the pong deadline gets terminated and redialed.
  if (ws && ws.readyState === 0 && ws.__openedAt && Date.now() - ws.__openedAt > PONG_DEADLINE_MS) {
    log('socket stuck in CONNECTING — recycling');
    try { ws.close(); } catch {}
    return; // onclose -> reconnect timer
  }
  if (!ws && opts && opts.configured) {
    reconnectTimer = setTimeout(() => connect(), 0);
  }
}

// ---- relay discovery (tailnet scan) ----
// Probes tailnet IPs' /health. The extension can't run `tailscale status`, but it
// can ask the user for the tailscale IP range OR scan the most common case:
// we can't enumerate peers from inside the extension, so we rely on the relay
// being reachable at a known/host IP. Instead we support:
//   1. explicit URL (manual, always)
//   2. localhost:8787 (relay on same machine — the Mac mini case)
//   3. MagicDNS name: http://<hostname>:8787 via a candidate list the user gives
// Manual URL stays the primary path; this is a convenience fallback.

async function probeRelay(base) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.ok === true ? base.replace(/^http/, 'ws') : null;
  } catch { return null; }
}

async function discoverRelay() {
  const candidates = [
    'http://localhost:8787',
    'http://127.0.0.1:8787',
  ];
  for (const c of candidates) {
    const ws = await probeRelay(c);
    if (ws) return ws;
  }
  return null;
}

// ---- WS to relay ----

function connect() {
  if (!opts.configured) {
    // unconfigured: don't dial, don't retry — wait for popup save
    connected = false;
    ws = null;
    setBadge('SETUP', '#666');
    log('not configured — set the relay URL (token optional) in the popup');
    return;
  }
  if (ws) { try { ws.close(); } catch {} }
  clearTimeout(reconnectTimer);
  log('connecting', opts.relay);
  const sock = new WebSocket(`${opts.relay}/extension?token=${encodeURIComponent(opts.token)}&v=1`);
  sock.__openedAt = Date.now(); // birth time for stuck-CONNECTING detection
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return; // stale socket won the race
    connected = true;
    retryDelay = 2000;
    lastPongAt = Date.now();
    log('connected to relay');
    refreshBadge();
    startPingLoop(sock);
    send({ t: 'scope', mode: opts.scopeMode, allowlist: opts.allowlist });
    // advertise currently-attached targets (post-resume)
    for (const [tabId, info] of attached) sendAttached(tabId, info);
    // full-browser mode: auto-attach to every existing tab
    if (opts.scopeMode === 'full') autoAttachAll();
  };
  sock.onclose = () => {
    if (ws !== sock) return; // a newer socket has taken over
    connected = false;
    ws = null;
    refreshBadge();
    if (revoked) return; // user revoked — stay down until they save settings
    // retry while configured, with mild backoff (2s -> 30s) so a dead relay
    // doesn't spin the CPU; alarms still tick as a backstop
    if (opts.configured) {
      reconnectTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 1.7, 30_000);
    }
  };
  sock.onerror = () => { try { sock.close(); } catch {} };
  sock.onmessage = (ev) => {
    lastPongAt = Date.now(); // any traffic proves liveness
    handleMessage(String(ev.data)).catch(e => log('handle error', e));
  };
}

// WS-level ping loop bound to a specific socket instance; dies with the socket.
function startPingLoop(sock) {
  setTimeout(function ping() {
    if (ws !== sock || sock.readyState !== 1) return; // socket replaced/closed
    sock.send('ping');
    setTimeout(ping, PING_INTERVAL_MS);
  }, PING_INTERVAL_MS);
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function log(...a) {
  console.log('[tb]', ...a);
}
async function handleMessage(raw) {
  if (raw === 'ping' || raw === 'pong') return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.t) {
    case 'hello': {
      // relay ack; nothing to do
      return;
    }
    case 'cdp': {
      // relay -> extension: run a CDP command on a target. Isolated: a throw
      // here must never leave the relay hanging — always answer the envelope id.
      const { id, targetId, method, params, sessionId } = msg;
      const tabId = findTabByTarget(targetId);
      try {
        if (method === 'Target.createTarget' && targetId == null) {
          // browser-level create target: only in full mode
          if (opts.scopeMode !== 'full') throw new Error('TB_SCOPE: creating new tabs requires full-browser mode');
          const url = (params && params.url) || 'about:blank';
          const tab = await chrome.tabs.create({ url, active: false });
          const info = await attachTab(tab.id, { createdByAgent: true });
          send({ t: 'cdpResult', id, ok: true, result: { targetId: info.targetId, newTab: true } });
          return;
        }
        if (tabId == null) throw new Error('TB_SCOPE: unknown or unpermitted target ' + targetId);
        const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
        send({ t: 'cdpResult', id, ok: true, result, sessionId });
      } catch (e) {
        send({ t: 'cdpResult', id, ok: false, error: String(e && e.message || e), sessionId });
      }
      return;
    }
    case 'attach': {
      // relay asks extension to attach to a tab (user-driven in M0; relay never drives this)
      const { tabId } = msg;
      try {
        await attachTab(Number(tabId));
        send({ t: 'attachOk', id: msg.id, tabId });
      } catch (e) {
        send({ t: 'attachFail', id: msg.id, error: String(e && e.message || e) });
      }
      return;
    }
    case 'closeTab': {
      const tabId = findTabByTarget(msg.targetId);
      if (tabId == null) return send({ t: 'cdpResult', id: msg.id, ok: false, error: 'TB_SCOPE: unknown target' });
      if (opts.scopeMode !== 'full') return send({ t: 'cdpResult', id: msg.id, ok: false, error: 'TB_SCOPE: closing tabs requires full-browser mode' });
      try { await chrome.tabs.remove(tabId); send({ t: 'cdpResult', id: msg.id, ok: true, result: { success: true } }); }
      catch (e) { send({ t: 'cdpResult', id: msg.id, ok: false, error: String(e && e.message || e) }); }
      return;
    }
    case 'detach': {
      const { tabId } = msg;
      try { await detachTab(Number(tabId), 'relay'); } catch {}
      send({ t: 'detachOk', id: msg.id, tabId });
      return;
    }
    case 'detachAll': {
      for (const [tabId] of attached) { try { await detachTab(tabId, 'relay'); } catch {} }
      send({ t: 'ok', id: msg.id });
      return;
    }
  }
}

function findTabByTarget(targetId) {
  for (const [tabId, info] of attached) if (info.targetId === targetId) return tabId;
  return null;
}

// ---- attach / detach ----

async function attachTab(tabId, { createdByAgent = false } = {}) {
  if (attached.has(tabId)) return attached.get(tabId);
  if (!createdByAgent && !(await isOptedIn(tabId))) throw new Error('TB_SCOPE: tab not in scope');
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // our own stale attach (service worker restarted; attachments outlive the SW)
    if (String(e.message || e).includes('Another debugger is already attached')) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
      await chrome.debugger.attach({ tabId }, '1.3');
    } else {
      throw e;
    }
  }
  // Resolve the REAL CDP targetId — Playwright treats it as the main frame id,
  // so a synthetic id breaks every frame op ("Frame has been detached").
  // A brand-new tab can take a moment to appear in getTargets — retry briefly
  // instead of silently falling back to a fake id.
  let targetId = null;
  for (let attempt = 0; attempt < 10 && !targetId; attempt++) {
    try {
      const targets = await chrome.debugger.getTargets();
      const t = targets.find((x) => x.tabId === tabId);
      if (t && t.id) targetId = t.id;
    } catch (e) { log('getTargets failed', e); }
    if (!targetId) await new Promise((r) => setTimeout(r, 100));
  }
  if (!targetId) throw new Error(`TB_ERR: could not resolve CDP target for tab ${tabId} (is the tab still alive?)`);
  const info = { sessionId: 'tb-' + tabId, targetId };
  attached.set(tabId, info);
  persistRuntimeState();
  refreshBadge();
  sendAttached(tabId, info);
  return info;
}

async function detachTab(tabId, reason) {
  const info = attached.get(tabId);
  if (!info) return;
  attached.delete(tabId);
  persistRuntimeState();
  try { await chrome.debugger.detach({ tabId }); } catch {}
  refreshBadge();
  send({ t: 'detached', tabId, targetId: info.targetId, reason: reason || 'user' });
}

function sendAttached(tabId, info) {
  chrome.tabs.get(tabId).then(tab => {
    send({ t: 'attached', tabId, targetId: info.targetId, url: tab.url || '', title: tab.title || '' });
  }).catch(() => {});
}

async function autoAttachAll() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try { await attachTab(tab.id, { createdByAgent: true }); } catch (e) { log('autoAttach skip', tab.id, e.message); }
    }
    log('full-browser mode: attached to', attached.size, 'tabs');
  } catch (e) { log('autoAttachAll failed', e); }
}

// ---- chrome.debugger events ----

chrome.debugger.onEvent.addListener((src, method, params) => {
  const tabId = src.tabId;
  const info = attached.get(tabId);
  if (!info) return;
  send({ t: 'cdpEvent', targetId: info.targetId, method, params });
});

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source.tabId;
  const info = attached.get(tabId);
  if (info) {
    attached.delete(tabId);
    persistRuntimeState();
    refreshBadge();
    send({ t: 'detached', tabId, targetId: info.targetId, reason: 'browser' });
  }
});

// ---- user events: opt-in/out, tab lifecycle ----

chrome.action.onClicked.addListener(async (tab) => {
  // icon clicked (no popup would be needed, but we have popup in M0 — this fires when popup is absent)
  if (attached.has(tab.id)) await detachTab(tab.id, 'user');
  else await optIn(tab.id);
});

async function optIn(tabId) {
  optedIn.add(tabId);
  await persistOptedIn();
  try { await attachTab(tabId); } catch (e) { optedIn.delete(tabId); await persistOptedIn(); log('attach failed', e); }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (opts.scopeMode === 'full' && connected) {
    attachTab(tab.id, { createdByAgent: true }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  optedIn.delete(tabId);
  if (attached.has(tabId)) {
    const info = attached.get(tabId);
    attached.delete(tabId);
    persistOptedIn();
    persistRuntimeState();
    send({ t: 'detached', tabId, targetId: info.targetId, reason: 'closed' });
    refreshBadge();
  } else {
    persistOptedIn();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!attached.has(tabId)) return;
  if (change.url) {
    const allowed = opts.scopeMode === 'full' || (opts.scopeMode === 'allowlist' ? matchAllowlist(change.url) : true);
    if (!allowed) await detachTab(tabId, 'out-of-scope');
    else send({ t: 'targetInfoChanged', targetId: attached.get(tabId).targetId, url: change.url });
  }
});

// ---- messages from popup ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.t) {
      case 'getStatus': {
        const attachedInfo = [];
        for (const tabId of attached.keys()) {
          const info = { tabId };
          try { const tab = await chrome.tabs.get(tabId); info.url = (tab.url || '').slice(0, 40); } catch {}
          attachedInfo.push(info);
        }
        sendResponse({ connected, relay: opts.relay, scopeMode: opts.scopeMode, allowlist: opts.allowlist, attached: attachedInfo, token: !!opts.token, configured: !!opts.configured, keepalive: { offscreen: !!keepalivePort, alarm: true, lastPongAgoMs: lastPongAt ? Date.now() - lastPongAt : null } });
        return;
      }
      case 'saveOpts': {
        // undefined token = keep the stored one (popup sends undefined when the
        // field is blank and the user didn't ask to clear)
        const incoming = { ...msg.opts };
        if (incoming.token === undefined) delete incoming.token;
        revoked = false; // re-saving settings re-authorizes the agent
        Object.assign(opts, incoming);
        await saveOpts();
        await ensureOffscreen();
        await ensureAlarm();
        retryDelay = 2000;
        connect(); // reconnect with new settings
        if (msg.opts.scopeMode === 'full') setTimeout(() => { if (connected) autoAttachAll(); }, 1500);
        sendResponse({ ok: true });
        return;
      }
      case 'discover': {
        const found = await discoverRelay();
        if (found) {
          Object.assign(opts, { relay: found, configured: true });
          await saveOpts();
          await ensureOffscreen();
          await ensureAlarm();
          retryDelay = 2000;
          connect();
          sendResponse({ ok: true, relay: found });
        } else {
          sendResponse({ ok: false, error: 'no relay found on this machine. Start one with `npx tailbrowser relay` or enter the URL manually.' });
        }
        return;
      }
      case 'optIn': await optIn(msg.tabId); sendResponse({ ok: true }); return;
      case 'optOut': await detachTab(msg.tabId, 'user'); optedIn.delete(msg.tabId); sendResponse({ ok: true }); return;
      case 'disconnectAgent': {
        // hard revoke: close WS and stay down until settings are saved again
        // (previously it auto-reconnected in 2s, making revoke meaningless)
        revoked = true;
        if (ws) { try { ws.close(4000, 'revoked'); } catch {} }
        sendResponse({ ok: true });
        return;
      }
      case 'reEvalScope': {
        // re-evaluate all attached tabs against current scope
        for (const [tabId] of attached) {
          try {
            if (!(await isOptedIn(tabId))) await detachTab(tabId, 'out-of-scope');
          } catch {}
        }
        sendResponse({ ok: true });
        return;
      }
    }
  })();
  return true; // async sendResponse
});

// ---- boot ----

// Rebuild `attached` from chrome.debugger state: attachments outlive service-worker
// restarts, so on boot we may already be attached to tabs we forgot about.
async function rebuildAttached() {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null && !attached.has(t.tabId)) {
        attached.set(t.tabId, { sessionId: 'tb-' + t.tabId, targetId: t.id });
        log('rebuilt attach', t.tabId, t.id);
      }
    }
  } catch (e) { log('rebuildAttached failed', e); }
}

// ---- boot ----

// Runs on every cold start of the worker (extension load, browser restart,
// worker restart after termination). Restores persisted state, ensures the
// keepalive chain (offscreen doc + alarm) is in place, and connects.
async function boot() {
  if (booted) return;
  booted = true;
  await loadOpts();
  await restoreOptedIn();
  await rebuildAttached();
  await restoreRuntimeState();
  log('boot', opts.relay, opts.configured ? '(configured)' : '(unconfigured)', `attached=${attached.size}`);
  await ensureOffscreen();
  await ensureAlarm();
  connect();
}

boot().catch(async (e) => {
  // A failed boot used to leave booted=true with no alarm chain — the worker
  // went dark until Chrome restarted it. Retry instead.
  log('boot failed — retrying in 5s', String((e && e.message) || e));
  booted = false;
  setTimeout(() => { boot().catch(() => {}); }, 5000);
});
