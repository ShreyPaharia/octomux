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
    await user.click(screen.getByText('New Task'));
  }

  async function fillForm(fields: { title?: string; description?: string; repoPath?: string }) {
    if (fields.title) await user.type(screen.getByLabelText('Title'), fields.title);
    if (fields.description)
      await user.type(screen.getByLabelText('Description'), fields.description);
    if (fields.repoPath) await user.type(screen.getByLabelText('Repository Path'), fields.repoPath);
  }

  // ─── Dialog open/close ────────────────────────────────────────────────────

  it('opens dialog on button click', async () => {
    await openDialog();
    expect(screen.getByText('Create Task')).toBeInTheDocument();
  });

  it('shows all form fields', async () => {
    await openDialog();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Repository Path')).toBeInTheDocument();
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
    const createBtn = screen.getByRole('button', { name: 'Create' });
    expect(createBtn).toBeDisabled();
  });

  // ─── Successful submission ────────────────────────────────────────────────

  it('calls createTask with form data on submit', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Fix the order bug', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith({
        title: 'Fix bug',
        description: 'Fix the order bug',
        repo_path: '/tmp/repo',
      });
    });
  });

  it('calls onCreated callback after successful creation', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
  });

  it('trims whitespace from form values', async () => {
    await openDialog();
    await fillForm({ title: '  Fix bug  ', description: '  Desc  ', repoPath: '  /tmp/repo  ' });
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith({
        title: 'Fix bug',
        description: 'Desc',
        repo_path: '/tmp/repo',
      });
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('shows error message when createTask fails', async () => {
    apiMock.createTask.mockRejectedValueOnce(new Error('Repository not found'));
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('Repository not found')).toBeInTheDocument();
    });
  });

  it('does not call onCreated when createTask fails', async () => {
    apiMock.createTask.mockRejectedValueOnce(new Error('fail'));
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('fail')).toBeInTheDocument();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  // ─── Draft checkbox ─────────────────────────────────────────────────────

  it('sends draft=true when checkbox is checked', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    const checkbox = screen.getByLabelText('Save as draft (start later)');
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith({
        title: 'Fix bug',
        description: 'Desc',
        repo_path: '/tmp/repo',
        draft: true,
      });
    });
  });

  it('does not send draft when checkbox is unchecked', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith({
        title: 'Fix bug',
        description: 'Desc',
        repo_path: '/tmp/repo',
      });
    });
  });

  // ─── Cancel ───────────────────────────────────────────────────────────────

  it('closes dialog on cancel without calling API', async () => {
    await openDialog();
    await fillForm({ title: 'Fix bug', description: 'Desc', repoPath: '/tmp/repo' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(apiMock.createTask).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
