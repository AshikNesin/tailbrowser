#!/usr/bin/env bash
# End-to-end M0 smoke test: relay + fake extension + playwright demo, all in-process.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules/ws ] || [ ! -d node_modules/playwright-core ]; then npm i --no-fund --no-audit; fi
# shellcheck disable=SC2206
PW_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if ! ls -d "$PW_DIR"/chromium_headless_shell-* >/dev/null 2>&1; then
  npx playwright-core install chromium-headless-shell
fi

TOKEN=
PORT=8899
LOG=$(mktemp -d)
cleanup() { kill $RELAY $FAKE 2>/dev/null || true; }
trap cleanup EXIT

node relay/relay.mjs --port $PORT --bind 127.0.0.1 >"$LOG/relay.log" 2>&1 & RELAY=$!
node agent/fake-extension.mjs --relay ws://127.0.0.1:$PORT --url https://example.com --scope full >"$LOG/ext.log" 2>&1 & FAKE=$!

for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.5; done
for i in $(seq 1 30); do grep -q ready "$LOG/ext.log" 2>/dev/null && break; sleep 0.5; done

echo "— health: $(curl -s http://127.0.0.1:$PORT/health)"
echo "— tokenless mode smoke (tailnet-only posture)"
if TAILBROWSER_HOST="ws://127.0.0.1:$PORT" node agent/demo.mjs; then
  echo "SMOKE OK (logs: $LOG)"
else
  echo "SMOKE FAILED (logs: $LOG)"; tail -20 "$LOG/relay.log" "$LOG/ext.log"; exit 1
fi
