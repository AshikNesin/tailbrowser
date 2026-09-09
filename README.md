# tailbrowser

Let AI agents on your **Tailscale network** control a **real Chrome** — scoped to pages you allow, or the whole browser. Minimal self-hosted [Playwriter](https://github.com/remorses/playwriter), tailnet-native.

**Status: M1.1** — hardened relay (fault-isolated, self-healing Playwright link, real CDP attach semantics). — stateful snippet sessions, CLI, MCP server, auto-discovery, background keep-alive. Working in daily use against real Chrome.

```
Chrome + extension ──ws──► relay :8787 ◄──ws── agents (CLI / MCP / npx)
   (Mac mini etc.)       (any tailnet box)
```

## Quick start

**1. Start the relay** (once, on any tailnet machine — e.g. the same Mac mini as Chrome):
```bash
npx tailbrowser relay        # or: node agent/tailbrowser.mjs relay
```
It auto-binds the tailscale IP, runs tokenless (tailnet membership = auth), and prints exactly what to paste where.

**2. Install the extension** on the Chrome device: `chrome://extensions` → Developer mode → Load unpacked → `extension/` folder. Popup → **Discover** (finds a relay on the same machine) or paste `ws://<relay-ip>:8787` → **Save & connect**.

**3. Drive it from any tailnet machine:**
```bash
npx tailbrowser -e 'await page.goto("https://example.com"); console.log(await page.title())'
npx tailbrowser -e 'state.hits = await page.$$eval("a", as => as.map(a => a.textContent))'
npx tailbrowser session list
```
No env vars, no session ids — the relay is discovered automatically and the session is sticky per machine.

## MCP (Claude Code / Cursor / any MCP client)
```json
{
  "mcpServers": {
    "tailbrowser": {
      "command": "npx",
      "args": ["-y", "tailbrowser@latest", "--mcp"]
    }
  }
}
```
Single `execute` tool with sticky sessions; snippet scope: `page, context, state, pages(), snapshot(), screenshot(), newPage()`. `TAILBROWSER_HOST` overrides discovery when needed.

## Commands

```
tailbrowser relay [--port 8787] [--bind ip] [--token x]   start the relay
tailbrowser discover             find + cache a relay on the tailnet
tailbrowser -e 'code'            run a snippet (sticky default session)
tailbrowser -s 2 -e 'code'       run in a specific session
tailbrowser -e 'code' --new      force a fresh session
tailbrowser session new|list|reset
tailbrowser scope | health
```

## Security model

- Relay binds the **tailscale interface only** — nothing off-tailnet can even connect
- Tokenless by default: your tailnet's membership (WireGuard) is the auth. `--token` available for shared tailnets
- Scope modes: **Tabs I pick** / **URL allowlist** / **Entire browser** — enforced in the extension; unpermitted tabs don't exist from the agent's view
- Chrome's yellow "debugging" banner always shows when a tab is under automation; dismissing it revokes that tab
- `newPage()`/tab creation requires full-browser mode (`TB_SCOPE` error otherwise)

## Dev

`bash scripts/smoke.sh` — end-to-end test (relay + fake extension + headless chromium, no real Chrome needed). `agent/fake-extension.mjs` simulates the extension against real headless Chromium for CI.
`node scripts/stability-test.mjs` — stability regression suite (crash isolation, flap recovery, newPage, concurrency, EADDRINUSE).

## Stability model (what keeps it up)

tailbrowser is designed to run unattended for weeks. The relay is the long-lived piece; browsers and machines flap — it must not.

**Fault isolation:** no request, WebSocket frame, or snippet can kill the relay process. Bad JSON → `400`, unknown envelope types → ignored, garbage frames → dropped, handler bugs → logged (`UNCAUGHT (survived)`) and served through. The original crash bugs (malformed `/execute` bodies, `targetInfoChanged` races) are locked out by `scripts/stability-test.mjs`.

**Self-healing Playwright connection:** the relay recycles its internal Playwright link whenever the extension generation changes (Chrome restart, network flap, machine sleep). Previously a single extension drop poisoned it until the relay was manually restarted — the main "it goes down whenever I use it" cause.

**Fail-fast everywhere:** agents get typed `TB_ERR` / `TB_TIMEOUT` errors in milliseconds instead of 30s+ stalls; `newPage()`/`attachToTarget` speak real CDP semantics (`sessionId` in responses, real target ids) so Playwright's own fast paths work.

**Diagnosability:** every log line is timestamped; an event-loop stall watchdog flags a hanging synchronous snippet; `curl <relay>/health` answers in one round-trip.

Run the regression suite: `node scripts/stability-test.mjs` (13 checks: crash isolation, flap recovery without restart, `newPage()` end-to-end, concurrent load, garbage frames, session-state poisoning, friendly `EADDRINUSE`).

## Background / keep-alive architecture

Chrome terminates MV3 service workers ~30s after their last event, and since Chrome 116 WebSocket traffic **no longer counts** as an event — so a backgrounded browser used to silently drop the relay link. tailbrowser layers three mechanisms (all zero-config):

1. **Offscreen document + runtime port** (primary): a hidden offscreen doc pings the service worker over a `chrome.runtime` port every 20s; every message resets the worker's idle timer. Offscreen docs are never throttled, so this works with Chrome fully in the background.
2. **`chrome.alarms` fallback** (every 30s): if the worker is terminated anyway (memory pressure, crash), the alarm fires, Chrome restarts the worker, and it reconnects + re-advertises attached targets automatically. `chrome.debugger` attachments survive worker restarts; opts/opt-ins persist via `chrome.storage`.
3. **App-level WS ping/pong** (20s ping / 75s deadline): detects half-open sockets after sleep/wake or network switches and recycles the connection. The relay applies the same discipline in reverse and fails agent commands fast (`TB_ERR: extension not connected`) instead of stalling 30s on a dead pipe.

The popup shows live keep-alive status (`port ✓ · last relay pong Ns ago`).
