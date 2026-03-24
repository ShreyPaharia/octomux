#!/usr/bin/env node

import { execFileSync, exec as execCb } from 'child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, cpSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read version from package.json at runtime
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;

// ─── Argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (command === 'start') {
  await runStart(args.slice(1));
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

  // Install bundled skills
  installSkills();

  // Ensure cli/ dependencies are installed
  ensureCliDeps();

  // Fix node-pty spawn-helper permissions (may have been missed if postinstall didn't run)
  fixNodePtyPermissions();

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

// ─── cli dependency installer ────────────────────────────────────────────────

function ensureCliDeps() {
  const cliDir = path.join(__dirname, '..', 'cli');
  const cliPkg = path.join(cliDir, 'package.json');
  if (!existsSync(cliPkg)) return;

  // Check if cli has dependencies that need installing
  const pkg = JSON.parse(readFileSync(cliPkg, 'utf8'));
  const hasDeps =
    (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
    (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0);
  if (!hasDeps) return;

  const cliModules = path.join(cliDir, 'node_modules');
  if (existsSync(cliModules)) return;

  console.log('Installing cli/ dependencies...');
  try {
    execFileSync('npm', ['install', '--ignore-scripts'], { cwd: cliDir, stdio: 'ignore' });
  } catch {
    console.warn('⚠  Could not install cli/ dependencies. Run manually: cd cli && npm install');
  }
}

// ─── node-pty permissions fix ────────────────────────────────────────────────

function fixNodePtyPermissions() {
  try {
    const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
    if (!existsSync(nodePtyDir)) return;
    const entries = readdirSync(nodePtyDir).filter((e) => e.startsWith('darwin-'));
    for (const entry of entries) {
      const helper = path.join(nodePtyDir, entry, 'spawn-helper');
      if (existsSync(helper)) {
        execFileSync('chmod', ['+x', helper], { stdio: 'ignore' });
      }
    }
  } catch {
    // Non-critical — node-pty may still work without this
  }
}

// ─── skill installer ─────────────────────────────────────────────────────────

function installSkills() {
  const skillsSource = path.join(__dirname, '..', 'skills');
  const skillsTarget = path.join(os.homedir(), '.claude', 'skills');

  if (!existsSync(skillsSource)) return;

  let installed = false;
  for (const skill of readdirSync(skillsSource)) {
    const target = path.join(skillsTarget, skill);
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
      cpSync(path.join(skillsSource, skill), target, { recursive: true });
      installed = true;
    }
  }
  if (installed) {
    console.log('Installed octomux skills for Claude Code');
  }
}
