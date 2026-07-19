import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkflowsPage from './WorkflowsPage';
import { renderWithRouter } from '../test-helpers';
import type { WorkflowRow, WorkflowRunRow } from '@/lib/api/workflowsApi';

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

function makeWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    kind: 'pr-extract',
    displayName: 'PR Extracts',
    surfaces: ['feed', 'artifact'],
    trigger: { kind: 'github', event: 'pr_merged' },
    runCount: 3,
    ...overrides,
  };
}

const ALL_WORKFLOWS: WorkflowRow[] = [
  makeWorkflow({ kind: 'loops', displayName: 'Loops', trigger: { kind: 'manual' }, runCount: 5 }),
  makeWorkflow({
    kind: 'pr-extract',
    displayName: 'PR Extracts',
    trigger: { kind: 'github', event: 'pr_merged' },
    runCount: 3,
  }),
  makeWorkflow({
    kind: 'prod-log-triage',
    displayName: 'Prod Log Triage',
    trigger: { kind: 'cron' },
    runCount: 1,
  }),
  makeWorkflow({
    kind: 'reviewer',
    displayName: 'PR Reviewer',
    trigger: { kind: 'github', event: 'review_requested' },
    runCount: 2,
  }),
];

describe('WorkflowsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every workflow with its trigger badge and run count', async () => {
    apiMock.listWorkflows.mockResolvedValue({ workflows: ALL_WORKFLOWS });
    renderWithRouter(<WorkflowsPage />);

    expect(await screen.findByText('Loops')).toBeTruthy();
    expect(screen.getByText('PR Extracts')).toBeTruthy();
    expect(screen.getByText('Prod Log Triage')).toBeTruthy();
    // reviewer has no client UI but must still appear.
    expect(screen.getByText('PR Reviewer')).toBeTruthy();

    expect(screen.getByText('manual')).toBeTruthy();
    expect(screen.getByText('GitHub: pr_merged')).toBeTruthy();
    expect(screen.getByText('GitHub: review_requested')).toBeTruthy();
    expect(screen.getByText('cron')).toBeTruthy();

    expect(screen.getByTestId('workflow-run-count-loops')).toHaveTextContent('5');
    expect(screen.getByTestId('workflow-run-count-pr-extract')).toHaveTextContent('3');
  });

  it('expanding a row fetches and lists its runs', async () => {
    const user = userEvent.setup();
    apiMock.listWorkflows.mockResolvedValue({ workflows: ALL_WORKFLOWS });
    const runs: WorkflowRunRow[] = [
      {
        id: 'run-1',
        workflow_kind: 'pr-extract',
        trigger: 'github',
        status: 'done',
        effective_status: 'done',
        task_id: 'task-1',
        loop_run_id: null,
        started_at: '2026-01-01 00:00:00',
      },
    ];
    apiMock.getWorkflowRuns.mockResolvedValue({ runs });

    renderWithRouter(<WorkflowsPage />);

    await user.click(await screen.findByTestId('workflow-expand-pr-extract'));

    await waitFor(() => expect(apiMock.getWorkflowRuns).toHaveBeenCalledWith('pr-extract'));
    expect(await screen.findByTestId('workflow-run-run-1')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
  });

  it('a run links to /tasks/:id', async () => {
    const user = userEvent.setup();
    apiMock.listWorkflows.mockResolvedValue({ workflows: ALL_WORKFLOWS });
    apiMock.getWorkflowRuns.mockResolvedValue({
      runs: [
        {
          id: 'run-1',
          workflow_kind: 'pr-extract',
          trigger: 'github',
          status: 'done',
          effective_status: 'done',
          task_id: 'task-1',
          loop_run_id: null,
          started_at: '2026-01-01 00:00:00',
        },
      ],
    });

    renderWithRouter(<WorkflowsPage />);
    await user.click(await screen.findByTestId('workflow-expand-pr-extract'));

    const taskLink = await screen.findByTestId('workflow-run-task-link-run-1');
    await user.click(taskLink);

    expect(mockNavigate).toHaveBeenCalledWith('/tasks/task-1');
  });

  it('a run with a loop_run_id links to /w/loops/:id', async () => {
    const user = userEvent.setup();
    apiMock.listWorkflows.mockResolvedValue({ workflows: ALL_WORKFLOWS });
    apiMock.getWorkflowRuns.mockResolvedValue({
      runs: [
        {
          id: 'run-2',
          workflow_kind: 'loops',
          trigger: 'manual',
          status: 'running',
          effective_status: 'running',
          task_id: 'task-2',
          loop_run_id: 'loop-2',
          started_at: '2026-01-01 00:00:00',
        },
      ],
    });

    renderWithRouter(<WorkflowsPage />);
    await user.click(await screen.findByTestId('workflow-expand-loops'));

    const loopLink = await screen.findByTestId('workflow-run-loop-link-run-2');
    await user.click(loopLink);

    expect(mockNavigate).toHaveBeenCalledWith('/w/loops/loop-2');
  });
});
