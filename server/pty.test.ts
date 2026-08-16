/**
 * Runs under `bun test`, not vitest — the shim needs Bun.Terminal, which doesn't
 * exist in Node. The filename dodges vitest's `server/**\/*.test.ts` include.
 *
 *   bun test server/pty.bun-test.ts
 */

import { test, expect } from 'bun:test';
import { spawn } from './pty.js';

function collect(pty: ReturnType<typeof spawn>) {
  let out = '';
  pty.onData((d) => {
    out += d;
  });
  return () => out;
}

function exitOf(pty: ReturnType<typeof spawn>) {
  return new Promise<{ exitCode: number; signal?: number }>((resolve) => pty.onExit(resolve));
}

test('child sees a real tty and its output reaches onData', async () => {
  const pty = spawn('/bin/sh', ['-c', 'tty; echo done'], { cols: 80, rows: 24 });
  const read = collect(pty);
  const exit = await exitOf(pty);

  expect(exit.exitCode).toBe(0);
  expect(read()).toContain('/dev/');
  expect(read()).toContain('done');
});

test('output emitted before onData attaches is not dropped', async () => {
  const pty = spawn('/bin/sh', ['-c', 'echo early'], {});
  await Bun.sleep(200); // let the child write and exit before any listener exists
  const read = collect(pty);
  await exitOf(pty);

  expect(read()).toContain('early');
});

test('write() feeds stdin and TERM/size are propagated', async () => {
  const pty = spawn('/bin/sh', ['-c', 'read line; echo "got:$line term:$TERM cols:$(tput cols)"'], {
    cols: 100,
    rows: 40,
    name: 'xterm-256color',
  });
  const read = collect(pty);
  pty.write('hello\n');
  await exitOf(pty);

  expect(read()).toContain('got:hello');
  expect(read()).toContain('term:xterm-256color');
  expect(read()).toContain('cols:100');
});

test('resize() updates the tty winsize the child reads', async () => {
  // `read` blocks until we write, so the resize lands before tput queries the tty.
  const pty = spawn('/bin/sh', ['-c', 'read x; echo "cols:$(tput cols) rows:$(tput lines)"'], {
    cols: 80,
    rows: 24,
  });
  const read = collect(pty);
  await Bun.sleep(150);
  pty.resize(132, 50);
  pty.write('\n');
  await exitOf(pty);

  expect(read()).toContain('cols:132');
  expect(read()).toContain('rows:50');
});

// Bun.Terminal.resize() alone updates winsize without signalling, which leaves
// `tmux attach` showing the old geometry. This is the regression guard for the
// explicit SIGWINCH in resize().
test('resize() delivers SIGWINCH to the child', async () => {
  const pty = spawn(
    '/bin/sh',
    ['-c', 'trap "echo GOT-WINCH" WINCH; i=0; while [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done'],
    { cols: 80, rows: 24 },
  );
  const read = collect(pty);
  await Bun.sleep(300);
  pty.resize(132, 50);
  await Bun.sleep(500);
  pty.kill('SIGKILL');

  expect(read()).toContain('GOT-WINCH');
});

test('kill() terminates the child and reports the signal', async () => {
  const pty = spawn('/bin/sh', ['-c', 'sleep 30'], {});
  collect(pty);
  await Bun.sleep(150);
  pty.kill();
  const exit = await exitOf(pty);

  expect(exit.signal).toBe(1); // SIGHUP
});
