// Cleanly restore native Antigravity navigator and remove plugin directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TARGET_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'workbuddy-context-jump');
const removeScript = path.join(TARGET_DIR, 'scripts', 'remove.mjs');

if (fs.existsSync(removeScript)) {
  try {
    execFileSync(process.execPath, [removeScript], { stdio: 'inherit' });
  } catch {}
}

if (fs.existsSync(TARGET_DIR)) {
  try {
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
    console.log(`[ok] Removed plugin directory: ${TARGET_DIR}`);
  } catch (err) {
    console.error(`[warn] Could not fully remove ${TARGET_DIR} (Sidecar may still be running — disable the plugin in Antigravity Customizations first): ${err.message}`);
    process.exitCode = 1;
  }
} else {
  console.log('[info] Plugin directory already absent.');
}
