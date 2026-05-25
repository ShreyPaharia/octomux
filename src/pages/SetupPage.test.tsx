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
});
