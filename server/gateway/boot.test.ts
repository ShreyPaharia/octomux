import { describe, it, expect, afterEach, beforeEach, vi } from '../bun-test.js';

const mockCreateTelegramAdapter = vi.fn();
const mockCreateSlackAdapter = vi.fn();

vi.mock('./telegram.js', () => ({
  createTelegramAdapter: (token: string) => mockCreateTelegramAdapter(token),
}));
vi.mock('./slack.js', () => ({
  createSlackAdapter: (bot: string, app: string) => mockCreateSlackAdapter(bot, app),
}));

const { createTestDb } = await import('../test-helpers.js');
const { createIntegration, setEnabled } = await import('../integrations/store.js');
const { startGatewayIfConfigured } = await import('./boot.js');


function fakeAdapter(id: string) {
  return { id, start: vi.fn(async () => {}), sendTyping: vi.fn(async () => {}), send: vi.fn() };
}

// Isolated in-memory DB for every test in this file — resolveCredential()
// queries the integrations table, so nothing here should touch the real
// dev/prod database.
beforeEach(() => {
  createTestDb();
});

afterEach(() => {
  delete process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
  delete process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN;
  delete process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN;
});

describe('startGatewayIfConfigured — no DB / legacy env-only behavior', () => {
  it('is a silent no-op when no token is configured', async () => {
    delete process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
    await expect(startGatewayIfConfigured()).resolves.toBeUndefined();
  });

  it('does not start Slack when only the bot token is set', async () => {
    process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN = 'xoxb-fake';
    delete process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN;
    await expect(startGatewayIfConfigured()).resolves.toBeUndefined();
  });

  it('does not start Slack when only the app token is set', async () => {
    delete process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN;
    process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN = 'xapp-fake';
    await expect(startGatewayIfConfigured()).resolves.toBeUndefined();
  });
});

// ─── Credential resolution: env override, then the stored integration row ────

describe('startGatewayIfConfigured — credential resolution', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    delete process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
    delete process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN;
    delete process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN;
    mockCreateTelegramAdapter.mockReturnValue(fakeAdapter('telegram'));
    mockCreateSlackAdapter.mockReturnValue(fakeAdapter('slack'));
  });

  it('Telegram stays disabled with neither env nor a stored integration', async () => {
    await startGatewayIfConfigured();
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled();
  });

  it('Telegram starts from the env token', async () => {
    process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN = 'env-token';
    createIntegration('telegram-gateway', 'Telegram', { token: 'stored-token' });
    await startGatewayIfConfigured();
    expect(mockCreateTelegramAdapter).toHaveBeenCalledWith('env-token');
  });

  it('Telegram starts from the stored integration when env is absent', async () => {
    createIntegration('telegram-gateway', 'Telegram', { token: 'stored-token' });
    await startGatewayIfConfigured();
    expect(mockCreateTelegramAdapter).toHaveBeenCalledWith('stored-token');
  });

  it('ignores a disabled telegram-gateway integration', async () => {
    const integration = createIntegration('telegram-gateway', 'Telegram', {
      token: 'stored-token',
    });
    setEnabled(integration.id, false);
    await startGatewayIfConfigured();
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled();
  });

  it('Slack stays disabled with neither env nor a stored integration', async () => {
    await startGatewayIfConfigured();
    expect(mockCreateSlackAdapter).not.toHaveBeenCalled();
  });

  it('Slack starts from the env tokens', async () => {
    process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN = 'env-bot';
    process.env.OCTOMUX_GATEWAY_SLACK_APP_TOKEN = 'env-app';
    createIntegration('slack-gateway', 'Slack', {
      bot_token: 'stored-bot',
      app_token: 'stored-app',
    });
    await startGatewayIfConfigured();
    expect(mockCreateSlackAdapter).toHaveBeenCalledWith('env-bot', 'env-app');
  });

  it('Slack starts from the stored integration when env is absent', async () => {
    createIntegration('slack-gateway', 'Slack', {
      bot_token: 'stored-bot',
      app_token: 'stored-app',
    });
    await startGatewayIfConfigured();
    expect(mockCreateSlackAdapter).toHaveBeenCalledWith('stored-bot', 'stored-app');
  });

  it('mixes sources: env bot token + stored app token both resolve, Slack starts', async () => {
    process.env.OCTOMUX_GATEWAY_SLACK_BOT_TOKEN = 'env-bot';
    createIntegration('slack-gateway', 'Slack', { app_token: 'stored-app' });
    await startGatewayIfConfigured();
    expect(mockCreateSlackAdapter).toHaveBeenCalledWith('env-bot', 'stored-app');
  });

  it('Slack stays disabled when only the bot token resolves', async () => {
    createIntegration('slack-gateway', 'Slack', { bot_token: 'stored-bot' });
    await startGatewayIfConfigured();
    expect(mockCreateSlackAdapter).not.toHaveBeenCalled();
  });
});
