import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorCommandBar } from './OrchestratorCommandBar';
import { renderWithRouter } from '../test-helpers';

const mockRefresh = vi.fn();
let mockRunning = true;
const mockSend = vi.fn().mockResolvedValue({ ok: true, running: true });
const mockType = vi.fn().mockResolvedValue({ ok: true, running: true });

vi.mock('@/lib/orchestrator-context', () => ({
  useOrchestratorContext: () => ({
    running: mockRunning,
    loading: false,
    start: vi.fn(),
    stop: vi.fn(),
    error: null,
    refresh: mockRefresh,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    orchestratorSend: (...args: any[]) => mockSend(...args),
    orchestratorType: (...args: any[]) => mockType(...args),
    recentRepos: vi.fn().mockResolvedValue([]),
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    listBranches: vi.fn().mockResolvedValue([]),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
    listTasks: vi.fn().mockResolvedValue([]),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockRunning = true;
});

describe('OrchestratorCommandBar', () => {
  it('renders all command chips from COMMANDS', () => {
    renderWithRouter(<OrchestratorCommandBar />);
    expect(screen.getByText('+ Create Task')).toBeInTheDocument();
    expect(screen.getByText('List Tasks')).toBeInTheDocument();
    expect(screen.getByText('Task Status')).toBeInTheDocument();
    expect(screen.getByText('Create PR')).toBeInTheDocument();
  });

  it('does not render a free-text input', () => {
    renderWithRouter(<OrchestratorCommandBar />);
    expect(screen.queryByPlaceholderText(/ask the orchestrator/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('fieldless commands', () => {
  it('sends immediately via orchestratorSend when clicking a fieldless chip', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('List Tasks'));
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('Show me all running tasks');
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('does not show a form for fieldless commands', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('List Tasks'));
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('disables chips while a fieldless send is in flight', async () => {
    let resolveSend: (v: { ok: boolean; running: boolean }) => void = () => {};
    mockSend.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean; running: boolean }>((r) => {
          resolveSend = r;
        }),
    );
    renderWithRouter(<OrchestratorCommandBar />);
    const listChip = screen.getByText('List Tasks') as HTMLButtonElement;
    await userEvent.click(listChip);
    expect(listChip).toBeDisabled();
    resolveSend({ ok: true, running: true });
    await waitFor(() => {
      expect(listChip).not.toBeDisabled();
    });
  });
});

describe('field-based commands', () => {
  it('shows form when clicking a chip with fields', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const chips = screen.getAllByText('+ Create Task');
    await userEvent.click(chips[0]);
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
  });

  it('closes form and returns to chips on close button', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getAllByText('+ Create Task')[0]);
    expect(screen.getByText('Title')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText('Title')).not.toBeInTheDocument();
    // Chips row still rendered
    expect(screen.getByText('List Tasks')).toBeInTheDocument();
  });

  it('replaces form when clicking a different chip with fields', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('+ Create Task'));
    expect(screen.getByText('Title')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Task Status'));
    expect(screen.queryByText('Title')).not.toBeInTheDocument();
    expect(screen.getByText('Task')).toBeInTheDocument();
  });

  it('sends immediately and collapses form when clicking fieldless chip while form is open', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('+ Create Task'));
    expect(screen.getByText('Title')).toBeInTheDocument();

    await userEvent.click(screen.getByText('List Tasks'));
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('Show me all running tasks');
    });
    // Form should be closed
    expect(screen.queryByText('Title')).not.toBeInTheDocument();
  });
});
