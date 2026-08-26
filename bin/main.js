#!/usr/bin/env bun

/**
 * The octomux application entry — this is what `bun build --compile` bundles
 * into the single-file binary (see `build:binary`).
 *
 * It is NOT the npm `bin` target: that's `bin/octomux.js`, a plain-Node
 * launcher, because this file imports TypeScript sources directly.
 */

import { which } from 'bun';
import { exec as execCb } from 'child_process';
import { existsSync, mkdirSync, readdirSync, cpSync } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import pkg from '../package.json';
import { assetRoot, isCompiled } from '../server/assets.ts';
import { installSkills, installCliShim } from './installers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Imported, not read from disk: inside a compiled binary there is no
// package.json next to __dirname, and a static import gets bundled.
const version = pkg.version;

// ─── Argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (command === 'start') {
  await runStart(args.slice(1));
} else if (command === 'review') {
  await runReview(args.slice(1));
} else if (command === '__submit-result-mcp') {
  // Hidden: stdio MCP subprocess spawned by the compiled binary itself
  // (submitResultServerInvocation in server/agent-session/mcp/config.ts).
  const { main } = await import('../server/agent-session/mcp/submit-result-server.ts');
  await main();
} else if (command === '__octomux-mcp') {
  // Hidden: stdio MCP subprocess (mcpServerInvocation in server/orchestrator/runner.ts).
  const { main } = await import('../server/orchestrator/mcp/server.ts');
  await main();
} else {
  // Delegate to CLI (commander-based) for all other commands
  await import('../cli/src/index.ts');
}

// ─── tmux binary resolver ────────────────────────────────────────────────────
// Mirrors the resolution logic in server/tmux-bin.ts (kept in sync manually).
// Uses createRequire so the optional CJS package can be loaded from ESM context.

const _require = createRequire(import.meta.url);

function resolveTmuxBin() {
  if (process.env.OCTOMUX_TMUX_BIN) return process.env.OCTOMUX_TMUX_BIN;
  try {
    const tmuxPkg = `@octomux/tmux-${process.platform}-${process.arch}`;
    const { tmuxBin } = _require(tmuxPkg);
    if (tmuxBin) return tmuxBin;
  } catch {
    /* not installed yet — fall back to PATH */
  }
  return 'tmux';
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
    } else if (startArgs[i] === '--bind' && startArgs[i + 1]) {
      process.env.OCTOMUX_BIND = startArgs[i + 1];
      i++;
    } else if (startArgs[i] === '--no-open') {
      autoOpen = false;
    } else if (startArgs[i] === '--safe-mode') {
      // Read by server/plugins/loader.ts: skips every manifest plugin row,
      // but core harnesses/providers still register (they're side effects of
      // importing harnesses/index.js and integrations/index.js, unconditional).
      process.env.OCTOMUX_SAFE_MODE = '1';
    }
  }

  // Welcome banner
  console.log(`\n\uD83D\uDC19 octomux v${version}\n`);

  // Install bundled skills and configs. Skills are version-gated: a stamp
  // matching this version means nothing to install or update.
  if (
    installSkills({
      source: path.join(assetRoot(), 'plugin', 'skills'),
      target: path.join(os.homedir(), '.claude', 'skills'),
      version,
    })
  ) {
    console.log('Installed octomux skills for Claude Code');
  }
  installWorkflows();
  installLazygitConfig();
  // npm installs own their bin shim; only the standalone compiled binary needs
  // to put itself on PATH — and only when nothing else already provides octomux.
  if (isCompiled) {
    const link = installCliShim({
      execPath: process.execPath,
      onPath: Boolean(which('octomux')),
    });
    if (link) {
      console.log(`Linked ${link} -> ${process.execPath}`);
      const onPathDirs = (process.env.PATH || '').split(path.delimiter);
      if (!onPathDirs.includes(path.dirname(link))) {
        console.log(`Note: add ${path.dirname(link)} to PATH so agents can run the octomux CLI.`);
      }
    }
  }

  // Preflight: warn about missing tools (install from dashboard Setup — no blocking exit)
  const { warnBinary, checkNeovimVersion } = await import('../server/startup.ts');

  const resolvedTmux = resolveTmuxBin();
  const preflight = [
    {
      cmd: resolvedTmux,
      checkArgs: ['-V'],
      name: 'tmux',
      // No brewPkg — tmux is bundled via @octomux/tmux-<platform>-<arch>.
      // If the bundled package isn't available and PATH tmux is also missing,
      // the bundled binary isn't available for this platform/arch and PATH tmux is also missing.
    },
    { cmd: 'git', checkArgs: ['--version'], brewPkg: 'git' },
    {
      cmd: 'claude',
      checkArgs: ['--version'],
      name: 'Claude Code CLI',
      installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    },
    {
      cmd: 'cursor-agent',
      checkArgs: ['--version'],
      name: 'Cursor CLI',
      installUrl: 'https://cursor.com/docs/cli',
    },
    { cmd: 'nvim', checkArgs: ['--version'], brewPkg: 'neovim', name: 'neovim' },
    { cmd: 'lazygit', checkArgs: ['--version'], brewPkg: 'lazygit' },
  ];

  for (const dep of preflight) {
    warnBinary(dep);
  }

  checkNeovimVersion();
  console.log('Open Setup in the dashboard to install dependencies and configure defaults.');
  console.log('Tip: use --bind 0.0.0.0 to enable remote access over Tailscale.\n');

  // Start server
  process.env.NODE_ENV = 'production';
  process.env.PORT = String(port);

  const { server } = await import('../server/index.ts');

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

// ─── review subcommand ───────────────────────────────────────────────────────

async function runReview(reviewArgs) {
  const { runReview: handler } = await import('../cli/review/index.ts');
  await handler(reviewArgs);
}

// ─── skill installer ─────────────────────────────────────────────────────────

function installLazygitConfig() {
  const source = path.join(assetRoot(), '.config', 'lazygit', 'config.yml');
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

function installWorkflows() {
  const src = path.join(assetRoot(), 'workflows');
  const target = path.join(os.homedir(), '.claude', 'workflows');
  if (!existsSync(src)) return;

  mkdirSync(target, { recursive: true });
  let installed = false;
  for (const file of readdirSync(src)) {
    if (!file.endsWith('.js')) continue;
    // Overwrite so workflow updates actually ship (unlike skills, which only
    // install when missing). The review-deep skill invokes these by scriptPath.
    cpSync(path.join(src, file), path.join(target, file));
    installed = true;
  }
  if (installed) {
    console.log('Installed octomux review workflows for Claude Code');
  }
}
