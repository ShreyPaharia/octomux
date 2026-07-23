import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerLearningsDigest } from './learnings-digest.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerLearningsDigest(program);
  return program;
}

describe('learnings-digest command', () => {
  const origBaseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
  const origToken = process.env.OCTOMUX_ACTION_TOKEN;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-agent';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.OCTOMUX_ACTION_BASE_URL;
    else process.env.OCTOMUX_ACTION_BASE_URL = origBaseUrl;
    if (origToken === undefined) delete process.env.OCTOMUX_ACTION_TOKEN;
    else process.env.OCTOMUX_ACTION_TOKEN = origToken;
    logSpy.mockRestore();
  });

  it('GETs /api/learnings/digest with repo + sinceDays and prints the three-section markdown digest', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        additions: [
          { id: 'a1', trigger: 'flaky mock', lesson: 'use default: mocked', evidence: 'setup.ts' },
        ],
        unused: [
          { id: 'u1', trigger: 't', lesson: 'never used', created_at: '2026-07-01 00:00:00' },
        ],
        benefit: { seededN: 4, unseededN: 2, seededPassRate: 0.75, unseededPassRate: 0.5 },
      }),
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(['learnings-digest', '--repo', '/r', '--since', '14'], {
      from: 'user',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = mockFetch.mock.calls[0];
    const url = new URL(String(urlArg));
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:7777/api/learnings/digest');
    expect(url.searchParams.get('repo')).toBe('/r');
    expect(url.searchParams.get('sinceDays')).toBe('14');
    expect(initArg).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tok-agent' }),
      }),
    );

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('## Additions');
    expect(output).toContain('## Removal candidates');
    expect(output).toContain('## Benefit');
    expect(output).toContain('use default: mocked');
    expect(output).toContain('never used');
    expect(output).toContain('75%');
  });

  it('shows superseded rows under removal candidates', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        additions: [],
        unused: [],
        superseded: [
          {
            id: 's1',
            trigger: 't',
            lesson: 'old pattern no longer applies',
            evidence: null,
            usage_count: 3,
            created_at: '2026-07-01 00:00:00',
            superseded_reason: 'repo moved to bun',
          },
        ],
        benefit: { seededN: 0, unseededN: 0, seededPassRate: 0, unseededPassRate: 0 },
      }),
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(['learnings-digest', '--repo', '/r'], { from: 'user' });

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('## Removal candidates');
    expect(output).toContain('old pattern no longer applies');
    expect(output).toContain('repo moved to bun');
    expect(output).toContain('learn-forget');
  });

  it('defaults --since to 7 days when omitted', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        additions: [],
        unused: [],
        benefit: { seededN: 0, unseededN: 0, seededPassRate: 0, unseededPassRate: 0 },
      }),
      text: async () => '',
    });

    const program = buildProgram();
    await program.parseAsync(['learnings-digest', '--repo', '/r'], { from: 'user' });

    const [urlArg] = mockFetch.mock.calls[0];
    expect(new URL(String(urlArg)).searchParams.get('sinceDays')).toBe('7');
  });

  it('exits with an error when OCTOMUX_ACTION_TOKEN is missing', async () => {
    delete process.env.OCTOMUX_ACTION_TOKEN;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['learnings-digest', '--repo', '/r'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockFetch).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits with an error on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const program = buildProgram();
    await program.parseAsync(['learnings-digest', '--repo', '/r'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
