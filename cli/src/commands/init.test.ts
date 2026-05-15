import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { registerInit } from './init.js';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-init-test-'));
}

function makeProgram(): Command {
  const program = new Command();
  program
    .option('-s, --server-url <url>', 'server URL', 'http://localhost:7777')
    .option('--json', 'output as JSON');
  // Suppress commander's exit so failed validations don't kill the test process.
  program.exitOverride();
  registerInit(program);
  return program;
}

describe('init command', () => {
  let tmpHome: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = makeTmpHome();
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes settings.json with values from non-interactive flags', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'init',
      '--non-interactive',
      '--jira-url',
      'https://test.atlassian.net',
      '--jira-project',
      'TEST',
      '--base-branch',
      'main',
    ]);

    const settingsFile = path.join(tmpHome, '.octomux', 'settings.json');
    expect(fs.existsSync(settingsFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(parsed.defaultJiraBaseUrl).toBe('https://test.atlassian.net');
    expect(parsed.defaultJiraProjectKey).toBe('TEST');
    expect(parsed.defaultBaseBranch).toBe('main');
  });

  it('flags imply non-interactive mode', async () => {
    const program = makeProgram();
    // No --non-interactive flag; the presence of --base-branch should suffice.
    await program.parseAsync(['node', 'octomux', 'init', '--base-branch', 'develop']);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.octomux', 'settings.json'), 'utf-8'),
    );
    expect(parsed.defaultBaseBranch).toBe('develop');
  });

  it('merges with existing settings without removing unrelated keys', async () => {
    const dir = path.join(tmpHome, '.octomux');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        editor: 'vscode',
        dangerouslySkipPermissions: true,
        claudeFlags: '--verbose',
      }),
    );

    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'init',
      '--non-interactive',
      '--jira-project',
      'NEW',
    ]);

    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
    expect(parsed.editor).toBe('vscode');
    expect(parsed.dangerouslySkipPermissions).toBe(true);
    expect(parsed.claudeFlags).toBe('--verbose');
    expect(parsed.defaultJiraProjectKey).toBe('NEW');
  });

  it('uppercases the project key', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'init',
      '--non-interactive',
      '--jira-project',
      'proj',
    ]);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.octomux', 'settings.json'), 'utf-8'),
    );
    expect(parsed.defaultJiraProjectKey).toBe('PROJ');
  });

  it('strips trailing slash from Jira URL', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'init',
      '--non-interactive',
      '--jira-url',
      'https://test.atlassian.net///',
    ]);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.octomux', 'settings.json'), 'utf-8'),
    );
    expect(parsed.defaultJiraBaseUrl).toBe('https://test.atlassian.net');
  });

  it('rejects a Jira URL without http(s) scheme', async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync([
        'node',
        'octomux',
        'init',
        '--non-interactive',
        '--jira-url',
        'test.atlassian.net',
      ]),
    ).rejects.toThrow(/process.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects an invalid project key', async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync([
        'node',
        'octomux',
        'init',
        '--non-interactive',
        '--jira-project',
        '123-bad',
      ]),
    ).rejects.toThrow(/process.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('creates ~/.octomux directory if missing', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'init',
      '--non-interactive',
      '--base-branch',
      'develop',
    ]);
    expect(fs.existsSync(path.join(tmpHome, '.octomux'))).toBe(true);
  });

  it('skips fields that are not provided non-interactively', async () => {
    const program = makeProgram();
    await program.parseAsync([
      'node',
      'octomux',
      'init',
      '--non-interactive',
      '--base-branch',
      'main',
    ]);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.octomux', 'settings.json'), 'utf-8'),
    );
    expect(parsed.defaultBaseBranch).toBe('main');
    expect(parsed.defaultJiraBaseUrl).toBeUndefined();
    expect(parsed.defaultJiraProjectKey).toBeUndefined();
  });
});
