import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerTaskRefAdd } from './task-ref-add.js';

vi.mock('../action.js', () => ({
  getContext: (_cmd: unknown) => ({
    client: (globalThis as any).__testClient,
    json: false,
  }),
}));

describe('task-ref-add CLI', () => {
  let addTaskRef: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    addTaskRef = vi.fn().mockResolvedValue({
      integration: 'linear',
      ref: 'BAC-1',
      url: null,
      metadata: null,
    });
    (globalThis as any).__testClient = { addTaskRef };
  });

  it('passes a parsed --metadata object to the client', async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskRefAdd(program);
    await program.parseAsync([
      'node',
      'octomux',
      'task-ref-add',
      'task-1',
      'linear',
      'BAC-1',
      '--metadata',
      '{"team_key":"BAC","team_id":"uuid-1"}',
    ]);
    expect(addTaskRef).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        integration: 'linear',
        ref: 'BAC-1',
        metadata: { team_key: 'BAC', team_id: 'uuid-1' },
      }),
    );
  });

  it('rejects non-object metadata (JSON array)', async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskRefAdd(program);
    await expect(
      program.parseAsync([
        'node',
        'octomux',
        'task-ref-add',
        'task-1',
        'linear',
        'BAC-1',
        '--metadata',
        '[1,2,3]',
      ]),
    ).rejects.toThrow(/metadata.*object/i);
  });

  it('rejects invalid JSON', async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskRefAdd(program);
    await expect(
      program.parseAsync([
        'node',
        'octomux',
        'task-ref-add',
        'task-1',
        'linear',
        'BAC-1',
        '--metadata',
        '{not json}',
      ]),
    ).rejects.toThrow(/metadata.*invalid|metadata.*JSON/i);
  });

  it('works without --metadata (backward compatible)', async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskRefAdd(program);
    await program.parseAsync(['node', 'octomux', 'task-ref-add', 'task-1', 'jira', 'PROJ-1']);
    expect(addTaskRef).toHaveBeenCalledWith(
      'task-1',
      expect.not.objectContaining({ metadata: expect.anything() }),
    );
  });
});
