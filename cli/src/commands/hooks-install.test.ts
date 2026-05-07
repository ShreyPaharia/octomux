import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { registerHooksInstall } from './hooks-install.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-install-test-'));
}

function cleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeProgram(): Command {
  const program = new Command();
  program
    .option('-s, --server-url <url>', 'server URL', 'http://localhost:7777')
    .option('--json', 'output as JSON');
  registerHooksInstall(program);
  return program;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('hooks-install command', () => {
  let hooksDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hooksDir = makeTmpDir();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanDir(hooksDir);
    vi.restoreAllMocks();
  });

  it('installs the jira-status template into the target hooks dir', async () => {
    const program = makeProgram();

    await program.parseAsync([
      'node',
      'octomux',
      'hooks-install',
      'jira-status',
      '--hooks-dir',
      hooksDir,
    ]);

    const eventDir = path.join(hooksDir, 'workflow_status_changed.d');
    expect(fs.existsSync(eventDir)).toBe(true);

    const scriptPath = path.join(eventDir, 'jira-status');
    expect(fs.existsSync(scriptPath)).toBe(true);

    const configPath = path.join(eventDir, 'jira-status.config.json');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('makes the hook script executable', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'hooks-install',
      'jira-status',
      '--hooks-dir',
      hooksDir,
    ]);

    const scriptPath = path.join(hooksDir, 'workflow_status_changed.d', 'jira-status');
    const stat = fs.statSync(scriptPath);
    // Check owner execute bit
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it('config file contains REPLACE_ME placeholders', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'hooks-install',
      'jira-status',
      '--hooks-dir',
      hooksDir,
    ]);

    const configPath = path.join(hooksDir, 'workflow_status_changed.d', 'jira-status.config.json');
    const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(content.in_progress).toBe('REPLACE_ME');
    expect(content.done).toBe('REPLACE_ME');
  });

  it('prints success and next-steps output', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'hooks-install',
      'jira-status',
      '--hooks-dir',
      hooksDir,
    ]);

    const output = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // Output should mention JIRA_BASE_URL and task-ref-add
    expect(output).toContain('JIRA_BASE_URL');
    expect(output).toContain('task-ref-add');
  });
});
