import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoopDetailPage from './LoopDetailPage';
import { renderWithRouter, makeTask } from '../test-helpers';
import type { LoopRunDetail } from '@/lib/api/loopApi';

const { taskApiProxy, reviewApiProxy, configApiProxy, loopApiProxy, apiMock } = await vi.hoisted(
  async () => (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/api/loopApi', () => ({ loopApi: loopApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useParams: () => ({ id: 'loop-1' }) };
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

function makeRun(overrides: Partial<LoopRunDetail> = {}): LoopRunDetail {
  return {
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
  };
}

describe('LoopDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getTask.mockResolvedValue(makeTask({ id: 'task-1' }));
  });

  it('renders the control strip with iteration/max and the ledger', async () => {
    apiMock.getLoop.mockResolvedValue(
      makeRun({ iteration: 2, max_iterations: 10, iterations: [{}, {}] as never }),
    );
    renderWithRouter(<LoopDetailPage />);

    expect(await screen.findByTestId('loop-control-strip')).toBeTruthy();
    expect(screen.getByText('Iteration 2 / 10')).toBeTruthy();
    expect(screen.getByTestId('iteration-ledger-stub')).toBeTruthy();
  });

  it('shows the termination reason when present', async () => {
    apiMock.getLoop.mockResolvedValue(
      makeRun({ status: 'needs_human', termination_reason: 'max_iterations' }),
    );
    renderWithRouter(<LoopDetailPage />);
    expect(await screen.findByTestId('termination-reason')).toHaveTextContent('max_iterations');
  });

  it('shows Stop for a running loop and calls stopLoop on click', async () => {
    const user = userEvent.setup();
    apiMock.getLoop.mockResolvedValue(makeRun({ status: 'running' }));
    apiMock.stopLoop.mockResolvedValue({ id: 'loop-1', status: 'needs_human' });
    renderWithRouter(<LoopDetailPage />);

    const stopButton = await screen.findByTestId('loop-stop-button');
    await user.click(stopButton);

    await waitFor(() => expect(apiMock.stopLoop).toHaveBeenCalledWith('loop-1'));
  });

  it('hides Stop once the loop has terminated', async () => {
    apiMock.getLoop.mockResolvedValue(makeRun({ status: 'done' }));
    renderWithRouter(<LoopDetailPage />);
    await screen.findByTestId('loop-control-strip');
    expect(screen.queryByTestId('loop-stop-button')).toBeNull();
  });
});
