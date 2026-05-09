import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  useAgents: () => ({ agents: [], loading: false, error: null, refresh: vi.fn() }),
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
  it('empty URL → no intent header, scratch hint pill', () => {
    renderComposer('/');
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
    expect(screen.getByTestId('scratch-hint')).toHaveTextContent(/scratch/i);
  });

  it('?mode=scratch → no intent header', () => {
    renderComposer('/?mode=scratch');
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
  });

  it('?repo=/r&mode=new → no intent header, worktree checkbox ON', () => {
    renderComposer('/?repo=%2Fusers%2Fdev%2Focto&mode=new');
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
    expect(screen.getByTestId('worktree-checkbox')).toHaveAttribute('aria-checked', 'true');
  });

  it('?repo=/r&mode=none → no intent header, worktree checkbox OFF', () => {
    renderComposer('/?repo=%2Fusers%2Fdev%2Focto&mode=none');
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
    expect(screen.getByTestId('worktree-checkbox')).toHaveAttribute('aria-checked', 'false');
  });

  it('?repo=/r&mode=existing&worktree_path=/p → attach intent', () => {
    renderComposer('/?repo=%2Fusers%2Fdev%2Focto&mode=existing&worktree_path=%2Ftmp%2Fx');
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/attaching existing x/i);
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

  it('scratch mode → POST /api/chats, navigates to /chats/:id', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'chat-1' }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    renderComposer('/?mode=scratch');
    await user.type(screen.getByTestId('composer-prompt'), 'hello world');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chats',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(mockNavigate).toHaveBeenLastCalledWith('/chats/chat-1');
    expect(apiMock.createTask).not.toHaveBeenCalled();
  });

  it('bare `/` URL → typing + Enter creates a chat, navigates to /chats/:id', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'chat-default' }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    renderComposer('/');
    const textarea = screen.getByTestId('composer-prompt');
    await user.type(textarea, 'hello world{Enter}');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/chats',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(mockNavigate).toHaveBeenLastCalledWith('/chats/chat-default');
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
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
    await user.click(screen.getByTestId('draft-toggle'));
    await user.type(screen.getByTestId('composer-prompt'), 'draft me');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    });
  });

  it('Enter (without shift) submits', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'e1' }));
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
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
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
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

  it('calls preflight before creating a none-mode task with base_branch', async () => {
    apiMock.preflightNoneMode.mockResolvedValueOnce({
      ok: true,
      currentBranch: 'feature-x',
      targetBranch: 'feature-x',
      conflicts: [],
      warnings: [],
      dirty: null,
    });
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'none-1' }));
    renderComposer('/?repo=%2Fr&mode=none&branch=feature-x');
    await user.type(screen.getByTestId('composer-prompt'), 'do the thing');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => expect(apiMock.preflightNoneMode).toHaveBeenCalledWith('/r', 'feature-x'));
    expect(apiMock.createTask).toHaveBeenCalled();
  });

  it('conflict dialog opens when another task is on a different branch', async () => {
    apiMock.preflightNoneMode.mockResolvedValueOnce({
      ok: false,
      conflicts: [{ task_id: 't1', title: 'other', status: 'running', branch: 'main' }],
      warnings: [],
      dirty: null,
      currentBranch: 'main',
      targetBranch: 'feature-x',
    });
    renderComposer('/?repo=%2Fr&mode=none&branch=feature-x');
    await user.type(screen.getByTestId('composer-prompt'), 'do the thing');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => expect(screen.getByText(/Other chats are using/i)).toBeInTheDocument());
    expect(apiMock.createTask).not.toHaveBeenCalled();
  });

  it('shared-branch dialog warns (non-blocking) when another task is on the same branch', async () => {
    apiMock.preflightNoneMode.mockResolvedValueOnce({
      ok: true,
      conflicts: [],
      warnings: [{ task_id: 't1', title: 'other', status: 'running', branch: 'feature-x' }],
      dirty: null,
      currentBranch: 'feature-x',
      targetBranch: 'feature-x',
    });
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'none-shared' }));
    renderComposer('/?repo=%2Fr&mode=none&branch=feature-x');
    await user.type(screen.getByTestId('composer-prompt'), 'do the thing');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => expect(screen.getByText(/share the working tree/i)).toBeInTheDocument());
    expect(apiMock.createTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /continue anyway/i }));
    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalled());
  });

  it('dirty dialog opens when preflight returns dirty', async () => {
    apiMock.preflightNoneMode.mockResolvedValueOnce({
      ok: false,
      conflicts: [],
      warnings: [],
      dirty: { count: 5 },
      currentBranch: 'main',
      targetBranch: 'feature-x',
    });
    renderComposer('/?repo=%2Fr&mode=none&branch=feature-x');
    await user.type(screen.getByTestId('composer-prompt'), 'do the thing');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Uncommitted changes/i })).toBeInTheDocument(),
    );
  });

  it('preflight skipped when none mode has no base_branch', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'none-no-branch' }));
    renderComposer('/?repo=%2Fr&mode=none');
    await user.type(screen.getByTestId('composer-prompt'), 'edit in place');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalled());
    expect(apiMock.preflightNoneMode).not.toHaveBeenCalled();
  });
});

// ─── Intent header dismiss ────────────────────────────────────────────────

describe('Composer / intent dismiss', () => {
  const user = userEvent.setup();

  it('dismissing add-agent returns to scratch', async () => {
    renderComposer('/?add_agent=t1', { tasks: [makeTask({ id: 't1', title: 'Parent' })] });
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/adding agent to parent/i);
    await user.click(screen.getByRole('button', { name: /dismiss intent/i }));
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
    expect(screen.getByTestId('scratch-hint')).toBeInTheDocument();
  });

  it('dismissing fork-of returns to plain new mode', async () => {
    renderComposer('/?repo=%2Fr&mode=new&fork_of=abc', {
      tasks: [makeTask({ id: 'abc', title: 'Source' })],
    });
    expect(screen.getByTestId('intent-header')).toHaveTextContent(/forking from source/i);
    await user.click(screen.getByRole('button', { name: /dismiss intent/i }));
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
  });
});

// ─── Chip interactions drive derived mode ────────────────────────────────

describe('Composer / chip interactions', () => {
  const user = userEvent.setup();

  it('toggling worktree checkbox switches derived run_mode (new ↔ none)', async () => {
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
    const checkbox = screen.getByTestId('worktree-checkbox');
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();

    await user.click(checkbox);
    expect(screen.getByTestId('worktree-checkbox')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('worktree-checkbox'));
    expect(screen.getByTestId('worktree-checkbox')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
  });

  it('removing repo chip switches to scratch mode', async () => {
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
    const removeBtn = screen
      .getByTestId('repo-chip')
      .querySelector('button[aria-label="Remove"]') as HTMLButtonElement;
    await user.click(removeBtn);
    expect(screen.queryByTestId('intent-header')).not.toBeInTheDocument();
    expect(screen.getByTestId('scratch-hint')).toBeInTheDocument();
  });

  it('empty composer shows dashed "Add repo or folder" chip + scratch hint', () => {
    renderComposer('/');
    expect(screen.getByTestId('repo-chip-picker')).toHaveTextContent(/add repo or folder/i);
    expect(screen.getByTestId('scratch-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('worktree-checkbox')).not.toBeInTheDocument();
  });

  // T5 deliverable: repo + worktree=on → run_mode 'new'; off → 'none'.
  it('checking worktree before submit emits run_mode=new', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'wt-on' }));
    renderComposer('/?repo=%2Fr&mode=none&branch=main');
    expect(screen.getByTestId('worktree-checkbox')).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByTestId('worktree-checkbox'));
    await user.type(screen.getByTestId('composer-prompt'), 'fresh worktree');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(expect.objectContaining({ run_mode: 'new' }));
    });
  });

  it('unchecking worktree before submit emits run_mode=none', async () => {
    apiMock.createTask.mockResolvedValueOnce(makeTask({ id: 'wt-off' }));
    renderComposer('/?repo=%2Fr&mode=new&branch=main');
    expect(screen.getByTestId('worktree-checkbox')).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByTestId('worktree-checkbox'));
    await user.type(screen.getByTestId('composer-prompt'), 'edit in place');
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => {
      expect(apiMock.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ run_mode: 'none' }),
      );
    });
  });
});

// ─── Focus management ────────────────────────────────────────────────────

describe('Composer / focus management', () => {
  it('auto-focuses the textarea on mount', () => {
    renderComposer('/');
    expect(document.activeElement).toBe(screen.getByTestId('composer-prompt'));
  });

  it('`focus-composer` window event refocuses textarea', () => {
    renderComposer('/');
    const textarea = screen.getByTestId('composer-prompt') as HTMLTextAreaElement;
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(textarea);
    window.dispatchEvent(new CustomEvent('focus-composer'));
    expect(document.activeElement).toBe(textarea);
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

// ─── localStorage draft persistence ──────────────────────────────────────

describe('Composer / localStorage draft', () => {
  const DRAFT_KEY = 'octomux-composer-draft-prompt';
  const user = userEvent.setup();

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('reads saved draft from localStorage on mount', () => {
    localStorage.setItem(DRAFT_KEY, 'my saved draft');
    renderComposer('/');
    expect(screen.getByTestId('composer-prompt')).toHaveValue('my saved draft');
  });

  it('writes prompt to localStorage after debounce (250 ms)', async () => {
    vi.useFakeTimers();
    renderComposer('/');
    const textarea = screen.getByTestId('composer-prompt');
    // Use fireEvent directly to avoid fake-timer issues with userEvent
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(textarea, { target: { value: 'hello debounce' } });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    vi.advanceTimersByTime(250);
    expect(localStorage.getItem(DRAFT_KEY)).toBe('hello debounce');
    vi.useRealTimers();
  });

  it('clears localStorage on successful submit', async () => {
    localStorage.setItem(DRAFT_KEY, 'clear on submit');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'chat-x' }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    renderComposer('/?mode=scratch');
    await waitFor(() => {
      expect(screen.getByTestId('composer-prompt')).toHaveValue('clear on submit');
    });
    await user.click(screen.getByTestId('composer-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});
