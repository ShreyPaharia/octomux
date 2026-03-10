import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api';

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

// ─── request() via api methods ───────────────────────────────────────────────

describe('api.listTasks', () => {
  it('fetches /api/tasks with GET', async () => {
    fetchMock.mockResolvedValue(mockResponse([]));
    await api.listTasks();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
  });

  it('returns parsed response', async () => {
    const tasks = [{ id: 't1', title: 'Test' }];
    fetchMock.mockResolvedValue(mockResponse(tasks));
    const result = await api.listTasks();
    expect(result).toEqual(tasks);
  });
});

describe('api.getTask', () => {
  it('fetches /api/tasks/:id', async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: 't1' }));
    await api.getTask('t1');
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/t1', expect.any(Object));
  });
});

describe('api.createTask', () => {
  it('sends POST with body', async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: 't1' }));
    await api.createTask({ title: 'T', description: 'D', repo_path: '/tmp' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'T', description: 'D', repo_path: '/tmp' }),
      }),
    );
  });
});

describe('api.updateTask', () => {
  it('sends PATCH with status', async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: 't1', status: 'closed' }));
    await api.updateTask('t1', { status: 'closed' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/t1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'closed' }),
      }),
    );
  });
});

describe('api.deleteTask', () => {
  it('sends DELETE and returns undefined for 204', async () => {
    fetchMock.mockResolvedValue(mockResponse(undefined, 204));
    const result = await api.deleteTask('t1');
    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/t1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('api.addAgent', () => {
  it('sends POST with prompt', async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: 'a1' }));
    await api.addAgent('t1', { prompt: 'Write tests' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/t1/agents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ prompt: 'Write tests' }),
      }),
    );
  });

  it('sends empty object when no data provided', async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: 'a1' }));
    await api.addAgent('t1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/t1/agents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
  });
});

describe('api.stopAgent', () => {
  it('sends DELETE for agent', async () => {
    fetchMock.mockResolvedValue(mockResponse(undefined, 204));
    await api.stopAgent('t1', 'a1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/t1/agents/a1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('api.browse', () => {
  it('sends path as query param', async () => {
    fetchMock.mockResolvedValue(mockResponse({ current: '/tmp', parent: '/', entries: [] }));
    await api.browse('/tmp');
    expect(fetchMock).toHaveBeenCalledWith('/api/browse?path=%2Ftmp', expect.any(Object));
  });

  it('sends no query param when path is undefined', async () => {
    fetchMock.mockResolvedValue(mockResponse({ current: '/home', parent: '/', entries: [] }));
    await api.browse();
    expect(fetchMock).toHaveBeenCalledWith('/api/browse', expect.any(Object));
  });
});

describe('api.recentRepos', () => {
  it('fetches /api/recent-repos', async () => {
    fetchMock.mockResolvedValue(mockResponse([]));
    await api.recentRepos();
    expect(fetchMock).toHaveBeenCalledWith('/api/recent-repos', expect.any(Object));
  });
});

describe('api.previewPR', () => {
  it('sends POST with base branch', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ title: 'feat: test', body: '## What', base: 'main' }),
    );
    await api.previewPR('t1', { base: 'main' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/t1/pr/preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ base: 'main' }),
      }),
    );
  });
});

describe('api.createPR', () => {
  it('sends POST with PR details', async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: 't1', pr_url: 'https://gh/pr/1' }));
    await api.createPR('t1', { base: 'main', title: 'feat: test', body: '## What' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/t1/pr',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ base: 'main', title: 'feat: test', body: '## What' }),
      }),
    );
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('request error handling', () => {
  it('throws error from response body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: 'title is required' }),
    });
    await expect(api.listTasks()).rejects.toThrow('title is required');
  });

  it('falls back to statusText when body has no error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.resolve({}),
    });
    await expect(api.listTasks()).rejects.toThrow('Internal Server Error');
  });

  it('falls back to statusText when body parse fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.reject(new Error('not json')),
    });
    await expect(api.listTasks()).rejects.toThrow('Internal Server Error');
  });
});
