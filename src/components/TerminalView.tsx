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

export function TerminalView({ taskId, windowIndex, wsUrl: wsUrlProp }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const connect = useCallback(() => {
    if (!containerRef.current) return;

    // Clean up previous
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

    // WebSocket connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = wsUrlProp
      ? `${protocol}//${window.location.host}${wsUrlProp}`
      : `${protocol}//${window.location.host}/ws/terminal/${taskId}/${windowIndex}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Send initial size
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      term.write(event.data);
    };

    ws.onclose = (event) => {
      if (event.code !== 1000) {
        term.write('\r\n\x1b[31m[Terminal disconnected]\x1b[0m\r\n');
      }
    };

    ws.onerror = () => {
      term.write('\r\n\x1b[31m[Connection error]\x1b[0m\r\n');
    };

    wsRef.current = ws;

    // Terminal input → WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }, [taskId, windowIndex, wsUrlProp]);

  // Connect on mount and reconnect when taskId/windowIndex changes
  useEffect(() => {
    connect();

    return () => {
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
