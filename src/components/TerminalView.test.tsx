import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

// ─── Mock xterm & its addons ─────────────────────────────────────────────────
// Captures the last onData callback so tests can simulate keystrokes.
const lastOnDataCb = { current: null as ((data: string) => void) | null };
const terminalInstances: MockTerminal[] = [];

class MockTerminal {
  cols = 80;
  rows = 24;
  disposed = false;
  writes: string[] = [];
  loadAddon = vi.fn();
  open = vi.fn();
  write = (data: string) => {
    this.writes.push(data);
  };
  onData = (cb: (data: string) => void) => {
    lastOnDataCb.current = cb;
    return { dispose: () => {} };
  };
  dispose = () => {
    this.disposed = true;
  };
  constructor() {
    terminalInstances.push(this);
  }
}

vi.mock('@xterm/xterm', () => ({
  Terminal: MockTerminal,
}));

class MockFitAddon {
  fit = vi.fn();
}
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: MockFitAddon,
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}));

// ─── Mock WebSocket ──────────────────────────────────────────────────────────
// Records each instance; tests drive open/close manually so timing is deterministic.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSING;
    // Tests drive onclose explicitly to simulate real browser async behavior.
  }

  // Test helper — simulate the browser firing "open" after handshake.
  _open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  // Test helper — simulate browser firing "close". Default code 1005 matches
  // real browser behavior when ws.close() is called with no status code.
  _close(code = 1005) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason: '', wasClean: true } as CloseEvent);
  }
}

// jsdom doesn't ship ResizeObserver; TerminalView uses it in a resize effect.
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let OriginalWebSocket: typeof WebSocket;
let OriginalResizeObserver: typeof ResizeObserver;

beforeEach(() => {
  terminalInstances.length = 0;
  MockWebSocket.instances = [];
  lastOnDataCb.current = null;

  OriginalWebSocket = globalThis.WebSocket;
  OriginalResizeObserver = globalThis.ResizeObserver;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

  // Give the container non-zero dimensions so fitAndSendResize runs.
  Object.defineProperty(HTMLDivElement.prototype, 'clientWidth', {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', {
    configurable: true,
    value: 600,
  });
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  globalThis.ResizeObserver = OriginalResizeObserver;
  vi.useRealTimers();
});

// Dynamic import AFTER mocks are registered.
async function importTerminalView() {
  const mod = await import('./TerminalView');
  return mod.TerminalView;
}

describe('TerminalView', () => {
  it('opens a WebSocket for the given task/window', async () => {
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} />);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toMatch(/\/ws\/terminal\/task-A\/0$/);
  });

  it('reconnects to the new endpoint when windowIndex changes', async () => {
    const TerminalView = await importTerminalView();
    const { rerender } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    rerender(<TerminalView taskId="task-A" windowIndex={1} />);

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const latest = MockWebSocket.instances.at(-1)!;
    expect(latest.url).toMatch(/\/ws\/terminal\/task-A\/1$/);
  });

  it('routes keystrokes to the NEW endpoint after windowIndex changes', async () => {
    // Fake timers must be active BEFORE the prop change so any setTimeout
    // scheduled by ws1.onclose is captured, not silently running on real time.
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    const { rerender } = render(<TerminalView taskId="task-A" windowIndex={0} />);
    const ws1 = MockWebSocket.instances[0];
    act(() => ws1._open());

    rerender(<TerminalView taskId="task-A" windowIndex={1} />);
    const ws2 = MockWebSocket.instances[1];
    act(() => ws2._open());

    // Simulate browser firing ws1's onclose async (what happens after ws.close()).
    // Browsers report code 1005 when close() is called with no status code.
    act(() => ws1._close(1005));

    // If the buggy reconnect branch runs, it schedules setTimeout(~1000ms)
    // to reconnect via the STALE closure (pointing at windowIndex=0).
    // Fast-forward long enough for any stale timer to fire.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // User types in the (now-agent-2) tab. Should reach ws2, NOT ws1 or any
    // stale reconnected WebSocket to the old endpoint.
    act(() => {
      lastOnDataCb.current?.('hello');
    });

    // Input went to ws2 (the active window), not ws1.
    expect(ws2.sent).toContain('hello');
    expect(ws1.sent).not.toContain('hello');
  });

  it('closes active WebSocket on unmount', async () => {
    const TerminalView = await importTerminalView();
    const { unmount } = render(<TerminalView taskId="task-A" windowIndex={0} />);
    const ws1 = MockWebSocket.instances[0];
    const closeSpy = vi.spyOn(ws1, 'close');

    unmount();

    expect(closeSpy).toHaveBeenCalled();
  });

  it('does NOT show the disconnect overlay when an OPEN ws is idle for 10+ seconds', async () => {
    // Regression test: previously a 5s data-silence window would trip a stall
    // timer and show the "Server unreachable" overlay on any idle terminal
    // (shell at prompt, Claude waiting for input). Data silence is not a
    // disconnect signal — only ws.onclose should surface that overlay.
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    const { queryByTestId } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());

    // Simulate a long idle window with zero terminal output.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(queryByTestId('terminal-disconnected-overlay')).toBeNull();
  });

  it('shows the disconnect overlay when the ws closes with a non-normal code', async () => {
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    const { queryByTestId } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());
    // Non-normal close code (1005 = no status received) triggers the reconnect
    // path and the overlay.
    act(() => ws._close(1005));

    expect(queryByTestId('terminal-disconnected-overlay')).not.toBeNull();
  });

  it('does not reconnect a replaced WebSocket after it closes', async () => {
    // This is the core bug guard: once we switch tabs, the old WS's onclose
    // must NOT trigger a reconnect via the stale closure.
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    const { rerender } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws1 = MockWebSocket.instances[0];
    rerender(<TerminalView taskId="task-A" windowIndex={1} />);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Simulate browser firing ws1.onclose with code 1005 (default from ws.close()).
    act(() => ws1._close(1005));

    // Any reconnect timer would fire within ~1s.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // Must NOT have created a 3rd WebSocket — especially not one pointing
    // back at the old windowIndex=0.
    expect(MockWebSocket.instances).toHaveLength(2);
    const stale = MockWebSocket.instances.find((ws, idx) => idx >= 2 && ws.url.endsWith('/0'));
    expect(stale).toBeUndefined();
  });
});
