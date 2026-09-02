// tailbrowser M0 — extension service worker
// Connects to the relay over WS, pipes CDP between relay and chrome.debugger.
// M0 scope = tab mode: only tabs the user opts in via the popup (or icon click).

const DEFAULT_RELAY = 'ws://localhost:8787';

// ---- state (service worker lifetime) ----
let ws = null;
let connected = false;
let opts = null; // { relay, token, scopeMode, allowlist }
let optedIn = new Set(); // tabIds the user opted in
let attached = new Map(); // tabId -> { sessionId, targetId }

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
  log('connecting', opts.relay);
  const sock = new WebSocket(`${opts.relay}/extension?token=${encodeURIComponent(opts.token)}&v=1`);
  ws = sock;
  sock.onopen = () => {
    connected = true;
    log('connected to relay');
    refreshBadge();
    heartbeat();
    send({ t: 'scope', mode: opts.scopeMode, allowlist: opts.allowlist });
    // advertise currently-attached targets (post-resume)
    for (const [tabId, info] of attached) sendAttached(tabId, info);
    // full-browser mode: auto-attach to every existing tab
    if (opts.scopeMode === 'full') autoAttachAll();
  };
  sock.onclose = () => {
    connected = false;
    ws = null;
    refreshBadge();
    if (opts.configured) setTimeout(connect, 2000); // retry while configured
  };
  sock.onerror = () => { try { sock.close(); } catch {} };
  sock.onmessage = (ev) => { handleMessage(String(ev.data)).catch(e => log('handle error', e)); };
}

function heartbeat() {
  if (ws !== sock_ref()) return;
  if (ws && ws.readyState === 1) ws.send('ping');
  setTimeout(heartbeat, 20000);
}
function sock_ref() { return ws; }

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
      // relay -> extension: run a CDP command on a target
      const { id, targetId, method, params, sessionId } = msg;
      const tabId = findTabByTarget(targetId);
      try {
        if (method === 'Target.createTarget' && tabId == null) {
          // browser-level create target: only in full mode
          if (opts.scopeMode !== 'full') throw new Error('TB_SCOPE: creating new tabs requires full-browser mode');
          const url = (params && params.url) || 'about:blank';
          const tab = await chrome.tabs.create({ url, active: false });
          // attach and report
          await attachTab(tab.id, { createdByAgent: true });
          send({ t: 'cdpResult', id, ok: true, result: { targetId: String(tab.id), newTab: true } });
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
  let targetId = 'tb-target-' + tabId; // fallback (never ideal)
  try {
    const targets = await chrome.debugger.getTargets();
    const t = targets.find((x) => x.tabId === tabId);
    if (t && t.id) targetId = t.id;
  } catch (e) { log('getTargets failed', e); }
  const info = { sessionId: 'tb-' + tabId, targetId };
  attached.set(tabId, info);
  refreshBadge();
  sendAttached(tabId, info);
  return info;
}

async function detachTab(tabId, reason) {
  const info = attached.get(tabId);
  if (!info) return;
  attached.delete(tabId);
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

chrome.debugger.onDetach.addListener((src) => {
  const tabId = src.tabId;
  if (attached.has(tabId)) {
    attached.delete(tabId);
    refreshBadge();
    const info = attached.get(tabId) || { targetId: 'tb-target-' + tabId };
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
  try { await attachTab(tabId); } catch (e) { optedIn.delete(tabId); log('attach failed', e); }
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
    send({ t: 'detached', tabId, targetId: info.targetId, reason: 'closed' });
    refreshBadge();
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
        sendResponse({ connected, relay: opts.relay, scopeMode: opts.scopeMode, allowlist: opts.allowlist, attached: attachedInfo, token: !!opts.token, configured: !!opts.configured });
        return;
      }
      case 'saveOpts': {
        Object.assign(opts, msg.opts);
        await saveOpts();
        connect(); // reconnect with new settings
        if (msg.opts.scopeMode === 'full' && connected) setTimeout(autoAttachAll, 1500);
        sendResponse({ ok: true });
        return;
      }
      case 'discover': {
        const found = await discoverRelay();
        if (found) {
          Object.assign(opts, { relay: found, configured: true });
          await saveOpts();
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
        // hard revoke: close WS; relay kills sessions
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

loadOpts().then(async () => {
  await rebuildAttached();
  log('boot', opts.relay, opts.configured ? '(configured)' : '(unconfigured)', `attached=${attached.size}`);
  connect();
});
