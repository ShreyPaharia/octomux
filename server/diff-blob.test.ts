import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'child_process';
import { blobAt } from './diff.js';

describe('blobAt', () => {
  it('returns blob sha when ls-tree finds the path', async () => {
    vi.mocked(execFile).mockImplementation(((_c, args: readonly string[], _o, cb) => {
      const arr = args as string[];
      if (arr.includes('ls-tree')) {
        cb(null, {
          stdout: '100644 blob abcdef1234567890abcdef1234567890abcdef12\tsrc/foo.ts\n',
          stderr: '',
        });
      }
      return undefined;
    }) as unknown as typeof execFile);

    const sha = await blobAt({ worktree: '/wt', commit: 'HEAD', relPath: 'src/foo.ts' });
    expect(sha).toBe('abcdef1234567890abcdef1234567890abcdef12');
  });

  it('returns null when ls-tree output is empty (file absent at commit)', async () => {
    vi.mocked(execFile).mockImplementation(((_c, _args, _o, cb) => {
      cb(null, { stdout: '', stderr: '' });
      return undefined;
    }) as unknown as typeof execFile);

    const sha = await blobAt({ worktree: '/wt', commit: 'HEAD', relPath: 'src/missing.ts' });
    expect(sha).toBeNull();
  });

  it('returns null on git error', async () => {
    vi.mocked(execFile).mockImplementation(((_c, _args, _o, cb) => {
      cb(new Error('bad object'), { stdout: '', stderr: '' });
      return undefined;
    }) as unknown as typeof execFile);

    const sha = await blobAt({ worktree: '/wt', commit: 'invalid', relPath: 'src/foo.ts' });
    expect(sha).toBeNull();
  });
});
