import { describe, it, expect, vi } from '../bun-test.js';

vi.mock('@/lib/api/runApi', () => ({
  runApi: { getRun: vi.fn(), judgeLoopGroup: vi.fn() },
}));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { screen, waitFor } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { renderWithRouter } = await import('@/test-helpers');

function makeRun(groupOverrides: Record<string, unknown> = {}) {
  return {
    id: 'run-group-1',
    workflow_kind: 'loop-group',
    trigger: 'manual',
    schedule_id: null,
    task_id: null,
    chat_id: null,
    loop_run_id: null,
    status: 'running',
    effective_status: 'running',
    result_json: null,
    error: null,
    started_at: '2026-01-01 00:00:00',
    ended_at: null,
    loop: null,
    loopGroup: {
      id: 'group-1',
      spec_json: '{}',
      n: 2,
      repo_path: '/repo',
      base_branch: 'main',
      judge_status: 'not_run',
      winner_loop_run_id: null,
      judge_rationale: null,
      run_id: 'run-group-1',
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00',
      candidates: [
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
      ...groupOverrides,
    },
  };
}

describe('LoopGroupDetailPage', () => {
  it('renders one candidate card per loop run', async () => {
    const { runApi } = await import('@/lib/api/runApi');
    vi.mocked(runApi.getRun).mockResolvedValue(makeRun() as never);
    const { default: LoopGroupDetailPage } = await import('./LoopGroupDetailPage');

    renderWithRouter(<LoopGroupDetailPage />, {
      route: '/loop-groups/run-group-1',
      path: '/loop-groups/:id',
    });

    expect(await screen.findByTestId('loop-group-candidate-run-a')).toBeInTheDocument();
    expect(screen.getByTestId('loop-group-candidate-run-b')).toBeInTheDocument();
  });

  it('disables Judge now while any candidate is still running', async () => {
    const { runApi } = await import('@/lib/api/runApi');
    vi.mocked(runApi.getRun).mockResolvedValue(
      makeRun({
        candidates: [
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
      route: '/loop-groups/run-group-1',
      path: '/loop-groups/:id',
    });

    expect(await screen.findByTestId('judge-now-button')).toBeDisabled();
  });

  it('enables Judge now once every candidate is terminal, and clicking it calls judgeLoopGroup with the runs.id', async () => {
    const { runApi } = await import('@/lib/api/runApi');
    vi.mocked(runApi.getRun).mockResolvedValue(makeRun() as never);
    vi.mocked(runApi.judgeLoopGroup).mockResolvedValue(
      makeRun({ judge_status: 'running' }) as never,
    );
    const { default: LoopGroupDetailPage } = await import('./LoopGroupDetailPage');
    const user = userEvent.setup();

    renderWithRouter(<LoopGroupDetailPage />, {
      route: '/loop-groups/run-group-1',
      path: '/loop-groups/:id',
    });

    const button = await screen.findByTestId('judge-now-button');
    expect(button).not.toBeDisabled();
    await user.click(button);
    // judgeLoopGroup takes the group's own runs.id ('run-group-1'), not loop_groups.id.
    await waitFor(() => expect(runApi.judgeLoopGroup).toHaveBeenCalledWith('run-group-1'));
  });

  it('shows the winner + rationale once judged', async () => {
    const { runApi } = await import('@/lib/api/runApi');
    vi.mocked(runApi.getRun).mockResolvedValue(
      makeRun({
        judge_status: 'done',
        winner_loop_run_id: 'run-a',
        judge_rationale: 'Candidate A was cleaner.',
      }) as never,
    );
    const { default: LoopGroupDetailPage } = await import('./LoopGroupDetailPage');

    renderWithRouter(<LoopGroupDetailPage />, {
      route: '/loop-groups/run-group-1',
      path: '/loop-groups/:id',
    });

    expect(await screen.findByTestId('judge-verdict')).toHaveTextContent('run-a');
    expect(screen.getByTestId('judge-verdict')).toHaveTextContent('Candidate A was cleaner.');
  });
});
