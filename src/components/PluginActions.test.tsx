import { describe, it, expect, vi, beforeEach } from '../bun-test.js';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const usePluginUiActionsMock = vi.fn();
const invokePluginActionMock = vi.fn();
vi.mock('@/lib/plugin-ui', () => ({
  usePluginUiActions: usePluginUiActionsMock,
  invokePluginAction: invokePluginActionMock,
}));

const showToastMock = vi.fn();
vi.mock('@/components/CustomToast', () => ({ showToast: showToastMock, CustomToast: vi.fn() }));

const { PluginActions, PluginActionDialog } = await import('./PluginActions');

const bareAction = {
  pluginId: 'p1',
  actionId: 'p1:restart',
  id: 'restart',
  label: 'Restart',
  slot: 'task.panel' as const,
};

const confirmAction = {
  pluginId: 'p1',
  actionId: 'p1:delete',
  id: 'delete',
  label: 'Delete all',
  slot: 'task.panel' as const,
  confirm: 'This cannot be undone.',
};

const schemaAction = {
  pluginId: 'p1',
  actionId: 'p1:configure',
  id: 'configure',
  label: 'Configure',
  slot: 'task.panel' as const,
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', default: 'foo', format: 'single-line' },
    },
  },
};

function mockActions(actions: unknown[]) {
  usePluginUiActionsMock.mockReturnValue({ actions, loading: false, error: null });
}

beforeEach(() => {
  usePluginUiActionsMock.mockReset();
  invokePluginActionMock.mockReset();
  showToastMock.mockReset();
  invokePluginActionMock.mockResolvedValue({ ok: true, message: 'Done' });
});

describe('PluginActions', () => {
  it('renders nothing when there are no actions', () => {
    mockActions([]);
    const { container } = render(<PluginActions slot="task.panel" taskId="t1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a button per action for the slot', () => {
    mockActions([bareAction, confirmAction]);
    render(<PluginActions slot="task.panel" taskId="t1" />);
    expect(screen.getByTestId('plugin-action-p1:restart')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-action-p1:delete')).toBeInTheDocument();
  });

  it('invokes a no-schema no-confirm action directly on click, with no dialog', async () => {
    const user = userEvent.setup();
    mockActions([bareAction]);
    render(<PluginActions slot="task.panel" taskId="t1" />);

    await user.click(screen.getByTestId('plugin-action-p1:restart'));

    await waitFor(() =>
      expect(invokePluginActionMock).toHaveBeenCalledWith('p1:restart', { taskId: 't1' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith('success', 'Restart', 'Done'));
  });

  it('renders task-free (no taskId) and still invokes', async () => {
    const user = userEvent.setup();
    mockActions([bareAction]);
    render(<PluginActions slot="task.panel" />);

    await user.click(screen.getByTestId('plugin-action-p1:restart'));

    await waitFor(() =>
      expect(invokePluginActionMock).toHaveBeenCalledWith('p1:restart', { taskId: undefined }),
    );
  });

  it('a confirm action opens a dialog and requires an explicit confirm click', async () => {
    const user = userEvent.setup();
    mockActions([confirmAction]);
    render(<PluginActions slot="task.panel" taskId="t1" />);

    await user.click(screen.getByTestId('plugin-action-p1:delete'));
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(invokePluginActionMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('plugin-action-dialog-submit'));
    await waitFor(() =>
      expect(invokePluginActionMock).toHaveBeenCalledWith('p1:delete', {
        taskId: 't1',
        input: undefined,
      }),
    );
  });

  it('a schema action opens a form seeded with defaults and submits edited values as input', async () => {
    const user = userEvent.setup();
    mockActions([schemaAction]);
    render(<PluginActions slot="task.panel" taskId="t1" />);

    await user.click(screen.getByTestId('plugin-action-p1:configure'));
    const field = await screen.findByLabelText('Name');
    expect(field).toHaveValue('foo');

    await user.clear(field);
    await user.type(field, 'bar');
    await user.click(screen.getByTestId('plugin-action-dialog-submit'));

    await waitFor(() =>
      expect(invokePluginActionMock).toHaveBeenCalledWith('p1:configure', {
        taskId: 't1',
        input: { name: 'bar' },
      }),
    );
  });

  it('surfaces the error message on a failed invocation', async () => {
    const user = userEvent.setup();
    invokePluginActionMock.mockRejectedValue(new Error('boom'));
    mockActions([bareAction]);
    render(<PluginActions slot="task.panel" taskId="t1" />);

    await user.click(screen.getByTestId('plugin-action-p1:restart'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith('error', 'Restart', 'boom'));
  });

  it('disables the submit button while in flight', async () => {
    const user = userEvent.setup();
    let resolveInvoke!: (v: { ok: true }) => void;
    invokePluginActionMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
    );
    mockActions([confirmAction]);
    render(<PluginActions slot="task.panel" taskId="t1" />);

    await user.click(screen.getByTestId('plugin-action-p1:delete'));
    const submit = screen.getByTestId('plugin-action-dialog-submit');
    await user.click(submit);
    expect(submit).toBeDisabled();

    await act(async () => {
      resolveInvoke({ ok: true });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByTestId('plugin-action-dialog-submit')).not.toBeInTheDocument(),
    );
  });
});

describe('PluginActionDialog (exported for reuse, e.g. CommandPalette)', () => {
  it('renders the action label and confirm text when open', () => {
    render(<PluginActionDialog action={confirmAction} taskId="t1" open onClose={() => {}} />);
    expect(screen.getByText('Delete all')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });
});
