import { describe, it, expect } from '../bun-test.js';
import { deflateRawSync } from 'zlib';
import { inflateFrame, makeFrameWriter, supportsDeflate } from './terminal-frames';

function deflated(text: string): ArrayBuffer {
  const buf = deflateRawSync(Buffer.from(text));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const decode = (d: string | Uint8Array) =>
  typeof d === 'string' ? d : new TextDecoder().decode(d);

// Inflation latency varies wildly under a loaded parallel test run — poll for
// the expected write count instead of sleeping a fixed interval.
async function waitForWrites(writes: unknown[], count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (writes.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('terminal-frames', () => {
  it('advertises deflate support when DecompressionStream exists', () => {
    expect(supportsDeflate).toBe(true);
  });

  it('inflateFrame round-trips deflate-raw payloads', async () => {
    const out = await inflateFrame(deflated('hello \x1b[31mworld\x1b[0m'));
    expect(new TextDecoder().decode(out)).toBe('hello \x1b[31mworld\x1b[0m');
  });

  it('writes text frames synchronously when nothing is pending', () => {
    const writes: (string | Uint8Array)[] = [];
    const onFrame = makeFrameWriter((d) => writes.push(d));
    onFrame('abc');
    expect(writes).toEqual(['abc']); // no await needed — keystroke echo is sync
  });

  it('preserves arrival order when a text frame lands behind an inflating binary frame', async () => {
    const writes: string[] = [];
    const onFrame = makeFrameWriter((d) => writes.push(decode(d)));
    onFrame(deflated('big repaint'));
    onFrame('typed');
    await waitForWrites(writes, 2);
    expect(writes).toEqual(['big repaint', 'typed']);
  });

  it('keeps ordering across multiple binary frames', async () => {
    const writes: string[] = [];
    const onFrame = makeFrameWriter((d) => writes.push(decode(d)));
    onFrame(deflated('one'));
    onFrame(deflated('two'));
    onFrame('three');
    onFrame(deflated('four'));
    await waitForWrites(writes, 4);
    expect(writes).toEqual(['one', 'two', 'three', 'four']);
  });

  it('a corrupt binary frame does not wedge later frames', async () => {
    const writes: string[] = [];
    const onFrame = makeFrameWriter((d) => writes.push(decode(d)));
    onFrame(new Uint8Array([1, 2, 3]).buffer); // not a valid deflate stream
    onFrame('after');
    await waitForWrites(writes, 1);
    expect(writes).toEqual(['after']);
  });
});
