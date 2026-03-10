import { describe, it, expect, beforeEach } from 'vitest';
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

beforeEach(() => {
  localStorage.clear();
});

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

  // ─── Repo filtering ─────────────────────────────────────────────────────

  it('returns sorted unique repos', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.repos).toEqual(['/tmp/alpha', '/tmp/beta']);
  });

  it('defaults to all repos (empty string)', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.repo).toBe('');
  });

  it('filters tasks by repo', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('repo', '/tmp/alpha'));
    const ids = result.current.filtered.map((t) => t.id);
    // open filter + alpha repo = only t1 (running in alpha)
    expect(ids).toEqual(['t1']);
  });

  it('updates counts when repo filter is active', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('repo', '/tmp/alpha'));
    expect(result.current.counts.open).toBe(1);
    expect(result.current.counts.closed).toBe(1);
  });

  it('shows all tasks for selected repo when switching status tabs', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('repo', '/tmp/alpha'));
    act(() => result.current.setFilter('status', 'closed'));
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t3']);
  });

  it('persists repo filter to localStorage', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('repo', '/tmp/beta'));
    expect(localStorage.getItem('octomux-repo-filter')).toBe('/tmp/beta');
  });

  it('restores repo filter from localStorage', () => {
    localStorage.setItem('octomux-repo-filter', '/tmp/beta');
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.repo).toBe('/tmp/beta');
    // Should filter immediately
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t2', 't4']); // open tasks in beta
  });
});
