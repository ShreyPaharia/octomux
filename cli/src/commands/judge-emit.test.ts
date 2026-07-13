import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerJudgeEmit } from './judge-emit.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerJudgeEmit(program);
  return program;
}

describe('judge-emit command', () => {
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

  it('POSTs the judge-emit payload with a bearer token from env', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'group-1', judge_status: 'done' }),
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(
      ['judge-emit', '--group', 'group-1', '--winner', 'run-a', '--rationale', 'cleaner diff'],
      { from: 'user' },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7777/api/loop-groups/group-1/judge/emit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-agent',
        }),
        body: JSON.stringify({ winnerLoopRunId: 'run-a', rationale: 'cleaner diff' }),
      }),
    );
  });

  it('exits with an error when OCTOMUX_ACTION_TOKEN is missing', async () => {
    delete process.env.OCTOMUX_ACTION_TOKEN;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(
      ['judge-emit', '--group', 'group-1', '--winner', 'run-a', '--rationale', 'x'],
      { from: 'user' },
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockFetch).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with an error on a non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'winnerLoopRunId is not a candidate in this group',
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(
      ['judge-emit', '--group', 'group-1', '--winner', 'not-a-member', '--rationale', 'x'],
      { from: 'user' },
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
