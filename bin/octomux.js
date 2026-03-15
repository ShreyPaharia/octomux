#!/usr/bin/env node

import { execFileSync, exec as execCb } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read version from package.json at runtime
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;

// ─── Argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (command === 'start') {
  await runStart(args.slice(1));
} else if (command === 'init') {
  runInit();
} else {
  // Delegate to CLI (commander-based) for all other commands
  await import('../cli/dist/index.js');
}

// ─── start command ───────────────────────────────────────────────────────────

async function runStart(startArgs) {
  // Parse --port and --no-open flags
  let port = process.env.PORT || 7777;
  let autoOpen = true;

  for (let i = 0; i < startArgs.length; i++) {
    if (startArgs[i] === '--port' && startArgs[i + 1]) {
      port = parseInt(startArgs[i + 1], 10);
      i++;
    } else if (startArgs[i] === '--no-open') {
      autoOpen = false;
    }
  }

  // Welcome banner
  console.log(`\n\uD83D\uDC19 octomux v${version}\n`);

  // Preflight checks
  const required = [
    {
      cmd: 'tmux',
      args: ['-V'],
      name: 'tmux',
      hint: 'Install with: brew install tmux',
    },
    {
      cmd: 'git',
      args: ['--version'],
      name: 'git',
      hint: 'Install with: brew install git',
    },
    {
      cmd: 'claude',
      args: ['--version'],
      name: 'Claude Code CLI',
      hint: 'See: https://docs.anthropic.com/en/docs/claude-code',
    },
  ];

  const missing = [];
  for (const { cmd, args: checkArgs, name, hint } of required) {
    try {
      execFileSync(cmd, checkArgs, { stdio: 'ignore' });
    } catch {
      missing.push({ name, hint });
    }
  }

  if (missing.length > 0) {
    console.error('Missing required dependencies:\n');
    for (const { name, hint } of missing) {
      console.error(`  - ${name}`);
      console.error(`    ${hint}\n`);
    }
    process.exit(1);
  }

  // Start server
  process.env.NODE_ENV = 'production';
  process.env.PORT = String(port);

  const { server } = await import('../dist-server/index.js');

  // The server is already listening (listen called in index.js).
  // Attach handler for auto-open and status message.
  const url = `http://localhost:${port}`;

  if (server.listening) {
    onReady();
  } else {
    server.on('listening', onReady);
  }

  function onReady() {
    console.log(`Dashboard running at ${url} \u2014 press Ctrl+C to stop\n`);
    if (autoOpen && process.platform === 'darwin') {
      execCb(`open ${url}`);
    }
  }
}

// ─── init command ────────────────────────────────────────────────────────────

function runInit() {
  // Verify git repo
  if (!existsSync('.git')) {
    console.error('Error: Current directory is not a git repository.');
    console.error('Run this command from the root of a git repo.');
    process.exit(1);
  }

  const settingsPath = path.join('.claude', 'settings.local.json');

  if (existsSync(settingsPath)) {
    console.log(`${settingsPath} already exists. No changes made.`);
    return;
  }

  const settings = {
    permissions: {
      allow: [
        'Bash(git *)',
        'Bash(npm *)',
        'Bash(bun *)',
        'Read',
        'Write',
        'Edit',
      ],
    },
  };

  mkdirSync('.claude', { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  console.log(`Created ${settingsPath} with recommended agent permissions.`);
  console.log(`Add to .gitignore: .claude/settings.local.json`);
}
