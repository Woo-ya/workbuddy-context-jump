// WorkBuddy Context Jump — Managed Antigravity Sidecar Daemon (daemon.mjs)
// Automatically discovers running Antigravity windows via DevToolsActivePort,
// injects the WorkBuddy right-edge context jump navigator, persists across reloads,
// hot-reloads on source changes, and cleanly restores native UI on shutdown.

import fs from 'node:fs';
import path from 'node:path';
import {
  PLUGIN_ROOT,
  readCdpPort,
  listEligiblePages,
  CdpSession,
  buildInjectBundle,
  REMOVE_EXPRESSION,
} from './cdp-client.mjs';

const POLL_INTERVAL_MS = 2500;
const LOG_FILE = path.join(PLUGIN_ROOT, 'daemon.log');

const attached = new Map(); // targetId -> { session, scriptId, hash, title }
let shuttingDown = false;
let currentBundle = buildInjectBundle(PLUGIN_ROOT);
let scanTimer = null;
let reloadDebounce = null;
const watchers = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    console.log(line);
  } catch {}
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

async function attachAndInject(page) {
  const existing = attached.get(page.id);
  if (existing && !existing.session.closed) {
    if (existing.hash === currentBundle.hash) return;
    try {
      if (existing.scriptId) {
        await existing.session.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: existing.scriptId,
        });
      }
      const added = await existing.session.send('Page.addScriptToEvaluateOnNewDocument', {
        source: currentBundle.expression,
      });
      existing.scriptId = added?.identifier || null;
      await existing.session.send('Runtime.evaluate', {
        expression: currentBundle.expression,
        returnByValue: true,
      });
      existing.hash = currentBundle.hash;
      log(`[hot-reload] Updated ${existing.title} (${currentBundle.hash})`);
    } catch (err) {
      log(`[warn] Hot-reload failed for ${existing.title}: ${err.message}`);
    }
    return;
  }

  try {
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    const title = (page.title || page.url || page.id).slice(0, 60);
    const entry = { session, scriptId: null, hash: '', title };
    attached.set(page.id, entry);

    session.onClose = () => {
      if (attached.get(page.id) === entry) {
        attached.delete(page.id);
      }
    };

    await session.send('Page.enable');
    const added = await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: currentBundle.expression,
    });
    entry.scriptId = added?.identifier || null;

    const evalRes = await session.send('Runtime.evaluate', {
      expression: currentBundle.expression,
      returnByValue: true,
    });
    entry.hash = currentBundle.hash;

    const val = evalRes?.result?.value;
    log(`[attached] ${title} -> ${val?.status || 'ok'} (${currentBundle.hash})`);
  } catch (err) {
    attached.delete(page.id);
    log(`[warn] Failed to attach to ${page.id}: ${err.message}`);
  }
}

async function scanTargets() {
  if (shuttingDown) return;
  const port = readCdpPort();
  if (!port) return;
  try {
    const pages = await listEligiblePages(port);
    for (const page of pages) {
      if (shuttingDown) break;
      await attachAndInject(page);
    }
  } catch {}
}

function setupHotReloadWatchers() {
  const srcDir = path.join(PLUGIN_ROOT, 'src');
  try {
    const watcher = fs.watch(srcDir, () => {
      if (shuttingDown) return;
      clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(() => {
        try {
          currentBundle = buildInjectBundle(PLUGIN_ROOT);
          scanTargets();
        } catch (err) {
          log(`[warn] Rebuild failed: ${err.message}`);
        }
      }, 150);
    });
    watchers.push(watcher);
  } catch {}
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[shutdown] Received ${signal}; restoring native navigator...`);

  clearInterval(scanTimer);
  clearTimeout(reloadDebounce);
  for (const w of watchers) {
    try {
      w.close();
    } catch {}
  }

  const cleanupTasks = [];
  for (const entry of attached.values()) {
    if (!entry || entry.session.closed) continue;
    cleanupTasks.push(
      (async () => {
        try {
          if (entry.scriptId) {
            await entry.session.send('Page.removeScriptToEvaluateOnNewDocument', {
              identifier: entry.scriptId,
            }, 1500);
          }
          await entry.session.send('Runtime.evaluate', {
            expression: REMOVE_EXPRESSION,
            returnByValue: true,
          }, 1500);
        } catch {}
        entry.session.close();
      })()
    );
  }

  await Promise.race([
    Promise.allSettled(cleanupTasks),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log(`[error] uncaughtException: ${err?.stack || err}`));
process.on('unhandledRejection', (err) => log(`[error] unhandledRejection: ${err?.stack || err}`));

log(`[boot] WorkBuddy Context Jump daemon started (pid=${process.pid}, hash=${currentBundle.hash})`);
setupHotReloadWatchers();
scanTargets();
scanTimer = setInterval(scanTargets, POLL_INTERVAL_MS);
