import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BulkCreateDialog, parsePastePrompts, parseIssueNumbers } from './BulkCreateDialog';
import { renderWithRouter } from '../test-helpers';
import { TasksProvider } from '../lib/tasks-context';

const { taskApiProxy, reviewApiProxy, configApiProxy, apiMock } = await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());

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

function renderDialog() {
  return renderWithRouter(
    <TasksProvider>
      <BulkCreateDialog open onOpenChange={() => {}} />
    </TasksProvider>,
  );
}

const REPO_PLACEHOLDER = '/Users/you/projects/my-repo';

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listTasks.mockResolvedValue([]);
  apiMock.createTask.mockResolvedValue({ id: 'new-task' });
});

describe('parsePastePrompts', () => {
  it('treats each non-empty line as its own task when there are no blank lines', () => {
    const parsed = parsePastePrompts('Alpha\nBravo\n\n');
    // single block (blank trailing lines collapse) → per-line tasks
    expect(parsed).toEqual([
      { title: 'Alpha', prompt: 'Alpha' },
      { title: 'Bravo', prompt: 'Bravo' },
    ]);
  });

  it('splits blank-line blocks into title + prompt', () => {
    const parsed = parsePastePrompts('First task\nmore detail\n\nSecond task');
    expect(parsed).toEqual([
      { title: 'First task', prompt: 'more detail' },
      { title: 'Second task', prompt: 'Second task' },
    ]);
  });
});

describe('parseIssueNumbers', () => {
  it('parses comma/space separated unique positive ints', () => {
    expect(parseIssueNumbers('124, 125, 126 127')).toEqual([124, 125, 126, 127]);
    expect(parseIssueNumbers('12, 12, -3, abc, 0, 5')).toEqual([12, 5]);
  });
});

describe('BulkCreateDialog paste mode', () => {
  it('creates one task per line and routes to /monitor', async () => {
    const user = userEvent.setup();
    renderDialog();

    const lines = ['Task one', 'Task two', 'Task three', 'Task four', 'Task five', 'Task six'];
    const textarea = screen.getByTestId('bulk-paste-textarea');
    await user.click(textarea);
    await user.paste(lines.join('\n'));

    await user.type(screen.getByPlaceholderText(REPO_PLACEHOLDER), '/dev/octomux');

    const submit = screen.getByTestId('bulk-create-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalledTimes(6));
    const titles = apiMock.createTask.mock.calls.map((c) => c[0].title);
    expect(titles).toEqual(lines);
    apiMock.createTask.mock.calls.forEach((c) => {
      expect(c[0]).toMatchObject({ run_mode: 'new', repo_path: '/dev/octomux' });
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/monitor'));
  });
});

describe('BulkCreateDialog github mode', () => {
  it('fetches issues and builds tasks with body + Closes #N footer', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      const number = Number(url.split('/').pop());
      return {
        ok: true,
        status: 200,
        json: async () => ({
          number,
          title: `Issue ${number}`,
          body: `Body of ${number}`,
          html_url: `https://github.com/o/r/issues/${number}`,
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDialog();
    await user.click(screen.getByTestId('bulk-mode-github'));
    await user.type(screen.getByTestId('bulk-gh-repo'), 'Owner/Repo');
    await user.type(screen.getByTestId('bulk-gh-numbers'), '124, 125');
    await user.type(screen.getByPlaceholderText(REPO_PLACEHOLDER), '/dev/octomux');

    const submit = screen.getByTestId('bulk-create-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    await waitFor(() => expect(apiMock.createTask).toHaveBeenCalledTimes(2));
    const first = apiMock.createTask.mock.calls[0][0];
    expect(first.title).toBe('Issue 124');
    expect(first.initial_prompt).toContain('Body of 124');
    expect(first.initial_prompt).toContain('Closes #124');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/monitor'));

    vi.unstubAllGlobals();
  });

  it('continues past a failing issue and surfaces a summary without navigating', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      const number = Number(url.split('/').pop());
      if (number === 999) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          number,
          title: `Issue ${number}`,
          body: 'b',
          html_url: 'x',
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDialog();
    await user.click(screen.getByTestId('bulk-mode-github'));
    await user.type(screen.getByTestId('bulk-gh-repo'), 'Owner/Repo');
    await user.type(screen.getByTestId('bulk-gh-numbers'), '124, 999');
    await user.type(screen.getByPlaceholderText(REPO_PLACEHOLDER), '/dev/octomux');

    const submit = screen.getByTestId('bulk-create-submit');
    await waitFor(() => expect(submit).not.toBeDisabled());
    await user.click(submit);

    const summary = await screen.findByTestId('bulk-summary');
    expect(summary).toHaveTextContent('1 created, 1 failed');
    expect(summary).toHaveTextContent('#999');
    expect(apiMock.createTask).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
