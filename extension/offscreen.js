// tailbrowser offscreen document — keepalive companion for the MV3 service worker.
//
// Why this exists: Chrome kills MV3 service workers ~30s after their last
// event, and since Chrome 116 WebSocket traffic no longer counts as an event.
// An offscreen document is never throttled, so it can hold a long-lived
// runtime.Port whose every message resets the worker's idle timer — keeping
// the worker (and our relay WebSocket) alive while Chrome is in the background.

const PING_MS = 20_000;

let port = null;
let timer = null;

function connect() {
  if (port) return;
  try { port = chrome.runtime.connect({ name: 'tb-keepalive' }); } catch { port = null; return; }
  port.onMessage.addListener((msg) => {
    if (msg && msg.t === 'pong') {
      // health bookkeeping only; the message itself is what keeps the worker alive
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    clearTimeout(timer);
    // worker restarted or died — reconnect after a beat (connect() creates a fresh port)
    setTimeout(connect, 1000);
  });
  ping();
}

function ping() {
  if (!port) return;
  try { port.postMessage({ t: 'ping', at: Date.now() }); } catch { port = null; return; }
  timer = setTimeout(ping, PING_MS);
}

connect();
