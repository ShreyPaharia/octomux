import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useMediaQuery } from '@/lib/use-media-query';
import { installTerminalMobileTouch } from '@/lib/terminal-mobile-touch';
import { installTerminalVisualViewport } from '@/lib/terminal-visual-viewport';
import { MobileTerminalScrollControls } from '@/components/MobileTerminalScrollControls';
import { CloudOffIcon } from './icons';

const MOBILE_SCROLL_LINES = 5;

interface TerminalViewProps {
  taskId?: string;
  windowIndex?: number;
  wsUrl?: string;
  visible?: boolean;
  readOnly?: boolean;
  fontSize?: number;
  scrollback?: number;
}

const MAX_RECONNECT_DELAY = 10_000;
const INITIAL_RECONNECT_DELAY = 1_000;

export function TerminalView({
  taskId,
  windowIndex,
  wsUrl: wsUrlProp,
  visible = true,
  readOnly = false,
  fontSize = 13,
  scrollback = 5000,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(INITIAL_RECONNECT_DELAY);
  const unmounted = useRef(false);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const viewportCleanup = useRef<(() => void) | null>(null);
  const mobileTouchCleanup = useRef<(() => void) | null>(null);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [disconnected, setDisconnected] = useState(false);
  const [retrySecs, setRetrySecs] = useState<number>(0);
  // True while the WebSocket is opening (initial connect or a reconnect) and no
  // data has arrived yet. Drives the lightweight "Connecting…" placeholder.
  const [connecting, setConnecting] = useState(true);

  // Belt-and-suspenders: never show the overlay while the ws is actually OPEN,
  // even if some stale state flipped `disconnected` to true.
  const showOverlay =
    disconnected && (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN);

  const getWsUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return wsUrlProp
      ? `${protocol}//${window.location.host}${wsUrlProp}`
      : `${protocol}//${window.location.host}/ws/terminal/${taskId}/${windowIndex}`;
  }, [taskId, windowIndex, wsUrlProp]);

  const scrollCursorIntoView = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const textarea = containerRef.current?.querySelector(
      '.xterm-helper-textarea',
    ) as HTMLTextAreaElement | null;
    if (textarea && document.activeElement === textarea) {
      term.scrollToBottom();
    }
  }, []);

  const scrollOlder = useCallback(() => {
    termRef.current?.scrollLines(-MOBILE_SCROLL_LINES);
  }, []);

  const scrollNewer = useCallback(() => {
    termRef.current?.scrollLines(MOBILE_SCROLL_LINES);
  }, []);

  const scrollToLatest = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, []);

  // Helper to fit terminal and send resize dimensions over WebSocket
  const fitAndSendResize = useCallback(
    (ws: WebSocket) => {
      if (!fitRef.current || !termRef.current || !containerRef.current) return;
      // Skip when container is hidden (0 dimensions) — fitting a hidden terminal
      // sends a 0×0 resize to the PTY, which garbles apps like nvim.
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth === 0 || clientHeight === 0) return;
      fitRef.current.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          }),
        );
      }
      scrollCursorIntoView();
    },
    [scrollCursorIntoView],
  );

  const connectWs = useCallback(
    (term: Terminal) => {
      if (unmounted.current) return;

      // Show the connecting placeholder for every connect attempt, including
      // reconnects — cleared on open or as soon as the first chunk arrives.
      setConnecting(true);
      const ws = new WebSocket(getWsUrl());

      ws.onopen = () => {
        reconnectDelay.current = INITIAL_RECONNECT_DELAY;
        setDisconnected(false);
        setConnecting(false);
        if (countdownTimer.current) {
          clearInterval(countdownTimer.current);
          countdownTimer.current = null;
        }
        // Re-fit now that we know layout is settled (WS connect takes a few ms,
        // guaranteeing the browser has completed layout), then send correct dimensions.
        fitAndSendResize(ws);
        // Belt-and-suspenders: fit again after a frame to catch any late layout shifts
        requestAnimationFrame(() => {
          if (!unmounted.current) fitAndSendResize(ws);
        });
      };

      ws.onmessage = (event) => {
        // First chunk means the terminal has real content — drop the placeholder.
        setConnecting(false);
        term.write(event.data);
      };

      ws.onclose = (event) => {
        // Skip reconnect if we unmounted OR if this ws has already been replaced.
        // A replaced ws (via prop change or explicit reconnect) must not trigger
        // a reconnect via its now-stale closure — that closure captures the old
        // taskId/windowIndex and would route input to the wrong agent.
        if (unmounted.current || wsRef.current !== ws) return;
        if (event.code !== 1000 && event.code !== 1001) {
          term.write('\r\n\x1b[31m[Terminal disconnected — reconnecting...]\x1b[0m\r\n');
          setDisconnected(true);
          const delay = reconnectDelay.current;
          setRetrySecs(Math.ceil(delay / 1000));
          if (countdownTimer.current) clearInterval(countdownTimer.current);
          countdownTimer.current = setInterval(() => {
            setRetrySecs((s) => (s > 0 ? s - 1 : 0));
          }, 1000);
          // Exponential backoff reconnection
          reconnectTimer.current = setTimeout(() => {
            reconnectDelay.current = Math.min(reconnectDelay.current * 2, MAX_RECONNECT_DELAY);
            connectWs(term);
          }, delay);
        }
      };

      ws.onerror = () => {
        // onclose will handle reconnection
      };

      wsRef.current = ws;
    },
    [getWsUrl, fitAndSendResize],
  );

  const connect = useCallback(() => {
    if (!containerRef.current) return;

    // Clean up previous
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    viewportCleanup.current?.();
    viewportCleanup.current = null;
    mobileTouchCleanup.current?.();
    mobileTouchCleanup.current = null;

    const resolvedFontSize = isMobile ? Math.max(fontSize, 14) : fontSize;

    const term = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontSize: resolvedFontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#09090b',
        foreground: '#fafafa',
        cursor: '#fafafa',
        selectionBackground: '#3f3f46',
      },
      scrollback,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    // Force the xterm viewport to use a non-overlay scrollbar so FitAddon
    // correctly subtracts scrollbar width when calculating columns.
    // Without this, macOS overlay scrollbars report 0 width and the last
    // column gets clipped when the scrollbar appears.
    const viewport = containerRef.current.querySelector('.xterm-viewport');
    if (viewport) {
      (viewport as HTMLElement).style.overflowY = 'scroll';
    }

    if (isMobile && containerRef.current) {
      mobileTouchCleanup.current = installTerminalMobileTouch(containerRef.current, {
        onScrollLines: (lines) => term.scrollLines(lines),
      });
    }

    termRef.current = term;
    fitRef.current = fitAddon;
    reconnectDelay.current = INITIAL_RECONNECT_DELAY;

    // Register input handler once per terminal lifetime — always forwards to
    // the latest WebSocket via wsRef, so reconnects don't accumulate listeners.
    // Skipped in readOnly mode so panes can't receive keystrokes.
    if (!readOnly) {
      term.onData((data) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
        scrollCursorIntoView();
      });
    }

    // Defer initial fit to next frame so the browser has completed flex layout.
    // Without this, fit() can measure a not-yet-expanded container and set xterm
    // to a small size, which then constrains the flex parent (feedback loop).
    requestAnimationFrame(() => {
      if (!unmounted.current) fitAddon.fit();
    });

    connectWs(term);
  }, [connectWs, readOnly, fontSize, scrollback, isMobile, scrollCursorIntoView]);

  const handleRetryNow = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
    reconnectDelay.current = INITIAL_RECONNECT_DELAY;
    setRetrySecs(0);
    if (termRef.current) {
      connectWs(termRef.current);
    }
  }, [connectWs]);

  // Connect on mount and reconnect when taskId/windowIndex changes
  useEffect(() => {
    unmounted.current = false;
    connect();

    return () => {
      unmounted.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      if (countdownTimer.current) {
        clearInterval(countdownTimer.current);
      }
      wsRef.current?.close();
      termRef.current?.dispose();
      viewportCleanup.current?.();
      viewportCleanup.current = null;
      mobileTouchCleanup.current?.();
      mobileTouchCleanup.current = null;
    };
  }, [connect]);

  // Handle resize (window + container size changes)
  // Debounce with rAF to avoid excessive fit+resize during animated resizes.
  useEffect(() => {
    let rafId: number | null = null;
    const handleResize = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const ws = wsRef.current;
        if (ws) fitAndSendResize(ws);
      });
    };

    window.addEventListener('resize', handleResize);
    // Also observe container size changes
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [fitAndSendResize]);

  // Disable pull-to-refresh while an agent session terminal is visible on mobile.
  useEffect(() => {
    if (!isMobile || !visible) return;
    document.documentElement.classList.add('octomux-agent-session-active');
    return () => document.documentElement.classList.remove('octomux-agent-session-active');
  }, [isMobile, visible]);

  // On mobile, size the terminal to the visible viewport when the soft keyboard
  // opens — xterm handles touch scroll natively; we only manage layout height.
  useEffect(() => {
    if (!isMobile || !visible || !containerRef.current) return;
    viewportCleanup.current?.();
    viewportCleanup.current = installTerminalVisualViewport(containerRef.current, () => {
      const ws = wsRef.current;
      if (ws) fitAndSendResize(ws);
    });
    return () => {
      viewportCleanup.current?.();
      viewportCleanup.current = null;
    };
  }, [isMobile, visible, fitAndSendResize]);

  // Fit terminal when it becomes visible (e.g. toggling between agent/editor views).
  // Use double-rAF to ensure the browser has fully reflowed after CSS hidden→flex toggle.
  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      const rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const ws = wsRef.current;
          if (ws) fitAndSendResize(ws);
        });
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [visible, fitAndSendResize]);

  return (
    <div className="relative h-full w-full min-h-0">
      <div
        ref={containerRef}
        className="octomux-terminal-host h-full w-full min-h-0 overflow-hidden rounded-lg bg-[#09090b] transition-opacity"
        style={{ opacity: showOverlay ? 0.7 : 1 }}
      />
      {connecting && (
        <div
          data-testid="terminal-connecting-placeholder"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="flex items-center gap-1 text-[12px] font-medium text-[#a1a1aa]">
            Connecting to terminal
            <span className="inline-flex gap-0.5">
              <span className="size-1 animate-bounce rounded-full bg-[#a1a1aa] [animation-delay:-0.3s]" />
              <span className="size-1 animate-bounce rounded-full bg-[#a1a1aa] [animation-delay:-0.15s]" />
              <span className="size-1 animate-bounce rounded-full bg-[#a1a1aa]" />
            </span>
          </span>
        </div>
      )}
      {isMobile && visible && !connecting && (
        <MobileTerminalScrollControls
          onScrollOlder={scrollOlder}
          onScrollNewer={scrollNewer}
          onScrollToBottom={scrollToLatest}
          className="absolute bottom-2 right-2 z-20 md:hidden"
        />
      )}
      {showOverlay && (
        <div
          data-testid="terminal-disconnected-overlay"
          role="alert"
          className="bg-glass-l1 glass-blur-l1 pointer-events-auto absolute left-3 right-3 top-3 flex items-center gap-3 rounded-md border border-[#FFB80033] bg-[#FFB80014] px-4 py-2.5"
        >
          <CloudOffIcon size={14} className="shrink-0 text-[#FFB800]" />
          <span className="flex-1 text-[12px] font-medium text-[#FFB800]">
            Server unreachable — reconnecting in {Math.max(retrySecs, 0)}s…
          </span>
          <button
            type="button"
            onClick={handleRetryNow}
            className="rounded-md border border-[#FFB80066] bg-[#FFB80022] px-2.5 py-1 text-[11px] font-semibold text-[#FFB800] hover:bg-[#FFB80033]"
          >
            Retry now
          </button>
        </div>
      )}
    </div>
  );
}
