// One-shot injector for WorkBuddy Context Jump (useful for manual testing / immediate activation).
import {
  PLUGIN_ROOT,
  readCdpPort,
  listEligiblePages,
  CdpSession,
  buildInjectBundle,
} from '../sidecars/context_jump/cdp-client.mjs';

const port = readCdpPort();
if (!port) {
  console.error('Antigravity DevToolsActivePort not found. Start Antigravity with --remote-debugging-port=0.');
  process.exit(1);
}

const bundle = buildInjectBundle(PLUGIN_ROOT);
const pages = await listEligiblePages(port);
if (!pages.length) {
  console.error(`No eligible Antigravity windows found on port ${port}.`);
  process.exit(1);
}

for (const page of pages) {
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    const res = await session.send('Runtime.evaluate', {
      expression: bundle.expression,
      returnByValue: true,
    });
    console.log(`[ok] ${page.title || page.url}:`, res?.result?.value);
  } finally {
    session.close();
  }
}
