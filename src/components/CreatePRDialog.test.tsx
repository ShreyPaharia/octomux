import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreatePRDialog } from './CreatePRDialog';
import { renderWithRouter, mockApi } from '../test-helpers';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const apiMock = mockApi({
  previewPR: vi.fn().mockResolvedValue({
    title: 'feat(orders): add validation',
    body: '## What\n- Added checks',
    base: 'main',
  }),
  createPR: vi.fn().mockResolvedValue({ id: 't1', pr_url: 'https://github.com/pr/1' }),
});

vi.mock('@/lib/api', () => ({
  api: new Proxy(
    {},
    {
      get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock],
    },
  ),
}));

describe('CreatePRDialog', () => {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDialog(open = true) {
    return renderWithRouter(
      <CreatePRDialog
        taskId="test-task-01"
        open={open}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />,
    );
  }

  // ─── Dialog rendering ──────────────────────────────────────────────────────

  it('shows configure step when open', () => {
    renderDialog();
    expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
    expect(screen.getByLabelText('Base Branch')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    renderDialog(false);
    expect(screen.queryByText('Create Pull Request')).not.toBeInTheDocument();
  });

  it('defaults base branch to "main"', () => {
    renderDialog();
    expect(screen.getByLabelText('Base Branch')).toHaveValue('main');
  });

  // ─── Generate flow ─────────────────────────────────────────────────────────

  it('calls previewPR on generate click', async () => {
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => {
      expect(apiMock.previewPR).toHaveBeenCalledWith('test-task-01', { base: 'main' });
    });
  });

  it('transitions to review step after successful generate', async () => {
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => {
      expect(screen.getByText('Review PR')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Title')).toHaveValue('feat(orders): add validation');
    expect(screen.getByLabelText('Description')).toHaveValue('## What\n- Added checks');
  });

  it('shows error on generate failure', async () => {
    apiMock.previewPR.mockRejectedValueOnce(new Error('No commits found'));
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Generate' }));

    await waitFor(() => {
      expect(screen.getByText('No commits found')).toBeInTheDocument();
    });
    // Should stay on configure step
    expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
  });

  it('disables generate button when base is empty', async () => {
    renderDialog();
    const input = screen.getByLabelText('Base Branch');
    await user.clear(input);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  // ─── Review step ───────────────────────────────────────────────────────────

  async function goToReviewStep() {
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => {
      expect(screen.getByText('Review PR')).toBeInTheDocument();
    });
  }

  it('shows title and body inputs in review step', async () => {
    await goToReviewStep();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
  });

  it('shows Back and Create PR buttons in review step', async () => {
    await goToReviewStep();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeInTheDocument();
  });

  it('goes back to configure step on Back click', async () => {
    await goToReviewStep();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
  });

  // ─── PR creation ───────────────────────────────────────────────────────────

  it('calls createPR with correct params on Create PR click', async () => {
    await goToReviewStep();
    await user.click(screen.getByRole('button', { name: 'Create PR' }));

    await waitFor(() => {
      expect(apiMock.createPR).toHaveBeenCalledWith('test-task-01', {
        base: 'main',
        title: 'feat(orders): add validation',
        body: '## What\n- Added checks',
      });
    });
  });

  it('calls onCreated after successful PR creation', async () => {
    await goToReviewStep();
    await user.click(screen.getByRole('button', { name: 'Create PR' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
  });

  it('calls onOpenChange(false) after successful PR creation', async () => {
    await goToReviewStep();
    await user.click(screen.getByRole('button', { name: 'Create PR' }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('shows error on PR creation failure', async () => {
    apiMock.createPR.mockRejectedValueOnce(new Error('gh CLI failed'));
    await goToReviewStep();
    await user.click(screen.getByRole('button', { name: 'Create PR' }));

    await waitFor(() => {
      expect(screen.getByText('gh CLI failed')).toBeInTheDocument();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('disables Create PR when title is empty', async () => {
    await goToReviewStep();
    const titleInput = screen.getByLabelText('Title');
    await user.clear(titleInput);
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeDisabled();
  });

  // ─── Dialog close resets state ─────────────────────────────────────────────

  it('resets to configure step when dialog closes', async () => {
    await goToReviewStep();
    // Simulate dialog close via onOpenChange
    const { rerender } = renderWithRouter(
      <CreatePRDialog
        taskId="test-task-01"
        open={false}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />,
    );
    // Reopen
    rerender(
      <CreatePRDialog
        taskId="test-task-01"
        open={true}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />,
    );

    // Should be back on configure step (not review)
    await waitFor(() => {
      expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
    });
  });
});
