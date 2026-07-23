import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerRecall } from './recall.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerRecall(program);
  return program;
}

describe('recall command', () => {
  const origBaseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
  const origToken = process.env.OCTOMUX_ACTION_TOKEN;
  const origTaskId = process.env.OCTOMUX_TASK_ID;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-agent';
    process.env.OCTOMUX_TASK_ID = 'task-1';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.OCTOMUX_ACTION_BASE_URL;
    else process.env.OCTOMUX_ACTION_BASE_URL = origBaseUrl;
    if (origToken === undefined) delete process.env.OCTOMUX_ACTION_TOKEN;
    else process.env.OCTOMUX_ACTION_TOKEN = origToken;
    if (origTaskId === undefined) delete process.env.OCTOMUX_TASK_ID;
    else process.env.OCTOMUX_TASK_ID = origTaskId;
    logSpy.mockRestore();
  });

  it('GETs /api/learnings with taskId + query and a bearer token', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: 'l1', lesson: 'use default: mocked', evidence: 'setup.ts' }],
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(['recall', '--query', 'fs mock'], { from: 'user' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = mockFetch.mock.calls[0];
    const url = new URL(String(urlArg));
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:7777/api/learnings');
    expect(url.searchParams.get('taskId')).toBe('task-1');
    expect(url.searchParams.get('query')).toBe('fs mock');
    expect(initArg).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tok-agent' }),
      }),
    );
  });

  it('prints each row with its id so the agent can unlearn it later', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: 'l1', lesson: 'use default: mocked', evidence: 'setup.ts' }],
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(['recall', '--query', 'fs mock'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('[l1] use default: mocked (setup.ts)');
  });

  it('exits with an error when OCTOMUX_TASK_ID is missing', async () => {
    delete process.env.OCTOMUX_TASK_ID;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['recall', '--query', 'x'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockFetch).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with an error on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['recall', '--query', 'x'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
