/**
 * node-pty-shaped PTY, backed by `Bun.Terminal`.
 *
 * Why not node-pty: it loads under Bun but never emits `data` or `exit` (its read
 * loop leans on Node internals Bun doesn't drive), and its `pty.node` addon can't
 * be embedded by `bun build --compile`. `Bun.Terminal` (Bun >= 1.3) is a real PTY
 * that survives compilation.
 *
 * The surface here is deliberately the subset of node-pty's `IPty` that octomux
 * actually uses — onData / onExit / write / resize / kill / pid — so call sites
 * change one import line and nothing else.
 */

import os from 'os';

export interface Pty {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface PtyOptions {
  /** TERM value for the child. Default 'xterm-256color'. */
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

function signalNumber(code: NodeJS.Signals | null): number | undefined {
  if (!code) return undefined;
  return (os.constants.signals as Record<string, number>)[code];
}

export function spawn(file: string, args: string[], opts: PtyOptions = {}): Pty {
  const name = opts.name ?? 'xterm-256color';
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;

  const dataListeners: ((data: string) => void)[] = [];
  const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  const decoder = new TextDecoder();

  // Callers attach onData/onExit *after* spawn() returns, but the PTY can emit —
  // and the child can exit — before that. Buffer both until a listener shows up.
  let buffered = '';
  let exitInfo: { exitCode: number; signal?: number } | null = null;

  const term = new Bun.Terminal({
    cols,
    rows,
    name,
    data(_t, chunk) {
      const text = decoder.decode(chunk, { stream: true });
      if (!text) return;
      if (dataListeners.length === 0) {
        buffered += text;
        return;
      }
      for (const cb of dataListeners) cb(text);
    },
  });

  const proc = Bun.spawn([file, ...args], {
    terminal: term,
    cwd: opts.cwd,
    env: { ...(opts.env ?? (process.env as Record<string, string>)), TERM: name },
  });

  let exited = false;
  void proc.exited.then((exitCode) => {
    exited = true;
    // Bun.Terminal's own `exit` callback reports PTY EOF status, not the child's
    // exit code — take the code from the subprocess.
    const info = { exitCode, signal: signalNumber(proc.signalCode) };
    term.close();
    if (exitListeners.length === 0) {
      exitInfo = info;
      return;
    }
    for (const cb of exitListeners) cb(info);
  });

  return {
    get pid() {
      return proc.pid;
    },

    onData(cb) {
      dataListeners.push(cb);
      if (buffered) {
        const pending = buffered;
        buffered = '';
        cb(pending);
      }
    },

    onExit(cb) {
      exitListeners.push(cb);
      if (exitInfo) cb(exitInfo);
    },

    write(data) {
      if (exited || term.closed) return;
      term.write(data);
    },

    resize(nextCols, nextRows) {
      if (exited || term.closed) return;
      term.resize(nextCols, nextRows);
      // Bun.Terminal.resize() updates the tty winsize but does not signal the
      // child, so `tmux attach` never reflows. Deliver SIGWINCH ourselves.
      // ponytail: signals the direct child only — Bun doesn't put it in its own
      // process group, so a non-exec'd grandchild would miss it. Every octomux
      // call site spawns `tmux attach` or `$SHELL -c <cmd>` (which execs), so the
      // pid is the foreground process. Revisit if a substrate spawns a wrapper.
      try {
        proc.kill('SIGWINCH');
      } catch {
        // child already gone
      }
    },

    // node-pty defaults to SIGHUP, which is also what detaches a `tmux attach`.
    kill(signal = 'SIGHUP') {
      if (exited) return;
      proc.kill(signal);
    },
  };
}
