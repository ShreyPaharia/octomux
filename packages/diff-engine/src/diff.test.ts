import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getDiffSummary,
  getFileDiff,
  safeResolvePath,
  MAX_IGNORED_FILES,
  IGNORED_DENY_PREFIXES,
} from './diff.js';
import type { DiffTarget } from './types.js';

const execFileRaw = promisify(execFileCb);

// Strip GIT_* env vars so temp-repo git calls aren't hijacked by an outer
// git operation (e.g. the husky pre-push hook exports GIT_DIR / GIT_INDEX_FILE
// pointing at the main repo, which would otherwise make `git -C /tmp/... commit`
// target the main repo instead of the temp dir).
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
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'diff-test-'));
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

describe('diff module', () => {
  let repo: string;
  let baseSha: string;

  // Build a Task pointing at the temp repo, with `base_branch` left null so
  // `resolveDiffBase` returns the snapshot SHA without trying to fetch from a
  // non-existent origin.
  function makeTargetForRepo(overrides: Partial<DiffTarget> = {}): DiffTarget {
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
    repo = await makeRepo();
    await commit(repo, { 'a.txt': 'hello\n', 'src/b.ts': 'export const x = 1;\n' }, 'initial');
    const { stdout } = await execFile('git', ['-C', repo, 'rev-parse', 'main']);
    baseSha = stdout.trim();
    await execFile('git', ['-C', repo, 'checkout', '-q', '-b', 'feature']);
  });

  afterEach(async () => {
    await fs.promises.rm(repo, { recursive: true, force: true });
  });

  describe('getDiffSummary', () => {
    it('returns empty for no changes', async () => {
      const summary = await getDiffSummary({ target: makeTargetForRepo() });
      expect(summary.files).toEqual([]);
    });

    it('reports a committed modification', async () => {
      await commit(repo, { 'a.txt': 'hello world\n' }, 'tweak a');
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'a.txt',
        status: 'M',
        additions: 1,
        deletions: 1,
      });
      expect(files[0].post_blob_sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('reports an unstaged modification', async () => {
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'hello there\n');
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'a.txt',
        status: 'M',
        additions: 1,
        deletions: 1,
      });
      // unstaged: HEAD blob still matches the committed (pre-edit) content
      expect(files[0].post_blob_sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('reports an untracked file as added', async () => {
      await fs.promises.writeFile(path.join(repo, 'new.txt'), 'new\nfile\n');
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'new.txt',
        status: 'A',
        additions: 2,
        deletions: 0,
      });
      // Untracked files carry the working-tree content hash so edits to them are
      // detected for refetch / "changed since review".
      expect(files[0].post_blob_sha).toMatch(/^[0-9a-f]{40}$/);
    });

    // Regression: when a directory contains tracked files but a sub-tree (e.g.
    // docs/superpowers/) is partly gitignored with a `!` un-ignore for one file,
    // `git status --porcelain=v1` (default -unormal) collapses the untracked
    // sub-tree into a single trailing-slash entry. That used to leak through as
    // a fake file with empty basename and crash the right pane with EISDIR.
    it('expands partially-untracked directories into their real file paths', async () => {
      await commit(repo, { 'docs/tracked.md': 'tracked\n' }, 'add docs/tracked.md');
      await fs.promises.writeFile(
        path.join(repo, '.gitignore'),
        'docs/superpowers/*\n!docs/superpowers/README.md\n',
      );
      await fs.promises.mkdir(path.join(repo, 'docs/superpowers'), { recursive: true });
      await fs.promises.writeFile(path.join(repo, 'docs/superpowers/README.md'), 'sp readme\n');

      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      const paths = files.map((f) => f.path);
      // No trailing-slash directory entry leaks through.
      expect(paths.every((p) => !p.endsWith('/'))).toBe(true);
      // The actual file is present with its real basename.
      const readme = files.find((f) => f.path === 'docs/superpowers/README.md');
      expect(readme).toBeDefined();
      expect(readme?.status).toBe('A');
      // Defensive: every emitted path has a non-empty basename so the tree
      // builder produces visible nodes.
      for (const p of paths) {
        const basename = p.split('/').pop();
        expect(basename).toBeTruthy();
      }
    });

    it('reports a deleted file', async () => {
      await fs.promises.unlink(path.join(repo, 'a.txt'));
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'a.txt',
        status: 'D',
        additions: 0,
        deletions: 1,
        post_blob_sha: null,
      });
    });

    it('merges committed and uncommitted changes on the same file', async () => {
      await commit(repo, { 'a.txt': 'hello world\n' }, 'tweak a');
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'hello universe\n');
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('a.txt');
      expect(files[0].status).toBe('M');
    });
  });

  describe('getDiffSummary extended', () => {
    it('includes base_sha, base_ref, base_is_stale on the summary', async () => {
      await commit(repo, { 'src/foo.ts': 'export const x = 1;\n' }, 'add foo');
      const summary = await getDiffSummary({ target: makeTargetForRepo() });
      // No base_branch → snapshot SHA, not stale, ref = short SHA.
      expect(summary.base_sha).toBe(baseSha);
      expect(summary.base_ref).toBe(baseSha.slice(0, 7));
      expect(summary.base_is_stale).toBe(false);
      expect(summary.total_count).toBeGreaterThan(0);
    });

    it('post_blob_sha reflects the working-tree content (base), not HEAD', async () => {
      await commit(repo, { 'a.txt': 'committed\n' }, 'commit a');
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'uncommitted edit\n');
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      const { stdout: workingHash } = await execFile('git', [
        '-C',
        repo,
        'hash-object',
        '--',
        'a.txt',
      ]);
      expect(files.find((f) => f.path === 'a.txt')?.post_blob_sha).toBe(workingHash.trim());
    });

    it('total_count excludes ignored files', async () => {
      await fs.promises.writeFile(path.join(repo, '.gitignore'), '*.log\n');
      await fs.promises.writeFile(path.join(repo, 'debug.log'), 'x\n');
      const summary = await getDiffSummary({ target: makeTargetForRepo() });
      const ignored = summary.files.filter((f) => f.ignored).length;
      const nonIgnored = summary.files.length - ignored;
      expect(summary.total_count).toBe(nonIgnored);
      expect(ignored).toBeGreaterThan(0);
    });
  });

  describe('getFileDiff', () => {
    it('returns old and new content for a modified tracked file', async () => {
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'hello there\n');
      const diff = await getFileDiff({ worktree: repo, base: 'main', relPath: 'a.txt' });
      expect(diff).toEqual({
        oldContent: 'hello\n',
        newContent: 'hello there\n',
        status: 'M',
        tooLarge: false,
        binary: false,
        isDirectory: false,
      });
    });

    it('returns empty oldContent for an untracked file', async () => {
      await fs.promises.writeFile(path.join(repo, 'new.txt'), 'fresh\n');
      const diff = await getFileDiff({ worktree: repo, base: 'main', relPath: 'new.txt' });
      expect(diff.oldContent).toBe('');
      expect(diff.newContent).toBe('fresh\n');
      expect(diff.status).toBe('A');
    });

    it('returns empty newContent for a deleted file', async () => {
      await fs.promises.unlink(path.join(repo, 'a.txt'));
      const diff = await getFileDiff({ worktree: repo, base: 'main', relPath: 'a.txt' });
      expect(diff.oldContent).toBe('hello\n');
      expect(diff.newContent).toBe('');
      expect(diff.status).toBe('D');
    });

    it('flags a file above 1 MiB as tooLarge', async () => {
      const big = 'x'.repeat(1_048_577);
      await fs.promises.writeFile(path.join(repo, 'big.txt'), big);
      const diff = await getFileDiff({ worktree: repo, base: 'main', relPath: 'big.txt' });
      expect(diff.tooLarge).toBe(true);
      expect(diff.newContent).toBe('');
    });

    it('returns isDirectory=true for a directory path instead of throwing EISDIR', async () => {
      await fs.promises.mkdir(path.join(repo, 'somedir'));
      const diff = await getFileDiff({ worktree: repo, base: 'main', relPath: 'somedir' });
      expect(diff.isDirectory).toBe(true);
      expect(diff.newContent).toBe('');
      expect(diff.tooLarge).toBe(false);
      expect(diff.binary).toBe(false);
    });
  });

  describe('ignored files', () => {
    async function writeIgnoreAndFiles(files: Record<string, string>): Promise<void> {
      for (const [p, content] of Object.entries(files)) {
        const full = path.join(repo, p);
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, content);
      }
    }

    it('includes gitignored files with ignored=true and status=A', async () => {
      await writeIgnoreAndFiles({
        '.gitignore': '*.log\n',
        'debug.log': 'line1\nline2\n',
      });
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      const entry = files.find((f) => f.path === 'debug.log');
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        path: 'debug.log',
        status: 'A',
        additions: 2,
        deletions: 0,
        ignored: true,
      });
      // .gitignore itself is untracked (not ignored), must NOT carry ignored flag
      const gi = files.find((f) => f.path === '.gitignore');
      expect(gi?.ignored).toBeUndefined();
    });

    it('applies the deny-prefix list to filter out cache/build dirs', async () => {
      // Include one entry per deny prefix, plus one legitimate ignored file.
      const ignoreLines = ['*.log', ...IGNORED_DENY_PREFIXES.map((p) => p.replace(/\/$/, ''))];
      await writeIgnoreAndFiles({
        '.gitignore': ignoreLines.join('\n') + '\n',
        'debug.log': 'x\n',
        'node_modules/pkg/index.js': 'x\n',
        'dist/bundle.js': 'x\n',
        'coverage/lcov.info': 'x\n',
        '.DS_Store': 'x',
      });
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      const ignoredPaths = files.filter((f) => f.ignored).map((f) => f.path);
      expect(ignoredPaths).toContain('debug.log');
      expect(ignoredPaths).not.toContain('node_modules/pkg/index.js');
      expect(ignoredPaths).not.toContain('dist/bundle.js');
      expect(ignoredPaths).not.toContain('coverage/lcov.info');
      expect(ignoredPaths).not.toContain('.DS_Store');
    });

    it('flags oversized ignored files with tooLarge=true but still lists them', async () => {
      await writeIgnoreAndFiles({
        '.gitignore': '*.log\n',
      });
      const big = 'x'.repeat(1_048_577);
      await fs.promises.writeFile(path.join(repo, 'big.log'), big);
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      const entry = files.find((f) => f.path === 'big.log');
      expect(entry).toBeDefined();
      expect(entry?.ignored).toBe(true);
      expect(entry?.tooLarge).toBe(true);
      expect(entry?.additions).toBe(0);
    });

    it('marks binary ignored files with binary=true', async () => {
      await writeIgnoreAndFiles({
        '.gitignore': '*.bin\n',
      });
      await fs.promises.writeFile(
        path.join(repo, 'blob.bin'),
        Buffer.from([0, 1, 2, 3, 0, 255, 10]),
      );
      const { files } = await getDiffSummary({ target: makeTargetForRepo() });
      const entry = files.find((f) => f.path === 'blob.bin');
      expect(entry?.ignored).toBe(true);
      expect(entry?.binary).toBe(true);
      expect(entry?.additions).toBe(0);
    });

    it('truncates the ignored list at MAX_IGNORED_FILES and sets ignoredTruncated', async () => {
      await writeIgnoreAndFiles({
        '.gitignore': '*.log\n',
      });
      for (let i = 0; i < MAX_IGNORED_FILES + 5; i++) {
        await fs.promises.writeFile(path.join(repo, `file${i}.log`), 'x\n');
      }
      const summary = await getDiffSummary({ target: makeTargetForRepo() });
      const ignored = summary.files.filter((f) => f.ignored);
      expect(ignored).toHaveLength(MAX_IGNORED_FILES);
      expect(summary.ignoredTruncated).toBe(true);
    });

    it('does NOT set ignoredTruncated when list fits under the cap', async () => {
      await writeIgnoreAndFiles({
        '.gitignore': '*.log\n',
        'one.log': 'x\n',
      });
      const summary = await getDiffSummary({ target: makeTargetForRepo() });
      expect(summary.ignoredTruncated).toBeUndefined();
    });
  });

  describe('getFileDiff for ignored files', () => {
    it('returns oldContent="" and reads newContent from worktree', async () => {
      await fs.promises.writeFile(path.join(repo, '.gitignore'), '*.log\n');
      await fs.promises.writeFile(path.join(repo, 'debug.log'), 'log line\n');
      const diff = await getFileDiff({ worktree: repo, base: 'main', relPath: 'debug.log' });
      expect(diff.oldContent).toBe('');
      expect(diff.newContent).toBe('log line\n');
      expect(diff.status).toBe('A');
    });
  });

  describe('range-aware diffs', () => {
    async function commitOnBranch(files: Record<string, string>, msg: string): Promise<string> {
      await commit(repo, files, msg);
      const { stdout } = await execFile('git', ['-C', repo, 'rev-parse', 'HEAD']);
      return stdout.trim();
    }

    it('range=working returns only uncommitted changes (no committed entries)', async () => {
      // Commit something so base..HEAD has content; then write working-tree change.
      await commitOnBranch({ 'a.txt': 'committed change\n' }, 'commit on feature');
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'workdir tweak\n');
      await fs.promises.writeFile(path.join(repo, 'untracked.txt'), 'fresh\n');

      const summary = await getDiffSummary({
        target: makeTargetForRepo(),
        range: { kind: 'working' },
      });
      const paths = summary.files.map((f) => f.path).sort();
      expect(paths).toContain('a.txt');
      expect(paths).toContain('untracked.txt');
      // a.txt's status should reflect working-tree mod only.
      const aEntry = summary.files.find((f) => f.path === 'a.txt');
      expect(aEntry?.status).toBe('M');
    });

    it('range=commit:<sha> shows just that commit and excludes working tree', async () => {
      const sha1 = await commitOnBranch({ 'a.txt': 'first\n' }, 'first feature commit');
      await commitOnBranch({ 'b.txt': 'second\n' }, 'second feature commit');
      // Dirty working tree — must not leak into a single-commit view.
      await fs.promises.writeFile(path.join(repo, 'workdir-only.txt'), 'noise\n');

      const summary = await getDiffSummary({
        target: makeTargetForRepo(),
        range: { kind: 'commit', sha: sha1 },
      });
      const paths = summary.files.map((f) => f.path);
      expect(paths).toEqual(['a.txt']);
      expect(paths).not.toContain('workdir-only.txt');
    });

    it('range=range:<from>..<to> diffs the supplied range', async () => {
      const sha1 = await commitOnBranch({ 'a.txt': 'first\n' }, 'first');
      const sha2 = await commitOnBranch({ 'b.txt': 'second\n' }, 'second');

      const summary = await getDiffSummary({
        target: makeTargetForRepo(),
        range: { kind: 'range', from: sha1, to: sha2 },
      });
      const paths = summary.files.map((f) => f.path);
      expect(paths).toEqual(['b.txt']);
    });

    it('getFileDiff with range=commit reads old from sha^ and new from sha', async () => {
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'first\n');
      await execFile('git', ['-C', repo, 'add', '.']);
      await execFile('git', ['-C', repo, 'commit', '-q', '-m', 'first feature']);
      const { stdout } = await execFile('git', ['-C', repo, 'rev-parse', 'HEAD']);
      const sha = stdout.trim();

      const diff = await getFileDiff({
        worktree: repo,
        range: { kind: 'commit', sha },
        taskBaseSha: baseSha,
        relPath: 'a.txt',
      });
      expect(diff.oldContent).toBe('hello\n');
      expect(diff.newContent).toBe('first\n');
      expect(diff.status).toBe('M');
    });

    it('getFileDiff with range=working reads old from HEAD and new from disk', async () => {
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'workdir-only\n');
      const diff = await getFileDiff({
        worktree: repo,
        range: { kind: 'working' },
        taskBaseSha: baseSha,
        relPath: 'a.txt',
      });
      expect(diff.oldContent).toBe('hello\n');
      expect(diff.newContent).toBe('workdir-only\n');
    });

    it('getFileDiff with range=base reads old from base and new from the working tree', async () => {
      // Commit a change on the feature branch, then layer an uncommitted edit on
      // top. The full diff must show base → working tree (committed + uncommitted),
      // not base → HEAD.
      await commitOnBranch({ 'a.txt': 'committed change\n' }, 'commit on feature');
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'committed change\nplus uncommitted\n');

      const diff = await getFileDiff({
        worktree: repo,
        range: { kind: 'base' },
        taskBaseSha: baseSha,
        relPath: 'a.txt',
      });
      expect(diff.oldContent).toBe('hello\n');
      expect(diff.newContent).toBe('committed change\nplus uncommitted\n');
      expect(diff.status).toBe('M');
    });
  });

  describe('safeResolvePath', () => {
    it('resolves a normal relative path inside the worktree', () => {
      const out = safeResolvePath('/tmp/wt', 'src/a.ts');
      expect(out).toBe(path.resolve('/tmp/wt', 'src/a.ts'));
    });

    it('rejects path traversal', () => {
      expect(() => safeResolvePath('/tmp/wt', '../outside')).toThrow('Invalid path');
      expect(() => safeResolvePath('/tmp/wt', '/etc/passwd')).toThrow('Invalid path');
    });

    it('rejects empty path', () => {
      expect(() => safeResolvePath('/tmp/wt', '')).toThrow('Invalid path');
    });
  });
});
