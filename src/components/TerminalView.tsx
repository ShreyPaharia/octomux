import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalViewProps {
  taskId?: string;
  windowIndex?: number;
  wsUrl?: string;
}

const MAX_RECONNECT_DELAY = 10_000;
const INITIAL_RECONNECT_DELAY = 1_000;

export function TerminalView({ taskId, windowIndex, wsUrl: wsUrlProp }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(INITIAL_RECONNECT_DELAY);
  const unmounted = useRef(false);

  const getWsUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return wsUrlProp
      ? `${protocol}//${window.location.host}${wsUrlProp}`
      : `${protocol}//${window.location.host}/ws/terminal/${taskId}/${windowIndex}`;
  }, [taskId, windowIndex, wsUrlProp]);

  const connectWs = useCallback(
    (term: Terminal) => {
      if (unmounted.current) return;

      const ws = new WebSocket(getWsUrl());

      ws.onopen = () => {
        reconnectDelay.current = INITIAL_RECONNECT_DELAY;
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (event) => {
        term.write(event.data);
      };

      ws.onclose = (event) => {
        if (unmounted.current) return;
        if (event.code !== 1000 && event.code !== 1001) {
          term.write('\r\n\x1b[31m[Terminal disconnected — reconnecting...]\x1b[0m\r\n');
          // Exponential backoff reconnection
          reconnectTimer.current = setTimeout(() => {
            reconnectDelay.current = Math.min(reconnectDelay.current * 2, MAX_RECONNECT_DELAY);
            connectWs(term);
          }, reconnectDelay.current);
        }
      };

      ws.onerror = () => {
        // onclose will handle reconnection
      };

      wsRef.current = ws;

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
    },
    [getWsUrl],
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

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#09090b',
        foreground: '#fafafa',
        cursor: '#fafafa',
        selectionBackground: '#3f3f46',
      },
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;
    reconnectDelay.current = INITIAL_RECONNECT_DELAY;

    connectWs(term);
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
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [connect]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (fitRef.current && termRef.current) {
        fitRef.current.fit();
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'resize',
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            }),
          );
        }
      }
    };

    window.addEventListener('resize', handleResize);
    // Also observe container size changes
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-lg border border-border bg-[#09090b]"
    />
  );
}
