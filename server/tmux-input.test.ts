import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const mockedExecFile = vi.mocked(execFile);

import { sendMessageToAgent } from './tmux-input.js';

describe('sendMessageToAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedExecFile.mockReset();
    // execFile is callback-style; promisify wraps it. The mock has to invoke
    // the callback synchronously to play well with promisify + fake timers.
    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], cb: any) => {
      cb(null, { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);
  });

  it('sends the message and Enter as two separate send-keys calls with a delay', async () => {
    const promise = sendMessageToAgent('octomux-agent-abc', 0, 'hello world');
    await vi.advanceTimersByTimeAsync(60);
    await promise;

    expect(mockedExecFile).toHaveBeenCalledTimes(2);

    const firstCall = mockedExecFile.mock.calls[0];
    expect(firstCall[0]).toBe('tmux');
    expect(firstCall[1]).toEqual(['send-keys', '-t', 'octomux-agent-abc:0', '-l', 'hello world']);

    const secondCall = mockedExecFile.mock.calls[1];
    expect(secondCall[0]).toBe('tmux');
    expect(secondCall[1]).toEqual(['send-keys', '-t', 'octomux-agent-abc:0', 'Enter']);
  });

  it('forwards multi-line messages literally (newlines stay inside the message arg)', async () => {
    const message = 'line one\nline two\nline three';
    const promise = sendMessageToAgent('s', 3, message);
    await vi.advanceTimersByTimeAsync(60);
    await promise;

    expect(mockedExecFile.mock.calls[0][1]).toEqual(['send-keys', '-t', 's:3', '-l', message]);
  });
});
