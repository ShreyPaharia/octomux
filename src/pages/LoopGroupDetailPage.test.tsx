import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '@/test-helpers';

vi.mock('@/lib/api/loopGroupApi', () => ({
  loopGroupApi: { getLoopGroup: vi.fn(), judgeLoopGroup: vi.fn() },
}));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 'group-1',
    n: 2,
    repo_path: '/repo',
    base_branch: 'main',
    judge_status: 'not_run',
    winner_loop_run_id: null,
    judge_rationale: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    loopRuns: [
      {
        id: 'run-a',
        task_id: 'task-a',
        status: 'done',
        iteration: 3,
        max_iterations: 5,
        termination_reason: 'done',
        updated_at: '2026-01-01 00:00:00',
      },
      {
        id: 'run-b',
        task_id: 'task-b',
        status: 'done',
        iteration: 5,
        max_iterations: 5,
        termination_reason: 'max_iterations',
        updated_at: '2026-01-01 00:00:00',
      },
    ],
    ...overrides,
  };
}

describe('LoopGroupDetailPage', () => {
  it('renders one candidate card per loop run', async () => {
    const { loopGroupApi } = await import('@/lib/api/loopGroupApi');
    vi.mocked(loopGroupApi.getLoopGroup).mockResolvedValue(makeGroup() as never);
    const { default: LoopGroupDetailPage } = await import('./LoopGroupDetailPage');

    renderWithRouter(<LoopGroupDetailPage />, {
      route: '/loop-groups/group-1',
      path: '/loop-groups/:id',
    });

    expect(await screen.findByTestId('loop-group-candidate-run-a')).toBeInTheDocument();
    expect(screen.getByTestId('loop-group-candidate-run-b')).toBeInTheDocument();
  });

  it('disables Judge now while any candidate is still running', async () => {
    const { loopGroupApi } = await import('@/lib/api/loopGroupApi');
    vi.mocked(loopGroupApi.getLoopGroup).mockResolvedValue(
      makeGroup({
        loopRuns: [
          {
            id: 'run-a',
            task_id: 'task-a',
            status: 'running',
            iteration: 1,
            max_iterations: 5,
            termination_reason: null,
            updated_at: '2026-01-01 00:00:00',
          },
          {
            id: 'run-b',
            task_id: 'task-b',
            status: 'done',
            iteration: 5,
            max_iterations: 5,
            termination_reason: 'done',
            updated_at: '2026-01-01 00:00:00',
          },
        ],
      }) as never,
    );
    const { default: LoopGroupDetailPage } = await import('./LoopGroupDetailPage');

    renderWithRouter(<LoopGroupDetailPage />, {
      route: '/loop-groups/group-1',
      path: '/loop-groups/:id',
    });

    expect(await screen.findByTestId('judge-now-button')).toBeDisabled();
  });

  it('enables Judge now once every candidate is terminal, and clicking it calls judgeLoopGroup', async () => {
    const { loopGroupApi } = await import('@/lib/api/loopGroupApi');
    vi.mocked(loopGroupApi.getLoopGroup).mockResolvedValue(makeGroup() as never);
    vi.mocked(loopGroupApi.judgeLoopGroup).mockResolvedValue({ judge_status: 'running' } as never);
    const { default: LoopGroupDetailPage } = await import('./LoopGroupDetailPage');
    const user = userEvent.setup();

    renderWithRouter(<LoopGroupDetailPage />, {
      route: '/loop-groups/group-1',
      path: '/loop-groups/:id',
    });

    const button = await screen.findByTestId('judge-now-button');
    expect(button).not.toBeDisabled();
    await user.click(button);
    await waitFor(() => expect(loopGroupApi.judgeLoopGroup).toHaveBeenCalledWith('group-1'));
  });

  it('shows the winner + rationale once judged', async () => {
    const { loopGroupApi } = await import('@/lib/api/loopGroupApi');
    vi.mocked(loopGroupApi.getLoopGroup).mockResolvedValue(
      makeGroup({
        judge_status: 'done',
        winner_loop_run_id: 'run-a',
        judge_rationale: 'Candidate A was cleaner.',
      }) as never,
    );
    const { default: LoopGroupDetailPage } = await import('./LoopGroupDetailPage');

    renderWithRouter(<LoopGroupDetailPage />, {
      route: '/loop-groups/group-1',
      path: '/loop-groups/:id',
    });

    expect(await screen.findByTestId('judge-verdict')).toHaveTextContent('run-a');
    expect(screen.getByTestId('judge-verdict')).toHaveTextContent('Candidate A was cleaner.');
  });
});
