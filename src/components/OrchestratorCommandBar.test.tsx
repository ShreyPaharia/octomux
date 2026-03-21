import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorCommandBar } from './OrchestratorCommandBar';
import { renderWithRouter } from '../test-helpers';

const mockRefresh = vi.fn();
let mockRunning = true;
const mockSend = vi.fn().mockResolvedValue({ ok: true, running: true });

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
  it('renders input with placeholder', () => {
    renderWithRouter(<OrchestratorCommandBar />);
    expect(screen.getByPlaceholderText(/ask the orchestrator/i)).toBeInTheDocument();
  });

  it('renders send button disabled when input is empty', () => {
    renderWithRouter(<OrchestratorCommandBar />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('enables send button when input has text', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'hello');
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
  });

  it('sends message and refreshes on submit', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'Show me tasks');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(mockSend).toHaveBeenCalledWith('Show me tasks');
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
  });

  it('clears input after successful send', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'Show me tasks');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(input).toHaveValue('');
    });
  });

  it('sends on Enter key', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'hello{Enter}');

    expect(mockSend).toHaveBeenCalledWith('hello');
  });

  it('clears input on Escape', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'hello');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
  });
});

describe('slash command autocomplete', () => {
  it('shows dropdown when input starts with /', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/');
    expect(screen.getByText('/create-task')).toBeInTheDocument();
    expect(screen.getByText('/list-tasks')).toBeInTheDocument();
    expect(screen.getByText('/status')).toBeInTheDocument();
    expect(screen.getByText('/create-pr')).toBeInTheDocument();
  });

  it('filters commands as user types', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/cr');
    expect(screen.getByText('/create-task')).toBeInTheDocument();
    expect(screen.getByText('/create-pr')).toBeInTheDocument();
    expect(screen.queryByText('/list-tasks')).not.toBeInTheDocument();
    expect(screen.queryByText('/status')).not.toBeInTheDocument();
  });

  it('hides dropdown when no commands match', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/xyz');
    expect(screen.queryByText('/create-task')).not.toBeInTheDocument();
  });

  it('navigates with arrow keys and selects with Enter', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/');
    // Arrow down to second item (/list-tasks — no fields, sends immediately)
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('Show me all running tasks');
    });
  });

  it('closes dropdown on Escape without clearing input', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/cr');
    expect(screen.getByText('/create-task')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('/create-task')).not.toBeInTheDocument();
    expect(input).toHaveValue('/cr');
  });

  it('does not show dropdown for / in middle of text', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'hello /create');
    expect(screen.queryByText('/create-task')).not.toBeInTheDocument();
  });
});

describe('field-based commands', () => {
  it('shows form when clicking a chip with fields', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    // Click the Create Task chip button (not the form header which also has the same text)
    const chips = screen.getAllByText('+ Create Task');
    await userEvent.click(chips[0]);
    // Should show the form — textarea input should be gone, close button visible
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/ask the orchestrator/i)).not.toBeInTheDocument();
  });

  it('sends immediately for commands without fields', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('List Tasks'));
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('Show me all running tasks');
    });
    // Should NOT show a form
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('closes form and returns to input on close button', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getAllByText('+ Create Task')[0]);
    expect(screen.queryByPlaceholderText(/ask the orchestrator/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.getByPlaceholderText(/ask the orchestrator/i)).toBeInTheDocument();
  });

  it('replaces form when clicking a different chip with fields', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('+ Create Task'));
    expect(screen.getByText('Title')).toBeInTheDocument();

    // Click a different field-based command
    await userEvent.click(screen.getByText('Task Status'));
    expect(screen.queryByText('Title')).not.toBeInTheDocument();
    expect(screen.getByText('Task')).toBeInTheDocument();
  });

  it('sends immediately and collapses form when clicking fieldless chip while form is open', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('+ Create Task'));
    expect(screen.queryByPlaceholderText(/ask the orchestrator/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('List Tasks'));
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('Show me all running tasks');
    });
    // Form should be closed, input should be back
    expect(screen.getByPlaceholderText(/ask the orchestrator/i)).toBeInTheDocument();
  });
});
