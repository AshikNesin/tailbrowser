// tailbrowser offscreen document: keepalive companion for the MV3 service worker.
//
// Chrome kills MV3 service workers ~30s after their last event, and since
// Chrome 116 WebSocket traffic no longer counts as an event. An offscreen
// document is never throttled, so it can hold a long-lived runtime.Port whose
// every message resets the worker's idle timer, keeping the worker (and its
// relay WebSocket) alive while Chrome is in the background.

const PING_MS = 20_000;

let port = null;
let timer = 0;

function connect() {
  clearTimeout(timer);
  try {
    port = chrome.runtime.connect({ name: 'tb-keepalive' });
  } catch {
    port = null;
    timer = setTimeout(connect, 1000);
    return;
  }
  // worker restarted or died; reconnecting wakes it again
  port.onDisconnect.addListener(() => {
    port = null;
    clearTimeout(timer);
    timer = setTimeout(connect, 1000);
  });
  ping();
}

function ping() {
  if (!port) return;
  try { port.postMessage({ t: 'ping', at: Date.now() }); } catch { return; }
  timer = setTimeout(ping, PING_MS);
}

connect();
