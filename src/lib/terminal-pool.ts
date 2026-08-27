/**
 * Module-level pool of parked terminal ensembles: xterm instance + its DOM
 * host + the open WebSocket + the per-socket inflate stream, kept together
 * because the deflate context takeover means the stream cannot be rebuilt
 * mid-socket.
 *
 * TerminalView parks its entry here on unmount instead of tearing it down and
 * adopts it back on remount, so switching tabs/tasks repaints instantly from
 * the live xterm buffer — no reconnect, no "Connecting…" placeholder, no
 * tmux reattach. A parked entry keeps its server-side pty alive (paused, so
 * output is discarded, not streamed), bounded by an LRU cap and a TTL.
 */
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { FrameWriter } from './terminal-frames';
import type { TerminalTypeahead } from './terminal-typeahead';

export interface TerminalPoolListener {
  /** A ws frame arrived (clears the connecting placeholder). */
  onData(): void;
  /** The socket closed while mounted — owner decides whether to reconnect. */
  onClose(event: CloseEvent): void;
  /** Real user input was forwarded (scroll cursor into view etc.). */
  onUserInput(): void;
}

export interface TerminalPoolEntry {
  key: string;
  hostEl: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  /** Null only between entry creation and the first connect. */
  ws: WebSocket | null;
  frames: FrameWriter;
  /** Last cols/rows actually sent to the server — resize dedupe. */
  lastSize: { cols: number; rows: number } | null;
  lastMessageAt: number;
  /** Latest measured ws round-trip (ping → empty pong); gates typeahead. */
  latencyMs: number | null;
  /** In-flight ping send time — the next empty pong closes the sample. */
  pingSentAt: number | null;
  /** Local-echo predictor (null for readOnly panes); inert until enabled. */
  typeahead: TerminalTypeahead | null;
  /** First frame arrived — the buffer has content worth keeping. */
  hasData: boolean;
  /** The mounted TerminalView currently owning this entry; null while parked. */
  listener: TerminalPoolListener | null;
  parkTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
  /** hostEl-scoped installs (wheel coalesce, touch, IME) — run on destroy. */
  disposers: (() => void)[];
}

export const POOL_MAX = 5;
export const POOL_TTL_MS = 60_000;

const pool = new Map<string, TerminalPoolEntry>();

export function destroyEntry(entry: TerminalPoolEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  if (entry.parkTimer) clearTimeout(entry.parkTimer);
  if (pool.get(entry.key) === entry) pool.delete(entry.key);
  entry.listener = null;
  entry.frames.dispose();
  try {
    entry.ws?.close();
  } catch {
    // already closed
  }
  for (const d of entry.disposers) d();
  entry.term.dispose();
  entry.hostEl.remove();
}

/** Adopt a parked entry: removed from the pool, TTL cleared. Null when absent
 *  or its socket died while parked. */
export function takeEntry(key: string): TerminalPoolEntry | null {
  const entry = pool.get(key);
  if (!entry) return null;
  pool.delete(key);
  if (entry.parkTimer) {
    clearTimeout(entry.parkTimer);
    entry.parkTimer = null;
  }
  if (entry.disposed || entry.ws?.readyState !== WebSocket.OPEN) {
    destroyEntry(entry);
    return null;
  }
  return entry;
}

/** Park an unmounting entry for later adoption. Destroys it instead when
 *  there is nothing worth keeping (socket not OPEN, or nothing painted yet). */
export function parkEntry(entry: TerminalPoolEntry): void {
  if (entry.disposed || entry.ws?.readyState !== WebSocket.OPEN || !entry.hasData) {
    destroyEntry(entry);
    return;
  }
  entry.listener = null;
  entry.hostEl.remove();
  // Server discards paused output instead of streaming to a viewer nobody
  // sees; the adopter's resume triggers a full repaint to catch up.
  entry.ws.send(JSON.stringify({ type: 'pause' }));
  entry.parkTimer = setTimeout(() => destroyEntry(entry), POOL_TTL_MS);
  const existing = pool.get(entry.key);
  if (existing && existing !== entry) destroyEntry(existing);
  pool.set(entry.key, entry);
  while (pool.size > POOL_MAX) {
    // Map preserves insertion order — first value is the oldest parked.
    destroyEntry(pool.values().next().value!);
  }
}

/** Test-only: tear down everything parked. */
export function resetTerminalPool(): void {
  for (const entry of [...pool.values()]) destroyEntry(entry);
  pool.clear();
}
