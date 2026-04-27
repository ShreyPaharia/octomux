import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  return { ...actual, promisify: (fn: unknown) => fn };
});

import { execFile } from 'node:child_process';
import { preflightNoneMode } from './preflight';

const mockedExec = execFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  createTestDb();
  mockedExec.mockReset();
});

describe('preflightNoneMode', () => {
  it('returns ok=true when current branch matches target and no conflicts', async () => {
    mockedExec.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
        return Promise.resolve({ stdout: 'main\n', stderr: '' });
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });

    const result = await preflightNoneMode('/repo', 'main');

    expect(result).toEqual({
      ok: true,
      currentBranch: 'main',
      targetBranch: 'main',
      conflicts: [],
      dirty: null,
    });
  });
});
