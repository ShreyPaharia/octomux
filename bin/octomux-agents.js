#!/usr/bin/env node

import { execFileSync } from 'child_process';

// ─── Preflight checks ──────────────────────────────────────────────────────

const required = [
  { cmd: 'tmux', args: ['-V'], name: 'tmux' },
  { cmd: 'git', args: ['--version'], name: 'git' },
  { cmd: 'claude', args: ['--version'], name: 'claude (Claude Code CLI)' },
];

const missing = [];
for (const { cmd, args, name } of required) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error('octomux-agents: missing required system dependencies:');
  for (const name of missing) {
    console.error(`  - ${name}`);
  }
  console.error('\nInstall them and try again.');
  process.exit(1);
}

// ─── Start server ───────────────────────────────────────────────────────────

process.env.NODE_ENV = 'production';
await import('../dist-server/index.js');
