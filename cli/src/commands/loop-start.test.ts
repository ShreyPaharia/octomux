import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { registerLoopStart } from './loop-start.js';
import type { OctomuxClient } from '../client.js';

function makeClient(startLoop: OctomuxClient['startLoop']): OctomuxClient {
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
    recentRepos: notImpl as never,
    defaultBranch: notImpl as never,
    getRepoConfig: notImpl as never,
    startLoop,
  } as OctomuxClient;
}

function buildProgram(client: OctomuxClient): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json');
  program.hook('preAction', (thisCommand) => {
    thisCommand.setOptionValue('_client', client);
  });
  registerLoopStart(program);
  return program;
}

function makeRun(overrides: Partial<{ id: string; task_id: string; status: string }> = {}) {
  return {
    id: 'run-1',
    task_id: 't1',
    status: 'running',
    iteration: 0,
    max_iterations: 5,
    termination_reason: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('loop-start command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('starts a loop with the given spec', async () => {
    const startLoop = vi.fn(async () => makeRun());
    const program = buildProgram(makeClient(startLoop));

    await program.parseAsync(
      [
        'loop-start',
        '--task',
        't1',
        '--prompt',
        'fix the bug',
        '--verify',
        'bun run test',
        '--max-iterations',
        '5',
      ],
      { from: 'user' },
    );

    expect(startLoop).toHaveBeenCalledWith({
      taskId: 't1',
      spec: { prompt: 'fix the bug', verify: 'bun run test', maxIterations: 5 },
    });
  });

  it('reads the prompt from a file when prefixed with @', async () => {
    const startLoop = vi.fn(async () => makeRun());
    const program = buildProgram(makeClient(startLoop));

    const tmpFile = path.join(os.tmpdir(), `loop-prompt-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'prompt from a file');
    try {
      await program.parseAsync(
        [
          'loop-start',
          '--task',
          't1',
          '--prompt',
          `@${tmpFile}`,
          '--verify',
          'true',
          '--max-iterations',
          '3',
        ],
        { from: 'user' },
      );

      expect(startLoop).toHaveBeenCalledWith({
        taskId: 't1',
        spec: { prompt: 'prompt from a file', verify: 'true', maxIterations: 3 },
      });
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('maps --budget-tokens and --stall-after into spec.budget/noProgress', async () => {
    const startLoop = vi.fn(async () => makeRun());
    const program = buildProgram(makeClient(startLoop));

    await program.parseAsync(
      [
        'loop-start',
        '--task',
        't1',
        '--prompt',
        'x',
        '--verify',
        'y',
        '--max-iterations',
        '5',
        '--budget-tokens',
        '100000',
        '--stall-after',
        '3',
      ],
      { from: 'user' },
    );

    expect(startLoop).toHaveBeenCalledWith({
      taskId: 't1',
      spec: {
        prompt: 'x',
        verify: 'y',
        maxIterations: 5,
        budget: { tokens: 100000 },
        noProgress: { afterIters: 3 },
      },
    });
  });
});
