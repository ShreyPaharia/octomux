import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UniversalSidebar } from './sidebar/universal-sidebar';
import { forkDisabledReason } from './sidebar/nav-items';
import { renderWithRouter, makeTask } from '../test-helpers';
import { TasksProvider } from '../lib/tasks-context';
import type { RunMode } from '../../server/types';
import type { SidebarItem } from '@/lib/sidebar-utils';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));
const { mockNavigate, routerMockFactory } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupRouterNavigateMock(),
);
vi.mock('react-router-dom', routerMockFactory);

function renderSidebar(route: string = '/') {
  return renderWithRouter(
    <TasksProvider>
      <UniversalSidebar />
    </TasksProvider>,
    { route },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  apiMock.listTasks.mockResolvedValue([]);
});

describe('UniversalSidebar nav', () => {
  it('renders Home, Tasks, Reviews, Settings nav items', async () => {
    renderSidebar('/');
    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument());
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Reviews')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.queryByText('ORCHESTRATOR')).not.toBeInTheDocument();
  });

  it('points Tasks to /tasks, Reviews to /reviews and Home to /', async () => {
    renderSidebar('/');
    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument());
    expect(screen.getByText('Home').closest('a')).toHaveAttribute('href', '/');
    expect(screen.getByText('Tasks').closest('a')).toHaveAttribute('href', '/tasks');
    expect(screen.getByText('Reviews').closest('a')).toHaveAttribute('href', '/reviews');
  });

  it('nav links carry an aria-label matching the nav label', async () => {
    renderSidebar('/');
    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument());
    expect(screen.getByLabelText('Home')).toBeInTheDocument();
    expect(screen.getByLabelText('Tasks')).toBeInTheDocument();
    expect(screen.getByLabelText('Reviews')).toBeInTheDocument();
    expect(screen.getByLabelText('Settings')).toBeInTheDocument();
  });

  it('marks Reviews as active on /reviews and /reviews/:id', async () => {
    renderSidebar('/reviews');
    const row = await screen.findByTestId('sidebar-nav-reviews');
    expect(row).toHaveAttribute('data-active', 'true');
  });

  it('active nav row carries primary tint + left accent bar classes', async () => {
    renderSidebar('/tasks');
    const row = await screen.findByTestId('sidebar-nav-tasks');
    expect(row).toHaveAttribute('data-active', 'true');
    expect(row.className).toMatch(/border-primary/);
    expect(row.className).toMatch(/bg-primary\/15/);
    expect(row.className).toMatch(/text-primary/);
  });
});

describe('UniversalSidebar Monitor link', () => {
  it('shows a Monitor link above Workspaces under More, routing to /monitor', async () => {
    const user = userEvent.setup();
    renderSidebar('/');
    await waitFor(() => expect(screen.getByTestId('sidebar-more-toggle')).toBeInTheDocument());
    await user.click(screen.getByTestId('sidebar-more-toggle'));

    const monitor = await screen.findByTestId('sidebar-more-monitor');
    const workspaces = screen.getByTestId('sidebar-more-workspaces');
    expect(monitor).toHaveAttribute('href', '/monitor');

    // Monitor must render before Workspaces in document order.
    expect(monitor.compareDocumentPosition(workspaces)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('marks Monitor active on /monitor', async () => {
    const user = userEvent.setup();
    renderSidebar('/monitor');
    await user.click(await screen.findByTestId('sidebar-more-toggle'));
    const monitor = await screen.findByTestId('sidebar-more-monitor');
    expect(monitor).toHaveAttribute('data-active', 'true');
    expect(monitor.className).toMatch(/border-primary/);
    expect(monitor.className).toMatch(/text-primary/);
  });
});

describe('UniversalSidebar grouping', () => {
  it('groups sessions by repo basename', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', repo_path: '/dev/nucleus', title: 'Alpha' }),
      makeTask({ id: 't2', runtime_state: 'running', repo_path: '/dev/octomux', title: 'Beta' }),
      makeTask({ id: 't3', runtime_state: 'running', repo_path: '/dev/nucleus', title: 'Gamma' }),
    ]);
    renderSidebar();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.getByRole('button', { expanded: true, name: /nucleus/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { expanded: true, name: /^octomux$/i })).toBeInTheDocument();
  });

  it('renders an Other group for scratch / repo-less tasks', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', repo_path: '/dev/alpha' }),
      makeTask({
        id: 'scratch-1',
        runtime_state: 'running',
        repo_path: '',
        run_mode: 'scratch',
        title: 'Scratchwork',
      }),
    ]);
    renderSidebar();
    await waitFor(() => expect(screen.getByText('Scratchwork')).toBeInTheDocument());
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('does not render a + button on the Other group', async () => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({
        id: 'scratch-1',
        runtime_state: 'running',
        repo_path: '',
        run_mode: 'scratch',
        title: 'Scratchwork',
      }),
    ]);
    renderSidebar();
    await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument());
    expect(screen.queryByTestId('sidebar-group-add-__other__')).toBeNull();
  });

  it('navigates to the composer with repo + mode on + click', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', repo_path: '/dev/nucleus' }),
    ]);
    renderSidebar();
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-group-add-/dev/nucleus')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('sidebar-group-add-/dev/nucleus'));
    expect(mockNavigate).toHaveBeenCalledWith('/?repo=%2Fdev%2Fnucleus&mode=new');
  });
});

describe('UniversalSidebar status glyph + run-mode badge', () => {
  const rowFor = (id: string) => screen.getByTestId(`sidebar-row-${id}`);

  it.each<{ mode: RunMode; letter: string }>([
    { mode: 'new', letter: 'N' },
    { mode: 'existing', letter: 'E' },
    { mode: 'none', letter: 'Ø' },
    { mode: 'scratch', letter: 'S' },
  ])('renders the $letter badge for run_mode=$mode', async ({ mode, letter }) => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({
        id: `t-${mode}`,
        runtime_state: 'running',
        run_mode: mode,
        repo_path: mode === 'scratch' ? '' : '/dev/alpha',
      }),
    ]);
    renderSidebar();
    await waitFor(() => expect(rowFor(`t-${mode}`)).toBeInTheDocument());
    const row = rowFor(`t-${mode}`);
    const badge = row.querySelector('[data-run-mode]') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe(letter);
  });

  it.each([
    { name: 'running', runtime_state: 'running' as const, derived: null, glyph: 'running' },
    {
      name: 'needs_attention',
      runtime_state: 'running' as const,
      derived: 'needs_attention' as const,
      glyph: 'needs-you',
    },
    { name: 'error', runtime_state: 'error' as const, derived: null, glyph: 'error' },
    {
      name: 'setting_up',
      runtime_state: 'setting_up' as const,
      derived: null,
      glyph: 'setting_up',
    },
  ])('maps $name → glyph=$glyph', async ({ runtime_state, derived, glyph }) => {
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state, derived_status: derived, repo_path: '/dev/alpha' }),
    ]);
    renderSidebar();
    await waitFor(() => expect(rowFor('t1')).toBeInTheDocument());
    expect(rowFor('t1').querySelector(`[data-status-glyph="${glyph}"]`)).toBeTruthy();
  });
});

describe('UniversalSidebar group collapse persistence', () => {
  it('persists collapsed state per-group and rehydrates on re-render', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', repo_path: '/dev/nucleus', title: 'Alpha' }),
    ]);
    const { unmount } = renderSidebar();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    // The group header button exposes aria-expanded; target it specifically.
    await user.click(screen.getByRole('button', { expanded: true, name: /nucleus/i }));
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());

    expect(localStorage.getItem('octomux:sidebar:collapsed:/dev/nucleus')).toBe('true');

    unmount();

    renderSidebar();
    // After rehydrate, the group should still be collapsed
    await waitFor(() =>
      expect(screen.getByRole('button', { expanded: false, name: /nucleus/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });
});

describe('UniversalSidebar row menu', () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>, id: string) {
    await waitFor(() =>
      expect(screen.getByTestId(`task-row-menu-trigger-${id}`)).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId(`task-row-menu-trigger-${id}`));
    await waitFor(() => expect(screen.getByTestId(`task-row-menu-${id}`)).toBeInTheDocument());
    return screen.getByTestId(`task-row-menu-${id}`);
  }

  it('Open navigates to /tasks/<id>', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', repo_path: '/dev/alpha' }),
    ]);
    renderSidebar();
    const menu = await openMenu(user, 't1');
    await user.click(within(menu).getByText('Open'));
    expect(mockNavigate).toHaveBeenCalledWith('/tasks/t1');
  });

  it('Fork navigates to Home with repo/base_branch/mode/fork_of', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({
        id: 't1',
        runtime_state: 'running',
        run_mode: 'new',
        repo_path: '/dev/nucleus',
      }),
    ]);
    renderSidebar();
    const menu = await openMenu(user, 't1');
    await user.click(within(menu).getByText('Fork into new task'));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const url = mockNavigate.mock.calls[0][0] as string;
    expect(url).toContain('/?');
    expect(url).toContain('repo=%2Fdev%2Fnucleus');
    expect(url).toContain('base_branch=agents%2Ft1');
    expect(url).toContain('mode=new');
    expect(url).toContain('fork_of=t1');
  });

  it('Add agent navigates to Home with add_agent=<id>', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', repo_path: '/dev/alpha' }),
    ]);
    renderSidebar();
    const menu = await openMenu(user, 't1');
    await user.click(within(menu).getByText('Add agent…'));
    expect(mockNavigate).toHaveBeenCalledWith('/?add_agent=t1');
  });

  it('Done calls moveTask({workflow_status:done})', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', repo_path: '/dev/alpha' }),
    ]);
    renderSidebar();
    const menu = await openMenu(user, 't1');
    await user.click(within(menu).getByText('Done'));
    await waitFor(() =>
      expect(apiMock.moveTask).toHaveBeenCalledWith('t1', { workflow_status: 'done' }),
    );
  });

  it('Delete calls deleteTask', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', repo_path: '/dev/alpha' }),
    ]);
    renderSidebar();
    const menu = await openMenu(user, 't1');
    await user.click(within(menu).getByText('Delete'));
    await waitFor(() => expect(apiMock.deleteTask).toHaveBeenCalledWith('t1'));
  });

  it('Rename shows an input and calls updateTask({title}) on submit', async () => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({
        id: 't1',
        runtime_state: 'running',
        repo_path: '/dev/alpha',
        title: 'Old Title',
      }),
    ]);
    renderSidebar();
    const menu = await openMenu(user, 't1');
    await user.click(within(menu).getByText('Rename'));
    await waitFor(() => expect(screen.getByTestId('sidebar-rename-input')).toBeInTheDocument());
    const input = screen.getByTestId('sidebar-rename-input') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'New Title');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(apiMock.updateTask).toHaveBeenCalledWith('t1', { title: 'New Title' }),
    );
  });
});

describe('UniversalSidebar footer', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');

  function setOnline(value: boolean) {
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      get: () => value,
    });
  }

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(window.navigator, 'onLine', originalDescriptor);
    }
  });

  it('shows the connected state when the ws/context reports online', async () => {
    setOnline(true);
    renderSidebar('/');
    const footer = await screen.findByTestId('sidebar-footer');
    expect(footer).toHaveAttribute('data-connection', 'connected');
    expect(screen.getByLabelText('Connection connected')).toBeInTheDocument();
  });

  it('switches to reconnecting when the ws/context reports offline', async () => {
    setOnline(false);
    renderSidebar('/');
    const footer = await screen.findByTestId('sidebar-footer');
    expect(footer).toHaveAttribute('data-connection', 'reconnecting');
    expect(screen.getByLabelText('Connection reconnecting')).toBeInTheDocument();
  });

  it('reacts to online/offline events while mounted', async () => {
    setOnline(true);
    renderSidebar('/');
    const footer = await screen.findByTestId('sidebar-footer');
    expect(footer).toHaveAttribute('data-connection', 'connected');

    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('sidebar-footer')).toHaveAttribute(
        'data-connection',
        'reconnecting',
      ),
    );
  });
});

describe('forkDisabledReason', () => {
  function item(overrides: Partial<SidebarItem> = {}): SidebarItem {
    return {
      id: 'x',
      title: 'T',
      status: 'running',
      derivedStatus: null,
      runMode: 'new',
      repoPath: '/r',
      ...overrides,
    };
  }

  it.each<{ name: string; item: Partial<SidebarItem>; expected: string | null }>([
    { name: 'allows new', item: { runMode: 'new' }, expected: null },
    { name: 'allows existing', item: { runMode: 'existing' }, expected: null },
    { name: 'disallows scratch', item: { runMode: 'scratch' }, expected: 'scratch' },
    { name: 'disallows none', item: { runMode: 'none' }, expected: 'working tree' },
    { name: 'disallows draft', item: { status: 'idle' as const }, expected: 'draft' },
  ])('$name', ({ item: overrides, expected }) => {
    const reason = forkDisabledReason(item(overrides));
    if (expected === null) expect(reason).toBeNull();
    else expect(reason).toMatch(new RegExp(expected, 'i'));
  });
});

describe('UniversalSidebar row menu — Fork refusal', () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>, id: string) {
    await waitFor(() =>
      expect(screen.getByTestId(`task-row-menu-trigger-${id}`)).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId(`task-row-menu-trigger-${id}`));
    return screen.getByTestId(`task-row-menu-${id}`);
  }

  it.each<{ name: string; runMode: RunMode; repoPath: string }>([
    { name: 'scratch', runMode: 'scratch', repoPath: '' },
    { name: 'none', runMode: 'none', repoPath: '/dev/alpha' },
  ])('disables Fork for run_mode=$name', async ({ runMode, repoPath }) => {
    const user = userEvent.setup();
    apiMock.listTasks.mockResolvedValue([
      makeTask({ id: 't1', runtime_state: 'running', run_mode: runMode, repo_path: repoPath }),
    ]);
    renderSidebar();
    const menu = await openMenu(user, 't1');
    const forkItem = within(menu).getByText('Fork into new task');
    expect(forkItem.closest('button')).toBeDisabled();
    // Click should not navigate
    mockNavigate.mockClear();
    await user.click(forkItem);
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
