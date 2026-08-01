import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerUnlearn } from './unlearn.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerUnlearn(program);
  return program;
}

describe('unlearn command', () => {
  const origBaseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
  const origToken = process.env.OCTOMUX_ACTION_TOKEN;
  const origTaskId = process.env.OCTOMUX_TASK_ID;

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-agent';
    process.env.OCTOMUX_TASK_ID = 'task-1';
  });

  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.OCTOMUX_ACTION_BASE_URL;
    else process.env.OCTOMUX_ACTION_BASE_URL = origBaseUrl;
    if (origToken === undefined) delete process.env.OCTOMUX_ACTION_TOKEN;
    else process.env.OCTOMUX_ACTION_TOKEN = origToken;
    if (origTaskId === undefined) delete process.env.OCTOMUX_TASK_ID;
    else process.env.OCTOMUX_TASK_ID = origTaskId;
  });

  it('POSTs to /api/learnings/:id/supersede with taskId from env, the reason, and a bearer token', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'l1' }),
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(['unlearn', 'l1', '--reason', 'repo moved to bun'], {
      from: 'user',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7777/api/learnings/l1/supersede',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-agent',
        }),
        body: JSON.stringify({ taskId: 'task-1', reason: 'repo moved to bun' }),
      }),
    );
  });

  it('rejects a missing --reason', async () => {
    const program = buildProgram();
    await expect(program.parseAsync(['unlearn', 'l1'], { from: 'user' })).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exits with an error when OCTOMUX_TASK_ID is missing', async () => {
    delete process.env.OCTOMUX_TASK_ID;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['unlearn', 'l1', '--reason', 'x'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockFetch).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with an error on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['unlearn', 'l1', '--reason', 'x'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
