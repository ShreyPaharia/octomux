import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import { Command } from 'commander';
import { registerPostReview } from './post-review.js';
import type { InlineCommentRow, OctomuxClient } from '../client.js';

function makeRow(partial: Partial<InlineCommentRow> = {}): InlineCommentRow {
  return {
    id: 'cid-01',
    task_id: 'task-1',
    agent_id: null,
    file_path: 'src/foo.ts',
    line: 1,
    side: 'new',
    original_commit_sha: 'sha',
    body: 'x',
    created_at: '2026-01-01T00:00:00Z',
    resolved_at: null,
    ...partial,
  };
}

function makeClient(postComment: OctomuxClient['postComment']): OctomuxClient {
  const notImpl = () => {
    throw new Error('not implemented in test');
  };
  return {
    createTask: notImpl as never,
    listTasks: notImpl as never,
    getTask: notImpl as never,
    updateTask: notImpl as never,
    deleteTask: notImpl as never,
    addAgent: notImpl as never,
    stopAgent: notImpl as never,
    sendMessage: notImpl as never,
    listSkills: notImpl as never,
    getSkill: notImpl as never,
    createSkill: notImpl as never,
    deleteSkill: notImpl as never,
    recentRepos: notImpl as never,
    defaultBranch: notImpl as never,
    getRepoConfig: notImpl as never,
    postComment,
    listComments: notImpl as never,
    updateComment: notImpl as never,
    deleteComment: notImpl as never,
  } as OctomuxClient;
}

function buildProgram(client: OctomuxClient): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  program.option('--json');
  program.hook('preAction', (thisCommand) => {
    thisCommand.setOptionValue('_client', client);
  });
  registerPostReview(program);
  return program;
}

describe('post-review command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const origStdin = process.stdin;
  const origAgentEnv = process.env.OCTOMUX_AGENT_ID;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    if (origAgentEnv === undefined) delete process.env.OCTOMUX_AGENT_ID;
    else process.env.OCTOMUX_AGENT_ID = origAgentEnv;
  });

  it('posts a comment with explicit args', async () => {
    const postComment = vi.fn(async () => makeRow());
    const program = buildProgram(makeClient(postComment));

    await program.parseAsync(
      [
        'post-review',
        '--task',
        'task-1',
        '--file',
        'src/foo.ts',
        '--line',
        '5',
        '--body',
        'nit: rename',
      ],
      { from: 'user' },
    );

    expect(postComment).toHaveBeenCalledWith('task-1', {
      file_path: 'src/foo.ts',
      line: 5,
      side: 'new',
      body: 'nit: rename',
    });
  });

  it("rejects --side other than 'old' or 'new'", async () => {
    const program = buildProgram(makeClient(vi.fn(async () => makeRow())));

    await expect(
      program.parseAsync(
        [
          'post-review',
          '--task',
          't',
          '--file',
          'a.ts',
          '--line',
          '1',
          '--body',
          'x',
          '--side',
          'middle',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow();
  });

  it('rejects non-integer --line', async () => {
    const program = buildProgram(makeClient(vi.fn(async () => makeRow())));

    await expect(
      program.parseAsync(
        ['post-review', '--task', 't', '--file', 'a.ts', '--line', 'abc', '--body', 'x'],
        { from: 'user' },
      ),
    ).rejects.toThrow(/positive integer/);
  });

  it('reads body from stdin when --body -', async () => {
    const fakeStdin = Readable.from(['line one\n', 'line two\n']);
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const postComment = vi.fn(async () => makeRow());
    const program = buildProgram(makeClient(postComment));

    await program.parseAsync(
      ['post-review', '--task', 't', '--file', 'a.ts', '--line', '1', '--body', '-'],
      { from: 'user' },
    );

    expect(postComment).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ body: 'line one\nline two\n' }),
    );
  });

  it('falls back to OCTOMUX_AGENT_ID env var', async () => {
    process.env.OCTOMUX_AGENT_ID = 'env-agent';
    const postComment = vi.fn(async () => makeRow({ agent_id: 'env-agent' }));
    const program = buildProgram(makeClient(postComment));

    await program.parseAsync(
      ['post-review', '--task', 't', '--file', 'a.ts', '--line', '1', '--body', 'x'],
      { from: 'user' },
    );

    expect(postComment).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ agent_id: 'env-agent' }),
    );
  });

  it('explicit --agent overrides env var', async () => {
    process.env.OCTOMUX_AGENT_ID = 'env-agent';
    const postComment = vi.fn(async () => makeRow({ agent_id: 'flag-agent' }));
    const program = buildProgram(makeClient(postComment));

    await program.parseAsync(
      [
        'post-review',
        '--task',
        't',
        '--file',
        'a.ts',
        '--line',
        '1',
        '--body',
        'x',
        '--agent',
        'flag-agent',
      ],
      { from: 'user' },
    );

    expect(postComment).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ agent_id: 'flag-agent' }),
    );
  });
});
