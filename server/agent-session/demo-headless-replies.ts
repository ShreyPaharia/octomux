/**
 * Demo — requires a real Claude Code login; NOT run in CI.
 * Run: bun tsx server/agent-session/demo-headless-replies.ts 'your prompt'
 *
 * Launches a headless Claude Code agent via the pty substrate, waits for it
 * to call submit_result with a list of reply strings, and prints the result.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { runAgentSession } from './session.js';
import { ptySubstrate } from './substrate-pty.js';
import { claudeCodeHarness } from '../harnesses/claude-code.js';

const outputSchema = {
  type: 'object',
  properties: {
    replies: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['replies'],
  additionalProperties: false,
};

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write(
      'Usage: bun tsx server/agent-session/demo-headless-replies.ts "your prompt"\n',
    );
    process.exit(1);
  }

  // Create an ephemeral workspace dir — no git required
  const workspaceDir = path.join(os.tmpdir(), `octomux-demo-${nanoid(8)}`);
  fs.mkdirSync(workspaceDir, { recursive: true });

  try {
    const { result } = await runAgentSession({
      workspaceDir,
      harness: claudeCodeHarness,
      input,
      substrate: ptySubstrate,
      outputSchema,
      timeoutMs: 120_000,
    });

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}
