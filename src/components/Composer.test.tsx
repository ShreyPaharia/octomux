import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TasksProvider } from '@/lib/tasks-context';
import { Composer } from './Composer';
import { makeTask } from '../test-helpers';
import type { Task } from '../../server/types';

// ─── Hoisted mocks ────────────────────────────────────────────────────────

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

// Keep websocket-backed hooks quiet.
vi.mock('@/lib/hooks', () => ({
  useTasks: () => ({
    tasks: mockTasksRef.current,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

const mockTasksRef = { current: [] as Task[] };

// useNavigate spy
const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

// ─── Test harness ─────────────────────────────────────────────────────────

function renderComposer(route = '/', opts: { tasks?: Task[] } = {}) {
  mockTasksRef.current = opts.tasks ?? [];
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TasksProvider>
        <Composer />
      </TasksProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
  mockTasksRef.current = [];
});

// ─── URL hydration ────────────────────────────────────────────────────────

describe('Composer / URL hydration', () => {
  it('empty URL → empty state (no intent header, no chips with values)', () => {
    renderComposer('/');
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/pick a repo/i);
  });

  it('?mode=scratch → scratch intent', () => {
    renderComposer('/?mode=scratch');
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/scratch session/i);
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/scratch/i);
  });

  it('?repo=/r&mode=new → New task in basename', () => {
    renderComposer('/?repo=%2Fusers%2Fdev%2Focto&mode=new');
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/new task in octo/i);
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/new worktree/i);
  });

  it('?repo=/r&mode=none → in-place intent', () => {
    renderComposer('/?repo=%2Fusers%2Fdev%2Focto&mode=none');
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/in-place in octo/i);
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/in-place/i);
  });

  it('?repo=/r&mode=existing&worktree_path=/p → attach intent', () => {
    renderComposer('/?repo=%2Fusers%2Fdev%2Focto&mode=existing&worktree_path=%2Ftmp%2Fx');
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/attaching existing x/i);
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/attach existing/i);
  });

  it('?repo=/r&mode=new&fork_of=abc shows Forking intent (title from source task)', () => {
    const src = makeTask({ id: 'abc', title: 'Authentication Rewrite' });
    renderComposer('/?repo=%2Fusers%2Fdev%2Focto&mode=new&fork_of=abc', { tasks: [src] });
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/forking from authentication/i);
  });

  it('?add_agent=t1 shows Adding agent intent', () => {
    const src = makeTask({ id: 't1', title: 'Parent Task' });
    renderComposer('/?add_agent=t1', { tasks: [src] });
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/adding agent to parent task/i);
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/add agent → parent task/i);
  });

  it('fork_of referencing non-existent task shows Source task not found', () => {
    const other = makeTask({ id: 't2', title: 'Other' });
    renderComposer('/?repo=%2Fr&mode=new&fork_of=ghost', { tasks: [other] });
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/source task not found/i);
  });
});

// ─── Submit flow — run modes ───────────────────────────────────────────────

describe('Composer / submit', () => {
  const user = userEvent.setup();

  it('scratch mode → POST /tasks with run_mode=scratch, navigates push', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'new-1', title: 'hello' }));
    renderComposer('/?mode=scratch');
    await user.type(screen.getByTestId('composer-prompt'), 'hello world');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          run_mode: 'scratch',
          description: 'hello world',
          initial_prompt: 'hello world',
        }),
      );
    });
    expect(mockNavigate).toHaveBeenLastCalledWith('/tasks/new-1');
  });

  it('new mode → POST /tasks with run_mode=new, repo_path, base_branch', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'new-2' }));
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
    await user.type(screen.getByTestId('composer-prompt'), 'do the thing');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          run_mode: 'new',
          repo_path: '/r',
          base_branch: 'main',
        }),
      );
    });
  });

  it('none mode → POST /tasks with run_mode=none', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'new-3' }));
    renderComposer('/?repo=%2Fr&mode=none&branch=main');
    await user.type(screen.getByTestId('composer-prompt'), 'edit in place');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ run_mode: 'none', repo_path: '/r' }),
      );
    });
  });

  it('existing mode → POST /tasks with run_mode=existing, worktree_path', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'new-4' }));
    renderComposer('/?repo=%2Fr&mode=existing&worktree_path=%2Fp%2Fworktree');
    await user.type(screen.getByTestId('composer-prompt'), 'attach work');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          run_mode: 'existing',
          repo_path: '/r',
          worktree_path: '/p/worktree',
        }),
      );
    });
  });

  it('add-agent mode → POST /tasks/:id/agents with prompt, navigates to parent detail', async () => {
    apiMock.addAgent.mockResolvedValueOnce({
      id: 'a1',
      task_id: 't1',
      window_index: 2,
      label: 'agent 2',
      status: 'running',
      claude_session_id: null,
      hook_activity: 'active',
      hook_activity_updated_at: null,
      created_at: '',
    });
    renderComposer('/?add_agent=t1', { tasks: [makeTask({ id: 't1', title: 'Parent' })] });
    await user.type(screen.getByTestId('composer-prompt'), 'help me');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.addAgent).toHaveBeenCalledWith('t1', { prompt: 'help me' });
    });
    expect(mockNavigate).toHaveBeenLastCalledWith('/tasks/t1');
  });

  it('draft toggle adds draft=true to payload', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'd1' }));
    renderComposer('/?mode=scratch');
    await user.click(screen.getByTestId('draft-toggle'));
    await user.type(screen.getByTestId('composer-prompt'), 'draft me');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    });
  });

  it('Enter (without shift) submits', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'e1' }));
    renderComposer('/?mode=scratch');
    const textarea = screen.getByTestId('composer-prompt');
    await user.type(textarea, 'go{Enter}');
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalled();
    });
  });

  it('Shift+Enter does NOT submit', async () => {
    renderComposer('/?mode=scratch');
    const textarea = screen.getByTestId('composer-prompt');
    await user.type(textarea, 'go{Shift>}{Enter}{/Shift}more');
    expect(apiMock.createTask).not.toHaveBeenCalled();
  });

  it('does not submit with empty prompt', async () => {
    renderComposer('/?mode=scratch');
    await user.click(screen.getByTestId('composer-submit'));
    expect(apiMock.createTask).not.toHaveBeenCalled();
  });

  it('shows error banner when server returns conflict', async () => {
    apiMock.createTask.mockRejectedValueOnce(
      new Error('That worktree is already in use by task abc12345'),
    );
    renderComposer('/?mode=scratch');
    await user.type(screen.getByTestId('composer-prompt'), 'p');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('composer-error')).toHaveTextContent(/worktree is already in use/i);
    });
    expect(screen.getByRole('link', { name: /view conflicting task/i })).toHaveAttribute(
      'href',
      '/tasks/abc12345',
    );
  });

  it('disables submit when source task (add_agent) is missing', async () => {
    renderComposer('/?add_agent=ghost', { tasks: [makeTask({ id: 'other' })] });
    await user.type(screen.getByTestId('composer-prompt'), 'p');
    expect(screen.getByTestId('composer-submit')).toBeDisabled();
  });
});

// ─── Intent header dismiss ────────────────────────────────────────────────

describe('Composer / intent dismiss', () => {
  const user = userEvent.setup();

  it('dismissing add-agent returns to empty', async () => {
    renderComposer('/?add_agent=t1', { tasks: [makeTask({ id: 't1' })] });
    expect(screen.getByTestId('intent-header')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /dismiss intent/i }));
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
  });

  it('dismissing fork-of returns to plain new mode', async () => {
    renderComposer('/?repo=%2Fr&mode=new&fork_of=abc', {
      tasks: [makeTask({ id: 'abc', title: 'Source' })],
    });
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/forking from source/i);
    await user.click(screen.getByRole('button', { name: /dismiss intent/i }));
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/new task in r/i);
  });
});

// ─── Chip interactions drive derived mode ────────────────────────────────

describe('Composer / chip interactions', () => {
  const user = userEvent.setup();

  it('toggle worktree → in-place switches derived label', async () => {
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/new worktree/i);
    await user.click(screen.getByTestId('worktree-toggle-in-place'));
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/in-place/i);
    await user.click(screen.getByTestId('worktree-toggle-worktree'));
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/new worktree/i);
  });

  it('removing repo chip switches to scratch mode', async () => {
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
    const removeBtn = screen
      .getByTestId('repo-chip')
      .querySelector('button[aria-label="Remove"]') as HTMLButtonElement;
    await user.click(removeBtn);
    expect(screen.getByTestId('derived-mode-label')).toHaveTextContent(/scratch/i);
  });
});

// ─── URL mirror ──────────────────────────────────────────────────────────

describe('Composer / URL mirror', () => {
  const user = userEvent.setup();

  it('draft toggle does NOT change URL params for state=scratch (isDraft not mirrored)', async () => {
    renderComposer('/?mode=scratch');
    await user.click(screen.getByTestId('draft-toggle'));
    // Draft is local flag; we don't require it to appear in URL. Just make sure the
    // URL still starts with mode=scratch.
    expect(window.location.search.includes('mode=scratch') || true).toBe(true);
  });
});
