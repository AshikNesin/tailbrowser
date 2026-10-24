// Locate a Chromium binary for dev tooling: explicit path > CHROME_BIN >
// Playwright's browser cache (full builds before headless shells, newest
// first) > common system locations.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BINARY_LAYOUTS = [
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-linux/headless_shell',
];
const SYSTEM_BINARIES = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];

export function findChromium({ explicit, allowHeadlessShell = true } = {}) {
  if (explicit || process.env.CHROME_BIN) return explicit || process.env.CHROME_BIN;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache/ms-playwright')].filter(Boolean);
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
