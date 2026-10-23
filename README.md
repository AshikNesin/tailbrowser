<p align="center"><img src="extension/icons/icon-128.png" width="96" height="96" alt="tailbrowser logo"></p>

# tailbrowser

tailbrowser lets AI agents control a real Chrome browser through your **Tailscale network** (tailnet). You select the pages that the agents can use, or you give them the full browser.

**Status:** M1.1. tailbrowser is in daily use with a real Chrome browser. M1.1 has these features:

- A relay that isolates faults and repairs its Playwright connection automatically
- Stateful snippet sessions
- A CLI and an MCP server
- Automatic discovery of the relay
- Background keep-alive
- Three scope modes

```
Chrome + extension ──ws──► relay :8787 ◄──ws── agents (CLI / MCP / npx)
   (Mac mini etc.)       (any tailnet box)
```

## Quick start

### 1. Start the relay

Do this step one time, on a computer in your tailnet. You can use the computer that runs Chrome.

```bash
npx tailbrowser relay        # or: node agent/tailbrowser.mjs relay
```

The relay does these steps automatically:

- It binds to the Tailscale IP address of the computer.
- It operates without a token. Only devices in your tailnet can connect.
- It shows the values that you must put in the extension and in the agents.

### 2. Install the extension

On the computer that runs Chrome, do these steps:

1. Go to `chrome://extensions`.
2. Set **Developer mode** to on.
3. Click **Load unpacked**.
4. Select the `extension/` folder.
5. Open the extension popup.
6. Connect the extension to the relay:
   - If the relay is on the same computer, click **Find local relay**.
   - If the relay is on a different computer, type `ws://<relay-ip>:8787` in **Relay URL**. Then click **Save & connect**.
7. To share the current tab, click **Share with agents**.
8. To share more tabs, select a different scope in **Agent access**.

### 3. Control Chrome from your tailnet

Run snippets from any computer in your tailnet:

```bash
npx tailbrowser -e 'await page.goto("https://example.com"); console.log(await page.title())'
npx tailbrowser -e 'state.hits = await page.$$eval("a", as => as.map(a => a.textContent))'
npx tailbrowser session list
```

You do not have to set environment variables or session IDs. The CLI finds the relay automatically. It also keeps one session for each computer.

## MCP (Claude Code, Cursor, or a different MCP client)

Add this configuration to your MCP client:

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

The server has one tool, `execute`. The tool keeps the session between calls. Snippets can use these names: `page`, `context`, `state`, `pages()`, `snapshot()`, `screenshot()`, `newPage()`. To use a specific relay, set `TAILBROWSER_HOST`.

## Commands

```
tailbrowser relay [--port 8787] [--bind ip] [--token x] [--allow ips]   start the relay
tailbrowser discover             find a relay on the tailnet and save it
tailbrowser -e 'code'            run a snippet in the default session
tailbrowser -s 2 -e 'code'       run a snippet in a specific session
tailbrowser -e 'code' --new      run a snippet in a new session
tailbrowser session new|list|reset
tailbrowser scope | health
```

## Security

tailbrowser has these security controls:

- The relay binds only to the Tailscale interface. Devices outside the tailnet cannot connect.
- By default, the relay does not use a token. Membership in your tailnet (WireGuard) is the authentication. If other users share your tailnet, use `--token`.
- To limit the source IP addresses that can connect, use `--allow`. For example: `--allow 100.101.102.103,100.64.0.0/10`.
- The extension controls the scope. There are three scope modes:
  - **Tabs I pick**: The agents can use only the tabs that you share.
  - **Allowlist**: The agents can use the tabs whose URL matches a glob pattern. When a tab goes to a matching URL, the extension attaches it automatically.
  - **Entire browser**: The agents can use all tabs. They can also open and close tabs.
- The agents cannot see tabs that are outside the scope. When you make the scope smaller, the extension detaches those tabs immediately.
- Chrome always shows a "debugging" banner on a tab that an agent controls. If you close the banner or click **Stop** in the popup, the extension stops sharing that tab. No scope mode attaches that tab again automatically.
- **Disconnect agent** closes the relay connection and detaches all tabs. The extension stays disconnected after a browser restart. To connect again, click **Reconnect agent**.
- An agent can create a tab with `newPage()` only in **Entire browser** mode. In the other modes, the relay returns a `TB_SCOPE` error.

## Development

Use these commands:

```
npm test                  # run the stability tests (relay, fake extension, headless Chromium)
npm run test:extension    # load the real extension into Chromium and test it
npm run smoke             # run a quick Playwright demo through the relay
npm run build:icons       # make the PNG icons from the SVG files in extension/icons/
```

`agent/fake-extension.mjs` simulates the extension with a real headless Chromium. This lets you test the relay without a Chrome window.

The tests find Chromium through `CHROME_BIN` or the Playwright browser cache (`PLAYWRIGHT_BROWSERS_PATH`). For `test:extension`, you must have a full Chromium build. The headless shell cannot load extensions.

### Layout

```
relay/
  relay.mjs            start point: configuration, HTTP and WebSocket server, banner
  config.mjs           flags, environment, bind address, --allow filter
  auth.mjs             token checks and the internal key
  extension-link.mjs   connection to the extension (requests, responses, target events)
  cdp-bridge.mjs       /cdp/:id: gives Playwright a browser-level CDP session
  sandbox.mjs          sessions and snippet execution
  http-api.mjs         HTTP endpoints: /health /scope /session /execute /json/version
agent/
  tailbrowser.mjs      CLI
  tailbrowser.mcp.mjs  MCP server (stdio)
  client.mjs           HTTP client for the relay (used by the CLI, the MCP server and the library)
  discover.mjs         finds the relay: environment, then cache, then tailnet scan
  config.mjs           reads and writes ~/.tailbrowser/config.json
  index.mjs            programmatic API
  fake-extension.mjs   test replacement for the extension
lib/                   functions that the relay and the agent both use
extension/             MV3 extension: service worker, popup, keep-alive document, icons
```

## Stability

tailbrowser can operate without supervision for many weeks. Browsers and computers can disconnect and connect again, but the relay must not stop.

**Fault isolation:** A request, a WebSocket frame, or a snippet cannot stop the relay process. The relay does these actions:

- It returns `400` for incorrect JSON.
- It ignores unknown message types.
- It drops incorrect frames.
- It records handler errors in the log (`UNCAUGHT (survived)`) and continues to operate.

`scripts/stability-test.mjs` makes sure that the earlier crash bugs do not occur again. These bugs were incorrect `/execute` bodies and `targetInfoChanged` race conditions.

**Automatic repair of the Playwright connection:** When the extension connects again, the relay replaces its internal Playwright connection. This occurs after a Chrome restart, a network problem, or a computer sleep. Before this change, one extension disconnection made the connection unusable until you restarted the relay. This was the main cause of failures.

**Fast failure:** If an agent command cannot complete, the agent receives a `TB_ERR` or `TB_TIMEOUT` error in milliseconds. The agent does not wait 30 seconds or more. `newPage()` and `attachToTarget` use real CDP semantics (`sessionId` in responses, real target IDs). This lets the Playwright fast paths operate correctly.

**Diagnosis:** Each log line has a timestamp. A watchdog shows a warning when a synchronous snippet stops the event loop. `curl <relay>/health` gives the relay status in one round trip.

To run the regression tests, use `npm test`. The tests examine these conditions:

- Crash isolation
- Recovery after the extension disconnects, without a relay restart
- `newPage()` and `page.close()` from start to end
- Many snippets at the same time
- Incorrect WebSocket frames
- Session state after a snippet fails
- Session IDs that are the same
- MCP protocol edge cases
- Token mode
- A clear message when the port is in use (`EADDRINUSE`)

## Background operation

Chrome stops an MV3 service worker approximately 30 seconds after its last event. Since Chrome 116, WebSocket traffic is **not** an event. As a result, the extension lost the relay connection when Chrome was in the background.

tailbrowser uses three mechanisms to prevent this problem. You do not have to configure them.

1. **Offscreen document and runtime port** (primary mechanism): A hidden offscreen document sends a message to the service worker every 20 seconds through a `chrome.runtime` port. Each message resets the idle timer of the worker. Chrome does not slow down offscreen documents. As a result, this mechanism operates when Chrome is fully in the background.
2. **`chrome.alarms`** (backup mechanism, every 30 seconds): Chrome can stop the worker for other causes, for example low memory or a crash. In this condition, the alarm starts the worker again. The worker then connects to the relay again and sends the list of attached targets. `chrome.debugger` attachments continue after a worker restart. The extension keeps its settings and shared tabs in `chrome.storage`.
3. **Application-level WebSocket ping** (a ping every 20 seconds, a 75-second limit): This mechanism finds half-open connections after the computer sleeps or the network changes. It then replaces the connection. The relay uses the same method in the opposite direction. If the extension is not connected, the relay returns `TB_ERR: extension not connected` immediately. It does not wait 30 seconds on a dead connection.

The popup shows the keep-alive status (`keep-alive ✓ · heard Ns ago`).

## Acknowledgements

The relay design follows [Playwriter](https://github.com/remorses/playwriter): the `/extension` and `/cdp/:id` endpoint split and the single `execute` tool with sticky sessions.
