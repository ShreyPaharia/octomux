import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./binary-check.js', () => ({
  probeBinary: vi.fn(() => ({ ok: true, version: '1.0' })),
  brewInstall: vi.fn(() => true),
  hasBrew: vi.fn(() => false),
}));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => ({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
  })),
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
    ...patch,
  })),
}));

vi.mock('./github-login.js', () => ({
  ensureGithubLogin: vi.fn(async () => null),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd, _args, cb) => cb(new Error('not authed'))),
  execFileSync: vi.fn(() => 'NVIM v0.10.0'),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (String(p).includes('skills')) return true;
      return false;
    }),
    readdirSync: vi.fn(() => ['create-task']),
    cpSync: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  };
});

const { getSetupStatus, runSetupInstall, applyRecommendedDefaults } =
  await import('./setup-status.js');
const { probeBinary } = await import('./binary-check.js');

describe('getSetupStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeBinary).mockReturnValue({ ok: true, version: '1.0' });
  });

  it('returns items and summary when core binaries are present', async () => {
    const status = await getSetupStatus();
    expect(status.items.length).toBeGreaterThan(5);
    expect(status.summary.ready).toBe(true);
    expect(status.summary.blockerCount).toBe(0);
  });

  it('reports blockers when required binary is missing', async () => {
    vi.mocked(probeBinary).mockImplementation(({ cmd }) =>
      cmd === 'tmux' ? { ok: false } : { ok: true, version: '1.0' },
    );
    const status = await getSetupStatus();
    expect(status.summary.ready).toBe(false);
    expect(status.summary.blockerCount).toBeGreaterThan(0);
    const tmux = status.items.find((i) => i.id === 'tmux');
    expect(tmux?.status).toBe('missing');
  });

  it('does not surface Jira integration rows (those live under Integrations)', async () => {
    const status = await getSetupStatus();
    const ids = status.items.map((i) => i.id);
    expect(ids).not.toContain('jira-status-hook');
    expect(ids).not.toContain('jira-env');
    expect(ids).not.toContain('jira-integration');
  });

  it('offers a shell install for cursor-agent when missing (no brew)', async () => {
    vi.mocked(probeBinary).mockImplementation(({ cmd }) =>
      cmd === 'cursor-agent' ? { ok: false } : { ok: true, version: '1.0' },
    );
    const status = await getSetupStatus();
    const cursor = status.items.find((i) => i.id === 'cursor-agent');
    expect(cursor?.status).toBe('optional_missing');
    expect(cursor?.install).toEqual(expect.objectContaining({ kind: 'shell', id: 'cursor-agent' }));
  });
});

describe('runSetupInstall', () => {
  it('rejects unknown install ids', async () => {
    await expect(runSetupInstall('rm-rf')).rejects.toThrow(/not allowed/);
  });

  it('installs skills when allowed', async () => {
    const result = await runSetupInstall('skills');
    expect(result.ok).toBe(true);
  });

  it('runs the fixed shell installer for cursor-agent and re-probes', async () => {
    const { execFileSync } = await import('child_process');
    vi.mocked(probeBinary).mockReturnValue({ ok: true, version: '1.0' });
    const result = await runSetupInstall('cursor-agent');
    expect(result.ok).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'curl https://cursor.com/install -fsS | bash'],
      expect.anything(),
    );
  });

  it('reports failure when the shell installer leaves the binary off PATH', async () => {
    vi.mocked(probeBinary).mockReturnValue({ ok: false });
    const result = await runSetupInstall('claude');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/install/i);
  });
});

describe('applyRecommendedDefaults', () => {
  it('returns settings from updateSettings', async () => {
    const s = await applyRecommendedDefaults();
    expect(s).toBeDefined();
  });
});
