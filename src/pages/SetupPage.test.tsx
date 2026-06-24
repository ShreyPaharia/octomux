import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SetupPage from './SetupPage';
import { renderWithRouter } from '../test-helpers';

const apiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSetupStatus: vi.fn(),
  setupInstall: vi.fn(),
  updateSettings: vi.fn(),
  applyRecommendedDefaults: vi.fn(),
}));

vi.mock('@/lib/api/configApi', () => ({ configApi: apiMock }));
vi.mock('@/lib/api/taskApi', () => ({ taskApi: {} }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: {} }));

describe('SetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSettings.mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      defaultBaseBranch: '',
      deleteGraceHours: 6,
    });
    apiMock.getSetupStatus.mockResolvedValue({
      items: [
        {
          id: 'tmux',
          label: 'tmux',
          category: 'required',
          status: 'missing',
          install: { kind: 'brew', id: 'tmux', label: 'Install tmux' },
        },
        {
          id: 'defaults',
          label: 'Task defaults',
          category: 'recommended',
          status: 'unconfigured',
          configureUrl: '/setup',
        },
      ],
      summary: { ready: false, blockerCount: 1, attentionCount: 2 },
      platform: 'darwin',
      hasBrew: true,
    });
  });

  it('renders setup summary and install action', async () => {
    renderWithRouter(<SetupPage />);
    await waitFor(() => expect(screen.getByTestId('setup-summary')).toBeInTheDocument());
    expect(screen.getByText(/required item/)).toBeInTheDocument();
    expect(screen.getByTestId('setup-install-tmux')).toBeInTheDocument();
  });

  it('calls setupInstall when install clicked', async () => {
    apiMock.setupInstall.mockResolvedValue({ ok: true, message: 'Installed tmux' });
    const user = userEvent.setup();
    renderWithRouter(<SetupPage />);
    await waitFor(() => screen.getByTestId('setup-install-tmux'));
    await user.click(screen.getByTestId('setup-install-tmux'));
    await waitFor(() => expect(apiMock.setupInstall).toHaveBeenCalledWith('tmux'));
  });

  it('renders deleteGraceHours input with initial value and saves updated value', async () => {
    apiMock.updateSettings.mockResolvedValue({});
    const user = userEvent.setup();
    renderWithRouter(<SetupPage />);

    const input = await screen.findByTestId('setup-delete-grace-hours');
    expect(input).toHaveValue(6);

    await user.clear(input);
    await user.type(input, '12');

    await user.click(screen.getByTestId('setup-save-defaults'));

    await waitFor(() =>
      expect(apiMock.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ deleteGraceHours: 12 }),
      ),
    );
  });

  describe('DefaultsForm — tracker fields moved to Integrations', () => {
    it('does not render tracker / Jira / Linear default fields', async () => {
      apiMock.getSettings.mockResolvedValue({
        editor: 'nvim',
        dangerouslySkipPermissions: false,
        claudeFlags: '',
        defaultBaseBranch: 'main',
        defaultTracker: 'jira',
        defaultJiraBaseUrl: 'https://myco.atlassian.net',
        defaultLinearTeamKey: 'BAC',
      });
      renderWithRouter(<SetupPage />);
      // Base branch + grace hours remain; tracker-specific fields are gone.
      await screen.findByTestId('setup-default-branch');
      expect(screen.getByTestId('setup-delete-grace-hours')).toBeInTheDocument();
      expect(screen.queryByLabelText(/default tracker/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/jira base url/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/default linear team key/i)).not.toBeInTheDocument();
    });

    it('saves only base branch and grace hours', async () => {
      apiMock.updateSettings.mockResolvedValue({});
      const user = userEvent.setup();
      renderWithRouter(<SetupPage />);
      await screen.findByTestId('setup-save-defaults');
      await user.click(screen.getByTestId('setup-save-defaults'));
      await waitFor(() => expect(apiMock.updateSettings).toHaveBeenCalledTimes(1));
      const payload = apiMock.updateSettings.mock.calls[0][0];
      expect(payload).not.toHaveProperty('defaultTracker');
      expect(payload).not.toHaveProperty('defaultJiraBaseUrl');
      expect(payload).not.toHaveProperty('defaultLinearTeamKey');
      expect(payload).toHaveProperty('deleteGraceHours');
    });
  });
});
