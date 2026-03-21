import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateTaskDialog } from './CreateTaskDialog';
import { renderWithRouter, mockApi } from '../test-helpers';

const apiMock = mockApi();

vi.mock('@/lib/api', () => ({
  api: new Proxy(
    {},
    {
      get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock],
    },
  ),
}));

describe('CreateTaskDialog', () => {
  const onCreated = vi.fn();
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function openDialog() {
    renderWithRouter(<CreateTaskDialog onCreated={onCreated} />);
    await user.click(screen.getByText('NEW TASK'));
  }

  async function fillForm(fields: { title?: string; description?: string; repoPath?: string }) {
    if (fields.title) await user.type(screen.getByLabelText(/^Title/), fields.title);
    if (fields.description)
      await user.type(screen.getByLabelText(/^Description/), fields.description);
    if (fields.repoPath)
      await user.type(screen.getByLabelText(/^Repository Path/), fields.repoPath);
  }

  // ─── Dialog open/close ────────────────────────────────────────────────────

  it('opens dialog on button click', async () => {
    await openDialog();
    expect(screen.getByText('// NEW TASK')).toBeInTheDocument();
  });

  it('shows all form fields', async () => {
    await openDialog();
    expect(screen.getByLabelText(/^Title/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Description/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Repository Path/)).toBeInTheDocument();
    expect(screen.getByLabelText('Branch Name')).toBeInTheDocument();
    expect(screen.getByText('Base Branch')).toBeInTheDocument();
  });

  // ─── Validation — submit button disabled (table-driven) ───────────────────

  const incompleteFormCases = [
    { name: 'all empty', fields: {} },
    { name: 'only title', fields: { title: 'Fix bug' } },
    { name: 'only description', fields: { description: 'Desc' } },
    { name: 'only repo', fields: { repoPath: '/tmp/repo' } },
    { name: 'missing repo', fields: { title: 'Fix bug', description: 'Desc' } },
    { name: 'missing title', fields: { description: 'Desc', repoPath: '/tmp/repo' } },
    { name: 'missing description', fields: { title: 'Fix bug', repoPath: '/tmp/repo' } },
  ];

  it.each(incompleteFormCases)('Create button is disabled when $name', async ({ fields }) => {
    await openDialog();
    await fillForm(fields);
    const createBtn = screen.getByRole('button', { name: /DISPATCH/i });
    expect(createBtn).toBeDisabled();
  });

  // ─── Successful submission ────────────────────────────────────────────────

  it('calls createTask with form data on submit', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Fix the order bug', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Fix bug',
          description: 'Fix the order bug',
          repo_path: '/tmp/repo',
        }),
      );
    });
  });

  it('calls onCreated callback after successful creation', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
  });

  it('trims whitespace from form values', async () => {
    await openDialog();
    await fillForm({ title: '  Fix bug  ', description: '  Desc  ', repoPath: '  /tmp/repo  ' });
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Fix bug',
          description: 'Desc',
          repo_path: '/tmp/repo',
        }),
      );
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('shows error message when createTask fails', async () => {
    apiMock.createTask.mockRejectedValueOnce(new Error('Repository not found'));
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      expect(screen.getByText('Repository not found')).toBeInTheDocument();
    });
  });

  it('does not call onCreated when createTask fails', async () => {
    apiMock.createTask.mockRejectedValueOnce(new Error('fail'));
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      expect(screen.getByText('fail')).toBeInTheDocument();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  // ─── Draft checkbox ─────────────────────────────────────────────────────

  it('sends draft=true when checkbox is checked', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    const checkbox = screen.getByLabelText('DRAFT');
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Fix bug',
          description: 'Desc',
          repo_path: '/tmp/repo',
          draft: true,
        }),
      );
    });
  });

  it('does not send draft when checkbox is unchecked', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      const call = apiMock.createTask.mock.calls[0][0];
      expect(call.draft).toBeUndefined();
    });
  });

  // ─── Branch and base branch ────────────────────────────────────────────────

  it('sends branch when provided', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    // Clear the auto-generated branch and type a custom one
    const branchInput = screen.getByLabelText('Branch Name');
    await user.clear(branchInput);
    await user.type(branchInput, 'feat/my-feature');
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'feat/my-feature' }),
      );
    });
  });

  it('sends auto-generated branch from title', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      const call = apiMock.createTask.mock.calls[0][0];
      expect(call.branch).toBe('feat/fix-bug');
    });
  });

  it('fetches branches when repo path is set', async () => {
    apiMock.listBranches = vi.fn().mockResolvedValue(['main', 'develop', 'feat/x']);
    apiMock.getDefaultBranch = vi.fn().mockResolvedValue({ branch: 'main' });

    await openDialog();
    await user.type(screen.getByLabelText(/^Repository Path/), '/tmp/repo');

    await waitFor(() => {
      expect(apiMock.listBranches).toHaveBeenCalledWith('/tmp/repo');
      expect(apiMock.getDefaultBranch).toHaveBeenCalledWith('/tmp/repo');
    });
  });

  it('auto-selects default branch as base branch', async () => {
    apiMock.listBranches = vi.fn().mockResolvedValue(['main', 'develop']);
    apiMock.getDefaultBranch = vi.fn().mockResolvedValue({ branch: 'develop' });

    await openDialog();
    await fillForm({ title: 'Fix', description: 'Desc', repoPath: '/tmp/repo' });

    // Wait for debounced fetch
    await waitFor(() => {
      expect(apiMock.getDefaultBranch).toHaveBeenCalled();
    });

    await user.click(screen.getByRole('button', { name: /DISPATCH/i }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ base_branch: 'develop' }),
      );
    });
  });

  // ─── Cancel ───────────────────────────────────────────────────────────────

  it('closes dialog on cancel without calling API', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: 'CANCEL' }));

    expect(apiMock.createTask).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
