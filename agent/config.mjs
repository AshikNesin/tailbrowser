// ~/.tailbrowser/config.json — per-machine client state (discovered relay
// host, sticky default session). Writers merge, so one never clobbers another.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configPath() {
  return path.join(os.homedir(), '.tailbrowser', 'config.json');
}

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {}; } catch { return {}; }
}

export function updateConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}
