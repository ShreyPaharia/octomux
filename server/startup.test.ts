import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => ['some-plugin']),
  };
  return { ...mocked, default: mocked };
});

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import('child_process');
const fs = await import('fs');
const { ensureBinary, checkNeovimVersion, syncLazyVimPlugins } = await import('./startup.js');

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit');
});

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockReaddirSync.mockReturnValue(['some-plugin'] as unknown as ReturnType<typeof fs.readdirSync>);
});

// ─── ensureBinary ────────────────────────────────────────────────────────────

describe('ensureBinary', () => {
  it('does nothing when binary is already installed', () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    ensureBinary({ cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux' });

    expect(mockExecFileSync).toHaveBeenCalledWith('tmux', ['-V'], { stdio: 'ignore' });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it.each([
    { cmd: 'tmux', brewPkg: 'tmux', label: 'tmux' },
    { cmd: 'nvim', brewPkg: 'neovim', name: 'neovim', label: 'neovim' },
    { cmd: 'lazygit', brewPkg: 'lazygit', label: 'lazygit' },
  ])('auto-installs $label via brew on macOS when missing', ({ cmd, brewPkg, name }) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    // First call (check binary) fails, second (check brew) succeeds, third (brew install) succeeds
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('not found');
      })
      .mockReturnValueOnce(Buffer.from('Homebrew 4.0'))
      .mockReturnValueOnce(Buffer.from(''));

    ensureBinary({ cmd, checkArgs: ['--version'], brewPkg, name });

    expect(mockExecFileSync).toHaveBeenCalledWith('brew', ['install', brewPkg], {
      stdio: 'inherit',
    });
    expect(mockExit).not.toHaveBeenCalled();

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('exits with error when binary missing and no brew available on macOS', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    // Binary check fails, brew check fails
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(() => ensureBinary({ cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux' })).toThrow(
      'process.exit',
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('exits with error on non-macOS when binary missing', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(() => ensureBinary({ cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux' })).toThrow(
      'process.exit',
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses installUrl when provided instead of brew formula URL', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(() =>
      ensureBinary({
        cmd: 'claude',
        checkArgs: ['--version'],
        name: 'Claude Code CLI',
        installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
      }),
    ).toThrow('process.exit');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://docs.anthropic.com/en/docs/claude-code'),
    );

    Object.defineProperty(process, 'platform', { value: originalPlatform });
    errorSpy.mockRestore();
  });

  it('exits when brew install fails', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('not found');
      }) // binary check
      .mockReturnValueOnce(Buffer.from('Homebrew 4.0')) // brew check
      .mockImplementationOnce(() => {
        throw new Error('install failed');
      }); // brew install

    expect(() => ensureBinary({ cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux' })).toThrow(
      'process.exit',
    );
    expect(mockExit).toHaveBeenCalledWith(1);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
});

// ─── checkNeovimVersion ──────────────────────────────────────────────────────

describe('checkNeovimVersion', () => {
  it.each([
    { version: 'NVIM v0.10.0', desc: '0.10.0 (minimum)' },
    { version: 'NVIM v0.10.4', desc: '0.10.4' },
    { version: 'NVIM v0.11.0', desc: '0.11.0' },
    { version: 'NVIM v1.0.0', desc: '1.0.0' },
  ])('passes for version $desc', ({ version }) => {
    mockExecFileSync.mockReturnValue(version as unknown as Buffer);
    checkNeovimVersion();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it.each([
    { version: 'NVIM v0.9.5', desc: '0.9.5' },
    { version: 'NVIM v0.8.0', desc: '0.8.0' },
  ])('exits for version $desc (too old)', ({ version }) => {
    mockExecFileSync.mockReturnValue(version as unknown as Buffer);
    expect(() => checkNeovimVersion()).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits when version cannot be determined', () => {
    mockExecFileSync.mockReturnValue('unknown output' as unknown as Buffer);
    expect(() => checkNeovimVersion()).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

// ─── syncLazyVimPlugins ──────────────────────────────────────────────────────

describe('syncLazyVimPlugins', () => {
  it('skips sync when lazy dir exists and is non-empty', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['lazy.nvim'] as unknown as ReturnType<typeof fs.readdirSync>);

    syncLazyVimPlugins('/repo');

    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('runs sync when lazy dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    syncLazyVimPlugins('/repo');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'nvim',
      ['--headless', '+Lazy! sync', '+qa'],
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({
          XDG_CONFIG_HOME: '/repo/.config',
          XDG_DATA_HOME: '/repo/.local/share',
          XDG_STATE_HOME: '/repo/.local/state',
          XDG_CACHE_HOME: '/repo/.local/cache',
        }),
      }),
    );
  });

  it('runs sync when lazy dir is empty', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    syncLazyVimPlugins('/repo');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'nvim',
      ['--headless', '+Lazy! sync', '+qa'],
      expect.anything(),
    );
  });

  it('warns but does not exit when sync fails', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('sync failed');
    });

    syncLazyVimPlugins('/repo');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plugin sync failed'));
    expect(mockExit).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
