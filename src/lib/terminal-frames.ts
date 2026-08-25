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

export function makeStreamFrameWriter(write: (data: string | Uint8Array) => void): FrameWriter {
  let writer: WritableStreamDefaultWriter<BufferSource> | null = null;

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
        // Stream aborted (dispose) or corrupt input — a fresh socket brings a
        // fresh stream, and the watchdog replaces a dead one.
      }
    })();
    return w;
  };

  let disposed = false;
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
