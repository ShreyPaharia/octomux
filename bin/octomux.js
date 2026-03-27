#!/usr/bin/env node

import { execFileSync, exec as execCb } from 'child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, cpSync, rmSync } from 'fs';
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

  // Install bundled skills and configs
  installSkills();
  installLazygitConfig();

  // Ensure cli/ dependencies are installed
  ensureCliDeps();

  // Fix node-pty spawn-helper permissions (may have been missed if postinstall didn't run)
  fixNodePtyPermissions();

  // Preflight: ensure all required binaries are installed
  const { ensureBinary, checkNeovimVersion, syncLazyVimPlugins } =
    await import('../dist-server/startup.js');

  const required = [
    { cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux' },
    { cmd: 'git', checkArgs: ['--version'], brewPkg: 'git' },
    {
      cmd: 'claude',
      checkArgs: ['--version'],
      name: 'Claude Code CLI',
      installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    },
    { cmd: 'nvim', checkArgs: ['--version'], brewPkg: 'neovim', name: 'neovim' },
    { cmd: 'lazygit', checkArgs: ['--version'], brewPkg: 'lazygit' },
  ];

  for (const dep of required) {
    ensureBinary(dep);
  }

  // Neovim-specific: version check + LazyVim plugin sync
  const repoRoot = path.resolve(__dirname, '..');
  checkNeovimVersion();
  syncLazyVimPlugins(repoRoot);

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

function installLazygitConfig() {
  const source = path.join(__dirname, '..', '.config', 'lazygit', 'config.yml');
  if (!existsSync(source)) return;

  const configDir =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'lazygit')
      : path.join(os.homedir(), '.config', 'lazygit');
  const target = path.join(configDir, 'config.yml');

  if (existsSync(target)) return;

  mkdirSync(configDir, { recursive: true });
  cpSync(source, target);
  console.log('Installed lazygit config');
}

function installSkills() {
  const skillsSource = path.join(__dirname, '..', 'skills');
  const skillsTarget = path.join(os.homedir(), '.claude', 'skills');

  if (!existsSync(skillsSource)) return;

  // Remove old-named skills that have been renamed
  const deprecated = ['octomux-create-pr', 'octomux-create-task', 'octomux-create-commit', 'octomux-executing-plans'];
  for (const name of deprecated) {
    const old = path.join(skillsTarget, name);
    if (existsSync(old)) {
      rmSync(old, { recursive: true });
    }
  }

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
