import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDiffSummary } from './diff.js';

const execFileRaw = promisify(execFileCb);

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

async function execFile(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileRaw(cmd, args, { env: gitEnv() });
}

async function makeRepo(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'diff-sha-'));
  await execFile('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await execFile('git', ['-C', dir, 'config', 'user.email', 'test@test']);
  await execFile('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await execFile('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  await fs.promises.writeFile(path.join(dir, 'a.txt'), 'hello\n');
  await execFile('git', ['-C', dir, 'add', '.']);
  await execFile('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

async function headSha(repo: string): Promise<string> {
  const { stdout } = await execFile('git', ['-C', repo, 'rev-parse', 'HEAD^{commit}']);
  return stdout.trim();
}

describe('diff module with captured base_sha', () => {
  let repo: string;
  let baseSha: string;

  beforeEach(async () => {
    repo = await makeRepo();
    baseSha = await headSha(repo);
  });

  afterEach(async () => {
    await fs.promises.rm(repo, { recursive: true, force: true });
  });

  it('computes diff against a captured SHA (new mode simulation)', async () => {
    await fs.promises.writeFile(path.join(repo, 'a.txt'), 'hello world\n');
    const summary = await getDiffSummary({ worktree: repo, base: baseSha });
    expect(summary.files).toEqual([{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }]);
  });

  it('computes diff against a captured SHA (existing mode simulation)', async () => {
    await fs.promises.writeFile(path.join(repo, 'b.txt'), 'new file\n');
    const summary = await getDiffSummary({ worktree: repo, base: baseSha });
    expect(summary.files).toEqual([{ path: 'b.txt', status: 'A', additions: 1, deletions: 0 }]);
  });

  it('computes diff against a captured SHA (none mode simulation)', async () => {
    await fs.promises.writeFile(path.join(repo, 'a.txt'), 'changed\n');
    const summary = await getDiffSummary({ worktree: repo, base: baseSha });
    expect(summary.files).toEqual([{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }]);
  });
});
