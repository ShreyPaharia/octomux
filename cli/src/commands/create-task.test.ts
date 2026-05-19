import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { resolveForkFrom, registerCreateTask } from './create-task.js';
import type { OctomuxClient, Task } from '../client.js';

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: 'abc123',
    title: 'source',
    description: 'desc',
    status: 'running',
    repo_path: '/repo/src',
    branch: 'agents/abc123',
    base_branch: 'main',
    worktree: '/repo/src/.worktrees/abc123',
    pr_url: null,
    pr_number: null,
    initial_prompt: null,
    run_mode: 'new',
    base_sha: null,
    last_viewed_at: null,
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

function makeClient(overrides: Partial<OctomuxClient> = {}): OctomuxClient {
  const notImpl = () => {
    throw new Error('not implemented in test');
  };
  return {
    createTask: vi.fn(async () => makeTask({ id: 'new-id' })),
    listTasks: notImpl as never,
    getTask: vi.fn(async () => makeTask()),
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
    getRepoConfig: vi.fn(async () => ({
      repo_path: '/repo/src',
      base_branch: null,
      test_command: '',
      format_command: '',
      lint_command: '',
    })),
    ...overrides,
  } as OctomuxClient;
}

describe('resolveForkFrom', () => {
  it('expands fork-from to agents/<id> and inherits repo_path from source', async () => {
    const source = makeTask();
    const client = makeClient({ getTask: vi.fn(async () => source) });
    const git = vi.fn(async () => ({ stdout: '' }));

    const res = await resolveForkFrom(client, 'abc123', undefined, git);

    expect(res.baseBranch).toBe('agents/abc123');
    expect(res.repoPath).toBe('/repo/src');
    expect(res.warnings).toEqual([]);
  });

  it('prefers explicit repo_path over source.repo_path', async () => {
    const client = makeClient({ getTask: vi.fn(async () => makeTask()) });
    const git = vi.fn(async () => ({ stdout: '' }));

    const res = await resolveForkFrom(client, 'abc123', '/other/repo', git);

    expect(res.repoPath).toBe('/other/repo');
  });

  it.each([
    ['draft status', { status: 'draft' }],
    ['scratch run_mode', { run_mode: 'scratch' as const }],
    ['none run_mode', { run_mode: 'none' as const }],
    ['existing run_mode', { run_mode: 'existing' as const }],
  ])('refuses to fork from %s', async (_name, overrides) => {
    const client = makeClient({ getTask: vi.fn(async () => makeTask(overrides as Partial<Task>)) });
    const git = vi.fn(async () => ({ stdout: '' }));

    await expect(resolveForkFrom(client, 'abc123', undefined, git)).rejects.toThrow(
      /cannot fork from abc123: source has no/,
    );
  });

  it('refuses when source task not found', async () => {
    const client = makeClient({
      getTask: vi.fn(async () => {
        throw new Error('Task not found');
      }),
    });
    const git = vi.fn(async () => ({ stdout: '' }));

    await expect(resolveForkFrom(client, 'missing', undefined, git)).rejects.toThrow(
      /cannot fork from missing: source not found/,
    );
  });

  it('emits a warning when source worktree is dirty', async () => {
    const client = makeClient({ getTask: vi.fn(async () => makeTask()) });
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'status') return { stdout: ' M server/api.ts\n' };
      if (args[0] === 'rev-parse') return { stdout: '1a2b3c4\n' };
      return { stdout: '' };
    });

    const res = await resolveForkFrom(client, 'abc123', undefined, git);

    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('abc123');
    expect(res.warnings[0]).toContain('1a2b3c4');
    expect(res.warnings[0]).toContain('uncommitted changes');
  });

  it('emits no warning when source worktree is clean', async () => {
    const client = makeClient({ getTask: vi.fn(async () => makeTask()) });
    const git = vi.fn(async () => ({ stdout: '' }));

    const res = await resolveForkFrom(client, 'abc123', undefined, git);

    expect(res.warnings).toEqual([]);
  });
});

// ─── Integration: exercising registerCreateTask via commander ─────────────────

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
  registerCreateTask(program);
  return program;
}

describe('create-task command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('errors when --fork-from and --base-branch are both supplied', async () => {
    const client = makeClient();
    const program = buildProgram(client);

    await expect(
      program.parseAsync(
        [
          'create-task',
          '--title',
          't',
          '--description',
          'd',
          '--fork-from',
          'abc123',
          '--base-branch',
          'main',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('passes base_branch=agents/<id> and inherited repo_path when forking', async () => {
    const source = makeTask();
    const createTask = vi.fn(async () => makeTask({ id: 'new-id' }));
    const client = makeClient({
      getTask: vi.fn(async () => source),
      createTask,
    });
    const program = buildProgram(client);

    await program.parseAsync(
      ['create-task', '--title', 't', '--description', 'd', '--fork-from', 'abc123'],
      { from: 'user' },
    );

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        base_branch: 'agents/abc123',
        repo_path: '/repo/src',
      }),
    );
  });

  it('forwards --harness as harness_id when provided', async () => {
    const createTask = vi.fn(async () => makeTask({ id: 'cursor-task' }));
    const client = makeClient({ createTask });
    const program = buildProgram(client);

    await program.parseAsync(
      [
        'create-task',
        '--title',
        't',
        '--description',
        'd',
        '--mode',
        'scratch',
        '--harness',
        'cursor',
      ],
      { from: 'user' },
    );

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ harness_id: 'cursor' }));
  });

  it('omits harness_id when --harness is not provided', async () => {
    const createTask = vi.fn(async () => makeTask({ id: 'default-task' }));
    const client = makeClient({ createTask });
    const program = buildProgram(client);

    await program.parseAsync(
      ['create-task', '--title', 't', '--description', 'd', '--mode', 'scratch'],
      { from: 'user' },
    );

    const args = createTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('harness_id');
  });
});
