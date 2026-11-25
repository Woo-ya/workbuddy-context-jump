// One-shot clean removal / restore script for WorkBuddy Context Jump.
import {
  readCdpPort,
  listEligiblePages,
  CdpSession,
  REMOVE_EXPRESSION,
} from '../sidecars/context_jump/cdp-client.mjs';

const port = readCdpPort();
if (!port) {
  console.error('Antigravity DevToolsActivePort not found.');
  process.exit(1);
}

const pages = await listEligiblePages(port);
for (const page of pages) {
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    const res = await session.send('Runtime.evaluate', {
      expression: REMOVE_EXPRESSION,
      returnByValue: true,
    });
    console.log(`[restored] ${page.title || page.url}:`, res?.result?.value);
  } finally {
    session.close();
  }
}
