import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandFieldForm } from './CommandFieldForm';
import { COMMANDS } from '@/lib/orchestrator-commands';
import { renderWithRouter } from '../test-helpers';

vi.mock('@/lib/api', () => ({
  api: {
    recentRepos: vi.fn().mockResolvedValue([]),
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    listBranches: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
    listTasks: vi.fn().mockResolvedValue([]),
  },
}));

const mockOnSubmit = vi.fn();
const mockOnClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CommandFieldForm', () => {
  const createTaskCmd = COMMANDS.find((c) => c.slash === '/create-task')!;
  const statusCmd = COMMANDS.find((c) => c.slash === '/status')!;

  it('renders command name and close button', () => {
    renderWithRouter(
      <CommandFieldForm
        command={createTaskCmd}
        onSubmit={mockOnSubmit}
        onClose={mockOnClose}
        sending={false}
      />,
    );
    expect(screen.getByText('+ Create Task')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('renders fields for the command', () => {
    renderWithRouter(
      <CommandFieldForm
        command={createTaskCmd}
        onSubmit={mockOnSubmit}
        onClose={mockOnClose}
        sending={false}
      />,
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Repository')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Initial Prompt')).toBeInTheDocument();
  });

  it('disables send when required fields are empty', () => {
    renderWithRouter(
      <CommandFieldForm
        command={createTaskCmd}
        onSubmit={mockOnSubmit}
        onClose={mockOnClose}
        sending={false}
      />,
    );
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('calls onClose when close button clicked', async () => {
    renderWithRouter(
      <CommandFieldForm
        command={statusCmd}
        onSubmit={mockOnSubmit}
        onClose={mockOnClose}
        sending={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(mockOnClose).toHaveBeenCalled();
  });
});
