import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));

// RepoPickerField / BranchPickerField pull from the filesystem-ish APIs and
// include combobox UIs we don't need here.
vi.mock('./fields/RepoPickerField', () => ({
  RepoPickerField: ({ value }: { value: string }) => (
    <input aria-label="Repository Path" readOnly value={value} />
  ),
}));
vi.mock('./fields/BranchPickerField', () => ({
  BranchPickerField: ({ value }: { value: string }) => (
    <input aria-label="Base Branch" readOnly value={value} />
  ),
}));

import { DraftEditForm } from './DraftEditForm';
import { makeTask } from '../test-helpers';

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.updateTask.mockResolvedValue(makeTask());
});

describe('DraftEditForm', () => {
  it('shows branch/repo/base fields for non-scratch modes', () => {
    render(
      <DraftEditForm
        task={makeTask({ runtime_state: 'idle', run_mode: 'new' })}
        onSaved={() => {}}
        onStart={() => {}}
      />,
    );
    expect(screen.getByLabelText('Repository Path')).toBeInTheDocument();
    expect(screen.getByLabelText('Branch Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Base Branch')).toBeInTheDocument();
  });

  it('hides branch/repo/base fields for scratch mode', () => {
    render(
      <DraftEditForm
        task={makeTask({ runtime_state: 'idle', run_mode: 'scratch', repo_path: '', branch: null })}
        onSaved={() => {}}
        onStart={() => {}}
      />,
    );
    expect(screen.queryByLabelText('Repository Path')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Branch Name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Base Branch')).not.toBeInTheDocument();
  });

  it('scratch draft can be saved without repo_path', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <DraftEditForm
        task={makeTask({
          runtime_state: 'idle',
          run_mode: 'scratch',
          repo_path: '',
          branch: null,
          title: 'Scratch task',
          description: 'No repo',
        })}
        onSaved={onSaved}
        onStart={() => {}}
      />,
    );
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).not.toBeDisabled();
    await user.click(save);
    await waitFor(() => expect(apiMock.updateTask).toHaveBeenCalled());
    const [, payload] = apiMock.updateTask.mock.calls[0];
    expect(payload.repo_path).toBeUndefined();
    expect(payload.branch).toBeUndefined();
    expect(payload.base_branch).toBeUndefined();
  });
});
