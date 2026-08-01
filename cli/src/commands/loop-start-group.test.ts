import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerLoopStartGroup } from './loop-start-group.js';
import type { OctomuxClient, LoopGroupResult } from '../client.js';

function makeClient(startLoopGroup: OctomuxClient['startLoopGroup']): OctomuxClient {
  return { startLoopGroup } as OctomuxClient;
}

function buildProgram(client: OctomuxClient): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json');
  program.hook('preAction', (thisCommand) => {
    thisCommand.setOptionValue('_client', client);
  });
  registerLoopStartGroup(program);
  return program;
}

function makeGroup(overrides: Partial<LoopGroupResult> = {}): LoopGroupResult {
  return {
    id: 'group-1',
    n: 3,
    repo_path: '/repo',
    base_branch: 'main',
    judge_status: 'not_run',
    winner_loop_run_id: null,
    judge_rationale: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    loopRuns: [],
    ...overrides,
  };
}

describe('loop-start-group command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('defaults n to 3 and forwards repo/branch/spec', async () => {
    const startLoopGroup = vi.fn(async () => makeGroup());
    const program = buildProgram(makeClient(startLoopGroup));

    await program.parseAsync(
      [
        'loop-start-group',
        '--repo',
        '/repo',
        '--base-branch',
        'main',
        '--prompt',
        'improve X',
        '--verify',
        'true',
        '--max-iterations',
        '5',
      ],
      { from: 'user' },
    );

    expect(startLoopGroup).toHaveBeenCalledWith({
      repoPath: '/repo',
      baseBranch: 'main',
      spec: { prompt: 'improve X', verify: 'true', maxIterations: 5 },
      n: 3,
    });
  });

  it('honors an explicit --n', async () => {
    const startLoopGroup = vi.fn(async () => makeGroup({ n: 5 }));
    const program = buildProgram(makeClient(startLoopGroup));

    await program.parseAsync(
      [
        'loop-start-group',
        '--repo',
        '/repo',
        '--base-branch',
        'main',
        '--prompt',
        'improve X',
        '--verify',
        'true',
        '--max-iterations',
        '5',
        '--n',
        '5',
      ],
      { from: 'user' },
    );

    expect(startLoopGroup).toHaveBeenCalledWith(expect.objectContaining({ n: 5 }));
  });

  it('maps --budget-tokens into spec.budget', async () => {
    const startLoopGroup = vi.fn(async () => makeGroup());
    const program = buildProgram(makeClient(startLoopGroup));

    await program.parseAsync(
      [
        'loop-start-group',
        '--repo',
        '/repo',
        '--base-branch',
        'main',
        '--prompt',
        'x',
        '--verify',
        'y',
        '--max-iterations',
        '5',
        '--budget-tokens',
        '100000',
      ],
      { from: 'user' },
    );

    expect(startLoopGroup).toHaveBeenCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ budget: { tokens: 100000 } }) }),
    );
  });
});
