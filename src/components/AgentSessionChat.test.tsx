/**
 * src/components/AgentSessionChat.test.tsx
 *
 * Component tests for the standalone agent-session chat view.
 * Mirrors the WS mock pattern from src/pages/OrchestratorPage.test.tsx.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AgentSessionChat } from './AgentSessionChat';
import { renderWithRouter } from '../test-helpers';

// ─── WS mock ─────────────────────────────────────────────────────────────────

interface MockWs {
  readyState: number;
  sentMessages: string[];
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: Event) => void) | null;
  send: (data: string) => void;
  close: () => void;
  simulateMessage: (data: object) => void;
  simulateOpen: () => void;
}

let lastWs: MockWs | null = null;

function makeWsMock(): MockWs {
  const mock: MockWs = {
    readyState: 0,
    sentMessages: [],
    onmessage: null,
    onopen: null,
    onclose: null,
    onerror: null,
    send(data: string) {
      this.sentMessages.push(data);
    },
    close() {
      this.readyState = 3;
      this.onclose?.();
    },
    simulateMessage(data: object) {
      this.onmessage?.({ data: JSON.stringify(data) });
    },
    simulateOpen() {
      this.readyState = 1;
      this.onopen?.();
    },
  };
  return mock;
}

vi.stubGlobal(
  'WebSocket',
  Object.assign(
    vi.fn(() => {
      lastWs = makeWsMock();
      return lastWs;
    }),
    { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
  ),
);

function makeFetchMock(messages: unknown[] = []) {
  return vi.fn(async (url: string) => {
    if (url.match(/^\/api\/orchestrator\/conversations\/[^/]+\/messages$/)) {
      return { ok: true, status: 200, json: async () => messages } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe('AgentSessionChat', () => {
  beforeEach(() => {
    lastWs = null;
    vi.stubGlobal('fetch', makeFetchMock());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads prior history from the orchestrator messages endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock([
        {
          id: 'msg-1',
          conversation_id: 'conv-1',
          role: 'user',
          content: JSON.stringify([{ type: 'text', text: 'hey agent' }]),
          created_at: '2026-01-01 00:00:00',
        },
      ]),
    );

    renderWithRouter(<AgentSessionChat convId="conv-1" />);

    await waitFor(() => {
      expect(screen.getByText('hey agent')).toBeInTheDocument();
    });
  });

  it('opens a websocket to /ws/orchestrator/:convId', async () => {
    renderWithRouter(<AgentSessionChat convId="conv-1" />);
    await waitFor(() => expect(lastWs).not.toBeNull());
    expect(globalThis.WebSocket).toHaveBeenCalledWith(
      expect.stringContaining('/ws/orchestrator/conv-1'),
    );
  });

  it('renders incoming assistant messages and ignores card/tool/status events', async () => {
    renderWithRouter(<AgentSessionChat convId="conv-1" />);
    await waitFor(() => expect(lastWs).not.toBeNull());

    act(() => {
      lastWs!.simulateOpen();
      lastWs!.simulateMessage({ type: 'tool', id: 't1', tool_name: 'search', input: {} });
      lastWs!.simulateMessage({ type: 'card', id: 'c1', command: 'approve-plan', args: {} });
      lastWs!.simulateMessage({ type: 'status', status: 'working' });
      lastWs!.simulateMessage({ type: 'message', role: 'assistant', text: 'Hello from agent' });
    });

    await waitFor(() => {
      expect(screen.getByText('Hello from agent')).toBeInTheDocument();
    });
  });

  it('sends a user_turn ws frame when the form is submitted', async () => {
    renderWithRouter(<AgentSessionChat convId="conv-1" />);
    await waitFor(() => expect(lastWs).not.toBeNull());

    act(() => {
      lastWs!.simulateOpen();
    });

    const input = await screen.findByPlaceholderText(/message this agent/i);
    fireEvent.change(input, { target: { value: 'do the thing' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(lastWs?.sentMessages.some((m) => JSON.parse(m).type === 'user_turn')).toBe(true);
    });
    const turn = lastWs!.sentMessages
      .map((m) => JSON.parse(m) as { type: string; text?: string })
      .find((m) => m.type === 'user_turn');
    expect(turn?.text).toBe('do the thing');

    // Optimistic local echo of the user's message.
    expect(screen.getByText('do the thing')).toBeInTheDocument();
  });
});
