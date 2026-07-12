import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoopsPage from './LoopsPage';
import { renderWithRouter } from '../test-helpers';
import type { LoopRun } from '@/lib/api/loopApi';

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

const { routerMockFactory, mockNavigate } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function makeRun(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'loop-1',
    task_id: 'task-1',
    spec_json: '{}',
    status: 'running',
    iteration: 2,
    max_iterations: 10,
    budget_json: null,
    termination_reason: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('LoopsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no loops', async () => {
    apiMock.listLoops.mockResolvedValue([]);
    renderWithRouter(<LoopsPage />);
    expect(await screen.findByText(/no loop runs yet/i)).toBeTruthy();
  });

  it('renders loop rows with status + iteration/max', async () => {
    apiMock.listLoops.mockResolvedValue([
      makeRun({ id: 'loop-1', status: 'running', iteration: 2, max_iterations: 10 }),
      makeRun({ id: 'loop-2', status: 'done', iteration: 5, max_iterations: 5 }),
    ]);
    renderWithRouter(<LoopsPage />);

    expect(await screen.findByTestId('loop-row-loop-1')).toBeTruthy();
    expect(screen.getByTestId('loop-row-loop-2')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('2 / 10')).toBeTruthy();
    expect(screen.getByText('5 / 5')).toBeTruthy();
  });

  it('shows the termination reason when present', async () => {
    apiMock.listLoops.mockResolvedValue([
      makeRun({ id: 'loop-1', status: 'needs_human', termination_reason: 'max_iterations' }),
    ]);
    renderWithRouter(<LoopsPage />);
    expect(await screen.findByText('max_iterations')).toBeTruthy();
  });

  it('navigates to /loops/:id on row click', async () => {
    const user = userEvent.setup();
    apiMock.listLoops.mockResolvedValue([makeRun({ id: 'loop-42' })]);
    renderWithRouter(<LoopsPage />);

    const row = await screen.findByTestId('loop-row-loop-42');
    await user.click(row);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/loops/loop-42'));
  });
});
