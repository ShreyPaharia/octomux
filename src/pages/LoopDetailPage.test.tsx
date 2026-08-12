import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoopDetailPage from './LoopDetailPage';
import { renderWithRouter, makeTask } from '../test-helpers';
import type { RunDetail } from '@/lib/api/runApi';

const { taskApiProxy, reviewApiProxy, configApiProxy, runApiProxy, apiMock } = await vi.hoisted(
  async () => (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/api/runApi', () => ({ runApi: runApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useParams: () => ({ id: 'run-1' }) };
});
vi.mock('../components/loop/IterationLedger', () => ({
  IterationLedger: ({ iterations }: { iterations: unknown[] }) => (
    <div data-testid="iteration-ledger-stub">{iterations.length} iterations</div>
  ),
}));
vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ windowIndex }: { windowIndex: number }) => (
    <div data-testid="terminal-view-stub">window {windowIndex}</div>
  ),
}));

function makeRun(overrides: Partial<NonNullable<RunDetail['loop']>> = {}): RunDetail {
  return {
    id: 'run-1',
    workflow_kind: 'loop',
    trigger: 'manual',
    schedule_id: null,
    task_id: 'task-1',
    chat_id: null,
    loop_run_id: 'loop-1',
    status: 'running',
    effective_status: 'running',
    result_json: null,
    error: null,
    started_at: '2026-01-01 00:00:00',
    ended_at: null,
    loop: {
      id: 'loop-1',
      task_id: 'task-1',
      spec_json: '{}',
      status: 'running',
      iteration: 2,
      max_iterations: 10,
      budget_json: null,
      termination_reason: null,
      group_id: null,
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00',
      iterations: [],
      ...overrides,
    },
    loopGroup: null,
  };
}

describe('LoopDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getTask.mockResolvedValue(makeTask({ id: 'task-1' }));
  });

  it('renders the control strip with iteration/max and the ledger', async () => {
    apiMock.getRun.mockResolvedValue(
      makeRun({ iteration: 2, max_iterations: 10, iterations: [{}, {}] as never }),
    );
    renderWithRouter(<LoopDetailPage />);

    expect(await screen.findByTestId('loop-control-strip')).toBeTruthy();
    expect(screen.getByText('Iteration 2 / 10')).toBeTruthy();
    expect(screen.getByTestId('iteration-ledger-stub')).toBeTruthy();
  });

  it('shows the termination reason when present', async () => {
    apiMock.getRun.mockResolvedValue(
      makeRun({ status: 'needs_human', termination_reason: 'max_iterations' }),
    );
    renderWithRouter(<LoopDetailPage />);
    expect(await screen.findByTestId('termination-reason')).toHaveTextContent('max_iterations');
  });

  it('shows Stop for a running loop and calls stopRun with the runs.id on click', async () => {
    const user = userEvent.setup();
    apiMock.getRun.mockResolvedValue(makeRun({ status: 'running' }));
    apiMock.stopRun.mockResolvedValue(makeRun({ status: 'needs_human' }));
    renderWithRouter(<LoopDetailPage />);

    const stopButton = await screen.findByTestId('loop-stop-button');
    await user.click(stopButton);

    // stopRun takes the top-level runs.id ('run-1'), not the nested loop_runs id.
    await waitFor(() => expect(apiMock.stopRun).toHaveBeenCalledWith('run-1'));
  });

  it('hides Stop once the loop has terminated', async () => {
    apiMock.getRun.mockResolvedValue(makeRun({ status: 'done' }));
    renderWithRouter(<LoopDetailPage />);
    await screen.findByTestId('loop-control-strip');
    expect(screen.queryByTestId('loop-stop-button')).toBeNull();
  });
});
