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

vi.mock('./integrations/store.js', () => ({
  listIntegrations: vi.fn(() => []),
}));

vi.mock('./github-login.js', () => ({
  ensureGithubLogin: vi.fn(async () => null),
}));

vi.mock('./hooks-install.js', () => ({
  isHookTemplateInstalled: vi.fn(() => false),
  listHookTemplates: vi.fn(() => ['jira-status']),
  installHookTemplate: vi.fn(() => ['/tmp/hook']),
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

const { getSetupStatus, runSetupInstall, applyRecommendedDefaults } = await import('./setup-status.js');
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
});

describe('runSetupInstall', () => {
  it('rejects unknown install ids', async () => {
    await expect(runSetupInstall('rm-rf')).rejects.toThrow(/not allowed/);
  });

  it('installs skills when allowed', async () => {
    const result = await runSetupInstall('skills');
    expect(result.ok).toBe(true);
  });
});

describe('applyRecommendedDefaults', () => {
  it('returns settings from updateSettings', async () => {
    const s = await applyRecommendedDefaults();
    expect(s).toBeDefined();
  });
});
