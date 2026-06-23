// NOTE: opts.env only applies to the attach pty process; the tmux session itself
// inherits the server's environment. Per-session env injection is out of scope (YAGNI).

import { spawn as ptySpawn, type IPty } from 'node-pty';
import { nanoid } from 'nanoid';
import { execTmux, tmuxSpawnSpec } from '../tmux-bin.js';
import { childLogger } from '../logger.js';
import type { ProcessHandle, ProcessSubstrate, SpawnOptions } from './substrate.js';

const logger = childLogger('agent-session/substrate-tmux');

function makeHandle(pty: IPty, session: string): ProcessHandle {
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
      execTmux(['kill-session', '-t', session]).catch(() => {});
    },
  };
}

export const tmuxSubstrate: ProcessSubstrate = {
  kind: 'tmux',

  async spawn(opts: SpawnOptions): Promise<ProcessHandle> {
    const session = 'octomux-as-' + nanoid(8);
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 30;

    logger.debug(
      { command: opts.command, cwd: opts.cwd, session, cols, rows },
      'spawning tmux session',
    );

    await execTmux(['new-session', '-d', '-s', session, '-c', opts.cwd, opts.command]);
    await execTmux(['set-option', '-t', session, 'aggressive-resize', 'on']).catch(() => {});

    const spec = tmuxSpawnSpec(['attach-session', '-t', session]);
    const pty = ptySpawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: { ...spec.env, ...(opts.env ?? {}) } as Record<string, string>,
    });

    return makeHandle(pty, session);
  },
};
