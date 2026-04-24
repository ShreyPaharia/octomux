import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithRouter, setupApiMock, setupRouterNavigateMock } from '../test-helpers';
import type { WorktreeSummary } from '../../server/types';

const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('react-router-dom', routerMockFactory);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

void setupApiMock;
void setupRouterNavigateMock;

const WorkspacesPage = (await import('./WorkspacesPage')).default;

const wt = (overrides: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
  id: 'w1',
  path: '/Users/dev/projects/repo/.worktrees/foo',
  repo_path: '/Users/dev/projects/repo',
  branch: 'agents/foo',
  base_branch: 'main',
  base_sha: null,
  mode: 'new',
  status: 'in_use',
  created_at: '2026-04-20 12:00:00',
  last_used_at: '2026-04-24 10:00:00',
  task_count: 1,
  active_task_id: 't1',
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
  mockNavigate.mockReset();
  (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).listWorktrees = vi
    .fn()
    .mockResolvedValue([]);
});

describe('WorkspacesPage', () => {
  it('renders the empty state', async () => {
    renderWithRouter(<WorkspacesPage />);
    await waitFor(() => expect(screen.getByText(/No workspaces yet/i)).toBeInTheDocument());
  });

  it('renders worktree rows', async () => {
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).listWorktrees = vi
      .fn()
      .mockResolvedValue([
        wt({ id: 'w1' }),
        wt({ id: 'w2', repo_path: '/other', mode: 'existing' }),
      ]);
    renderWithRouter(<WorkspacesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('workspace-row-w1')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-row-w2')).toBeInTheDocument();
    });
  });

  it('filters by repo', async () => {
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).listWorktrees = vi
      .fn()
      .mockResolvedValue([
        wt({ id: 'w1', repo_path: '/repo/alpha' }),
        wt({ id: 'w2', repo_path: '/repo/beta' }),
      ]);
    renderWithRouter(<WorkspacesPage />);
    await waitFor(() => expect(screen.getByTestId('workspace-row-w1')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Filter by repo/i), {
      target: { value: '/repo/alpha' },
    });
    expect(screen.getByTestId('workspace-row-w1')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-row-w2')).toBeNull();
  });

  it('filters by mode', async () => {
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).listWorktrees = vi
      .fn()
      .mockResolvedValue([wt({ id: 'w1', mode: 'new' }), wt({ id: 'w2', mode: 'scratch' })]);
    renderWithRouter(<WorkspacesPage />);
    await waitFor(() => expect(screen.getByTestId('workspace-row-w1')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Filter by mode/i), { target: { value: 'scratch' } });
    expect(screen.queryByTestId('workspace-row-w1')).toBeNull();
    expect(screen.getByTestId('workspace-row-w2')).toBeInTheDocument();
  });

  it('navigates to detail on row click', async () => {
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).listWorktrees = vi
      .fn()
      .mockResolvedValue([wt({ id: 'wX' })]);
    renderWithRouter(<WorkspacesPage />);
    const row = await screen.findByTestId('workspace-row-wX');
    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith('/workspaces/wX');
  });
});
