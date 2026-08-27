import { describe, it, expect } from '../bun-test.js';
import { createDeflateRaw, constants as zlibConstants } from 'zlib';
import {
  makeStreamFrameWriter,
  makeFlowControlledWrite,
  supportsDeflate,
  FLOW_CALLBACK_BYTES,
  FLOW_HIGH_WATER,
} from './terminal-frames';

/**
 * Produce the exact wire format the server's mode-2 sender emits: one shared
 * deflate context, one sync-flushed binary frame per send.
 */
async function makeFrames(texts: string[]): Promise<ArrayBuffer[]> {
  const deflate = createDeflateRaw();
  const frames: ArrayBuffer[] = [];
  let chunks: Buffer[] = [];
  deflate.on('data', (c: Buffer) => chunks.push(c));
  for (const text of texts) {
    await new Promise<void>((resolve) => {
      deflate.write(Buffer.from(text));
      deflate.flush(zlibConstants.Z_SYNC_FLUSH, () => {
        const buf = Buffer.concat(chunks);
        chunks = [];
        frames.push(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        resolve();
      });
    });
  }
  deflate.close();
  return frames;
}

const decode = (d: string | Uint8Array) =>
  typeof d === 'string' ? d : new TextDecoder().decode(d);

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('terminal-frames', () => {
  it('advertises deflate support when DecompressionStream exists', () => {
    expect(supportsDeflate).toBe(true);
  });

  it('inflates a stream of context-sharing frames in arrival order', async () => {
    const writes: string[] = [];
    const w = makeStreamFrameWriter((d) => writes.push(decode(d)));
    const frames = await makeFrames(['first repaint', 'second repaint', 'third']);
    for (const f of frames) w.onFrame(f);
    await waitFor(() => writes.join('').length >= 'first repaintsecond repaintthird'.length);
    // Chunk boundaries are the inflater's business; the byte stream must match.
    expect(writes.join('')).toBe('first repaintsecond repaintthird');
    w.dispose();
  });

  it('writes plain text frames synchronously (non-deflate server)', () => {
    const writes: string[] = [];
    const w = makeStreamFrameWriter((d) => writes.push(decode(d)));
    w.onFrame('abc');
    expect(writes).toEqual(['abc']);
    w.dispose();
  });

  it('ignores empty text frames (liveness pong)', () => {
    const writes: string[] = [];
    const w = makeStreamFrameWriter((d) => writes.push(decode(d)));
    w.onFrame('');
    expect(writes).toEqual([]);
    w.dispose();
  });

  it('reports a corrupt stream so the owner can replace the socket', async () => {
    const writes: string[] = [];
    let errored = 0;
    const w = makeStreamFrameWriter(
      (d) => writes.push(decode(d)),
      () => errored++,
    );
    w.onFrame(new Uint8Array([0xff, 0xff, 0xff, 0xff]).buffer); // invalid deflate
    await waitFor(() => errored > 0);
    expect(errored).toBe(1);
    w.dispose();
  });

  it('does not report a stream error caused by dispose itself', async () => {
    let errored = 0;
    const w = makeStreamFrameWriter(
      () => {},
      () => errored++,
    );
    const frames = await makeFrames(['content']);
    w.onFrame(frames[0]);
    await new Promise((r) => setTimeout(r, 20));
    w.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(errored).toBe(0);
  });

  it('sends pause when a flood passes the high watermark and resume once xterm drains', () => {
    const callbacks: (() => void)[] = [];
    const term = {
      write: (_d: string | Uint8Array, cb?: () => void) => {
        if (cb) callbacks.push(cb);
      },
    };
    const flow: string[] = [];
    const write = makeFlowControlledWrite(term, (s) => flow.push(s));

    // Flood: enough 100KB chunks to exceed the high watermark → one pause.
    const chunk = 'x'.repeat(FLOW_CALLBACK_BYTES);
    const n = Math.ceil(FLOW_HIGH_WATER / FLOW_CALLBACK_BYTES) + 1;
    for (let i = 0; i < n; i++) write(chunk);
    expect(flow).toEqual(['pause']);

    // xterm processes the backlog (completion callbacks fire) → one resume.
    for (const cb of callbacks) cb();
    expect(flow).toEqual(['pause', 'resume']);
  });

  it('attaches a write callback only every FLOW_CALLBACK_BYTES, not per chunk', () => {
    let withCallback = 0;
    const term = {
      write: (_d: string | Uint8Array, cb?: () => void) => {
        if (cb) withCallback++;
      },
    };
    const write = makeFlowControlledWrite(term, () => {});

    // 10 chunks summing to exactly FLOW_CALLBACK_BYTES → a single callback.
    const chunk = 'y'.repeat(FLOW_CALLBACK_BYTES / 10);
    for (let i = 0; i < 10; i++) write(chunk);
    expect(withCallback).toBe(1);
  });

  it('stops writing after dispose', async () => {
    const writes: string[] = [];
    const w = makeStreamFrameWriter((d) => writes.push(decode(d)));
    const frames = await makeFrames(['before close']);
    w.onFrame(frames[0]);
    await waitFor(() => writes.length > 0);
    w.dispose();
    // A late frame for the old socket must not throw or corrupt anything.
    w.onFrame(frames[0]);
    await new Promise((r) => setTimeout(r, 20));
    expect(writes.join('')).toBe('before close');
  });
});
