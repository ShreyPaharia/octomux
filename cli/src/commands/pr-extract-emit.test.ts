import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerPrExtractEmit } from './pr-extract-emit.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerPrExtractEmit(program);
  return program;
}

describe('pr-extract emit command', () => {
  const origBaseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
  const origToken = process.env.OCTOMUX_ACTION_TOKEN;

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-1';
  });

  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.OCTOMUX_ACTION_BASE_URL;
    else process.env.OCTOMUX_ACTION_BASE_URL = origBaseUrl;
    if (origToken === undefined) delete process.env.OCTOMUX_ACTION_TOKEN;
    else process.env.OCTOMUX_ACTION_TOKEN = origToken;
  });

  it('POSTs the extract payload with a bearer token', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '' });

    const program = buildProgram();
    await program.parseAsync(
      [
        'pr-extract',
        'emit',
        '--task',
        'task-1',
        '--area',
        'server',
        '--risk',
        'high',
        '--has-migration',
        'true',
        '--surface',
        'api',
        '--loc',
        '42',
      ],
      { from: 'user' },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7777/api/pr-extracts/task-1/emit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-1',
        }),
        body: JSON.stringify({
          area: 'server',
          risk: 'high',
          has_migration: true,
          surface: 'api',
          loc: 42,
        }),
      }),
    );
  });

  it('rejects a risk value not in the fixed enum', async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync(
        [
          'pr-extract',
          'emit',
          '--task',
          'task-1',
          '--area',
          'server',
          '--risk',
          'extreme',
          '--has-migration',
          'true',
          '--surface',
          'api',
          '--loc',
          '1',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exits with an error when OCTOMUX_ACTION_TOKEN is missing', async () => {
    delete process.env.OCTOMUX_ACTION_TOKEN;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(
      [
        'pr-extract',
        'emit',
        '--task',
        'task-1',
        '--area',
        'server',
        '--risk',
        'low',
        '--has-migration',
        'false',
        '--surface',
        'api',
        '--loc',
        '1',
      ],
      { from: 'user' },
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockFetch).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('reports a failed HTTP response and exits 1', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(
      [
        'pr-extract',
        'emit',
        '--task',
        'task-1',
        '--area',
        'server',
        '--risk',
        'low',
        '--has-migration',
        'false',
        '--surface',
        'api',
        '--loc',
        '1',
      ],
      { from: 'user' },
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
