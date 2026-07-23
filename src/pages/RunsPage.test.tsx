import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RunsPage from './RunsPage';
import { renderWithRouter } from '../test-helpers';
import type { WorkflowRunRow } from '@/lib/api/workflowsApi';
import { registerWorkflowUI } from '@/workflows/registry';

const { taskApiProxy, reviewApiProxy, configApiProxy, loopApiProxy, workflowsApiProxy, apiMock } =
  await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/api/loopApi', () => ({ loopApi: loopApiProxy }));
vi.mock('@/lib/api/workflowsApi', () => ({ workflowsApi: workflowsApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

const { routerMockFactory, mockNavigate } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function makeRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: 'run-1',
    workflow_kind: 'doc-drift',
    trigger: 'cron',
    status: 'done',
    effective_status: 'done',
    schedule_id: null,
    task_id: null,
    loop_run_id: null,
    chat_id: null,
    started_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('RunsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when there are no runs', async () => {
    apiMock.listAllRuns.mockResolvedValue({ runs: [] });
    renderWithRouter(<RunsPage />);

    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
  });

  it('renders every run and filters by kind when a chip is clicked', async () => {
    const user = userEvent.setup();
    apiMock.listAllRuns.mockResolvedValue({
      runs: [
        makeRun({ id: 'run-1', workflow_kind: 'doc-drift' }),
        makeRun({ id: 'run-2', workflow_kind: 'reviewer', trigger: 'github' }),
      ],
    });

    renderWithRouter(<RunsPage />);

    expect(await screen.findByTestId('run-row-run-1')).toBeInTheDocument();
    expect(screen.getByTestId('run-row-run-2')).toBeInTheDocument();

    await user.click(screen.getByTestId('run-kind-chip-doc-drift'));

    expect(screen.getByTestId('run-row-run-1')).toBeInTheDocument();
    expect(screen.queryByTestId('run-row-run-2')).not.toBeInTheDocument();
  });

  it('expands a row to render the result card when result_json is a valid envelope', async () => {
    const user = userEvent.setup();
    apiMock.listAllRuns.mockResolvedValue({
      runs: [
        makeRun({
          id: 'run-1',
          result_json: JSON.stringify({ outcome: 'done', summary: 'Fixed 3 doc drifts' }),
        }),
      ],
    });

    renderWithRouter(<RunsPage />);

    await user.click(await screen.findByTestId('run-row-run-1'));

    expect(await screen.findByText('Fixed 3 doc drifts')).toBeInTheDocument();
  });

  it('does not blank the page when result_json is malformed', async () => {
    const user = userEvent.setup();
    apiMock.listAllRuns.mockResolvedValue({
      runs: [makeRun({ id: 'run-1', result_json: '{not json' })],
    });

    renderWithRouter(<RunsPage />);

    const row = await screen.findByTestId('run-row-run-1');
    await user.click(row);

    // Still on the page, no crash — the row is still there.
    expect(screen.getByTestId('run-row-run-1')).toBeInTheDocument();
  });

  it('shows the outcome as a pill on the row without expanding it', async () => {
    apiMock.listAllRuns.mockResolvedValue({
      runs: [
        makeRun({
          id: 'run-1',
          result_json: JSON.stringify({ outcome: 'failed', summary: 'Build broke' }),
        }),
      ],
    });

    renderWithRouter(<RunsPage />);

    expect(await screen.findByTestId('run-outcome-run-1')).toHaveTextContent('failed');
    // The result body itself should not be rendered until the row is expanded.
    expect(screen.queryByText('Build broke')).not.toBeInTheDocument();
  });

  it('falls back to effective_status on the row when there is no parsed result', async () => {
    apiMock.listAllRuns.mockResolvedValue({
      runs: [makeRun({ id: 'run-1', effective_status: 'running', result_json: null })],
    });

    renderWithRouter(<RunsPage />);

    const row = await screen.findByTestId('run-row-run-1');
    expect(row).toHaveTextContent('running');
    expect(screen.queryByTestId('run-outcome-run-1')).not.toBeInTheDocument();
  });

  it('shows an explanatory message instead of a silent no-op for resultless rows', async () => {
    const user = userEvent.setup();
    apiMock.listAllRuns.mockResolvedValue({
      runs: [makeRun({ id: 'run-1', result_json: null })],
    });

    renderWithRouter(<RunsPage />);

    await user.click(await screen.findByTestId('run-row-run-1'));

    expect(await screen.findByText('No result recorded for this run.')).toBeInTheDocument();
  });

  it('deep-links to the detail view when the run has a task_id and a registered kind', async () => {
    const user = userEvent.setup();
    registerWorkflowUI('loops', {
      navLabel: 'Loops',
      icon: () => null,
      DetailView: () => null,
    });
    apiMock.listAllRuns.mockResolvedValue({
      runs: [makeRun({ id: 'run-1', workflow_kind: 'loops', task_id: 'task-9' })],
    });

    renderWithRouter(<RunsPage />);

    const link = await screen.findByTestId('run-detail-link-run-1');
    await user.click(link);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/w/loops/task-9'));
  });

  it('links back to the schedule that produced a run', async () => {
    const user = userEvent.setup();
    apiMock.listAllRuns.mockResolvedValue({
      runs: [makeRun({ id: 'run-1', schedule_id: 'sched-42' })],
    });

    renderWithRouter(<RunsPage />);

    await user.click(await screen.findByTestId('run-schedule-link-run-1'));

    expect(mockNavigate).toHaveBeenCalledWith('/schedules?expand=sched-42');
  });
});
