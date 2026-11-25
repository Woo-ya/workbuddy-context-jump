// Install WorkBuddy Context Jump into ~/.gemini/config/plugins/workbuddy-context-jump
// and optionally inject immediately into running Antigravity windows.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const TARGET_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'workbuddy-context-jump');

const COPY_ITEMS = ['plugin.json', 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', 'assets', 'src', 'sidecars', 'scripts', 'tests'];

fs.mkdirSync(TARGET_DIR, { recursive: true });

for (const item of COPY_ITEMS) {
  const srcPath = path.join(REPO_ROOT, item);
  if (!fs.existsSync(srcPath)) continue;
  const dstPath = path.join(TARGET_DIR, item);
  fs.cpSync(srcPath, dstPath, { recursive: true, force: true });
}

console.log(`[ok] Installed plugin to: ${TARGET_DIR}`);

if (!process.argv.includes('--no-inject')) {
  try {
    execFileSync(process.execPath, [path.join(TARGET_DIR, 'scripts', 'inject.mjs')], {
      stdio: 'inherit',
    });
  } catch {
    console.log('[info] Antigravity window not active or DevTools port unavailable; Sidecar will auto-attach when Antigravity runs.');
  }
}
