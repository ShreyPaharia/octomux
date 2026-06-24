import { describe, it, expect, vi, beforeEach } from 'vitest';
import { taskApi } from '../lib/api/taskApi';

// ─── Fetch Mock ──────────────────────────────────────────────────────────────

const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── API methods (table-driven) ─────────────────────────────────────────────

const apiCases = [
  {
    name: 'listTasks',
    call: () => taskApi.listTasks(),
    expectedUrl: '/api/tasks',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: [{ id: 't1', title: 'Test' }],
  },
  {
    name: 'getTask',
    call: () => taskApi.getTask('t1'),
    expectedUrl: '/api/tasks/t1',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: { id: 't1' },
  },
  {
    name: 'createTask',
    call: () => taskApi.createTask({ title: 'T', description: 'D', repo_path: '/tmp' }),
    expectedUrl: '/api/tasks',
    expectedMethod: 'POST',
    expectedBody: JSON.stringify({ title: 'T', description: 'D', repo_path: '/tmp' }),
    response: { id: 't1' },
  },
  {
    name: 'updateTask',
    call: () => taskApi.updateTask('t1', { status: 'closed' }),
    expectedUrl: '/api/tasks/t1',
    expectedMethod: 'PATCH',
    expectedBody: JSON.stringify({ status: 'closed' }),
    response: { id: 't1', status: 'closed' },
  },
  {
    name: 'startTask',
    call: () => taskApi.startTask('t1'),
    expectedUrl: '/api/tasks/t1/start',
    expectedMethod: 'POST',
    expectedBody: undefined,
    response: { id: 't1' },
  },
  {
    name: 'deleteTask',
    call: () => taskApi.deleteTask('t1'),
    expectedUrl: '/api/tasks/t1',
    expectedMethod: 'DELETE',
    expectedBody: undefined,
    response: undefined,
    status: 204,
  },
  {
    name: 'addAgent with prompt',
    call: () => taskApi.addAgent('t1', { prompt: 'Write tests' }),
    expectedUrl: '/api/tasks/t1/agents',
    expectedMethod: 'POST',
    expectedBody: JSON.stringify({ prompt: 'Write tests' }),
    response: { id: 'a1' },
  },
  {
    name: 'addAgent without data',
    call: () => taskApi.addAgent('t1'),
    expectedUrl: '/api/tasks/t1/agents',
    expectedMethod: 'POST',
    expectedBody: JSON.stringify({}),
    response: { id: 'a1' },
  },
  {
    name: 'stopAgent',
    call: () => taskApi.stopAgent('t1', 'a1'),
    expectedUrl: '/api/tasks/t1/agents/a1',
    expectedMethod: 'DELETE',
    expectedBody: undefined,
    response: undefined,
    status: 204,
  },
  {
    name: 'browse with path',
    call: () => taskApi.browse('/tmp'),
    expectedUrl: '/api/browse?path=%2Ftmp',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: { current: '/tmp', parent: '/', entries: [] },
  },
  {
    name: 'browse without path',
    call: () => taskApi.browse(),
    expectedUrl: '/api/browse',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: { current: '/home', parent: '/', entries: [] },
  },
  {
    name: 'recentRepos',
    call: () => taskApi.recentRepos(),
    expectedUrl: '/api/recent-repos',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: [],
  },
  {
    name: 'listBranches',
    call: () => taskApi.listBranches('/tmp/repo'),
    expectedUrl: '/api/branches?repo_path=%2Ftmp%2Frepo',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: ['main', 'develop'],
  },
  {
    name: 'getDefaultBranch',
    call: () => taskApi.getDefaultBranch('/tmp/repo'),
    expectedUrl: '/api/default-branch?repo_path=%2Ftmp%2Frepo',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: { branch: 'main' },
  },

  {
    name: 'createTerminal',
    call: () => taskApi.createTerminal('t1'),
    expectedUrl: '/api/tasks/t1/terminals',
    expectedMethod: 'POST',
    expectedBody: JSON.stringify({}),
    response: {
      id: 'term-1',
      task_id: 't1',
      window_index: 3,
      label: 'Terminal 1',
      status: 'idle',
      created_at: '',
    },
  },
  {
    name: 'closeTerminal',
    call: () => taskApi.closeTerminal('t1', 'term-1'),
    expectedUrl: '/api/tasks/t1/terminals/term-1',
    expectedMethod: 'DELETE',
    expectedBody: undefined,
    response: undefined,
    status: 204,
  },
  {
    name: 'markReviewed',
    call: () => taskApi.markReviewed('t1', 'src/foo.ts'),
    expectedUrl: '/api/tasks/t1/files/src/foo.ts/reviewed',
    expectedMethod: 'POST',
    expectedBody: undefined,
    response: undefined,
    status: 204,
  },
  {
    name: 'unmarkReviewed',
    call: () => taskApi.unmarkReviewed('t1', 'src/foo.ts'),
    expectedUrl: '/api/tasks/t1/files/src/foo.ts/reviewed',
    expectedMethod: 'DELETE',
    expectedBody: undefined,
    response: undefined,
    status: 204,
  },
  {
    name: 'postComment',
    call: () =>
      taskApi.postComment('t1', {
        file_path: 'src/foo.ts',
        line: 12,
        side: 'new',
        body: 'nit: rename this',
      }),
    expectedUrl: '/api/tasks/t1/comments',
    expectedMethod: 'POST',
    expectedBody: JSON.stringify({
      file_path: 'src/foo.ts',
      line: 12,
      side: 'new',
      body: 'nit: rename this',
    }),
    response: {
      id: 'c1',
      task_id: 't1',
      agent_id: null,
      file_path: 'src/foo.ts',
      line: 12,
      side: 'new',
      original_commit_sha: 'abc',
      body: 'nit: rename this',
      created_at: '2026-05-02 00:00:00',
      resolved_at: null,
    },
  },
  {
    name: 'listComments without file filter',
    call: () => taskApi.listComments('t1'),
    expectedUrl: '/api/tasks/t1/comments',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: { comments: [] },
  },
  {
    name: 'listComments with file filter',
    call: () => taskApi.listComments('t1', 'src/foo.ts'),
    expectedUrl: '/api/tasks/t1/comments?file=src%2Ffoo.ts',
    expectedMethod: undefined,
    expectedBody: undefined,
    response: { comments: [], outdated_unavailable: true },
  },
  {
    name: 'updateComment resolve',
    call: () => taskApi.updateComment('t1', 'c1', { resolved: true }),
    expectedUrl: '/api/tasks/t1/comments/c1',
    expectedMethod: 'PATCH',
    expectedBody: JSON.stringify({ resolved: true }),
    response: {
      id: 'c1',
      task_id: 't1',
      agent_id: null,
      file_path: 'src/foo.ts',
      line: 12,
      side: 'new',
      original_commit_sha: 'abc',
      body: 'nit: rename this',
      created_at: '2026-05-02 00:00:00',
      resolved_at: '2026-05-02 00:01:00',
    },
  },
  {
    name: 'updateComment edit body',
    call: () => taskApi.updateComment('t1', 'c1', { body: 'updated' }),
    expectedUrl: '/api/tasks/t1/comments/c1',
    expectedMethod: 'PATCH',
    expectedBody: JSON.stringify({ body: 'updated' }),
    response: {
      id: 'c1',
      task_id: 't1',
      agent_id: null,
      file_path: 'src/foo.ts',
      line: 12,
      side: 'new',
      original_commit_sha: 'abc',
      body: 'updated',
      created_at: '2026-05-02 00:00:00',
      resolved_at: null,
    },
  },
  {
    name: 'deleteComment',
    call: () => taskApi.deleteComment('t1', 'c1'),
    expectedUrl: '/api/tasks/t1/comments/c1',
    expectedMethod: 'DELETE',
    expectedBody: undefined,
    response: undefined,
    status: 204,
  },
] as const;

describe('api methods (table-driven)', () => {
  it.each(apiCases)('$name → $expectedMethod $expectedUrl', async (testCase) => {
    const status = 'status' in testCase ? (testCase.status as number) : 200;
    fetchMock.mockResolvedValue(mockResponse(testCase.response, status));

    const result = await testCase.call();

    expect(fetchMock).toHaveBeenCalledWith(
      testCase.expectedUrl,
      expect.objectContaining({
        ...(testCase.expectedMethod ? { method: testCase.expectedMethod } : {}),
        ...(testCase.expectedBody ? { body: testCase.expectedBody } : {}),
      }),
    );

    if (status === 204) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toEqual(testCase.response);
    }
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('request error handling', () => {
  const errorCases = [
    {
      name: 'throws error from response body',
      response: {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: 'title is required' }),
      },
      expectedError: 'title is required',
    },
    {
      name: 'falls back to statusText when body has no error',
      response: {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      },
      expectedError: 'Internal Server Error',
    },
    {
      name: 'falls back to statusText when body parse fails',
      response: {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('not json')),
      },
      expectedError: 'Internal Server Error',
    },
  ];

  it.each(errorCases)('$name', async ({ response, expectedError }) => {
    fetchMock.mockResolvedValue(response);
    await expect(taskApi.listTasks()).rejects.toThrow(expectedError);
  });
});
