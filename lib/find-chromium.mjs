// Locate a Chromium binary for dev tooling: explicit path > CHROME_BIN >
// Playwright's browser cache (full builds before headless shells, newest
// first) > common system locations.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// layouts inside a Playwright browser-cache entry (Linux and macOS)
const BINARY_LAYOUTS = [
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-linux/headless_shell',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-headless-shell-mac-x64/chrome-headless-shell',
];
const SYSTEM_BINARIES = [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome',
  '/usr/local/bin/chromium', '/usr/local/bin/chromium-browser', '/usr/local/bin/google-chrome',
  '/snap/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const CACHE_ROOTS = [
  path.join(os.homedir(), '.cache/ms-playwright'), // Linux
  path.join(os.homedir(), 'Library/Caches/ms-playwright'), // macOS
];

export function findChromium({ explicit, allowHeadlessShell = true } = {}) {
  if (explicit || process.env.CHROME_BIN) return explicit || process.env.CHROME_BIN;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, ...CACHE_ROOTS].filter(Boolean);
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    const dirs = entries
      .filter((e) => e.startsWith('chromium') && (allowHeadlessShell || !e.includes('headless')))
      .sort((a, b) => (a.includes('headless') - b.includes('headless')) || b.localeCompare(a, undefined, { numeric: true }));
    for (const dir of dirs) {
      for (const layout of BINARY_LAYOUTS) {
        const exe = path.join(root, dir, layout);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return SYSTEM_BINARIES.find((p) => fs.existsSync(p)) || null;
}
