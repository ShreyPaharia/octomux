import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateNameDialog, DeleteConfirmDialog } from './crud-dialog';

describe('CreateNameDialog', () => {
  it('submits via button and Enter key', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <CreateNameDialog
        open
        onOpenChange={vi.fn()}
        title="Create Agent"
        placeholder="Agent name"
        value="my-agent"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        submitting={false}
        canSubmit
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe('DeleteConfirmDialog', () => {
  it('renders description and confirm action', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <DeleteConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete Skill"
        description="Are you sure?"
        onConfirm={onConfirm}
        submitting={false}
      />,
    );

    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
