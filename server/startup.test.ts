import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';

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

vi.mock('./binary-check.js', () => ({
  probeBinary: vi.fn(),
  brewInstall: vi.fn(),
  hasBrew: vi.fn(() => false),
}));

const { execFileSync } = await import('child_process');
const { probeBinary, brewInstall } = await import('./binary-check.js');
const fs = await import('fs');
const { ensureBinary, checkNeovimVersion, syncLazyVimPlugins } = await import('./startup.js');
const { setLogger, getLogger } = await import('./logger.js');

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('process.exit');
});

/** Pipe pino output to an in-memory buffer so we can assert log content. */
function captureLogs() {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
  const original = getLogger();
  setLogger(pino({ level: 'trace' }, stream));
  return {
    text: () => chunks.join(''),
    restore: () => setLogger(original),
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let logs: ReturnType<typeof captureLogs>;

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockReaddirSync.mockReturnValue(['some-plugin'] as unknown as ReturnType<typeof fs.readdirSync>);
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
});

// ─── ensureBinary ────────────────────────────────────────────────────────────

describe('ensureBinary', () => {
  // The brew auto-install path only runs on macOS (process.platform === 'darwin').
  // Pin the platform so these tests are deterministic on Linux CI runners too.
  const realPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('does nothing when binary is already installed', () => {
    vi.mocked(probeBinary).mockReturnValue({ ok: true });

    ensureBinary({ cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux' });

    expect(mockExit).not.toHaveBeenCalled();
  });

  it.each([
    { cmd: 'tmux', brewPkg: 'tmux', checkArgs: ['-V'], label: 'tmux' },
    { cmd: 'nvim', brewPkg: 'neovim', checkArgs: ['--version'], name: 'neovim', label: 'neovim' },
    { cmd: 'lazygit', brewPkg: 'lazygit', checkArgs: ['--version'], label: 'lazygit' },
  ])('auto-installs $label via brew when missing', ({ cmd, brewPkg, checkArgs, name }) => {
    vi.mocked(probeBinary).mockReturnValueOnce({ ok: false }).mockReturnValueOnce({ ok: true });
    vi.mocked(brewInstall).mockReturnValue(true);

    ensureBinary({ cmd, checkArgs, brewPkg, name });

    expect(brewInstall).toHaveBeenCalledWith(brewPkg, { cmd, checkArgs });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('exits with error when binary missing and brew install fails', () => {
    vi.mocked(probeBinary).mockReturnValue({ ok: false });
    vi.mocked(brewInstall).mockReturnValue(false);

    expect(() => ensureBinary({ cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux' })).toThrow(
      'process.exit',
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('skips brew and exits on non-darwin platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(probeBinary).mockReturnValue({ ok: false });
    vi.mocked(brewInstall).mockReturnValue(true);

    expect(() => ensureBinary({ cmd: 'tmux', checkArgs: ['-V'], brewPkg: 'tmux' })).toThrow(
      'process.exit',
    );
    // brew auto-install must not be attempted off macOS, even if it would succeed.
    expect(brewInstall).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('uses installUrl when provided instead of brew formula URL', () => {
    vi.mocked(probeBinary).mockReturnValue({ ok: false });
    vi.mocked(brewInstall).mockReturnValue(false);

    expect(() =>
      ensureBinary({
        cmd: 'claude',
        checkArgs: ['--version'],
        name: 'Claude Code CLI',
        installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
      }),
    ).toThrow('process.exit');

    expect(logs.text()).toContain('https://docs.anthropic.com/en/docs/claude-code');
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
    mockExecFileSync.mockReturnValue(version);
    checkNeovimVersion();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it.each([
    { version: 'NVIM v0.9.5', desc: '0.9.5' },
    { version: 'NVIM v0.8.0', desc: '0.8.0' },
  ])('warns for version $desc (too old) without exiting', ({ version }) => {
    mockExecFileSync.mockReturnValue(version);
    checkNeovimVersion();
    expect(mockExit).not.toHaveBeenCalled();
    expect(logs.text()).toContain('Neovim version too old');
  });

  it('exits when version cannot be determined', () => {
    mockExecFileSync.mockReturnValue('unknown output');
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
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('sync failed');
    });

    syncLazyVimPlugins('/repo');

    expect(logs.text()).toContain('plugin sync failed');
    expect(mockExit).not.toHaveBeenCalled();
  });
});
