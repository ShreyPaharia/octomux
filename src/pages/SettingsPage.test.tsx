import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsPage from './SettingsPage';
import { renderWithRouter } from '../test-helpers';

const { taskApiProxy, reviewApiProxy, configApiProxy } = await vi.hoisted(async () => {
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
    listLearnings: vi.fn().mockResolvedValue([]),
    deleteLearning: vi.fn().mockResolvedValue(undefined),
  });
});
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/api/schedulesApi', () => ({
  scheduleSkillsApi: {
    listScheduleSkills: vi.fn().mockResolvedValue([]),
    updateScheduleSkill: vi.fn().mockResolvedValue({ kind: 'doc-drift', content: '' }),
    resetScheduleSkill: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../lib/hooks', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useRepoConfigs: () => ({ configs: [], loading: false, error: null, refresh: vi.fn() }),
  };
});

vi.mock('@/lib/tasks-context', () => ({
  useTasksContextOptional: () => null,
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the section navigation with all groups', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-nav-general')).toBeInTheDocument();
    });
    for (const id of ['general', 'hooks', 'repositories', 'editor', 'agent-launch']) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('settings-nav-orchestrator')).not.toBeInTheDocument();
  });

  it('marks the default nav item (general) as active', async () => {
    renderWithRouter(<SettingsPage />);
    const general = await screen.findByTestId('settings-nav-general');
    expect(general).toHaveAttribute('data-active', 'true');
    expect(general.className).toContain('text-primary');
    expect(general.className).toContain('border-primary');
  });

  it('clicking a nav item scrolls the matching section into view and marks it active', async () => {
    const scrollSpy = vi.fn();
    // jsdom doesn't implement scrollIntoView; stub it.
    (HTMLElement.prototype as unknown as { scrollIntoView: typeof scrollSpy }).scrollIntoView =
      scrollSpy;

    const user = userEvent.setup();
    renderWithRouter(<SettingsPage />);

    const hooksNav = await screen.findByTestId('settings-nav-hooks');
    await user.click(hooksNav);

    expect(scrollSpy).toHaveBeenCalled();
    expect(hooksNav).toHaveAttribute('data-active', 'true');
    expect(hooksNav.className).toContain('text-primary');
    expect(hooksNav.className).toContain('border-primary');

    // The previously-active general item is no longer active.
    const generalNav = screen.getByTestId('settings-nav-general');
    expect(generalNav).not.toHaveAttribute('data-active');
  });

  it('renders the Reviews nav item and Reviews section', async () => {
    renderWithRouter(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-nav-reviews')).toBeInTheDocument();
    });
    // The section element should be present in the DOM
    expect(document.getElementById('section-reviews')).toBeInTheDocument();
  });
});
