import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorCommandBar } from './OrchestratorCommandBar';
import { renderWithRouter } from '../test-helpers';

const mockOpen = vi.fn();
const mockRefresh = vi.fn();
let mockRunning = true;
const mockSend = vi.fn().mockResolvedValue({ ok: true, running: true });

vi.mock('@/lib/orchestrator-context', () => ({
  useOrchestratorContext: () => ({
    isOpen: false,
    running: mockRunning,
    loading: false,
    open: mockOpen,
    close: vi.fn(),
    toggle: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    error: null,
    refresh: mockRefresh,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    orchestratorSend: (...args: any[]) => mockSend(...args),
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

  it('sends message and opens modal on submit', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'Show me tasks');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(mockSend).toHaveBeenCalledWith('Show me tasks');
    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
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

  it('selects command on click and fills template', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/cr');
    await userEvent.click(screen.getByText('/create-task'));
    expect((input as HTMLTextAreaElement).value).toContain('Create a task titled');
  });

  it('navigates with arrow keys and selects with Enter', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/');
    // Arrow down to second item
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Second command is /list-tasks which has no placeholders — should send immediately
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
