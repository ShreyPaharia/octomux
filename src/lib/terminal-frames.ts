/**
 * Frame decoding for the terminal WebSocket.
 *
 * Bun's ws shim never negotiates permessage-deflate (the option is a silent
 * no-op server-side), so compression is app-level: the client advertises
 * `?deflate=2` when DecompressionStream is available, and the server then
 * sends every output frame as binary, deflated through one per-connection
 * zlib context with takeover (consecutive TUI repaints are near-identical, so
 * each frame costs a percent or two of its raw size). Binary frames are fed
 * into a single DecompressionStream in arrival order; the only text frames a
 * deflating server sends are empty liveness pongs, and a non-deflating server
 * sends only text — so the two paths never interleave and ordering holds.
 */
export const supportsDeflate = typeof DecompressionStream === 'function';

export interface FrameWriter {
  onFrame(data: string | ArrayBuffer): void;
  dispose(): void;
}

// ─── xterm write flow control ────────────────────────────────────────────────
// Per the xterm.js flow-control guide: unbounded term.write() during an output
// flood overruns xterm's parse buffer and starves input handling. Count bytes
// written vs processed — attaching a write-completion callback only every
// FLOW_CALLBACK_BYTES, not per chunk — and tell the server to stop forwarding
// pty output past the high watermark, resuming once xterm drains below the
// low one. FLOW_HIGH_WATER > FLOW_CALLBACK_BYTES guarantees a callback is
// always outstanding while paused, so the resume can never be missed.
export const FLOW_CALLBACK_BYTES = 100_000;
export const FLOW_HIGH_WATER = 400_000;
export const FLOW_LOW_WATER = 100_000;

export function makeFlowControlledWrite(
  term: { write(data: string | Uint8Array, callback?: () => void): void },
  sendFlow: (state: 'pause' | 'resume') => void,
): (data: string | Uint8Array) => void {
  let written = 0;
  let processed = 0;
  let sinceCallback = 0;
  let pausedByFlow = false;
  return (data) => {
    written += data.length;
    sinceCallback += data.length;
    if (sinceCallback >= FLOW_CALLBACK_BYTES) {
      sinceCallback = 0;
      const mark = written;
      term.write(data, () => {
        processed = mark;
        if (pausedByFlow && written - processed <= FLOW_LOW_WATER) {
          pausedByFlow = false;
          sendFlow('resume');
        }
      });
    } else {
      term.write(data);
    }
    if (!pausedByFlow && written - processed > FLOW_HIGH_WATER) {
      pausedByFlow = true;
      sendFlow('pause');
    }
  };
}

export function makeStreamFrameWriter(
  write: (data: string | Uint8Array) => void,
  onStreamError?: () => void,
): FrameWriter {
  let writer: WritableStreamDefaultWriter<BufferSource> | null = null;
  let disposed = false;

  const ensureStream = (): WritableStreamDefaultWriter<BufferSource> => {
    if (writer) return writer;
    const ds = new DecompressionStream('deflate-raw');
    const w: WritableStreamDefaultWriter<BufferSource> = ds.writable.getWriter();
    writer = w;
    void (async () => {
      const reader = ds.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) write(value);
        }
      } catch {
        // Corrupt input kills the stream permanently, and the liveness
        // watchdog can't see it — raw ws frames still arrive, only decoding
        // stopped. Surface it so the owner replaces the socket (a fresh
        // socket brings a fresh deflate context on both ends).
        if (!disposed) onStreamError?.();
      }
    })();
    return w;
  };

  return {
    onFrame(data) {
      if (disposed) return; // late frame for a replaced socket
      if (typeof data === 'string') {
        if (data) write(data);
        return;
      }
      // write() promises resolve in call order, so frames stay FIFO.
      void ensureStream()
        .write(new Uint8Array(data))
        .catch(() => {});
    },
    dispose() {
      disposed = true;
      void writer?.close().catch(() => {});
      writer = null;
    },
  };
}
