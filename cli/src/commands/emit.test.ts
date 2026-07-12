import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerEmit } from './emit.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerEmit(program);
  return program;
}

describe('emit command', () => {
  const origBaseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
  const origToken = process.env.OCTOMUX_ACTION_TOKEN;

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-agent';
  });

  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.OCTOMUX_ACTION_BASE_URL;
    else process.env.OCTOMUX_ACTION_BASE_URL = origBaseUrl;
    if (origToken === undefined) delete process.env.OCTOMUX_ACTION_TOKEN;
    else process.env.OCTOMUX_ACTION_TOKEN = origToken;
  });

  it('POSTs the emit payload with a bearer token from env', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'run-1', status: 'done' }),
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(
      ['emit', '--run', 'run-1', '--status', 'done', '--reason', 'all tests pass'],
      { from: 'user' },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7777/api/loops/run-1/emit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-agent',
        }),
        body: JSON.stringify({ status: 'done', reason: 'all tests pass' }),
      }),
    );
  });

  it('rejects a status not in the fixed enum', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(['emit', '--run', 'run-1', '--status', 'finished', '--reason', 'x'], {
        from: 'user',
      }),
    ).rejects.toThrow();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exits with an error when OCTOMUX_ACTION_TOKEN is missing', async () => {
    delete process.env.OCTOMUX_ACTION_TOKEN;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['emit', '--run', 'run-1', '--status', 'done', '--reason', 'x'], {
      from: 'user',
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockFetch).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
