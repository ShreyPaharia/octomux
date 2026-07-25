import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

vi.mock('@/lib/api/configApi', () => ({ configApi: apiMock }));
vi.mock('@/lib/api/taskApi', () => ({ taskApi: {} }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: {} }));

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

  describe('generic provider rendering (slack-gateway / telegram-gateway)', () => {
    const SLACK_GATEWAY_PROVIDER = {
      kind: 'slack-gateway',
      displayName: 'Slack Gateway',
      events: [],
      configSchema: {
        type: 'object',
        properties: {
          bot_token: { type: 'string', title: 'Bot token', secret: true },
          app_token: { type: 'string', title: 'App token', secret: true },
          allow: { type: 'string', title: 'Allowed sender IDs' },
        },
      },
    };

    it('lists a provider with no bespoke form via the generic providers section', async () => {
      apiMock.listProviders.mockResolvedValue([SLACK_GATEWAY_PROVIDER]);
      renderWithRouter(<IntegrationsPage />);
      expect(await screen.findByText('Slack Gateway')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add slack gateway/i })).toBeInTheDocument();
    });

    it('creates a generic-provider integration through the schema-driven form', async () => {
      const user = userEvent.setup();
      apiMock.listProviders.mockResolvedValue([SLACK_GATEWAY_PROVIDER]);
      apiMock.createIntegration.mockResolvedValue({ id: 'int-1' });
      renderWithRouter(<IntegrationsPage />);

      await user.click(await screen.findByRole('button', { name: /add slack gateway/i }));
      await user.type(screen.getByLabelText('Name'), 'My Slack');
      await user.type(screen.getByLabelText('Bot token'), 'xoxb-123');
      await user.type(screen.getByLabelText('App token'), 'xapp-123');
      await user.click(screen.getByRole('button', { name: /^create$/i }));

      await waitFor(() =>
        expect(apiMock.createIntegration).toHaveBeenCalledWith('slack-gateway', 'My Slack', {
          bot_token: 'xoxb-123',
          app_token: 'xapp-123',
          allow: '',
        }),
      );
    });

    it('edits a generic-provider integration, preserving the masked token field untouched', async () => {
      const user = userEvent.setup();
      apiMock.listProviders.mockResolvedValue([SLACK_GATEWAY_PROVIDER]);
      apiMock.listIntegrations.mockResolvedValue([
        {
          id: 'int-1',
          kind: 'slack-gateway',
          name: 'My Slack',
          config: { bot_token: '••••', app_token: '••••', allow: 'U1' },
          enabled: true,
          created_at: '',
          updated_at: '',
        },
      ]);
      apiMock.updateIntegration.mockResolvedValue({ id: 'int-1' });
      renderWithRouter(<IntegrationsPage />);

      const row = await screen.findByTestId('integration-row-int-1');
      await user.click(within(row).getByText('Edit'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() =>
        expect(apiMock.updateIntegration).toHaveBeenCalledWith('int-1', {
          name: 'My Slack',
          config: { bot_token: '••••', app_token: '••••', allow: 'U1' },
        }),
      );
    });
  });
});
