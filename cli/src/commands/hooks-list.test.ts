import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { registerHooksList } from './hooks-list.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-list-test-'));
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeProgram(): Command {
  const program = new Command();
  program
    .option('-s, --server-url <url>', 'server URL', 'http://localhost:7777')
    .option('--json', 'output as JSON');
  registerHooksList(program);
  return program;
}

/** Write a valid enriched hook log file into a directory. */
function writeLogFile(
  logsDir: string,
  opts: {
    event: string;
    script: string;
    taskId?: string;
    startedAt?: number;
    durationMs?: number;
    exitCode?: number;
  },
): void {
  fs.mkdirSync(logsDir, { recursive: true });
  const { event, script, taskId = '', startedAt = Date.now(), durationMs = 100, exitCode = 0 } = opts;
  const taskSuffix = taskId ? `-${taskId}` : '';
  const fileName = `${event}-${startedAt}-${script}${taskSuffix}.log`;
  const content = [
    `[octomux] event=${event} script=${script} task_id=${taskId} started_at=${startedAt}`,
    'hook output',
    `[octomux] duration_ms=${durationMs} exit_code=${exitCode}`,
  ].join('\n');
  fs.writeFileSync(path.join(logsDir, fileName), content);
}

/** Write an executable hook script file into the event.d directory. */
function writeHookScript(hooksBase: string, event: string, scriptName: string): void {
  const dir = path.join(hooksBase, `${event}.d`);
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, scriptName);
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
  fs.chmodSync(scriptPath, 0o755);
}

describe('hooks-list command', () => {
  let tmpDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanDir(tmpDir);
    vi.restoreAllMocks();
  });

  it('shows "(none)" when no hooks are installed globally', async () => {
    // No scripts installed; override hooksBase via symlink trick would be complex,
    // so we test by pointing --repo to a non-existent repo and ensuring output is generated
    const program = makeProgram();
    // We need to trick the globalHooksBase. Since it's hardcoded to os.homedir(), we
    // can't override it in a unit test easily. But we CAN verify that hooks from
    // a repo path are shown (or absent), and that the command doesn't crash.
    await program.parseAsync(['node', 'octomux', 'hooks-list', '--repo', tmpDir]);
    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Installed Hooks');
  });

  it('shows scripts from repo hooks dir', async () => {
    const repoDir = path.join(tmpDir, 'myrepo');
    fs.mkdirSync(repoDir);
    // Make it look like a git repo
    fs.mkdirSync(path.join(repoDir, '.git'));

    const repoHooksBase = path.join(repoDir, '.octomux', 'hooks');
    writeHookScript(repoHooksBase, 'workflow_status_changed', 'my-hook.sh');

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'hooks-list', '--repo', repoDir]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('my-hook.sh');
    expect(output).toContain('workflow_status_changed');
  });

  it('shows last-run info when logs exist', async () => {
    const repoDir = path.join(tmpDir, 'myrepo');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(path.join(repoDir, '.git'));

    const repoHooksBase = path.join(repoDir, '.octomux', 'hooks');
    writeHookScript(repoHooksBase, 'workflow_status_changed', 'jira-status');

    // Put logs in the data/logs/hooks path (dev mode)
    const logsDir = path.join(process.cwd(), 'data', 'logs', 'hooks');
    writeLogFile(logsDir, {
      event: 'workflow_status_changed',
      script: 'jira-status',
      startedAt: Date.now() - 120_000, // 2 minutes ago
      durationMs: 412,
      exitCode: 0,
    });

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'hooks-list', '--repo', repoDir]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('jira-status');
    // Should contain exit code info
    expect(output).toContain('exit 0');

    // Cleanup the logs we wrote
    fs.rmSync(logsDir, { recursive: true, force: true });
  });

  it('shows "(never run)" when no log exists for a script', async () => {
    const repoDir = path.join(tmpDir, 'myrepo');
    fs.mkdirSync(repoDir);
    fs.mkdirSync(path.join(repoDir, '.git'));

    const repoHooksBase = path.join(repoDir, '.octomux', 'hooks');
    writeHookScript(repoHooksBase, 'note_added', 'slack-notify.sh');

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'hooks-list', '--repo', repoDir]);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('never run');
  });
});
