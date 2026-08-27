import { describe, it, expect, vi, beforeEach, afterEach } from '../bun-test.js';

const useMediaQueryMock = vi.fn((..._args: unknown[]) => false);
vi.mock('@/lib/use-media-query', () => ({
  useMediaQuery: (...args: unknown[]) => useMediaQueryMock(...args),
}));
vi.mock('@/lib/terminal-mobile-touch', () => ({
  installTerminalMobileTouch: () => () => {},
}));
vi.mock('@/lib/terminal-visual-viewport', () => ({
  installTerminalVisualViewport: () => () => {},
}));

// ─── Mock xterm & its addons ─────────────────────────────────────────────────
// Captures the last onData callback so tests can simulate keystrokes.
const lastOnDataCb = { current: null as ((data: string) => void) | null };
const terminalInstances: MockTerminal[] = [];

class MockTerminal {
  cols = 80;
  rows = 24;
  disposed = false;
  // Minimal buffer surface for the typeahead (normal screen, cursor at 0,0).
  buffer = {
    active: {
      type: 'normal',
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      getLine: () => undefined,
    },
  };
  writes: string[] = [];
  scrollLineCalls: number[] = [];
  scrollToBottomCalls = 0;
  loadAddon = vi.fn();
  open = vi.fn();
  write = (data: string) => {
    this.writes.push(data);
  };
  scrollLines = (amount: number) => {
    this.scrollLineCalls.push(amount);
  };
  scrollToBottom = () => {
    this.scrollToBottomCalls += 1;
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

const { render, act } = await import('@testing-library/react');
// Static-import safe: terminal-pool only type-imports xterm, so it resolves
// before the mocks above without pulling in the real xterm.
const { resetTerminalPool } = await import('@/lib/terminal-pool');

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
  resetTerminalPool();
  localStorage.removeItem('octomux-terminal-local-echo');
  useMediaQueryMock.mockReturnValue(false);
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
  // Destroy parked entries before restoring globals so their TTL timers and
  // sockets don't leak into the next test.
  resetTerminalPool();
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
    expect(MockWebSocket.instances[0].url).toMatch(/\/ws\/terminal\/task-A\/0(\?|$)/);
  });

  it('advertises streaming deflate support in the ws URL', async () => {
    // bun's runtime has DecompressionStream, so the component opts in — the
    // server only compresses for clients that set this flag.
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} />);
    expect(MockWebSocket.instances[0].url).toMatch(/\?deflate=2$/);
  });

  it('reconnects to the new endpoint when windowIndex changes', async () => {
    const TerminalView = await importTerminalView();
    const { rerender } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    rerender(<TerminalView taskId="task-A" windowIndex={1} />);

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const latest = MockWebSocket.instances.at(-1)!;
    expect(latest.url).toMatch(/\/ws\/terminal\/task-A\/1(\?|$)/);
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

  it('keeps the connecting placeholder up after the ws opens, until data arrives', async () => {
    const TerminalView = await importTerminalView();
    const { queryByTestId } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    // While the ws is still CONNECTING, the placeholder is shown.
    expect(ws.readyState).toBe(MockWebSocket.CONNECTING);
    expect(queryByTestId('terminal-connecting-placeholder')).not.toBeNull();

    // The socket opens in a few ms but the server's first frame lands later —
    // clearing here would leave a blank black rectangle with no feedback.
    act(() => ws._open());
    expect(queryByTestId('terminal-connecting-placeholder')).not.toBeNull();

    act(() => ws.onmessage?.({ data: 'hello' } as MessageEvent));
    expect(queryByTestId('terminal-connecting-placeholder')).toBeNull();
  });

  it('hides the connecting placeholder as soon as the first data chunk arrives', async () => {
    const TerminalView = await importTerminalView();
    const { queryByTestId } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    expect(queryByTestId('terminal-connecting-placeholder')).not.toBeNull();

    // First PTY chunk arrives (without an explicit onopen) — placeholder clears.
    act(() => ws.onmessage?.({ data: 'hello' } as MessageEvent));
    expect(queryByTestId('terminal-connecting-placeholder')).toBeNull();
  });

  it('shows the connecting placeholder again while reconnecting', async () => {
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    const { queryByTestId } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());
    act(() => ws.onmessage?.({ data: 'hello' } as MessageEvent));
    expect(queryByTestId('terminal-connecting-placeholder')).toBeNull();

    // Non-normal close triggers a reconnect; advancing past the backoff delay
    // creates a fresh CONNECTING ws and the placeholder reappears.
    act(() => ws._close(1005));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(queryByTestId('terminal-connecting-placeholder')).not.toBeNull();
  });

  it('does not forward typed input to the WebSocket when readOnly is true', async () => {
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} readOnly />);
    const ws = MockWebSocket.instances[0];
    act(() => ws._open());

    // In readOnly mode, the onData handler is never registered, so even if a
    // keystroke event were fired, no callback would run. Simulate that by
    // calling the captured cb if it exists — it should be null.
    expect(lastOnDataCb.current).toBeNull();

    // Sanity: also verify no payload was sent on the ws beyond the resize.
    const nonResize = ws.sent.filter((m) => {
      try {
        const parsed = JSON.parse(m as string);
        return parsed?.type !== 'resize';
      } catch {
        return true;
      }
    });
    expect(nonResize).toEqual([]);
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
    const stale = MockWebSocket.instances.find(
      (ws, idx) => idx >= 2 && ws.url.includes('/ws/terminal/task-A/0'),
    );
    expect(stale).toBeUndefined();
  });

  it('reconnects when a liveness ping goes unanswered (half-open socket)', async () => {
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());

    // Idle past the watchdog window — the client probes the link.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(ws.sent).toContain('{"type":"ping"}');

    // Nothing comes back within the pong timeout → the socket is half-open;
    // it gets replaced without waiting for a TCP-level close.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('keeps the socket when the liveness ping is answered', async () => {
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(ws.sent).toContain('{"type":"ping"}');

    // Server's empty pong frame proves the link is alive.
    act(() => ws.onmessage?.({ data: '' } as MessageEvent));
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('probes an OPEN socket on tab return instead of trusting readyState', async () => {
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());

    // Simulate a laptop-sleep gap: time passes with no traffic, then the tab
    // returns. The socket still reports OPEN but may be half-open.
    await act(async () => {
      vi.setSystemTime(Date.now() + 60_000);
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(ws.sent).toContain('{"type":"ping"}');
  });

  it('reconnects immediately on tab return when the socket is dead', async () => {
    // Background tabs throttle the backoff timer, so a scheduled reconnect can
    // sit for minutes. Returning to the tab must not wait for it.
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws1 = MockWebSocket.instances[0];
    act(() => ws1._open());
    act(() => ws1._close(1006)); // abnormal close → reconnect scheduled with backoff

    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does not open a duplicate socket on tab return while connected', async () => {
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} />);

    act(() => MockWebSocket.instances[0]._open());
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('parks the terminal on unmount and adopts it on remount — same socket, no placeholder', async () => {
    const TerminalView = await importTerminalView();
    const { unmount } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());
    act(() => ws.onmessage?.({ data: 'hello' } as MessageEvent));

    unmount();
    // Parked, not torn down: the socket stays OPEN (server attachment warm)
    // and the stream is paused so nothing streams to an invisible buffer.
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(ws.sent).toContain('{"type":"pause"}');
    expect(terminalInstances[0].disposed).toBe(false);

    const resizeCount = () => ws.sent.filter((m) => String(m).includes('"resize"')).length;
    const resizesBefore = resizeCount();

    const { queryByTestId } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    // Adopted: no new WebSocket, no "Connecting…" placeholder, stream resumed.
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(queryByTestId('terminal-connecting-placeholder')).toBeNull();
    expect(ws.sent).toContain('{"type":"resume"}');

    // Resize discipline: the layout didn't change, so adoption must not send
    // a redundant resize (a redundant resize SIGWINCHes the pty → tmux redraw
    // → the reflow flash this pool exists to eliminate).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60)); // flush rAF-deferred fits
    });
    expect(resizeCount()).toBe(resizesBefore);
  });

  it('destroys a parked terminal after the grace period', async () => {
    vi.useFakeTimers();
    const TerminalView = await importTerminalView();
    const { unmount } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());
    act(() => ws.onmessage?.({ data: 'hello' } as MessageEvent));
    unmount();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    // TTL fired: socket closed, xterm disposed — nothing left to adopt.
    expect(ws.readyState).toBe(MockWebSocket.CLOSING);
    expect(terminalInstances[0].disposed).toBe(true);
  });

  it('treats an empty-string frame as a pong: not data worth parking', async () => {
    // The server's watchdog pong is ws.send('') — an empty TEXT frame, not an
    // empty ArrayBuffer. It proves liveness, not content.
    const TerminalView = await importTerminalView();
    const { unmount } = render(<TerminalView taskId="task-A" windowIndex={0} />);
    const ws = MockWebSocket.instances[0];
    act(() => ws._open());
    act(() => ws.onmessage?.({ data: '' } as MessageEvent));
    unmount();

    // No real content arrived, so the entry is destroyed, not parked.
    expect(ws.readyState).toBe(MockWebSocket.CLOSING);
    expect(terminalInstances[0].disposed).toBe(true);
  });

  it('measures latency from an empty-string pong and activates the typeahead', async () => {
    vi.useFakeTimers();
    localStorage.setItem('octomux-terminal-local-echo', 'true');
    const TerminalView = await importTerminalView();
    render(<TerminalView taskId="task-A" windowIndex={0} />);
    const ws = MockWebSocket.instances[0];
    act(() => ws._open());

    // First data frame seeds one latency ping.
    act(() => ws.onmessage?.({ data: 'hello' } as MessageEvent));
    expect(ws.sent).toContain('{"type":"ping"}');

    // The pong comes back 100ms later as an empty TEXT frame — that must
    // close the sample (it used to require an empty ArrayBuffer, leaving
    // latencyMs null forever and the typeahead permanently inert).
    await act(async () => {
      vi.setSystemTime(Date.now() + 100);
    });
    act(() => ws.onmessage?.({ data: '' } as MessageEvent));

    // 100ms is past the 30ms gate → a keystroke now renders a dim prediction.
    act(() => lastOnDataCb.current?.('a'));
    expect(terminalInstances[0].writes).toContain('\x1b[2ma\x1b[22m');
  });

  it('does not park a terminal that never received data', async () => {
    const TerminalView = await importTerminalView();
    const { unmount } = render(<TerminalView taskId="task-A" windowIndex={0} />);

    const ws = MockWebSocket.instances[0];
    act(() => ws._open());
    unmount();

    // Nothing painted yet — no buffer worth keeping, so the socket is closed.
    expect(ws.readyState).toBe(MockWebSocket.CLOSING);

    render(<TerminalView taskId="task-A" windowIndex={0} />);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
