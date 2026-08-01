import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDiffSummary } from '@octomux/diff-engine';
import type { DiffTarget } from '@octomux/diff-engine';
import { decorateDiffSummaryWithReviewState } from './diff-review-state.js';
import { createTestDb, insertTestTask } from './test-helpers.js';
import { setReviewed } from './repositories/file-review-state.js';

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
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'diff-review-'));
  await execFile('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  await execFile('git', ['-C', dir, 'config', 'user.email', 'test@test']);
  await execFile('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await execFile('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  return dir;
}

async function commit(dir: string, files: Record<string, string>, msg: string): Promise<void> {
  for (const [p, content] of Object.entries(files)) {
    const full = path.join(dir, p);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, content);
  }
  await execFile('git', ['-C', dir, 'add', '.']);
  await execFile('git', ['-C', dir, 'commit', '-q', '-m', msg]);
}

// Every case here drives real `git` subprocesses against a temp repo, which
// costs ~2.5-3.7s per test on its own. Under the full suite's parallel load that
// overruns vitest's 5s default and the file flakes. 20s leaves headroom without
// hiding a genuine hang.
describe('decorateDiffSummaryWithReviewState', { timeout: 20_000 }, () => {
  let repo: string;
  let baseSha: string;

  function makeTarget(overrides: Partial<DiffTarget> = {}): DiffTarget {
    return {
      id: 't-diff',
      worktree: repo,
      repo_path: repo,
      run_mode: 'worktree',
      base_branch: null,
      base_sha: baseSha,
      ...overrides,
    };
  }

  beforeEach(async () => {
    createTestDb();
    repo = await makeRepo();
    await commit(repo, { 'a.txt': 'hello\n', 'src/b.ts': 'export const x = 1;\n' }, 'initial');
    const { stdout } = await execFile('git', ['-C', repo, 'rev-parse', 'main']);
    baseSha = stdout.trim();
    await execFile('git', ['-C', repo, 'checkout', '-q', '-b', 'feature']);
  });

  afterEach(async () => {
    await fs.promises.rm(repo, { recursive: true, force: true });
  });

  it('sets reviewed_count to 0 when no files are reviewed', async () => {
    await commit(repo, { 'src/foo.ts': 'export const x = 1;\n' }, 'add foo');
    const summary = await getDiffSummary({ target: makeTarget() });
    const decorated = await decorateDiffSummaryWithReviewState('t-diff', repo, summary);
    expect(decorated.reviewed_count).toBe(0);
  });

  it('marks file reviewed when stored commit blob matches HEAD blob', async () => {
    await commit(repo, { 'src/foo.ts': 'export const x = 1;\n' }, 'add foo');
    const { stdout: headSha } = await execFile('git', ['-C', repo, 'rev-parse', 'HEAD']);
    insertTestTask({ id: 't-rev-1', worktree: repo, base_sha: baseSha, base_branch: null });
    setReviewed('t-rev-1', 'src/foo.ts', headSha.trim());

    const summary = await getDiffSummary({ target: makeTarget({ id: 't-rev-1' }) });
    const decorated = await decorateDiffSummaryWithReviewState('t-rev-1', repo, summary);
    const file = decorated.files.find((f) => f.path === 'src/foo.ts');
    expect(file?.reviewed).toBe(true);
    expect(file?.changed_since_review).toBe(false);
    expect(decorated.reviewed_count).toBe(1);
  });

  it('flags changed_since_review when blobs differ', async () => {
    await commit(repo, { 'src/foo.ts': 'export const x = 1;\n' }, 'add foo');
    const { stdout: oldHead } = await execFile('git', ['-C', repo, 'rev-parse', 'HEAD']);
    insertTestTask({ id: 't-rev-2', worktree: repo, base_sha: baseSha, base_branch: null });
    setReviewed('t-rev-2', 'src/foo.ts', oldHead.trim());
    await commit(repo, { 'src/foo.ts': 'export const x = 2;\n' }, 'tweak foo');

    const summary = await getDiffSummary({ target: makeTarget({ id: 't-rev-2' }) });
    const decorated = await decorateDiffSummaryWithReviewState('t-rev-2', repo, summary);
    const file = decorated.files.find((f) => f.path === 'src/foo.ts');
    expect(file?.reviewed).toBe(false);
    expect(file?.changed_since_review).toBe(true);
    expect(decorated.reviewed_count).toBe(0);
  });

  it('stays reviewed when reviewed against uncommitted content that has not changed', async () => {
    await fs.promises.writeFile(path.join(repo, 'a.txt'), 'dirty but reviewed\n');
    const { stdout: blob } = await execFile('git', ['-C', repo, 'hash-object', '--', 'a.txt']);
    const { stdout: head } = await execFile('git', ['-C', repo, 'rev-parse', 'HEAD']);
    insertTestTask({ id: 't-wd', worktree: repo, base_sha: baseSha, base_branch: null });
    setReviewed('t-wd', 'a.txt', head.trim(), blob.trim());

    const summary = await getDiffSummary({ target: makeTarget({ id: 't-wd' }) });
    const decorated = await decorateDiffSummaryWithReviewState('t-wd', repo, summary);
    const file = decorated.files.find((f) => f.path === 'a.txt');
    expect(file?.reviewed).toBe(true);
    expect(file?.changed_since_review).toBe(false);
    expect(decorated.reviewed_count).toBe(1);
  });
});
