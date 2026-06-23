import { describe, it, expect } from 'vitest';
import { ptySubstrate } from './substrate-pty.js';

const CWD = process.cwd();

describe('ptySubstrate', () => {
  it('collects output and exits with code 0', async () => {
    const handle = await ptySubstrate.spawn({
      command: `node -e "process.stdout.write('hello-substrate'); process.exit(0)"`,
      cwd: CWD,
    });

    const chunks: string[] = [];
    handle.onData((chunk) => chunks.push(chunk));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for exit')), 8000);
      handle.onExit(({ code }) => {
        clearTimeout(timer);
        try {
          expect(chunks.join('')).toContain('hello-substrate');
          expect(code).toBe(0);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    handle.dispose();
  }, 10_000);

  it('reports non-zero exit code', async () => {
    const handle = await ptySubstrate.spawn({
      command: `node -e "process.exit(3)"`,
      cwd: CWD,
    });

    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for exit')), 8000);
      handle.onExit(({ code: c }) => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    expect(code).toBe(3);
    handle.dispose();
  }, 10_000);

  it('echo round-trip: write to stdin, receive on stdout, then dispose', async () => {
    const handle = await ptySubstrate.spawn({
      command: 'cat',
      cwd: CWD,
    });

    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ping echo')), 8000);
      handle.onData((chunk) => {
        if (chunk.includes('ping')) {
          clearTimeout(timer);
          resolve(chunk);
        }
      });
      // Give the pty a tick to initialise before writing
      setImmediate(() => handle.write('ping\n'));
    });

    expect(received).toContain('ping');
    handle.dispose();
  }, 10_000);

  it('dispose is idempotent — calling twice does not throw', async () => {
    const handle = await ptySubstrate.spawn({
      command: 'cat',
      cwd: CWD,
    });

    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  }, 10_000);
});
