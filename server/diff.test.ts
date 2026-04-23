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

  beforeEach(async () => {
    repo = await makeRepo();
    await commit(repo, { 'a.txt': 'hello\n', 'src/b.ts': 'export const x = 1;\n' }, 'initial');
    await execFile('git', ['-C', repo, 'checkout', '-q', '-b', 'feature']);
  });

  afterEach(async () => {
    await fs.promises.rm(repo, { recursive: true, force: true });
  });

  describe('getDiffSummary', () => {
    it('returns empty for no changes', async () => {
      const summary = await getDiffSummary({ worktree: repo, base: 'main' });
      expect(summary.files).toEqual([]);
    });

    it('reports a committed modification', async () => {
      await commit(repo, { 'a.txt': 'hello world\n' }, 'tweak a');
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
      expect(files).toEqual([{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }]);
    });

    it('reports an unstaged modification', async () => {
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'hello there\n');
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
      expect(files).toEqual([{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }]);
    });

    it('reports an untracked file as added', async () => {
      await fs.promises.writeFile(path.join(repo, 'new.txt'), 'new\nfile\n');
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
      expect(files).toEqual([{ path: 'new.txt', status: 'A', additions: 2, deletions: 0 }]);
    });

    it('reports a deleted file', async () => {
      await fs.promises.unlink(path.join(repo, 'a.txt'));
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
      expect(files).toEqual([{ path: 'a.txt', status: 'D', additions: 0, deletions: 1 }]);
    });

    it('merges committed and uncommitted changes on the same file', async () => {
      await commit(repo, { 'a.txt': 'hello world\n' }, 'tweak a');
      await fs.promises.writeFile(path.join(repo, 'a.txt'), 'hello universe\n');
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('a.txt');
      expect(files[0].status).toBe('M');
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
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
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
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
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
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
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
      const { files } = await getDiffSummary({ worktree: repo, base: 'main' });
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
      const summary = await getDiffSummary({ worktree: repo, base: 'main' });
      const ignored = summary.files.filter((f) => f.ignored);
      expect(ignored).toHaveLength(MAX_IGNORED_FILES);
      expect(summary.ignoredTruncated).toBe(true);
    });

    it('does NOT set ignoredTruncated when list fits under the cap', async () => {
      await writeIgnoreAndFiles({
        '.gitignore': '*.log\n',
        'one.log': 'x\n',
      });
      const summary = await getDiffSummary({ worktree: repo, base: 'main' });
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
