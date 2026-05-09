import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsPage from './SettingsPage';
import { renderWithRouter } from '../test-helpers';

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
  });
});
vi.mock('@/lib/api', () => ({ api: apiProxy }));

vi.mock('../lib/hooks', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSkills: () => ({ skills: [], loading: false, error: null, refresh: vi.fn() }),
    useRepoConfigs: () => ({ configs: [], loading: false, error: null, refresh: vi.fn() }),
    useAgents: () => ({ agents: [], loading: false, error: null, refresh: vi.fn() }),
  };
});

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the section navigation with all groups', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-nav-general')).toBeInTheDocument();
    });
    for (const id of [
      'general',
      'agents',
      'skills',
      'hooks',
      'repositories',
      'editor',
      'agent-launch',
    ]) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('settings-nav-orchestrator')).not.toBeInTheDocument();
  });

  it('marks the default nav item (general) as active', async () => {
    renderWithRouter(<SettingsPage />);
    const general = await screen.findByTestId('settings-nav-general');
    expect(general).toHaveAttribute('data-active', 'true');
    // Active style is the cyan tint
    expect(general.getAttribute('style') ?? '').toContain('59, 130, 246');
  });

  it('clicking a nav item scrolls the matching section into view and marks it active', async () => {
    const scrollSpy = vi.fn();
    // jsdom doesn't implement scrollIntoView; stub it.
    (HTMLElement.prototype as unknown as { scrollIntoView: typeof scrollSpy }).scrollIntoView =
      scrollSpy;

    const user = userEvent.setup();
    renderWithRouter(<SettingsPage />);

    const skillsNav = await screen.findByTestId('settings-nav-skills');
    await user.click(skillsNav);

    expect(scrollSpy).toHaveBeenCalled();
    expect(skillsNav).toHaveAttribute('data-active', 'true');
    expect(skillsNav.getAttribute('style') ?? '').toContain('59, 130, 246');

    // The previously-active general item is no longer active.
    const generalNav = screen.getByTestId('settings-nav-general');
    expect(generalNav).not.toHaveAttribute('data-active');
  });
});
