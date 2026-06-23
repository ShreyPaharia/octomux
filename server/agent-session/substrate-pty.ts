import { spawn as ptySpawn, type IPty } from 'node-pty';
import { childLogger } from '../logger.js';
import type { ProcessHandle, ProcessSubstrate, SpawnOptions } from './substrate.js';

const logger = childLogger('agent-session/substrate-pty');

function makeHandle(pty: IPty): ProcessHandle {
  let disposed = false;
  let exited = false;

  pty.onExit(() => {
    exited = true;
  });

  return {
    write(data: string): void {
      if (disposed || exited) return;
      try {
        pty.write(data);
      } catch {
        // PTY already exited
      }
    },

    onData(cb: (chunk: string) => void): void {
      pty.onData(cb);
    },

    onExit(cb: (info: { code: number; signal?: number }) => void): void {
      pty.onExit(({ exitCode, signal }) => {
        cb({ code: exitCode, signal: signal as number | undefined });
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (!exited) {
        try {
          pty.kill();
        } catch {
          // already dead
        }
      }
    },
  };
}

export const ptySubstrate: ProcessSubstrate = {
  kind: 'pty',

  async spawn(opts: SpawnOptions): Promise<ProcessHandle> {
    const shell = process.env.SHELL || '/bin/sh';
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 30;

    logger.debug({ command: opts.command, cwd: opts.cwd, cols, rows }, 'spawning pty process');

    const pty = ptySpawn(shell, ['-c', opts.command], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    });

    return makeHandle(pty);
  },
};
