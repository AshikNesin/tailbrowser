# tailbrowser: Remote Browser Control over Tailscale

**A minimal, self-hosted Playwriter: let cloud AI agents control a real Chrome browser on your tailnet device, scoped to specific pages or the entire browser.**

| | |
|---|---|
| Status | Draft v0.1 |
| Owner | You |
| Repo | `tailbrowser` (npm name verified free; only collision: dormant `barnstar/TailBrowser` iOS browser) |
| Inspirations | [remorses/playwriter](https://github.com/remorses/playwriter) (architecture), Tailscale (transport/auth boundary) |

---

## 1. Summary

tailbrowser is a two-part system:

1. **A Chrome extension** installed on a device inside your Tailscale network (e.g. your home/work machine). It uses `chrome.debugger` (Chrome DevTools Protocol) to control *your real browser*, with the logins, cookies, and extensions already present. It connects **outbound** to a relay over WebSocket.
2. **A relay server** running anywhere on the tailnet (can be the same device, or a small cloud VM). It bridges agent-side Playwright/CDP clients to the extension, with token auth.

Your **AI agents run in the cloud** on the same tailnet. They connect to the relay via an MCP server (one `execute` tool that runs Playwright snippets in a stateful sandbox, like Playwriter) or programmatically via `chromium.connectOverCDP()`.

**Key differentiator vs Playwriter:** Playwriter's remote mode needs a public Cloudflare tunnel (traforo) to traverse the internet. tailbrowser is **Tailscale-native**: no public exposure, no port forwarding, no third-party relay; the tailnet *is* the network. On top of that, tailbrowser adds **configurable scope**: an agent's access can be limited to specific pages/origins (like Playwriter's per-tab opt-in) or opened up to the entire browser (all tabs, tab creation, browser-level CDP domains). Your choice, enforced at the extension.

```
┌───────────────────────────── TAILSCALE NETWORK (private, WireGuard) ─────────────────────────────┐
│                                                                                                  │
│  ┌──────────────────────────┐                ┌──────────────────────────────────────────────┐  │
│  │  DEVICE (e.g. home PC)   │                │  RELAY (device or cloud VM)                  │  │
│  │                          │                │                                              │  │
│  │  Chrome                  │   WS  (out)    │  ws server :8787                             │  │
│  │   └─ tailbrowser ext ───┼───────────────►│    /extension   ← extension (CDP pipe)       │  │
│  │       (chrome.debugger)  │                │    /cdp/:sess   ← Playwright clients        │  │
│  │                          │                │    HTTP /session (mgmt)                     │  │
│  └──────────────────────────┘                │    MCP stdio    ← agent host process        │  │
│                                              └──────────────┬───────────────────────────────┘  │
│                                                           │ WS                                 │
│  ┌──────────────────────────┐                            │                                    │
│  │  CLOUD AGENT HOST        │────────────────────────────┘                                    │
│  │  MCP client (Claude Code,│                                                                 │
│  │  Cursor, custom agent)   │                                                                 │
│  │  TAILBROWSER_HOST=ws://ip:8787  │                                                                 │
│  │  TAILBROWSER_TOKEN=••••       │                                                                 │
│  └──────────────────────────┘                                                                 │
│                                                        (auth: bearer token + Tailscale ACL)    │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Background & problem

You already use (or evaluated) **Playwriter**, which lets agents control your real Chrome via a Chrome extension + local WS relay + MCP. Its remote-access story requires exposing the relay through a public tunnel (traforo/Cloudflare): extra moving parts, a public URL, and a third party.

Your actual topology:

- Chrome runs on a device inside a **Tailscale tailnet**.
- AI agents run in the **cloud**, also joined to the same tailnet.

So the public-tunnel layer is unnecessary. What you want is the minimal core of Playwriter, self-hosted, private to your tailnet, with a **scope control** Playwriter doesn't offer as first-class config: choose whether agents see only hand-picked pages or the whole browser.

Why control the real browser rather than spawn headless Chrome in the cloud:

- Logins, cookies, and existing extensions are already there.
- Real fingerprint/profile, so far fewer bot-detection problems.
- The human and the agent share one browser (supervisable automation).
- The device's IP/geolocation is the one sites already trust.

---

## 3. Goals & non-goals

### Goals

1. **G1: Minimal Playwriter core.** Chrome extension + relay + MCP/CLI that can run arbitrary Playwright snippets against the real browser, in stateful sessions.
2. **G2: Tailscale-native transport.** All traffic stays on the tailnet via plain `ws://<tailnet-ip>:<port>`. No public endpoints, no tunnels, no port forwarding, no TLS: WireGuard encrypts node-to-node traffic at the transport layer, so TLS (e.g. `tailscale serve`) is unnecessary for a tailnet-only relay and is offered only as an optional appendix.
3. **G3: Configurable scope (the headline feature).** A device owner can grant agents access at one of three levels:
   - **Tab mode**: only tabs explicitly opted in (click extension icon on a tab; it turns green). Default. (= Playwriter behavior)
   - **Allowlist mode**: any tab whose URL matches a configured pattern list (`https://app.example.com/*`), auto-attach on navigation.
   - **Full-browser mode**: all current tabs + ability to open/close tabs + browser-level CDP domains. Explicit, scary-confirmation opt-in.
4. **G4: Agent-friendly API.** One MCP `execute` tool (full Playwright API, tiny context footprint), a CLI for humans/scripts, and a raw CDP endpoint for programmatic use.
5. **G5: Safe by default.** Token auth on the relay; Tailscale ACLs as the outer perimeter; extension banner always visible when a tab is under automation; instant revoke from the extension popup.

### Non-goals (v1)

- Public internet access mode (no tunnels, no traforo equivalent). Tailscale only.
- Chrome Web Store publication. Load unpacked / internal distribution only (keeps `chrome.debugger` review process out of scope).
- Multi-browser / multi-device fleet management (single device, single Chrome instance per relay; but see Open Questions).
- Video streaming, RTMP, live code editing, breakpoints/debugger tooling (Playwriter extras).
- Firefox/Edge/Safari.
- Bot-detection-bypass features beyond what "your real browser" naturally provides.
- A GUI dashboard. Config lives in the extension popup + a JSON config file.

---

## 4. Users & use cases

| Persona | Description |
|---|---|
| **Owner (you)** | Installs the extension on the tailnet device, configures scope, issues the token, watches the automation banner. |
| **Agent (cloud)** | An MCP client (Claude Code, Cursor, custom coding agent) or script running on a cloud box in the tailnet. Executes browser tasks. |

**UC-1: Agent operates an allowlisted web app.** Owner sets allowlist mode with `https://internal-tool.example.com/*`. Cloud agent logs in (session already exists), scrapes data, fills forms. Other 40 open tabs are invisible to it.

**UC-2: Agent does a cross-site task.** Owner flips to full-browser mode for the session; agent researches across sites, opens new tabs, downloads files. Owner flips back to tab mode when done.

**UC-3: One-off supervised task.** Owner clicks the extension icon on a single tab (green dot), tells the agent "you have one tab", agent completes a checkout, owner clicks again to revoke.

**UC-4: CI/eval harness.** A cloud job uses `connectOverCDP()` directly to run checks against a real signed-in browser every night.

---

## 5. Architecture

### 5.1 Components

| Component | Runtime | Responsibility |
|---|---|---|
| **Extension** | Chrome MV3 service worker + popup | Holds `chrome.debugger` attach/detach; enforces **scope**; maintains outbound WS to relay with retry; routes CDP commands/events; shows status & revoke UI. |
| **Relay** | Node.js (TypeScript), `ws` | Auth; extension registry; session sandboxes; multiplexes CDP between `/extension` and `/cdp/:sessionId`; `/session` HTTP mgmt API; audit log. |
| **Agent kit** | Node.js | (a) MCP server exposing `execute`; (b) `bridge` CLI; (c) thin client lib wrapping `connectOverCDP`. |

### 5.2 Data flow (CDP pipe)

1. Extension service worker starts, reads config (relay URL, token, scope), opens WS to `ws://relay:8787/extension?token=…`. Retries forever with backoff.
2. Agent creates a session: `POST /session` → `{ sessionId }`. Session = a Node VM sandbox with `page`, `context`, `state` (persists across calls within the session), Playwright globals.
3. Agent (via MCP/CLI) submits a snippet; the sandbox maps its `page` onto a CDP connection opened at `ws://relay:8787/cdp/<sessionId>?token=…` (Playwright `connectOverCDP`).
4. Relay forwards CDP commands to the extension; extension runs them through `chrome.debugger.sendCommand` on allowed targets; events flow back.
5. Target discovery: relay synthesizes `Target.attachedToTarget`/`detachedToTarget` for **only the targets the current scope permits**, so unpermitted tabs simply don't exist from the agent's perspective.

### 5.3 Scope enforcement (G3): the core novel bit

Enforcement lives in the **extension** (it's the only place that knows the scope config and controls attach). The relay trusts the extension's target advertisement.

- **Tab mode:** extension attaches only to tabs the owner opted in. `detach` on opt-out → agent sees `detachedFromTarget`.
- **Allowlist mode:** extension subscribes to `tabs.onUpdated`; auto-attaches matching tabs, auto-detaches when a navigation leaves the allowlist. Patterns: `glob:` (default), `regex:` prefixes. Always-denied regardless of mode: `chrome://*`, `chrome-extension://*`, `https://chrome.google.com/webstore*`.
- **Full-browser mode:** extension enumerates all tabs (`tabs.query`), attaches to each, and exposes `Target.createTarget`/`closeTarget` and browser-level domains (e.g. `Browser.*`, `Fetch` at browser scope) to the agent.
- Mode changes apply live: switching modes re-evaluates current targets within ~1s and emits attach/detach events accordingly.
- **Hard revoke:** popup button "Disconnect agent" → extension closes the WS; relay kills all sessions bound to that extension.

### 5.4 Auth model (layered)

| Layer | Mechanism |
|---|---|
| Network | Tailscale ACLs: only the relay's tailnet IP:port may be reached, and only by the agent host's tag/user + the device. Default-deny everything else. |
| Transport (optional) | None needed: WireGuard encrypts tailnet traffic pairwise, and there is no on-path attacker to defend against. `tailscale serve` TLS is an optional appendix for operators who want browser-friendly `https://machine.tailnet.ts.net` URLs; never required for v1. |
| Application | Bearer token required on every WS/HTTP call (extension↔relay, agent↔relay). Random 32-byte, stored in relay config + extension storage + agent env. |
| Identity pinning (v1.x) | Relay runs `tailscale whois <peer-ip>` on connect and can restrict to specific tailnet nodes/machines beyond the token. |

The token is defense-in-depth; the tailnet is the primary perimeter. A leaked token alone is useless off-tailnet (relay not publicly routable).

### 5.5 Why outbound WS from the extension

Extensions can't listen on ports and MV3 service workers are ephemeral, so a persistent outbound WebSocket (kept alive via heartbeat, service-worker keepalive churn) is the standard pattern (it's also what Playwriter does). On a tailnet this is trivially reachable since the extension's device can dial the relay's tailnet IP/magicDNS name directly.

---

## 6. Functional requirements

### Extension

- **FR-E1** Connect to configured relay URL with token; auto-reconnect with backoff; status badge (gray=disconnected, red=relay down, yellow=connected/no scope, green=attached per-tab).
- **FR-E2** Popup UI: relay URL + token fields; scope mode selector (Tab / Allowlist / Full browser); allowlist editor; live list of currently-attached tabs; **Disconnect agent** button.
- **FR-E3** Full-browser mode requires a typed confirmation ("I understand agents will control the entire browser").
- **FR-E4** Enforce scope per §5.3; deny-list privileged URLs in all modes.
- **FR-E5** Surface Chrome's native "extension started debugging this browser" banner (automatic; requirement is: never suppress or auto-re-attach when user manually dismisses; treat dismissal as revoke for that tab).

### Relay

- **FR-R1** Endpoints: `WS /extension`, `WS /cdp/:sessionId`, `POST/GET /session`, `GET /health`. All require token.
- **FR-R2** Sessions: create, list (with state keys), reset, expire idle sessions (default 30 min). Sessions have isolated `state` objects; browser tabs remain shared (like Playwriter).
- **FR-R3** Stateful snippet execution: each call runs in the session sandbox; `state` persists; console output + thrown errors returned to caller as structured result.
- **FR-R4** Event fan-out: route CDP events to all CDP connections subscribed to that session/target.
- **FR-R5** Audit log (JSONL): timestamp, session, command/method, target URL, ok/error. Stored on relay; `GET /audit?session=` to read. (No response bodies: method names + targets only, to keep the log small.)
- **FR-R6** Protocol version header on `/extension`; relay must accept older extensions (no breaking WS protocol changes; same rule Playwriter follows).

### Agent kit

- **FR-A1** MCP server (stdio) with a single `execute` tool: args `{ sessionId, code }` → `{ result, logs }`. Config via `TAILBROWSER_HOST`, `TAILBROWSER_TOKEN` env.
- **FR-A2** CLI: `bridge session new|list|reset`, `bridge -s 1 -e 'await page.goto(…)'`. Human-readable errors when relay/token/scope missing.
- **FR-A3** Helper injected into sandbox scope: `snapshot({ page })` (accessibility tree with `aria-ref=eN` refs) and `screenshot({ page })`, matching the Playwright idioms agents already know.
- **FR-A4** Programmatic: document `connectOverCDP('ws://relay:8787/cdp/<sessionId>?token=…')` + warn: **never call `browser.close()`** (it would close the owner's Chrome).
- **FR-A5** Agent-side skill/docs file (like `playwriter skill`) describing available scope variables and idioms, installable into agent contexts.

### Configuration

- **FR-C1** Extension-side config (popup, chrome.storage): `relayUrl`, `token`, `scopeMode`, `allowlist[]`.
- **FR-C2** Relay-side config (JSON file / env): `token`, `port`, `bind` (default: tailscale interface), `sessionIdleTimeout`, `auditPath`, optional `tailscaleWhoisRestrict: [nodes]`.
- **FR-C3** Scope report: `GET /scope` (or popup) returns current mode, allowlist, and attached-target URLs, so an agent can discover what it's allowed to touch.

---

## 7. API sketches

```bash
# On the tailnet device (or anywhere on tailnet)
relay --port 8787 --token $(cat token.txt)

# Agent host (cloud, on tailnet)
export TAILBROWSER_HOST=ws://100.x.y.z:8787
export TAILBROWSER_TOKEN=…
bridge session new                    # → 1
bridge -s 1 -e 'await page.goto("https://app.example.com")'
bridge -s 1 -e 'console.log(await snapshot({ page }))'
bridge -s 1 -e 'await page.locator("aria-ref=e5").click()'
```

```json
// MCP registration (Claude Code / Cursor)
{
  "mcpServers": {
    "bridge": {
      "command": "npx",
      "args": ["-y", "tailbrowser@latest"],
      "env": { "TAILBROWSER_HOST": "ws://100.x.y.z:8787", "TAILBROWSER_TOKEN": "…" }
    }
  }
}
```

Sandbox scope: `page` (default target within permitted set), `context`, `state`, `newPage()` (full-browser mode only; in Tab/Allowlist modes it throws a scoped error), Node globals, dynamic `import()`.

---

## 8. Security & privacy requirements

- **S1** No public network listeners. Relay binds to the Tailscale interface; documented `ufw`/ACL defaults; smoke test asserts the port is unreachable off-tailnet.
- **S2** Token never logged; audit log redacts query strings of page URLs (they may contain tokens/session ids).
- **S3** The extension is the enforcement point for scope: the relay never asks the extension to attach to a target outside the current scope, and the extension refuses if asked (defense against a compromised relay).
- **S4** Snippet execution = arbitrary code on the agent host sandbox by design; this is the product. Mitigations: tailnet-only reachability, single shared token per trust domain, audit log, hard revoke.
- **S5** Service-worker ephememerality: on Chrome killing the worker, WS drops and reconnects; in-flight commands return a typed `TAILBROWSER_DISCONNECTED` error agents can retry on.
- **S6** Chrome's debugger banner is the human's always-on signal; dismissing it must de-scope that tab (FR-E5).

---

## 9. Non-functional requirements

- **N1 Latency:** CDP command round-trip relay↔extension p95 < 100 ms on tailnet (typically < 20 ms same-region).
- **N2 Reconnect:** Extension re-establishes WS < 5 s after relay restart or network blip; sessions survive relay restart (in-memory state acceptable for v1, documented).
- **N3 Platforms:** Extension: Chrome stable (MV3). Relay/agent kit: Linux + macOS (Node ≥ 20).
- **N4 Footprint:** Relay idle < 100 MB RSS; extension service worker idle-cheap (event-driven, no polling).
- **N5 Protocol stability:** `/extension` WS protocol versioned additive-only.

---

## 10. Tech stack (proposal)

- **Extension:** TypeScript, `vite` + `@crxjs/vite-plugin` (fast MV3 builds), `chrome.debugger`, `chrome.storage`, `chrome.tabs`.
- **Relay & agent kit:** Node.js 20+, TypeScript, `ws`, `playwright-core` (agent side only, never on the device), `zod` for config, `node:vm` sandboxes for snippet execution, `commander` for CLI, `@modelcontextprotocol/sdk` for MCP.
- **Monorepo:** pnpm workspaces (`extension/`, `relay/`, `agent/`, `docs/`).
- **No database**: audit log is JSONL on disk; sessions in memory.

---

## 11. Milestones

| # | Deliverable | Exit criteria |
|---|---|---|
| **M0: Spike (wire the pipe)** | Unpacked extension attaches `chrome.debugger` to one hard-coded tab; minimal relay; agent script does `connectOverCDP` over tailnet and runs `page.goto` + `snapshot`. | One command executed by a remote agent against your real Chrome, entirely over Tailscale. |
| **M1: Core (minimal Playwriter)** | Token auth; session create/list/reset; stateful `execute` sandbox; MCP server + CLI; tab-mode opt-in (green tab); reconnect handling. | Cloud agent (Claude Code or Cursor) completes a 2-tab browsing task end-to-end with only opted-in tabs visible. |
| **M2: Scope (headline feature)** | Allowlist mode with pattern matching + live attach/detach; full-browser mode with typed confirm + new-tab/browser domains; `GET /scope`; mode-switch re-evaluation. | Demo: same agent snippet behaves differently under each mode; unpermitted tabs invisible; revoke works mid-task. |
| **M3: Hardening** | Audit log + redaction; idle session expiry; optional `tailscale serve` guide (appendix only) + whois pinning; off-tailnet smoke test; agent skill docs; README quickstart. | 7-day unattended soak with nightly agent job, zero manual reconnects; PRD security section fully implemented. |

M0 is deliberately a throwaway-quality vertical slice; its job is to de-risk the two unknowns early: MV3 service-worker WS longevity and CDP-via-`chrome.debugger` fidelity over a multi-hop pipe.

---

## 12. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Arbitrary code execution surface.** `execute` is RCE-by-design on the sandbox. | Critical | Tailnet-only reachability + ACLs; token; audit; hard revoke; never run the relay with extra privileges. |
| **MV3 service worker killed**, WS drops mid-task. | Med | WebSocket activity resets the 30s idle timer (Chrome ≥ 116 keeps workers alive for active WS); heartbeat every 20s; typed reconnect errors agents can retry (S5, N2). |
| **`chrome.debugger` quirks**: single debugger attach (conflicts with DevTools open on the same tab), banner dismissal = detach. | Med | Document; detect and return actionable errors ("close DevTools on this tab"); treat banner dismissal as revoke (FR-E5). |
| **Scope bypass via CDP**: agent uses `Target.createTarget` or window.open to escape allowlist. | High | Extension filters `Target.*` commands by scope; new tabs auto-evaluated against allowlist before attach; deny-listed URL schemes never attach. Test suite includes escape attempts (M2 exit criteria). |
| **Tailscale misconfig** exposing relay publicly. | High | Bind to tailscale interface only; S1 smoke test in CI; docs with copy-paste ACL snippet. |
| **Playwright ↔ chrome.debugger protocol drift** (implicit expectations of a real browser endpoint). | Med | Keep the CDP translation layer thin and event-faithful; pin `playwright-core` version; port Playwriter's known event-handling tricks (`attachedToTarget` synthesis, session/target id mapping). |
| **Chrome update breaks debugger API.** | Med | Extension is versioned additive-only protocol; pin nothing on device Chrome; keep M0 spike re-runnable as a canary. |

---

## 13. Open questions

1. ~~**Plain WS vs TLS on tailnet?**~~ **Resolved:** plain `ws://`, since WireGuard already encrypts tailnet traffic pairwise; no on-path attacker exists; nothing in the stack (extension WS, `connectOverCDP`) requires `wss://`. `tailscale serve` demoted to optional appendix (useful only if ever exposing via Funnel).
2. **One relay, multiple devices?** Multiple extensions connected to one relay (device registry, per-device token/scope): needed eventually? Deferred past v1.
3. **Session state durability.** In-memory is fine for interactive agents; should nightly CI jobs survive relay restarts (persist `state` to disk)?
4. **Full-browser mode boundaries.** Even in full mode, should privileged pages (`chrome://settings`) stay always-denied? (Proposal: yes.)
5. **Screenshots vs a11y snapshots default.** Follow Playwriter (a11y snapshot, 5-20 KB) with screenshots on demand? (Proposal: yes.)

---

## 14. Success metrics (v1)

- Time from `git clone` to first remote `page.goto` on tailnet: **< 15 minutes** following the README.
- Agent task reliability: ≥ 95% of snippet calls succeed across a 7-day nightly job without human intervention (excludes genuine page-side failures).
- Scope correctness: zero unpermitted-target commands observed in audit log during adversarial test suite.
- Latency: p95 CDP round-trip < 100 ms on tailnet (N1).

---

## 15. Appendix: prior art

- **[remorses/playwriter](https://github.com/remorses/playwriter)**: direct architectural reference: extension + WS relay (port 19988) + MCP/CLI with stateful snippet sessions; `/extension` and `/cdp/:id` endpoint split; per-tab opt-in model. Remote access there = traforo/Cloudflare public tunnel; tailbrowser replaces that layer with Tailscale and adds scope modes.
- **[Playwriter remote-access docs](https://github.com/remorses/playwriter/blob/main/docs/remote-access.md)**: confirms the `serve --token` + env-var client pattern tailbrowser adopts (`TAILBROWSER_HOST`/`TAILBROWSER_TOKEN`).
- **[chrome.debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)**: the privileged API that makes extension-driven CDP possible without launching Chrome with `--remote-debugging-port`.
- **Tailscale**: WireGuard mesh, magicDNS, ACLs (optional `serve`/Funnel); replaces all public-tunnel infrastructure.
