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
