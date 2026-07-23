import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerLearn } from './learn.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerLearn(program);
  return program;
}

describe('learn command', () => {
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

  it('POSTs the learning payload with taskId from env and a bearer token', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'l1' }),
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(
      [
        'learn',
        '--trigger',
        'flaky fs mock',
        '--lesson',
        'use default: mocked',
        '--evidence',
        'setup.ts',
        '--private',
      ],
      { from: 'user' },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7777/api/learnings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-agent',
        }),
        body: JSON.stringify({
          taskId: 'task-1',
          trigger: 'flaky fs mock',
          lesson: 'use default: mocked',
          evidence: 'setup.ts',
          private: true,
        }),
      }),
    );
  });

  it('defaults private to false when the flag is omitted', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({}),
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(['learn', '--trigger', 't', '--lesson', 'l', '--evidence', 'e'], {
      from: 'user',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({
          taskId: 'task-1',
          trigger: 't',
          lesson: 'l',
          evidence: 'e',
          private: false,
        }),
      }),
    );
  });

  it('rejects a missing --lesson', async () => {
    const program = buildProgram();
    await expect(
      program.parseAsync(['learn', '--trigger', 't', '--evidence', 'e'], { from: 'user' }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exits with an error when OCTOMUX_TASK_ID is missing', async () => {
    delete process.env.OCTOMUX_TASK_ID;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['learn', '--trigger', 't', '--lesson', 'l', '--evidence', 'e'], {
      from: 'user',
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockFetch).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with an error on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 422, text: async () => 'rejected' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['learn', '--trigger', 't', '--lesson', 'l', '--evidence', 'e'], {
      from: 'user',
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
