/**
 * Frame decoding for the terminal WebSocket.
 *
 * Bun's ws shim never negotiates permessage-deflate (the option is a silent
 * no-op server-side), so the server deflates large frames itself and sends
 * them as binary; small frames stay plain text. The client advertises support
 * with `?deflate=1` when DecompressionStream is available.
 */
export const supportsDeflate = typeof DecompressionStream === 'function';

export async function inflateFrame(buf: ArrayBuffer | Blob): Promise<Uint8Array> {
  const blob = buf instanceof Blob ? buf : new Blob([buf]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Returns a handler that writes incoming frames to the terminal in arrival
 * order. Inflation is async, so a promise chain preserves ordering; text
 * frames bypass the chain when nothing is pending, so keystroke echo never
 * waits on a repaint that is still inflating.
 */
export function makeFrameWriter(
  write: (data: string | Uint8Array) => void,
): (data: string | ArrayBuffer | Blob) => void {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const enqueue = (fn: () => unknown) => {
    pending++;
    // Each link swallows its own error, so `chain` is always resolved and a
    // corrupt frame can't wedge every frame after it.
    chain = chain
      .then(fn)
      .catch(() => {})
      .finally(() => {
        pending--;
      });
  };
  return (data) => {
    if (typeof data === 'string') {
      if (pending === 0) write(data);
      else enqueue(() => write(data));
      return;
    }
    enqueue(async () => write(await inflateFrame(data)));
  };
}
