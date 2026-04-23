import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerAddAgent } from './add-agent.js';
import type { OctomuxClient, Agent } from '../client.js';

function makeAgent(partial: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    task_id: 'task-1',
    window_index: 1,
    label: 'Agent 2',
    status: 'running',
    claude_session_id: null,
    hook_activity: '',
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

function makeClient(addAgent: OctomuxClient['addAgent']): OctomuxClient {
  const notImpl = () => {
    throw new Error('not implemented in test');
  };
  return {
    createTask: notImpl as never,
    listTasks: notImpl as never,
    getTask: notImpl as never,
    updateTask: notImpl as never,
    deleteTask: notImpl as never,
    addAgent,
    stopAgent: notImpl as never,
    sendMessage: notImpl as never,
    listSkills: notImpl as never,
    getSkill: notImpl as never,
    createSkill: notImpl as never,
    deleteSkill: notImpl as never,
    recentRepos: notImpl as never,
    defaultBranch: notImpl as never,
    getRepoConfig: notImpl as never,
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
  registerAddAgent(program);
  return program;
}

describe('add-agent command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('requires --task and --prompt', async () => {
    const addAgent = vi.fn(async () => makeAgent());
    const program = buildProgram(makeClient(addAgent));

    await expect(program.parseAsync(['add-agent'], { from: 'user' })).rejects.toThrow(
      /required option/,
    );
  });

  it('sends prompt only when --agent and --label are not passed', async () => {
    const addAgent = vi.fn(async () => makeAgent());
    const program = buildProgram(makeClient(addAgent));

    await program.parseAsync(['add-agent', '--task', 'task-1', '--prompt', 'do the thing'], {
      from: 'user',
    });

    expect(addAgent).toHaveBeenCalledWith('task-1', { prompt: 'do the thing' });
  });

  it('forwards --agent and --label when provided', async () => {
    const addAgent = vi.fn(async () => makeAgent({ label: 'Reviewer' }));
    const program = buildProgram(makeClient(addAgent));

    await program.parseAsync(
      [
        'add-agent',
        '--task',
        'task-1',
        '--prompt',
        'review the diff',
        '--agent',
        'code-reviewer',
        '--label',
        'Reviewer',
      ],
      { from: 'user' },
    );

    expect(addAgent).toHaveBeenCalledWith('task-1', {
      prompt: 'review the diff',
      agent: 'code-reviewer',
      label: 'Reviewer',
    });
  });
});
