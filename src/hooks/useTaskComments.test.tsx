import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));

import { useTaskComments } from './useTaskComments';
import type { InlineCommentRow, InlineCommentWithOutdated } from '@/lib/api';

function row(o: Partial<InlineCommentRow> = {}): InlineCommentRow {
  return {
    id: 'c1',
    task_id: 't1',
    agent_id: null,
    file_path: 'src/foo.ts',
    line: 10,
    side: 'new',
    original_commit_sha: 'abc1234',
    body: 'hello',
    created_at: '2026-05-02 00:00:00',
    resolved_at: null,
    ...o,
  };
}

function withOutdated(r: InlineCommentRow, outdated = false): InlineCommentWithOutdated {
  return { ...r, outdated };
}

async function renderLoaded(
  initial: InlineCommentWithOutdated[] = [],
  outdatedUnavailable = false,
) {
  apiMock.listComments.mockResolvedValue(
    outdatedUnavailable ? { comments: initial, outdated_unavailable: true } : { comments: initial },
  );
  const hook = renderHook(() => useTaskComments('t1'));
  await waitFor(() => expect(hook.result.current.byId.size).toBe(initial.length));
  return hook;
}

describe('useTaskComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listComments.mockResolvedValue({ comments: [] });
  });

  it('loads comments on mount', async () => {
    const { result } = await renderLoaded([withOutdated(row({ id: 'c1' }))]);
    expect(result.current.byId.get('c1')?.body).toBe('hello');
  });

  it('groups by file', async () => {
    const { result } = await renderLoaded([
      withOutdated(row({ id: 'c1', file_path: 'a.ts' })),
      withOutdated(row({ id: 'c2', file_path: 'b.ts' })),
      withOutdated(row({ id: 'c3', file_path: 'a.ts', line: 5 })),
    ]);
    expect(result.current.byFile('a.ts')).toHaveLength(2);
    expect(result.current.byFile('b.ts')).toHaveLength(1);
  });

  it('byFileLineSide filters precisely', async () => {
    const { result } = await renderLoaded([
      withOutdated(row({ id: 'c1', file_path: 'a.ts', line: 10, side: 'new' })),
      withOutdated(row({ id: 'c2', file_path: 'a.ts', line: 10, side: 'old' })),
      withOutdated(row({ id: 'c3', file_path: 'a.ts', line: 11, side: 'new' })),
    ]);
    expect(result.current.byFileLineSide('a.ts', 10, 'new')).toHaveLength(1);
    expect(result.current.byFileLineSide('a.ts', 10, 'old')).toHaveLength(1);
    expect(result.current.byFileLineSide('a.ts', 99, 'new')).toHaveLength(0);
  });

  it('post() optimistically adds then replaces with server row', async () => {
    const { result } = await renderLoaded([]);
    apiMock.postComment.mockResolvedValueOnce(row({ id: 'server-1', body: 'real' }));

    await act(async () => {
      await result.current.post({
        file_path: 'src/foo.ts',
        line: 10,
        side: 'new',
        body: 'real',
      });
    });
    expect(result.current.byId.size).toBe(1);
    expect(result.current.byId.has('server-1')).toBe(true);
  });

  it('post() rolls back on failure', async () => {
    const onError = vi.fn();
    apiMock.listComments.mockResolvedValue({ comments: [] });
    const { result } = renderHook(() => useTaskComments('t1', { onError }));
    await waitFor(() => expect(apiMock.listComments).toHaveBeenCalled());

    apiMock.postComment.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await result.current.post({
        file_path: 'src/foo.ts',
        line: 10,
        side: 'new',
        body: 'oops',
      });
    });
    expect(result.current.byId.size).toBe(0);
    expect(onError).toHaveBeenCalledWith('boom');
  });

  it('update() resolves optimistically and rolls back on failure', async () => {
    const onError = vi.fn();
    apiMock.listComments.mockResolvedValue({
      comments: [withOutdated(row({ id: 'c1' }))],
    });
    const { result } = renderHook(() => useTaskComments('t1', { onError }));
    await waitFor(() => expect(result.current.byId.size).toBe(1));

    apiMock.updateComment.mockRejectedValueOnce(new Error('nope'));
    await act(async () => {
      await result.current.update('c1', { resolved: true });
    });
    expect(result.current.byId.get('c1')?.resolved_at).toBeNull();
    expect(onError).toHaveBeenCalledWith('nope');
  });

  it('remove() optimistically deletes and rolls back on failure', async () => {
    const onError = vi.fn();
    apiMock.listComments.mockResolvedValue({
      comments: [withOutdated(row({ id: 'c1' }))],
    });
    const { result } = renderHook(() => useTaskComments('t1', { onError }));
    await waitFor(() => expect(result.current.byId.size).toBe(1));

    apiMock.deleteComment.mockRejectedValueOnce(new Error('forbidden'));
    await act(async () => {
      await result.current.remove('c1');
    });
    expect(result.current.byId.has('c1')).toBe(true);
    expect(onError).toHaveBeenCalledWith('forbidden');
  });

  it('refetch() reloads comments and updates outdated_unavailable', async () => {
    const { result } = await renderLoaded([]);

    apiMock.listComments.mockResolvedValueOnce({
      comments: [withOutdated(row({ id: 'c1' }), true)],
      outdated_unavailable: true,
    });
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.byId.size).toBe(1);
    expect(result.current.outdatedUnavailable).toBe(true);
    expect(result.current.byId.get('c1')?.outdated).toBe(true);
  });

  it('skips fetch when taskId is undefined', async () => {
    const { result } = renderHook(() => useTaskComments(undefined));
    await Promise.resolve();
    expect(result.current.byId.size).toBe(0);
    expect(apiMock.listComments).not.toHaveBeenCalled();
  });
});
