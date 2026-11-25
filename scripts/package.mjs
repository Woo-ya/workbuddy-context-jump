// Package WorkBuddy Context Jump into a distributable release ZIP under dist/.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
const version = pkg.version || '1.0.0';
const distDir = path.join(REPO_ROOT, 'dist');
const stageRoot = path.join(distDir, 'stage');
const stagePluginDir = path.join(stageRoot, 'workbuddy-context-jump');
const zipPath = path.join(distDir, `workbuddy-context-jump-v${version}.zip`);

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stagePluginDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

const INCLUDE = [
  'plugin.json',
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
  'assets',
  'src',
  'sidecars',
  'scripts',
  'tests',
];

for (const item of INCLUDE) {
  const srcPath = path.join(REPO_ROOT, item);
  if (!fs.existsSync(srcPath)) continue;
  fs.cpSync(srcPath, path.join(stagePluginDir, item), { recursive: true, force: true });
}

if (process.platform === 'win32') {
  const psCmd = `Compress-Archive -Path '${stagePluginDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', '-q', zipPath, 'workbuddy-context-jump'], {
    cwd: stageRoot,
    stdio: 'inherit',
  });
}

fs.rmSync(stageRoot, { recursive: true, force: true });
const stat = fs.statSync(zipPath);
console.log(`[ok] Packaged release archive: ${zipPath} (${stat.size} bytes)`);
