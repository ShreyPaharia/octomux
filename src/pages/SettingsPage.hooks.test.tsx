/**
 * C5: HooksSection component tests.
 *
 * Verifies: three groups render, toggle calls API, warning visible when env unset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsPage from './SettingsPage';
import { renderWithRouter } from '../test-helpers';
import type { HookRegistryEntry } from '../../src/lib/api';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BUILTIN_ENTRY: HookRegistryEntry = {
  scope: 'builtin',
  key: 'summarize-progress',
  event: null,
  script_path: null,
  description: 'Calls Haiku to write a one-sentence progress summary.',
  enabled: false,
  requires_env: 'ANTHROPIC_API_KEY',
  last_run_at: null,
  last_exit_code: null,
};

const GLOBAL_ENTRY: HookRegistryEntry = {
  scope: 'global',
  key: 'workflow_status_changed/notify-slack.sh',
  event: 'workflow_status_changed',
  script_path: '/Users/me/.octomux/hooks/workflow_status_changed.d/notify-slack.sh',
  description: null,
  enabled: true,
  requires_env: null,
  last_run_at: null,
  last_exit_code: null,
};

const REPO_ENTRY: HookRegistryEntry = {
  scope: 'repo:/Users/me/my-repo',
  key: 'summary_updated/post-to-slack.sh',
  event: 'summary_updated',
  script_path: '/Users/me/my-repo/.octomux/hooks/summary_updated.d/post-to-slack.sh',
  description: null,
  enabled: true,
  requires_env: null,
  last_run_at: null,
  last_exit_code: null,
};

// ─── Mock Setup — uses lazy refs to avoid TDZ with vi.hoisted ────────────────

const getHooksRegistryMock = vi.fn();
const updateHookEnabledMock = vi.fn();

const { apiProxy } = await vi.hoisted(async () => {
  const { vi } = await import('vitest');
  const helpers = await import('../test-helpers');
  return helpers.setupApiMock({
    getSettings: vi.fn().mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      envOverrides: { claudeFlags: null },
    }),
    updateSettings: vi.fn().mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      envOverrides: { claudeFlags: null },
    }),
    // We can't reference module-level consts here (TDZ). The test-helper
    // default resolves to { hooks: [] }, which we override per-test below.
  });
});

vi.mock('@/lib/api', () => ({
  api: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'getHooksRegistry') return getHooksRegistryMock;
        if (prop === 'updateHookEnabled') return updateHookEnabledMock;
        return (apiProxy as Record<string, unknown>)[prop];
      },
    },
  ),
}));

vi.mock('../lib/hooks', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSkills: () => ({ skills: [], loading: false, error: null, refresh: vi.fn() }),
    useRepoConfigs: () => ({ configs: [], loading: false, error: null, refresh: vi.fn() }),
    useAgents: () => ({ agents: [], loading: false, error: null, refresh: vi.fn() }),
  };
});

vi.mock('@/lib/tasks-context', () => ({
  useTasksContextOptional: () => null,
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('C5: HooksSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHooksRegistryMock.mockResolvedValue({
      hooks: [BUILTIN_ENTRY, GLOBAL_ENTRY, REPO_ENTRY],
    });
    updateHookEnabledMock.mockResolvedValue({
      scope: 'builtin',
      key: 'summarize-progress',
      enabled: true,
    });
  });

  it('renders HOOKS nav item between SKILLS and REPOSITORIES', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-nav-hooks')).toBeInTheDocument();
    });
    // Check order in DOM
    const nav = screen
      .getAllByRole('button')
      .filter((b) =>
        ['settings-nav-skills', 'settings-nav-hooks', 'settings-nav-repositories'].includes(
          b.getAttribute('data-testid') ?? '',
        ),
      );
    const ids = nav.map((b) => b.getAttribute('data-testid'));
    expect(ids.indexOf('settings-nav-skills')).toBeLessThan(ids.indexOf('settings-nav-hooks'));
    expect(ids.indexOf('settings-nav-hooks')).toBeLessThan(
      ids.indexOf('settings-nav-repositories'),
    );
  });

  it('renders the Built-in, Global, and Repo group headings', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Built-in')).toBeInTheDocument();
    });
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText('Repo')).toBeInTheDocument();
  });

  it('renders hook keys in their groups', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('summarize-progress')).toBeInTheDocument();
    });
    expect(screen.getByText('workflow_status_changed/notify-slack.sh')).toBeInTheDocument();
    expect(screen.getByText('summary_updated/post-to-slack.sh')).toBeInTheDocument();
  });

  it('shows warning when requires_env is set', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
    });
  });

  it('does not show warning when requires_env is null', async () => {
    getHooksRegistryMock.mockResolvedValue({
      hooks: [{ ...BUILTIN_ENTRY, requires_env: null }, GLOBAL_ENTRY],
    });
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('summarize-progress')).toBeInTheDocument();
    });
    expect(screen.queryByText(/ANTHROPIC_API_KEY/)).not.toBeInTheDocument();
  });

  it('calls updateHookEnabled on toggle with optimistic update', async () => {
    const user = userEvent.setup();
    renderWithRouter(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText('summarize-progress')).toBeInTheDocument();
    });

    // Find the toggle switch within the row containing the summarize-progress label.
    const label = screen.getByText('summarize-progress');
    // Walk up to the flex row that contains both label and toggle
    const row = label.closest('.flex.items-center.justify-between');
    expect(row).toBeTruthy();
    const toggle = row!.querySelector('[role="switch"]') as HTMLElement;
    expect(toggle).toBeTruthy();
    // summarize-progress is enabled=false → aria-checked="false"
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);

    expect(updateHookEnabledMock).toHaveBeenCalledWith('builtin', 'summarize-progress', true);
  });

  it('shows "No global hooks installed." when global group is empty', async () => {
    getHooksRegistryMock.mockResolvedValue({
      hooks: [BUILTIN_ENTRY],
    });
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('No global hooks installed.')).toBeInTheDocument();
    });
  });
});
