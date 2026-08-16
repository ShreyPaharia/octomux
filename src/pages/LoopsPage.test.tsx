import { describe, it, expect, vi, beforeEach } from '../bun-test.js';
import type { RunRow } from '@/lib/api/runApi';

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

const { routerMockFactory, mockNavigate } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

const { screen, waitFor } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { default: LoopsPage } = await import('./LoopsPage');
const { renderWithRouter } = await import('../test-helpers');

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 'loop-1',
    workflow_kind: 'loop',
    trigger: 'manual',
    schedule_id: null,
    task_id: 'task-1',
    chat_id: null,
    loop_run_id: 'loop-run-1',
    status: 'running',
    effective_status: 'running',
    result_json: null,
    error: null,
    started_at: '2026-01-01 00:00:00',
    ended_at: null,
    ...overrides,
  };
}

describe('LoopsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no loops', async () => {
    apiMock.listRuns.mockResolvedValue({ runs: [] });
    renderWithRouter(<LoopsPage />);
    expect(await screen.findByText(/no loop runs yet/i)).toBeTruthy();
  });

  it('renders loop rows with task id + status', async () => {
    apiMock.listRuns.mockResolvedValue({
      runs: [
        makeRun({
          id: 'loop-1',
          task_id: 'task-1',
          status: 'running',
          effective_status: 'running',
        }),
        makeRun({ id: 'loop-2', task_id: 'task-2', status: 'done', effective_status: 'done' }),
      ],
    });
    renderWithRouter(<LoopsPage />);

    expect(await screen.findByTestId('loop-row-loop-1')).toBeTruthy();
    expect(screen.getByTestId('loop-row-loop-2')).toBeTruthy();
    expect(screen.getByText('task-1')).toBeTruthy();
    expect(screen.getByText('task-2')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
  });

  it('shows the error message when present', async () => {
    apiMock.listRuns.mockResolvedValue({
      runs: [
        makeRun({
          id: 'loop-1',
          status: 'failed',
          effective_status: 'failed',
          error: 'max_iterations',
        }),
      ],
    });
    renderWithRouter(<LoopsPage />);
    expect(await screen.findByText('max_iterations')).toBeTruthy();
  });

  it('navigates to /loops/:id on row click', async () => {
    const user = userEvent.setup();
    apiMock.listRuns.mockResolvedValue({ runs: [makeRun({ id: 'loop-42' })] });
    renderWithRouter(<LoopsPage />);

    const row = await screen.findByTestId('loop-row-loop-42');
    await user.click(row);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/loops/loop-42'));
  });

  it('opens the best-of-N dialog from the "Best of N" button', async () => {
    const user = userEvent.setup();
    apiMock.listRuns.mockResolvedValue({ runs: [] });
    renderWithRouter(<LoopsPage />);

    await user.click(await screen.findByText('Best of N'));
    expect(await screen.findByTestId('new-loop-group-dialog')).toBeInTheDocument();
  });
});
