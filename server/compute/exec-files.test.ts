import { describe, it, expect, vi, beforeEach } from '../bun-test.js';
import { execBackedFiles } from './exec-files.js';
import type { ComputeSession, ExecResult } from './types.js';

describe('execBackedFiles', () => {
  let exec: ReturnType<typeof vi.fn> & ComputeSession['exec'];
  let files: ReturnType<typeof execBackedFiles>;

  function mockResult(partial: Partial<ExecResult>): ExecResult {
    return { stdout: '', stderr: '', exitCode: 0, ...partial };
  }

  beforeEach(() => {
    exec = vi.fn() as unknown as typeof exec;
    files = execBackedFiles(exec);
  });

  it('exists() runs `test -e <path>` with allowFailure and checks exitCode', async () => {
    exec.mockResolvedValue(mockResult({ exitCode: 0 }));
    expect(await files.exists('/a/b')).toBe(true);
    expect(exec).toHaveBeenCalledWith(['test', '-e', '/a/b'], { allowFailure: true });

    exec.mockResolvedValue(mockResult({ exitCode: 1 }));
    expect(await files.exists('/a/b')).toBe(false);
  });

  it('mkdirp() runs `mkdir -p <path>`', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.mkdirp('/a/b');
    expect(exec).toHaveBeenCalledWith(['mkdir', '-p', '/a/b']);
  });

  it('read() runs `cat <path>` with allowFailure and returns stdout on success', async () => {
    exec.mockResolvedValue(mockResult({ exitCode: 0, stdout: 'contents' }));
    expect(await files.read('/a/b')).toBe('contents');
    expect(exec).toHaveBeenCalledWith(['cat', '/a/b'], { allowFailure: true });
  });

  it('read() returns null when the file does not exist', async () => {
    exec.mockResolvedValue(mockResult({ exitCode: 1, stdout: '' }));
    expect(await files.read('/a/b')).toBeNull();
  });

  it('write() pipes content to stdin and passes the path as $1, never interpolated', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.write('/a/b path with spaces', 'hello world');
    expect(exec).toHaveBeenCalledWith(['sh', '-c', 'cat > "$1"', 'sh', '/a/b path with spaces'], {
      input: 'hello world',
    });
    // The path never appears inside the shell script string itself.
    const [argv] = exec.mock.calls[0] as [string[], unknown];
    expect(argv[2]).not.toContain('path with spaces');
  });

  it('write() chmods afterward when opts.mode is given', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.write('/a/b', 'hi', { mode: 0o755 });
    expect(exec).toHaveBeenNthCalledWith(1, ['sh', '-c', 'cat > "$1"', 'sh', '/a/b'], {
      input: 'hi',
    });
    expect(exec).toHaveBeenNthCalledWith(2, ['chmod', '755', '/a/b']);
  });

  it('write() does not chmod when opts.mode is omitted', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.write('/a/b', 'hi');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('copy() runs `cp -R <src> <dst>`', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.copy('/src', '/dst');
    expect(exec).toHaveBeenCalledWith(['cp', '-R', '/src', '/dst']);
  });

  it('rm() runs `rm -f <path>` by default', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.rm('/a/b');
    expect(exec).toHaveBeenCalledWith(['rm', '-f', '/a/b']);
  });

  it('rm() runs `rm -rf <path>` when recursive is set', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.rm('/a/b', { recursive: true });
    expect(exec).toHaveBeenCalledWith(['rm', '-rf', '/a/b']);
  });
  it('chmod() runs `chmod <octal> <path>`', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.chmod('/a/b', 0o500);
    expect(exec).toHaveBeenCalledWith(['chmod', '500', '/a/b']);
  });

  it('mkdirp() chmods after mkdir when a mode is given', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.mkdirp('/a/b', { mode: 0o700 });
    expect(exec).toHaveBeenNthCalledWith(1, ['mkdir', '-p', '/a/b']);
    expect(exec).toHaveBeenNthCalledWith(2, ['chmod', '700', '/a/b']);
  });

  it('mkdirp() does not chmod when no mode is given', async () => {
    exec.mockResolvedValue(mockResult({}));
    await files.mkdirp('/a/b');
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
