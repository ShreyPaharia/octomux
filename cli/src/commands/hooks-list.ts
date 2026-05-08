import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';

const ALL_EVENTS = [
  'workflow_status_changed',
  'summary_updated',
  'note_added',
  'ref_added',
  'ref_removed',
  'task_created',
  'runtime_state_changed',
] as const;

type HookEvent = (typeof ALL_EVENTS)[number];

/** Detect the repo root by walking up from cwd looking for a .git dir. */
function detectRepoRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface ScriptInfo {
  name: string;
  fullPath: string;
}

function discoverScripts(hooksBase: string, event: HookEvent): ScriptInfo[] {
  const dir = path.join(hooksBase, `${event}.d`);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => {
        try {
          const st = fs.statSync(path.join(dir, name));
          return st.isFile();
        } catch {
          return false;
        }
      })
      .sort()
      .map((name) => ({ name, fullPath: path.join(dir, name) }));
  } catch {
    return [];
  }
}

interface ParsedMeta {
  durationMs: number | null;
  exitCode: number | null;
  startedAt: number;
}

function parseLogMeta(logPath: string): ParsedMeta | null {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    const headerLine = lines.find((l) => l.startsWith('[octomux] event='));
    if (!headerLine) return null;
    const startedAtMatch = headerLine.match(/started_at=(\d+)/);
    const startedAt = startedAtMatch ? parseInt(startedAtMatch[1], 10) : 0;

    const footerLine = lines.slice(1).find((l) => l.startsWith('[octomux] duration_ms='));
    let durationMs: number | null = null;
    let exitCode: number | null = null;
    if (footerLine) {
      const dm = footerLine.match(/duration_ms=(\d+)/);
      const ec = footerLine.match(/exit_code=(-?\d+)/);
      if (dm) durationMs = parseInt(dm[1], 10);
      if (ec) exitCode = parseInt(ec[1], 10);
    }
    return { durationMs, exitCode, startedAt };
  } catch {
    return null;
  }
}

/** Find the most recent log entry for a given event + script-basename pair. */
function findLastRun(logsDir: string, event: string, scriptName: string): ParsedMeta | null {
  try {
    if (!fs.existsSync(logsDir)) return null;
    const prefix = `${event}-`;
    const suffix = `-${scriptName}`;
    const files = fs
      .readdirSync(logsDir)
      .filter(
        (f) => f.startsWith(prefix) && (f.endsWith(`${suffix}.log`) || f.includes(`${suffix}-`)),
      )
      .map((f) => {
        try {
          return { f, mtime: fs.statSync(path.join(logsDir, f)).mtimeMs };
        } catch {
          return { f, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return parseLogMeta(path.join(logsDir, files[0].f));
  } catch {
    return null;
  }
}

function timeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function printHooksFor(
  label: string,
  hooksBase: string,
  logsDir: string,
  isProduction: boolean,
): void {
  console.log('');
  console.log(chalk.bold(`${label} (${hooksBase})`));

  let anyScript = false;
  for (const event of ALL_EVENTS) {
    const scripts = discoverScripts(hooksBase, event);
    if (scripts.length === 0) continue;
    anyScript = true;
    console.log(`  ${chalk.cyan(event)}`);
    for (const script of scripts) {
      const lastRun = findLastRun(logsDir, event, script.name);
      if (!lastRun) {
        console.log(`    ${chalk.dim('○')} ${script.name}${chalk.dim('  (never run)')}`);
      } else {
        const exitBadge =
          lastRun.exitCode === 0
            ? chalk.green('✓')
            : lastRun.exitCode !== null
              ? chalk.red('✗')
              : chalk.dim('?');
        const runMeta =
          lastRun.startedAt > 0
            ? chalk.dim(` last run: ${timeAgo(lastRun.startedAt)}`) +
              (lastRun.exitCode !== null ? chalk.dim(` (exit ${lastRun.exitCode}`) : '') +
              (lastRun.durationMs !== null
                ? chalk.dim(`, ${lastRun.durationMs}ms)`)
                : chalk.dim(')'))
            : '';
        console.log(`    ${exitBadge} ${script.name}${runMeta}`);
      }
    }
  }

  if (!anyScript) {
    console.log(`  ${chalk.dim('(none)')}`);
  }
  void isProduction;
}

export function registerHooksList(program: Command): void {
  program
    .command('hooks-list')
    .description('List installed hook scripts with last-run status.')
    .option('--repo <path>', 'repo path (default: auto-detect from cwd)')
    .action((opts: { repo?: string }) => {
      const isProduction = process.env.NODE_ENV === 'production';
      const globalHooksBase = path.join(os.homedir(), '.octomux', 'hooks');
      const logsDir = isProduction
        ? path.join(os.homedir(), '.octomux', 'logs', 'hooks')
        : path.join(process.cwd(), 'data', 'logs', 'hooks');

      console.log(chalk.bold.underline('Installed Hooks'));
      printHooksFor('global hooks', globalHooksBase, logsDir, isProduction);

      // Repo-local hooks
      const repoPath = opts.repo ?? detectRepoRoot(process.cwd());
      if (repoPath) {
        const repoHooksBase = path.join(repoPath, '.octomux', 'hooks');
        printHooksFor(`repo hooks`, repoHooksBase, logsDir, isProduction);
      } else {
        console.log('');
        console.log(chalk.dim('  (no repo detected in current directory)'));
      }

      console.log('');
    });
}
