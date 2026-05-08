import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTaskFilters } from './use-task-filters';
import { makeTask } from '../test-helpers';
import type { Task } from '../../server/types';

beforeEach(() => {
  localStorage.clear();
});

describe('useTaskFilters', () => {
  const tasks: Task[] = [
    makeTask({ id: 't1', runtime_state: 'running', repo_path: '/tmp/alpha' }),
    makeTask({ id: 't2', runtime_state: 'idle', repo_path: '/tmp/beta' }),
    makeTask({ id: 't3', runtime_state: 'idle', repo_path: '/tmp/alpha' }),
    makeTask({ id: 't4', runtime_state: 'error', repo_path: '/tmp/beta' }),
  ];

  it('defaults to All filter showing every task', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.status).toBe('all');
    const ids = result.current.filtered.map((t) => t.id).sort();
    expect(ids).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('Running chip shows only running / setting_up tasks', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'running'));
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t1']);
  });

  it('Needs You chip includes errored tasks', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'needs_you'));
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t4']);
  });

  it('Needs You includes tasks with pending prompts', () => {
    const extra = makeTask({
      id: 't5',
      runtime_state: 'running',
      repo_path: '/tmp/beta',
      pending_prompts: [
        {
          id: 'pp1',
          task_id: 't5',
          agent_id: null,
          agent_label: 'a',
          session_id: 's',
          tool_name: 'Bash',
          tool_input: {},
          status: 'pending',
          created_at: '',
          resolved_at: null,
        },
      ],
    });
    const { result } = renderHook(() => useTaskFilters([...tasks, extra]));
    act(() => result.current.setFilter('status', 'needs_you'));
    const ids = result.current.filtered.map((t) => t.id).sort();
    expect(ids).toEqual(['t4', 't5']);
  });

  it('Closed chip shows idle (closed/draft) tasks', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'closed'));
    const ids = result.current.filtered.map((t) => t.id).sort();
    expect(ids).toEqual(['t2', 't3']);
  });

  it('provides status counts for all chips', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.counts.all).toBe(4);
    expect(result.current.counts.running).toBe(1);
    expect(result.current.counts.needs_you).toBe(1);
    expect(result.current.counts.closed).toBe(2); // both idle tasks (t2+t3)
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
    const ids = result.current.filtered.map((t) => t.id).sort();
    expect(ids).toEqual(['t1', 't3']);
  });

  it('updates counts when repo filter is active', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('repo', '/tmp/alpha'));
    expect(result.current.counts.all).toBe(2);
    expect(result.current.counts.running).toBe(1);
    expect(result.current.counts.needs_you).toBe(0);
    expect(result.current.counts.closed).toBe(1); // only t3 (idle) in /tmp/alpha
  });

  it('shows all tasks for selected repo when switching status tabs', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('repo', '/tmp/alpha'));
    act(() => result.current.setFilter('status', 'closed'));
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t3']);
  });

  // ─── Persistence ──────────────────────────────────────────────────────

  it('persists status filter to localStorage', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'closed'));
    expect(localStorage.getItem('octomux-status-filter')).toBe('closed');
  });

  it('restores status filter from localStorage', () => {
    localStorage.setItem('octomux-status-filter', 'closed');
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.status).toBe('closed');
    const ids = result.current.filtered.map((t) => t.id).sort();
    expect(ids).toEqual(['t2', 't3']); // both idle tasks (t2 was closed, t3 was draft)
  });

  it('restores needs_you status filter from localStorage', () => {
    localStorage.setItem('octomux-status-filter', 'needs_you');
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.status).toBe('needs_you');
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t4']);
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
    const ids = result.current.filtered.map((t) => t.id).sort();
    expect(ids).toEqual(['t2', 't4']);
  });
});
