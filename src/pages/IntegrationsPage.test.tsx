import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IntegrationsPage from './IntegrationsPage';
import { renderWithRouter } from '../test-helpers';

const apiMock = vi.hoisted(() => ({
  listProviders: vi.fn(),
  listIntegrations: vi.fn(),
  listHookTemplates: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  installHookTemplate: vi.fn(),
  createIntegration: vi.fn(),
  updateIntegration: vi.fn(),
  deleteIntegration: vi.fn(),
  testIntegration: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMock }));

describe('IntegrationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listProviders.mockResolvedValue([]);
    apiMock.listIntegrations.mockResolvedValue([]);
    apiMock.listHookTemplates.mockResolvedValue([{ id: 'jira-status', installed: false }]);
    apiMock.getSettings.mockResolvedValue({ defaultTracker: 'jira' });
    apiMock.updateSettings.mockResolvedValue({});
    apiMock.installHookTemplate.mockResolvedValue({ ok: true, files: ['/tmp/x'] });
  });

  it('renders the Workflow hooks section with an install button and tooltip', async () => {
    renderWithRouter(<IntegrationsPage />);
    const row = await screen.findByTestId('hook-template-jira-status');
    expect(row).toHaveTextContent('jira-status hook');
    expect(screen.getByTestId('hook-install-jira-status')).toBeInTheDocument();
    // Tooltip trigger present (accessible label)
    expect(screen.getByRole('button', { name: /about jira-status hook/i })).toBeInTheDocument();
  });

  it('installs a hook template when the button is clicked', async () => {
    const user = userEvent.setup();
    renderWithRouter(<IntegrationsPage />);
    await screen.findByTestId('hook-install-jira-status');
    await user.click(screen.getByTestId('hook-install-jira-status'));
    await waitFor(() => expect(apiMock.installHookTemplate).toHaveBeenCalledWith('jira-status'));
  });

  it('shows Installed state when the hook is already present', async () => {
    apiMock.listHookTemplates.mockResolvedValue([{ id: 'jira-status', installed: true }]);
    renderWithRouter(<IntegrationsPage />);
    const row = await screen.findByTestId('hook-template-jira-status');
    expect(row).toHaveTextContent('Installed');
    expect(screen.queryByTestId('hook-install-jira-status')).not.toBeInTheDocument();
  });

  it('renders the primary-tracker selector seeded from settings and saves changes', async () => {
    const user = userEvent.setup();
    renderWithRouter(<IntegrationsPage />);
    const select = (await screen.findByTestId('primary-tracker-select')) as HTMLSelectElement;
    expect(select.value).toBe('jira');
    await user.selectOptions(select, 'linear');
    await waitFor(() =>
      expect(apiMock.updateSettings).toHaveBeenCalledWith({ defaultTracker: 'linear' }),
    );
  });
});
