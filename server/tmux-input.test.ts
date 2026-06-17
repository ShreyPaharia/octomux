import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const mockedExecFile = vi.mocked(execFile);

import { sendMessageToAgent, normalizePromptForPaste } from './tmux-input.js';

describe('normalizePromptForPaste', () => {
  it('leaves a plain prose prompt untouched (newlines preserved)', () => {
    const prompt = 'Fix the bug.\n\nIt is in the parser.';
    expect(normalizePromptForPaste(prompt)).toBe(prompt);
  });

  it('collapses a leading-slash command prompt to a single line', () => {
    // Claude Code parses a paste starting with "/" as a single-line slash
    // command and strips newlines — gluing tokens together. Pre-collapsing to
    // one line keeps the command name intact with inline args.
    const prompt = '/review-orchestrator\n\nReview task id: abc123\nPass --task abc123.';
    expect(normalizePromptForPaste(prompt)).toBe(
      '/review-orchestrator Review task id: abc123 Pass --task abc123.',
    );
  });

  it('collapses runs of whitespace for slash prompts', () => {
    expect(normalizePromptForPaste('/foo   \n   bar')).toBe('/foo bar');
  });

  it('treats leading whitespace before the slash as a slash command', () => {
    expect(normalizePromptForPaste('  /foo\nbar')).toBe('/foo bar');
  });

  it('returns empty string unchanged', () => {
    expect(normalizePromptForPaste('')).toBe('');
  });
});

describe('sendMessageToAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedExecFile.mockReset();
    // execFile is callback-style; promisify wraps it. The mock has to invoke
    // the callback synchronously to play well with promisify + fake timers.
    mockedExecFile.mockImplementation(((...args: any[]) => {
      // promisify may pass options as 3rd arg and callback as 4th; find callback from end
      for (let i = args.length - 1; i >= 0; i--) {
        if (typeof args[i] === 'function') {
          args[i](null, { stdout: '', stderr: '' });
          break;
        }
      }
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);
  });

  it('sends the message and Enter as two separate send-keys calls with a delay', async () => {
    const promise = sendMessageToAgent('octomux-agent-abc', 0, 'hello world');
    await vi.advanceTimersByTimeAsync(60);
    await promise;

    expect(mockedExecFile).toHaveBeenCalledTimes(2);

    // execTmux prepends '-S <sock>' to all tmux invocations; strip it for assertion
    function stripSocketPrefix(args: string[]): string[] {
      return args[0] === '-S' ? args.slice(2) : args;
    }

    const firstCall = mockedExecFile.mock.calls[0];
    expect(firstCall[0]).toBe('tmux');
    expect(stripSocketPrefix(firstCall[1] as string[])).toEqual([
      'send-keys',
      '-t',
      'octomux-agent-abc:0',
      '-l',
      'hello world',
    ]);

    const secondCall = mockedExecFile.mock.calls[1];
    expect(secondCall[0]).toBe('tmux');
    expect(stripSocketPrefix(secondCall[1] as string[])).toEqual([
      'send-keys',
      '-t',
      'octomux-agent-abc:0',
      'Enter',
    ]);
  });

  it('forwards multi-line messages literally (newlines stay inside the message arg)', async () => {
    const message = 'line one\nline two\nline three';
    const promise = sendMessageToAgent('s', 3, message);
    await vi.advanceTimersByTimeAsync(60);
    await promise;

    const args0 = mockedExecFile.mock.calls[0][1] as string[];
    const strippedArgs0 = args0[0] === '-S' ? args0.slice(2) : args0;
    expect(strippedArgs0).toEqual(['send-keys', '-t', 's:3', '-l', message]);
  });
});
