import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { IterationLedger } from './IterationLedger';
import type { LoopIteration } from '@/lib/api/loopApi';

const { taskApiProxy, taskApiMock } = await vi.hoisted(async () =>
  (await import('../../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));

function makeIteration(overrides: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: `it-${overrides.n ?? 1}`,
    loop_run_id: 'loop-1',
    n: 1,
    sha_from: 'sha-a',
    sha_to: 'sha-b',
    verify_passed: 1,
    tokens: 100,
    emit_status: null,
    emit_reason: null,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('IterationLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskApiMock.getTaskDiffSummary.mockResolvedValue({ files: [] });
  });

  it('renders one row per iteration with verify badges', () => {
    const iterations = [
      makeIteration({ id: 'it-1', n: 1, verify_passed: 1 }),
      makeIteration({ id: 'it-2', n: 2, verify_passed: 0 }),
      makeIteration({ id: 'it-3', n: 3, verify_passed: null }),
    ];
    render(<IterationLedger taskId="task-1" iterations={iterations} />);

    expect(screen.getByTestId('iteration-row-1')).toBeTruthy();
    expect(screen.getByTestId('iteration-row-2')).toBeTruthy();
    expect(screen.getByTestId('iteration-row-3')).toBeTruthy();
    expect(screen.getByText('verify pass')).toBeTruthy();
    expect(screen.getByText('verify fail')).toBeTruthy();
    expect(screen.getByText('pending')).toBeTruthy();
  });

  it('shows an empty state with no iterations', () => {
    render(<IterationLedger taskId="task-1" iterations={[]} />);
    expect(screen.getByText(/no iterations yet/i)).toBeTruthy();
  });

  it('requests the diff for the clicked iteration range', async () => {
    const user = userEvent.setup();
    const iterations = [
      makeIteration({ id: 'it-1', n: 1, sha_from: 'aaa111', sha_to: 'bbb222' }),
      makeIteration({ id: 'it-2', n: 2, sha_from: 'bbb222', sha_to: 'ccc333' }),
    ];
    render(<IterationLedger taskId="task-1" iterations={iterations} />);

    expect(screen.queryByTestId('iteration-diff-pane')).toBeNull();

    await user.click(screen.getByTestId('iteration-row-2'));

    await waitFor(() =>
      expect(taskApiMock.getTaskDiffSummary).toHaveBeenCalledWith('task-1', {
        kind: 'range',
        from: 'bbb222',
        to: 'ccc333',
      }),
    );
    expect(screen.getByTestId('iteration-diff-pane')).toBeTruthy();
  });
});
