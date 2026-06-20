/**
 * src/pages/OrchestratorPage.test.tsx
 *
 * Component tests for the minimal orchestrator chat UI (Task 1.7 / SHR-123).
 *
 * Tests:
 *  - OrchestratorPage renders the conversation list and "New conversation" button.
 *  - Selecting a conversation opens the message thread.
 *  - Sending a message emits a user_turn ws event.
 *  - Incoming ws message events render incrementally in the thread.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import OrchestratorPage from './OrchestratorPage';
import { renderWithRouter } from '../test-helpers';

// ─── WS mock ─────────────────────────────────────────────────────────────────

type WsEventHandler = (event: { data: string }) => void;
type WsCloseHandler = () => void;

interface MockWs {
  readyState: number;
  sentMessages: string[];
  onmessage: WsEventHandler | null;
  onopen: (() => void) | null;
  onclose: WsCloseHandler | null;
  onerror: ((err: Event) => void) | null;
  send: (data: string) => void;
  close: () => void;
  /** Test helper: simulate an incoming message from the server. */
  simulateMessage: (data: object) => void;
  /** Test helper: simulate the ws opening. */
  simulateOpen: () => void;
}

let lastWs: MockWs | null = null;

function makeWsMock(): MockWs {
  const mock: MockWs = {
    readyState: 0, // CONNECTING
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
      this.readyState = 1; // OPEN
      this.onopen?.();
    },
  };
  return mock;
}

vi.stubGlobal(
  'WebSocket',
  vi.fn(() => {
    lastWs = makeWsMock();
    return lastWs;
  }),
);

// ─── fetch mock ──────────────────────────────────────────────────────────────

const CONV_1 = {
  id: 'conv-abc123',
  title: 'My orchestrator chat',
  status: 'active',
  tmux_window: null,
  claude_session_id: null,
  transcript_path: null,
  created_at: '2026-06-20 00:00:00',
  updated_at: '2026-06-20 00:00:00',
};

const CONV_2 = {
  id: 'conv-def456',
  title: 'Second conversation',
  status: 'active',
  tmux_window: null,
  claude_session_id: null,
  transcript_path: null,
  created_at: '2026-06-19 00:00:00',
  updated_at: '2026-06-19 00:00:00',
};

const MSG_HISTORY = [
  {
    id: 'msg-001',
    conversation_id: 'conv-abc123',
    role: 'user',
    content: JSON.stringify([{ type: 'text', text: 'Hello orchestrator' }]),
    created_at: '2026-06-20 00:01:00',
  },
  {
    id: 'msg-002',
    conversation_id: 'conv-abc123',
    role: 'assistant',
    content: JSON.stringify([{ type: 'text', text: 'Hello! How can I help?' }]),
    created_at: '2026-06-20 00:01:01',
  },
];

const ZERO_USAGE = {
  conversation_id: CONV_1.id,
  tasks_spawned: 0,
  tool_calls: 0,
  started_at: '2026-06-20 00:00:00',
  last_activity_at: '2026-06-20 00:00:00',
};

const WARN_USAGE = {
  conversation_id: CONV_1.id,
  tasks_spawned: 15,
  tool_calls: 50,
  started_at: '2026-06-20 00:00:00',
  last_activity_at: '2026-06-20 00:05:00',
};

function makeFetchMock(
  options: {
    conversations?: (typeof CONV_1)[];
    messages?: typeof MSG_HISTORY;
    createConv?: typeof CONV_1;
    usage?: typeof ZERO_USAGE;
  } = {},
) {
  const convs = options.conversations ?? [CONV_1];
  const msgs = options.messages ?? [];
  const newConv = options.createConv ?? CONV_1;
  const usage = options.usage ?? ZERO_USAGE;

  return vi.fn(async (url: string, opts?: RequestInit) => {
    const method = (opts?.method ?? 'GET').toUpperCase();

    if (url === '/api/orchestrator/conversations' && method === 'GET') {
      return { ok: true, status: 200, json: async () => convs } as Response;
    }
    if (url === '/api/orchestrator/conversations' && method === 'POST') {
      return { ok: true, status: 201, json: async () => newConv } as Response;
    }
    if (url.match(/^\/api\/orchestrator\/conversations\/[^/]+\/messages$/) && method === 'GET') {
      return { ok: true, status: 200, json: async () => msgs } as Response;
    }
    if (url.match(/^\/api\/orchestrator\/conversations\/[^/]+\/usage$/) && method === 'GET') {
      return { ok: true, status: 200, json: async () => usage } as Response;
    }
    if (url.match(/^\/api\/orchestrator\/conversations\/[^/]+$/) && method === 'GET') {
      const id = url.split('/').at(-1);
      const conv = convs.find((c) => c.id === id) ?? CONV_1;
      return { ok: true, status: 200, json: async () => conv } as Response;
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OrchestratorPage', () => {
  beforeEach(() => {
    lastWs = null;
    vi.stubGlobal('fetch', makeFetchMock({ conversations: [CONV_1, CONV_2] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page heading and new conversation button', async () => {
    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });

    // The page has an sr-only h1 heading
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /orchestrator/i })).toBeInTheDocument();
    });
    // There is at least one "New conversation" button (sidebar header + empty state)
    const newConvBtns = screen.getAllByRole('button', { name: /new conversation/i });
    expect(newConvBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('lists conversations from the API', async () => {
    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });

    await waitFor(() => {
      expect(screen.getByText('My orchestrator chat')).toBeInTheDocument();
    });
    expect(screen.getByText('Second conversation')).toBeInTheDocument();
  });

  it('opens a message thread when a conversation is clicked', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ conversations: [CONV_1], messages: MSG_HISTORY }));

    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });

    await waitFor(() => {
      expect(screen.getByText('My orchestrator chat')).toBeInTheDocument();
    });

    // Click the conversation
    fireEvent.click(screen.getByText('My orchestrator chat'));

    await waitFor(() => {
      expect(screen.getByText('Hello orchestrator')).toBeInTheDocument();
    });
    expect(screen.getByText('Hello! How can I help?')).toBeInTheDocument();
  });

  it('shows a message input when a conversation is selected', async () => {
    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });

    await waitFor(() => {
      expect(screen.getByText('My orchestrator chat')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('My orchestrator chat'));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/message/i)).toBeInTheDocument();
    });
  });

  it('sends a user_turn ws message when the form is submitted', async () => {
    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });

    await waitFor(() => screen.getByText('My orchestrator chat'));
    fireEvent.click(screen.getByText('My orchestrator chat'));

    // Wait for the ws to be created (openOrchestratorWs called after listMessages resolves)
    await waitFor(() => expect(lastWs).not.toBeNull());

    // Simulate ws open so the send function will forward messages
    act(() => {
      lastWs!.simulateOpen();
    });

    // Wait for the input to appear
    await waitFor(() => screen.getByPlaceholderText(/message/i));

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'list running tasks' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(lastWs?.sentMessages.some((m) => JSON.parse(m).type === 'user_turn')).toBe(true);
    });

    const turn = lastWs!.sentMessages
      .map((m) => JSON.parse(m) as { type: string; text?: string })
      .find((m) => m.type === 'user_turn');
    expect(turn?.text).toBe('list running tasks');
  });

  it('renders incoming assistant message from ws events', async () => {
    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });

    await waitFor(() => screen.getByText('My orchestrator chat'));
    fireEvent.click(screen.getByText('My orchestrator chat'));
    await waitFor(() => screen.getByPlaceholderText(/message/i));

    act(() => {
      lastWs?.simulateOpen();
      lastWs?.simulateMessage({ type: 'message', role: 'assistant', text: 'I can see 3 tasks.' });
    });

    await waitFor(() => {
      expect(screen.getByText('I can see 3 tasks.')).toBeInTheDocument();
    });
  });

  it('creates a new conversation when the button is clicked', async () => {
    const newConv = { ...CONV_1, id: 'conv-new', title: 'New conversation' };
    vi.stubGlobal('fetch', makeFetchMock({ conversations: [CONV_1], createConv: newConv }));

    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });

    // Wait for conversations to load
    await waitFor(() => screen.getByText('My orchestrator chat'));

    // Click the first "New conversation" button (sidebar header +icon)
    const newConvBtns = screen.getAllByRole('button', { name: /new conversation/i });
    fireEvent.click(newConvBtns[0]);

    // Should show a title input / confirm dialog or immediately create
    // (implementation-defined — just assert fetch was called with POST)
    await waitFor(() => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      const postCalls = calls.filter(
        ([url, opts]) => url === '/api/orchestrator/conversations' && opts?.method === 'POST',
      );
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  it('renders delta stream incrementally as messages arrive over ws', async () => {
    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });

    await waitFor(() => screen.getByText('My orchestrator chat'));
    fireEvent.click(screen.getByText('My orchestrator chat'));
    await waitFor(() => screen.getByPlaceholderText(/message/i));

    act(() => {
      lastWs?.simulateOpen();
      lastWs?.simulateMessage({ type: 'message', role: 'assistant', text: 'First message' });
    });

    await waitFor(() => expect(screen.getByText('First message')).toBeInTheDocument());

    act(() => {
      lastWs?.simulateMessage({ type: 'message', role: 'user', text: 'Follow up' });
    });

    await waitFor(() => expect(screen.getByText('Follow up')).toBeInTheDocument());

    // Both messages should be in the thread
    expect(screen.getByText('First message')).toBeInTheDocument();
  });
});

// ─── Conductor-leanness indicator tests (SHR-137) ────────────────────────────

describe('conductor-leanness indicator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows zero stats when usage has no activity', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ conversations: [CONV_1], usage: ZERO_USAGE }));

    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });
    await waitFor(() => screen.getByText('My orchestrator chat'));
    fireEvent.click(screen.getByText('My orchestrator chat'));

    // Usage indicator should show "0 tasks" and "0 calls"
    await waitFor(() => {
      expect(screen.getByLabelText(/conductor leanness stats/i)).toBeInTheDocument();
    });
    expect(screen.getByText('0 tasks')).toBeInTheDocument();
    expect(screen.getByText('0 calls')).toBeInTheDocument();
  });

  it('shows warning state when tasks_spawned exceeds the soft threshold', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ conversations: [CONV_1], usage: WARN_USAGE }));

    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });
    await waitFor(() => screen.getByText('My orchestrator chat'));
    fireEvent.click(screen.getByText('My orchestrator chat'));

    await waitFor(() => {
      // Indicator should be present and show the high counts
      expect(screen.getByText('15 tasks')).toBeInTheDocument();
    });
    expect(screen.getByText('50 calls')).toBeInTheDocument();
  });

  it('does not render the leanness indicator before a conversation is opened', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ conversations: [CONV_1] }));

    renderWithRouter(<OrchestratorPage />, { route: '/orchestrator' });
    await waitFor(() => screen.getByText('My orchestrator chat'));

    // No conversation selected yet — indicator should not be visible
    expect(screen.queryByLabelText(/conductor leanness stats/i)).not.toBeInTheDocument();
  });
});

// ─── MessageThread isolated tests ────────────────────────────────────────────

import { MessageThread } from '../components/orchestrator/MessageThread';

describe('MessageThread', () => {
  it('renders user and assistant messages with distinct styling', () => {
    const messages = [
      { id: 'a', role: 'user' as const, text: 'Hello' },
      { id: 'b', role: 'assistant' as const, text: 'Hi there' },
    ];

    const { container } = renderWithRouter(<MessageThread messages={messages} />);

    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Hi there')).toBeInTheDocument();

    // User message should have a data-role attribute
    const userMsg = container.querySelector('[data-role="user"]');
    const assistantMsg = container.querySelector('[data-role="assistant"]');
    expect(userMsg).not.toBeNull();
    expect(assistantMsg).not.toBeNull();
  });

  it('renders an empty thread without crashing', () => {
    expect(() => renderWithRouter(<MessageThread messages={[]} />)).not.toThrow();
  });
});
