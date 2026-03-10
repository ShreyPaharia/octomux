import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTaskFilters } from './use-task-filters';
import type { Task } from '../../server/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-01',
    title: 'Test',
    description: 'Desc',
    repo_path: '/tmp/repo',
    status: 'running',
    branch: null,
    base_branch: null,
    worktree: null,
    tmux_session: null,
    pr_url: null,
    pr_number: null,
    initial_prompt: null,
    error: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('useTaskFilters', () => {
  const tasks: Task[] = [
    makeTask({ id: 't1', status: 'running', repo_path: '/tmp/alpha' }),
    makeTask({ id: 't2', status: 'draft', repo_path: '/tmp/beta' }),
    makeTask({ id: 't3', status: 'closed', repo_path: '/tmp/alpha' }),
    makeTask({ id: 't4', status: 'error', repo_path: '/tmp/beta' }),
  ];

  it('defaults to open filter showing non-closed tasks', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.status).toBe('open');
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t1', 't2', 't4']);
  });

  it('switches to closed filter', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'closed'));
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t3']);
  });

  it('provides status counts', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.counts.open).toBe(3);
    expect(result.current.counts.closed).toBe(1);
  });
});
