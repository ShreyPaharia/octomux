import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDiffSummary, getFileDiff, safeResolvePath } from './diff.js';

const execFile = promisify(execFileCb);

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
