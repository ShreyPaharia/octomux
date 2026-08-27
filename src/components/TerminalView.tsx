import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useMediaQuery } from '@/lib/use-media-query';
import { installTerminalMobileTouch } from '@/lib/terminal-mobile-touch';
import { installTerminalWheelCoalesce } from '@/lib/terminal-wheel-coalesce';
import {
  supportsDeflate,
  makeStreamFrameWriter,
  makeFlowControlledWrite,
} from '@/lib/terminal-frames';
import { createTerminalTypeahead, getLocalEchoEnabled } from '@/lib/terminal-typeahead';
import { installTerminalVisualViewport } from '@/lib/terminal-visual-viewport';
import { isAndroid, attachAndroidImeBridge } from '@/lib/terminal-android-ime';
import {
  takeEntry,
  parkEntry,
  destroyEntry,
  type TerminalPoolEntry,
  type TerminalPoolListener,
} from '@/lib/terminal-pool';
import { CloudOffIcon } from './icons';

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
// Liveness watchdog: a NAT drop or laptop sleep leaves a half-open socket that
// still reports OPEN, so onclose never fires and the terminal silently freezes
// until a manual refresh. Probe an idle link with an app-level ping (the server
// replies with an empty frame); a silent one is dead — replace it.
const WATCHDOG_IDLE_MS = 15_000;
const PONG_TIMEOUT_MS = 5_000;

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
  // The live ensemble (xterm + host div + ws + inflate stream). On unmount it
  // is parked in the terminal pool rather than destroyed, so switching back
  // paints instantly from the existing buffer.
  const entryRef = useRef<TerminalPoolEntry | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(INITIAL_RECONNECT_DELAY);
  const unmounted = useRef(false);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const viewportCleanup = useRef<(() => void) | null>(null);
  const isMobile = useMediaQuery('(max-width: 767px)');
  const visibleRef = useRef(visible);
  const [disconnected, setDisconnected] = useState(false);
  const [retrySecs, setRetrySecs] = useState<number>(0);
  // True while the WebSocket is opening (initial connect or a reconnect) and no
  // data has arrived yet. Drives the lightweight "Connecting…" placeholder.
  const [connecting, setConnecting] = useState(true);

  // Belt-and-suspenders: never show the overlay while the ws is actually OPEN,
  // even if some stale state flipped `disconnected` to true.
  const showOverlay = disconnected && entryRef.current?.ws?.readyState !== WebSocket.OPEN;

  const getWsUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const deflate = supportsDeflate ? '?deflate=2' : '';
    return wsUrlProp
      ? `${protocol}//${window.location.host}${wsUrlProp}${deflate}`
      : `${protocol}//${window.location.host}/ws/terminal/${taskId}/${windowIndex}${deflate}`;
  }, [taskId, windowIndex, wsUrlProp]);

  const scrollCursorIntoView = useCallback(() => {
    const term = entryRef.current?.term;
    if (!term) return;
    const textarea = containerRef.current?.querySelector(
      '.xterm-helper-textarea',
    ) as HTMLTextAreaElement | null;
    if (textarea && document.activeElement === textarea) {
      term.scrollToBottom();
    }
  }, []);

  // Fit the terminal and send the dimensions — but only when they actually
  // changed. A redundant resize still SIGWINCHes the pty and makes tmux redraw
  // the whole pane, which is the visible reflow flash on every tab switch.
  const fitAndSendResize = useCallback(() => {
    const entry = entryRef.current;
    if (!entry || !containerRef.current) return;
    // Skip when container is hidden (0 dimensions) — fitting a hidden terminal
    // sends a 0×0 resize to the PTY, which garbles apps like nvim.
    const { clientWidth, clientHeight } = containerRef.current;
    if (clientWidth === 0 || clientHeight === 0) return;
    entry.fit.fit();
    const { cols, rows } = entry.term;
    if (
      entry.ws?.readyState === WebSocket.OPEN &&
      (entry.lastSize?.cols !== cols || entry.lastSize?.rows !== rows)
    ) {
      entry.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      entry.lastSize = { cols, rows };
    }
    scrollCursorIntoView();
  }, [scrollCursorIntoView]);

  const connectWs = useCallback(
    (entry: TerminalPoolEntry) => {
      if (unmounted.current || entry.disposed) return;

      // Show the connecting placeholder for every connect attempt, including
      // reconnects — cleared as soon as the first chunk arrives.
      setConnecting(true);
      const ws = new WebSocket(getWsUrl());
      ws.binaryType = 'arraybuffer';
      // One inflate stream per socket — the server deflates with per-connection
      // context takeover, so frames only decode against this socket's stream.
      // A stream decode error is invisible to the watchdog (raw frames keep
      // arriving, only decoding stopped), so it forces its own reconnect.
      entry.frames.dispose();
      // Watermark flow control: during output floods, ask the server to stop
      // forwarding pty output while xterm's write buffer is past the high
      // watermark — otherwise unprocessed bytes pile up and starve input
      // handling. Counters live in this per-socket closure (fresh per connect,
      // matching the server's fresh flow state) and travel with the entry
      // through park/adopt via entry.frames.
      const write = makeFlowControlledWrite(entry.term, (state) => {
        if (!entry.disposed && entry.ws === ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'flow', state }));
        }
      });
      const frames = makeStreamFrameWriter(
        (data) => {
          // The typeahead's rewind/undo prefix must land before the data it
          // reconciles against; a handful of control bytes, so it skips flow
          // accounting.
          const prefix = entry.typeahead?.reconcile(data);
          if (prefix) entry.term.write(prefix);
          write(data);
        },
        () => {
          if (entry.disposed || entry.ws !== ws) return;
          ws.close();
          if (entry.listener) connectWs(entry);
          else destroyEntry(entry);
        },
      );
      entry.frames = frames;
      entry.ws = ws;
      // Fresh socket = fresh server-side pty spawned at its default size, so
      // the first fit must send even if cols/rows match the previous socket's.
      entry.lastSize = null;

      ws.onopen = () => {
        if (entry.disposed || entry.ws !== ws) return;
        reconnectDelay.current = INITIAL_RECONNECT_DELAY;
        entry.lastMessageAt = Date.now();
        setDisconnected(false);
        // Deliberately NOT clearing `connecting` here: the socket opens in ~5ms
        // but the server's first frame lands later, so clearing on open left the
        // user staring at a blank black rectangle with no feedback for the rest
        // of the wait. `onmessage` clears it when there is actually something to see.
        if (countdownTimer.current) {
          clearInterval(countdownTimer.current);
          countdownTimer.current = null;
        }
        // Re-fit now that we know layout is settled (WS connect takes a few ms,
        // guaranteeing the browser has completed layout), then send correct dimensions.
        fitAndSendResize();
        // Hidden LRU tabs shouldn't stream output nobody can see — pause until
        // the tab becomes active (server discards + repaints on resume).
        if (!visibleRef.current) {
          ws.send(JSON.stringify({ type: 'pause' }));
        }
        // Belt-and-suspenders: fit again after a frame to catch any late layout shifts
        requestAnimationFrame(() => {
          if (!unmounted.current) fitAndSendResize();
        });
      };

      ws.onmessage = (event) => {
        // A queued frame from a just-replaced socket must not count as this
        // socket's liveness pong (or paint into the new stream).
        if (entry.disposed || entry.ws !== ws) return;
        // Empty frames are watchdog pongs — they prove liveness, not content.
        const isEmptyPong = event.data instanceof ArrayBuffer && event.data.byteLength === 0;
        if (!isEmptyPong) entry.hasData = true;
        entry.lastMessageAt = Date.now();
        // Latency sampling for the typeahead gate. Only an empty pong closes
        // a sample — data frames aren't request/response. Seed one ping on the
        // first data frame (not on open: messages sent before the server's
        // attach completes are queued behind tmux setup, which would measure
        // setup time instead of RTT); the idle watchdog refreshes it after.
        if (isEmptyPong && entry.pingSentAt !== null) {
          entry.latencyMs = Date.now() - entry.pingSentAt;
          entry.pingSentAt = null;
        } else if (
          entry.typeahead &&
          entry.latencyMs === null &&
          entry.pingSentAt === null &&
          getLocalEchoEnabled()
        ) {
          entry.pingSentAt = Date.now();
          ws.send(JSON.stringify({ type: 'ping' }));
        }
        frames.onFrame(event.data);
        // First chunk means the terminal has real content — the mounted owner
        // drops its placeholder. A parked entry just keeps its buffer warm.
        entry.listener?.onData();
      };

      ws.onclose = (event) => {
        // Skip if this ws has already been replaced. A replaced ws (via prop
        // change or explicit reconnect) must not trigger a reconnect via its
        // now-stale closure — that would route input to the wrong agent.
        if (entry.disposed || entry.ws !== ws) return;
        if (entry.listener) entry.listener.onClose(event);
        // A parked entry whose socket died has nothing left worth adopting.
        else destroyEntry(entry);
      };

      ws.onerror = () => {
        // onclose will handle reconnection
      };
    },
    [getWsUrl, fitAndSendResize],
  );

  // Park (or destroy) the current entry — on unmount and on prop-driven
  // endpoint changes. Unbinding the listener first stops the entry's ws
  // callbacks from touching this component's state.
  const release = useCallback(() => {
    const entry = entryRef.current;
    entryRef.current = null;
    if (!entry) return;
    entry.listener = null;
    parkEntry(entry);
  }, []);

  const connect = useCallback(() => {
    if (!containerRef.current) return;

    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    release();

    const resolvedFontSize = isMobile ? Math.max(fontSize, 14) : fontSize;
    // Entries are only interchangeable when everything baked into the xterm
    // instance matches too, so the config is part of the identity (a readOnly
    // grid cell must never adopt the interactive tab's terminal or vice versa).
    const key = `${getWsUrl()}|ro:${readOnly ? 1 : 0}|fs:${resolvedFontSize}|sb:${scrollback}`;

    const listener: TerminalPoolListener = {
      onData: () => setConnecting(false),
      onUserInput: scrollCursorIntoView,
      onClose: (event) => {
        const entry = entryRef.current;
        if (!entry) return;
        if (event.code !== 1000 && event.code !== 1001) {
          entry.term.write('\r\n\x1b[31m[Terminal disconnected — reconnecting...]\x1b[0m\r\n');
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
            connectWs(entry);
          }, delay);
        }
      },
    };

    // Warm reattach: a parked entry for this exact endpoint+config still has
    // its buffer, its socket, and its inflate stream — adopt it and the pane
    // paints instantly with no reconnect and no placeholder.
    const pooled = takeEntry(key);
    if (pooled) {
      pooled.listener = listener;
      entryRef.current = pooled;
      containerRef.current.appendChild(pooled.hostEl);
      reconnectDelay.current = INITIAL_RECONNECT_DELAY;
      setDisconnected(false);
      setConnecting(!pooled.hasData);
      // Un-pause the parked stream. The visible-effect also resumes on mount,
      // but connect() can re-run on a prop change without a remount — send
      // here too; the server's resume handler is idempotent.
      if (visibleRef.current) {
        pooled.ws?.send(JSON.stringify({ type: 'resume' }));
      }
      // Only an actual size change reaches the server (no SIGWINCH, no reflow
      // flash when the layout is unchanged).
      requestAnimationFrame(() => {
        if (!unmounted.current) fitAndSendResize();
      });
      return;
    }

    const hostEl = document.createElement('div');
    hostEl.style.width = '100%';
    hostEl.style.height = '100%';
    containerRef.current.appendChild(hostEl);

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
    term.open(hostEl);

    // WebGL renderer paints full-screen TUI repaints far faster than the DOM
    // renderer. Load after open(); on failure or GPU context loss, dispose and
    // xterm falls back to the DOM renderer automatically.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable (old GPU, jsdom) — DOM renderer remains
    }

    // De-decorate xterm's hidden capture textarea so mobile Safari / Chrome
    // don't draw autofill / suggestion / accessory UI above the soft
    // keyboard. Harmless on desktop (there's no textarea chrome to suppress
    // there), so this runs unconditionally rather than gating on isMobile.
    const helperTextarea = hostEl.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (helperTextarea) {
      helperTextarea.setAttribute('autocapitalize', 'off');
      helperTextarea.setAttribute('autocorrect', 'off');
      helperTextarea.setAttribute('autocomplete', 'off');
      helperTextarea.spellcheck = false;
      helperTextarea.setAttribute('enterkeyhint', 'send');
    }

    // Force the xterm viewport to use a non-overlay scrollbar so FitAddon
    // correctly subtracts scrollbar width when calculating columns.
    // Without this, macOS overlay scrollbars report 0 width and the last
    // column gets clipped when the scrollbar appears.
    const viewport = hostEl.querySelector('.xterm-viewport');
    if (viewport) {
      (viewport as HTMLElement).style.overflowY = 'scroll';
    }

    // hostEl-scoped installs ride along with the parked entry, so they are
    // registered once per terminal lifetime and disposed with it.
    const disposers: (() => void)[] = [];
    if (isMobile) {
      disposers.push(installTerminalMobileTouch(hostEl));
    }
    // Coalesce alt-buffer wheel events so a trackpad flick reaches the remote
    // TUI as a few scroll bursts instead of dozens of repaint-triggering ones.
    if (!readOnly) {
      disposers.push(installTerminalWheelCoalesce(hostEl, term));
    }

    const entry: TerminalPoolEntry = {
      key,
      hostEl,
      term,
      fit: fitAddon,
      ws: null,
      frames: { onFrame() {}, dispose() {} },
      lastSize: null,
      lastMessageAt: Date.now(),
      latencyMs: null,
      pingSentAt: null,
      typeahead: null,
      hasData: false,
      listener,
      parkTimer: null,
      disposed: false,
      disposers,
    };

    // Local-echo typeahead rides the entry (one per terminal lifetime, like
    // the input handler below). Inert unless the setting is on, measured
    // latency exceeds the gate, and the normal screen buffer is active.
    if (!readOnly) {
      const typeahead = createTerminalTypeahead(term, () => entry.latencyMs);
      entry.typeahead = typeahead;
      disposers.push(() => typeahead.dispose());
    }

    if (!readOnly && isAndroid()) {
      disposers.push(
        attachAndroidImeBridge(term, (bytes) => {
          if (entry.ws?.readyState === WebSocket.OPEN) {
            entry.ws.send(bytes);
          }
        }),
      );
      // Short-circuit xterm's broken composition path: returning false for
      // keydown keyCode 229 (IME composition) stops CompositionHelper from
      // scheduling its own naive textarea diff before the bridge above can
      // translate the mutation itself. Every other key falls through to
      // xterm's normal keymap untouched.
      term.attachCustomKeyEventHandler((e) => e.keyCode !== 229);
    }

    // Register input handler once per terminal lifetime — always forwards to
    // the entry's latest WebSocket, so reconnects and pool adoptions don't
    // accumulate listeners or capture a stale socket. No batching anywhere on
    // this path: keystroke → ws.send in the same tick.
    // Skipped in readOnly mode so panes can't receive keystrokes.
    if (!readOnly) {
      const forward = (data: string) => {
        if (entry.ws?.readyState === WebSocket.OPEN) {
          entry.ws.send(data);
          entry.typeahead?.onInput(data);
        }
        entry.listener?.onUserInput();
      };
      // PHANTOM-ENTER GUARD. `term.onData` fires both for real user input
      // (keystroke / paste / IME) AND for xterm-synthesized control-sequence
      // responses (focus-report escapes, DSR/CPR cursor reports, etc.) that
      // xterm emits on its own in response to programmatic calls like
      // `term.focus()`. Forwarding the latter to the pty can land stray
      // escape bytes at the shell prompt. xterm's internal
      // `coreService.onUserInput` fires immediately before `onData` on the
      // genuine user-input path (same synchronous tick), so gating on a flag
      // set there forwards only real input. If a future xterm rev removes
      // this internal, fall back to forwarding everything so the terminal
      // never silently stops accepting input.
      const coreService = (
        term as unknown as {
          _core?: { coreService?: { onUserInput?: (cb: () => void) => unknown } };
        }
      )._core?.coreService;
      if (coreService?.onUserInput) {
        let wasUserInput = false;
        coreService.onUserInput(() => {
          wasUserInput = true;
        });
        term.onData((data) => {
          if (!wasUserInput) return;
          wasUserInput = false;
          forward(data);
        });
      } else {
        term.onData(forward);
      }
    }

    entryRef.current = entry;
    reconnectDelay.current = INITIAL_RECONNECT_DELAY;

    // Defer initial fit to next frame so the browser has completed flex layout.
    // Without this, fit() can measure a not-yet-expanded container and set xterm
    // to a small size, which then constrains the flex parent (feedback loop).
    requestAnimationFrame(() => {
      if (!unmounted.current) fitAddon.fit();
    });

    connectWs(entry);
  }, [
    connectWs,
    release,
    getWsUrl,
    fitAndSendResize,
    readOnly,
    fontSize,
    scrollback,
    isMobile,
    scrollCursorIntoView,
  ]);

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
    const entry = entryRef.current;
    if (entry) {
      connectWs(entry);
    }
  }, [connectWs]);

  // Send a liveness ping if the link has been silent past the watchdog window;
  // a ping that goes unanswered means the socket is half-open — replace it.
  // Silent recovery: no overlay, the reconnect repaints from the tmux snapshot.
  const probeLiveness = useCallback(() => {
    const entry = entryRef.current;
    const ws = entry?.ws;
    if (!entry || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - entry.lastMessageAt < WATCHDOG_IDLE_MS) return;
    const sentAt = Date.now();
    entry.pingSentAt = sentAt; // also feeds the typeahead latency estimate
    ws.send(JSON.stringify({ type: 'ping' }));
    setTimeout(() => {
      if (unmounted.current || entryRef.current !== entry || entry.ws !== ws) return;
      if (entry.lastMessageAt >= sentAt) return; // pong (or any output) arrived
      // close() on a half-open socket can wait out a long TCP timeout before
      // onclose fires — reconnect immediately; the stale socket's onclose is
      // ignored via the entry.ws identity guard.
      ws.close();
      handleRetryNow();
    }, PONG_TIMEOUT_MS);
  }, [handleRetryNow]);

  useEffect(() => {
    const timer = setInterval(probeLiveness, WATCHDOG_IDLE_MS);
    return () => clearInterval(timer);
  }, [probeLiveness]);

  // A reconnect scheduled while the tab is hidden gets throttled by the browser
  // (background timers fire at most ~once a minute), so a dropped connection can
  // stay down long after the user returns. Retry immediately on tab return if
  // the socket is dead. An OPEN socket is probed instead of replaced — after a
  // laptop sleep it often only *looks* OPEN. CONNECTING is left to the
  // browser's own connect timeout.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = entryRef.current?.ws;
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        probeLiveness();
        return;
      }
      handleRetryNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [handleRetryNow, probeLiveness]);

  // Connect on mount and reconnect when taskId/windowIndex changes.
  // Unmount parks the entry (buffer + socket kept warm) instead of tearing it
  // down — the pool owns TTL and LRU eviction from here.
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
      release();
      viewportCleanup.current?.();
      viewportCleanup.current = null;
    };
  }, [connect, release]);

  // Handle resize (window + container size changes)
  // Debounce with rAF to avoid excessive fit+resize during animated resizes.
  useEffect(() => {
    let rafId: number | null = null;
    const handleResize = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        fitAndSendResize();
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
      fitAndSendResize();
    });
    return () => {
      viewportCleanup.current?.();
      viewportCleanup.current = null;
    };
  }, [isMobile, visible, fitAndSendResize]);

  // Pause the server-side stream while this terminal is a hidden LRU tab —
  // no point paying bandwidth for output nobody can see. Resume triggers a
  // server-side full repaint so the screen is current when the tab returns.
  // Runs on mount too, which is what resumes a just-adopted parked entry.
  useEffect(() => {
    visibleRef.current = visible;
    const ws = entryRef.current?.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: visible ? 'resume' : 'pause' }));
    }
  }, [visible]);

  // Fit terminal when it becomes visible (e.g. toggling between agent/editor views).
  // Use double-rAF to ensure the browser has fully reflowed after CSS hidden→flex toggle.
  // fitAndSendResize dedupes, so an unchanged layout sends nothing to the server.
  useEffect(() => {
    if (visible && entryRef.current) {
      const rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAndSendResize();
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
        onClick={() => {
          // Focus inside a real user gesture (tap) so mobile browsers raise
          // the soft keyboard. The terminal may already be disposed (e.g. a
          // tap racing an unmount), so this is best-effort.
          if (!readOnly) {
            try {
              entryRef.current?.term.focus();
            } catch {
              /* terminal disposed mid-tap — nothing to focus */
            }
          }
        }}
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
