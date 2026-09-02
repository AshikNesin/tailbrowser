# tailbrowser

Let AI agents on your **Tailscale network** control a **real Chrome** — scoped to pages you allow, or the whole browser. Minimal self-hosted [Playwriter](https://github.com/remorses/playwriter), tailnet-native.

**Status: M1** — stateful snippet sessions, CLI, MCP server, auto-discovery. Working in daily use against real Chrome.

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
