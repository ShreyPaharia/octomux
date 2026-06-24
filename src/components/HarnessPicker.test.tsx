import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

vi.mock('@/lib/hooks', () => ({
  useHarnesses: () => ({
    harnesses: [
      { id: 'claude-code', displayName: 'Claude Code', sessionIdMode: 'orchestrator-assigned' },
      { id: 'cursor', displayName: 'Cursor', sessionIdMode: 'harness-issued' },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { HarnessPicker } from './HarnessPicker';

describe('HarnessPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSettings.mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      defaultHarnessId: 'claude-code',
      harnesses: {},
      envOverrides: { claudeFlags: null },
    });
  });

  it('defaults to settings.defaultHarnessId when value is null', async () => {
    apiMock.getSettings.mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      defaultHarnessId: 'cursor',
      harnesses: {},
      envOverrides: { claudeFlags: null },
    });
    const onChange = vi.fn();
    render(<HarnessPicker value={null} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('cursor'));
  });

  it('falls back to claude-code when no default is set in settings', async () => {
    apiMock.getSettings.mockResolvedValue({
      editor: 'nvim',
      dangerouslySkipPermissions: false,
      claudeFlags: '',
      harnesses: {},
      envOverrides: { claudeFlags: null },
    });
    const onChange = vi.fn();
    render(<HarnessPicker value={null} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('claude-code'));
  });

  it('renders the selected harness display name in the trigger', async () => {
    render(<HarnessPicker value="cursor" onChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('harness-picker-trigger')).toHaveTextContent('Cursor');
    });
  });

  it('fires onChange with the selected harness id when an option is clicked', async () => {
    const onChange = vi.fn();
    render(<HarnessPicker value="claude-code" onChange={onChange} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('harness-picker-trigger'));
    await user.click(await screen.findByTestId('harness-picker-option-cursor'));

    expect(onChange).toHaveBeenCalledWith('cursor');
  });
});
