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
}

export interface ProcessSubstrate {
  readonly kind: 'pty' | 'tmux';
  spawn(opts: SpawnOptions): Promise<ProcessHandle>;
}
