import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithRouter, makeTask } from '../test-helpers';
import type { Worktree } from '../../server/types';
import type { WorktreeDetail } from '@/lib/api';

const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('react-router-dom', routerMockFactory);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

const WorkspaceDetailPage = (await import('./WorkspaceDetailPage')).default;

const worktree = (overrides: Partial<Worktree> = {}): Worktree => ({
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
  ...overrides,
});

const detail = (overrides: Partial<WorktreeDetail> = {}): WorktreeDetail => ({
  worktree: worktree(),
  active_task: makeTask({ id: 't-active', title: 'Active work', status: 'running' }),
  history: [makeTask({ id: 't-old', title: 'Old work', status: 'closed' })],
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
  mockNavigate.mockReset();
});

describe('WorkspaceDetailPage', () => {
  it('renders active + history sections', async () => {
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).getWorktree = vi
      .fn()
      .mockResolvedValue(detail());
    renderWithRouter(<WorkspaceDetailPage />, {
      path: '/workspaces/:id',
      route: '/workspaces/w1',
    });
    await waitFor(() => {
      expect(screen.getByTestId('workspace-task-t-active')).toBeInTheDocument();
      expect(screen.getByTestId('workspace-task-t-old')).toBeInTheDocument();
    });
  });

  it('new task button navigates with repo+worktree_path query', async () => {
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).getWorktree = vi
      .fn()
      .mockResolvedValue(
        detail({
          worktree: worktree({ status: 'available' }),
          active_task: null,
        }),
      );
    renderWithRouter(<WorkspaceDetailPage />, {
      path: '/workspaces/:id',
      route: '/workspaces/w1',
    });
    const button = await screen.findByTestId('new-task-on-workspace');
    fireEvent.click(button);
    const arg = mockNavigate.mock.calls[0]?.[0] as string;
    expect(arg).toContain('/?');
    expect(arg).toContain('repo=%2FUsers%2Fdev%2Fprojects%2Frepo');
    expect(arg).toContain('mode=existing');
    expect(arg).toContain('worktree_path=');
  });

  it('remove workspace triggers deleteWorktree and navigates back', async () => {
    const getWt = vi.fn().mockResolvedValue(
      detail({
        worktree: worktree({ status: 'available' }),
        active_task: null,
        history: [],
      }),
    );
    const delWt = vi.fn().mockResolvedValue(undefined);
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).getWorktree = getWt;
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).deleteWorktree = delWt;
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );

    renderWithRouter(<WorkspaceDetailPage />, {
      path: '/workspaces/:id',
      route: '/workspaces/w1',
    });
    const removeBtn = await screen.findByTestId('remove-workspace');
    fireEvent.click(removeBtn);

    await waitFor(() => expect(delWt).toHaveBeenCalledWith('w1'));
    expect(mockNavigate).toHaveBeenCalledWith('/workspaces');
  });

  it('hides remove button when status is in_use', async () => {
    (apiMock as unknown as Record<string, ReturnType<typeof vi.fn>>).getWorktree = vi
      .fn()
      .mockResolvedValue(detail({ worktree: worktree({ status: 'in_use' }) }));
    renderWithRouter(<WorkspaceDetailPage />, {
      path: '/workspaces/:id',
      route: '/workspaces/w1',
    });
    await waitFor(() => expect(screen.getByText(/Active task/i)).toBeInTheDocument());
    expect(screen.queryByTestId('remove-workspace')).toBeNull();
  });
});
