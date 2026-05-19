#!/usr/bin/env node

/**
 * octomux-hook-bridge.js — Cursor hook bridge script
 *
 * Self-contained Node.js script (no npm dependencies). Copied into each
 * worktree's .octomux-hooks/ directory alongside a config.json that carries
 * {baseUrl, token}. Cursor invokes this as a hook command with event JSON
 * on stdin; the bridge forwards it to the octomux server and writes the
 * response JSON to stdout.
 *
 * Fail-open principle: any error (network, parse, missing config) writes '{}'
 * to stdout and exits 0 so Cursor is never blocked by bridge failures.
 *
 * The bridge NEVER exits with code 2. Deny is communicated via stdout JSON
 * {"permission":"deny",...} with exit 0.
 */

import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Hardcoded denylist — mirrors Claude's DENIED_TOOLS destructive set.
// These regexes are checked against event.command for beforeShellExecution.
const DENYLIST = [
  { re: /^\s*rm\s+-rf(\s|$)/, label: 'rm -rf' },
  { re: /^\s*git\s+push\s+--force(\s|$)/, label: 'git push --force' },
  { re: /^\s*git\s+reset\s+--hard(\s|$)/, label: 'git reset --hard' },
];

function writeStdout(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/**
 * POST JSON to a local http:// URL. Returns a promise that resolves with the
 * response status code on success, or rejects on network/timeout error.
 */
function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const qs = '?token=' + encodeURIComponent(token);

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + qs,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const payload = JSON.stringify(body);

    const req = http.request(options, (res) => {
      // Consume response body to free socket
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });

    // 5-second timeout — fail-open on expiry
    req.setTimeout(5000, () => {
      req.destroy(new Error('Hook bridge request timed out'));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  // Step 1: read all stdin synchronously. fd 0 = stdin.
  let stdinText = '';
  try {
    stdinText = fs.readFileSync(0, 'utf8');
  } catch {
    // No stdin available — treat as empty
  }

  // Step 2: parse stdin JSON. Malformed input → fail-open.
  let event;
  try {
    event = JSON.parse(stdinText);
  } catch {
    writeStdout({});
    process.exit(0);
  }

  // Step 3: resolve and read sibling config.json.
  let baseUrl, token;
  try {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.join(scriptDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    baseUrl = config.baseUrl;
    token = config.token;
    if (!baseUrl || !token) throw new Error('config.json missing baseUrl or token');
  } catch (err) {
    console.error('[octomux-hook-bridge] Failed to load config.json:', err);
    writeStdout({});
    process.exit(0);
  }

  // Step 4: branch on hook_event_name.
  const eventName = event.hook_event_name;

  if (eventName === 'sessionStart') {
    try {
      await postJson(baseUrl + '/api/hooks/session-start', token, {
        conversation_id: event.conversation_id,
        session_id: event.session_id,
        is_background_agent: event.is_background_agent ?? false,
      });
    } catch (err) {
      // HTTP error — fail-open
      console.error('[octomux-hook-bridge] sessionStart HTTP error:', err);
    }
    writeStdout({});
  } else if (eventName === 'beforeSubmitPrompt') {
    try {
      await postJson(baseUrl + '/api/hooks/user-prompt-submit', token, {
        conversation_id: event.conversation_id,
        prompt: event.prompt,
      });
    } catch (err) {
      console.error('[octomux-hook-bridge] beforeSubmitPrompt HTTP error:', err);
    }
    writeStdout({ continue: true });
  } else if (eventName === 'beforeShellExecution') {
    // Apply denylist locally — no HTTP call.
    const command = event.command ?? '';
    for (const rule of DENYLIST) {
      if (rule.re.test(command)) {
        writeStdout({
          permission: 'deny',
          user_message: 'Blocked by octomux denylist: ' + rule.label,
        });
        process.exit(0);
      }
    }
    writeStdout({ permission: 'allow' });
  } else if (eventName === 'postToolUse' || eventName === 'afterFileEdit') {
    try {
      await postJson(baseUrl + '/api/hooks/post-tool-use', token, {
        conversation_id: event.conversation_id,
        ...event,
      });
    } catch (err) {
      console.error('[octomux-hook-bridge] postToolUse/afterFileEdit HTTP error:', err);
    }
    writeStdout({});
  } else {
    // Unknown event — fail-open
    writeStdout({});
  }
}

main().catch((err) => {
  // Top-level safety net — any unhandled error must not crash Cursor
  console.error('[octomux-hook-bridge] Unhandled error:', err);
  writeStdout({});
  process.exit(0);
});
