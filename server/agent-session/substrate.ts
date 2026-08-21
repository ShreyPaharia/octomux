export interface SpawnOptions {
  command: string; // full shell command line to run
  cwd: string;
  env?: Record<string, string>;
  cols?: number; // default 120
  rows?: number; // default 30
}

export interface ProcessHandle {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (info: { code: number; signal?: number }) => void): void;
  dispose(): void; // idempotent terminate + free
  /**
   * Live pty resize, for an interactive attach (xterm.js). Optional because
   * only a pty-backed handle can honour it — a non-interactive substrate
   * simply has nothing to resize.
   */
  resize?(cols: number, rows: number): void;
}

export interface ProcessSubstrate {
  readonly kind: 'pty' | 'tmux';
  spawn(opts: SpawnOptions): Promise<ProcessHandle>;
}

export type { TmuxWindowLaunchOptions, TmuxWindowSubstrate } from './substrate-tmux-windowed.js';
