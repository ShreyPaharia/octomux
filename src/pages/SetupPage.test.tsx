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

vi.mock('@/lib/api', () => ({
  api: apiMock,
}));

describe('SetupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSettings.mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      defaultBaseBranch: '',
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

  describe('DefaultsForm — tracker selector', () => {
    it('renders Linear team-key input and hides Jira URL when defaultTracker is linear', async () => {
      apiMock.getSettings.mockResolvedValue({
        editor: 'nvim',
        dangerouslySkipPermissions: false,
        claudeFlags: '',
        defaultBaseBranch: '',
        defaultTracker: 'linear',
        defaultLinearTeamKey: 'BAC',
      });
      renderWithRouter(<SetupPage />);
      await waitFor(() => screen.getByLabelText(/default linear team key/i));
      expect(screen.getByLabelText(/default linear team key/i)).toHaveValue('BAC');
      expect(screen.queryByLabelText(/jira base url/i)).not.toBeInTheDocument();
    });

    it('renders Jira URL input and hides Linear team-key when defaultTracker is jira', async () => {
      apiMock.getSettings.mockResolvedValue({
        editor: 'nvim',
        dangerouslySkipPermissions: false,
        claudeFlags: '',
        defaultBaseBranch: '',
        defaultTracker: 'jira',
        defaultJiraBaseUrl: 'https://myco.atlassian.net',
      });
      renderWithRouter(<SetupPage />);
      await waitFor(() => screen.getByLabelText(/jira base url/i));
      expect(screen.getByLabelText(/jira base url/i)).toHaveValue('https://myco.atlassian.net');
      expect(screen.queryByLabelText(/default linear team key/i)).not.toBeInTheDocument();
    });

    it('switching tracker dropdown swaps conditional sections', async () => {
      apiMock.getSettings.mockResolvedValue({
        editor: 'nvim',
        dangerouslySkipPermissions: false,
        claudeFlags: '',
        defaultBaseBranch: '',
        defaultTracker: 'linear',
        defaultLinearTeamKey: '',
      });
      const user = userEvent.setup();
      renderWithRouter(<SetupPage />);
      await waitFor(() => screen.getByLabelText(/default tracker/i));
      // Initially linear — Linear input visible, Jira URL not
      expect(screen.getByLabelText(/default linear team key/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/jira base url/i)).not.toBeInTheDocument();
      // Switch to Jira
      await user.selectOptions(screen.getByLabelText(/default tracker/i), 'jira');
      expect(screen.getByLabelText(/jira base url/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/default linear team key/i)).not.toBeInTheDocument();
    });
  });
});
