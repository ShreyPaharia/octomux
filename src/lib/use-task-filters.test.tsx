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
    makeTask({ id: 't1', status: 'running', repo_path: '/tmp/alpha' }),
    makeTask({ id: 't2', status: 'draft', repo_path: '/tmp/beta' }),
    makeTask({ id: 't3', status: 'closed', repo_path: '/tmp/alpha' }),
    makeTask({ id: 't4', status: 'error', repo_path: '/tmp/beta' }),
  ];

  it('defaults to open filter showing non-closed, non-draft tasks', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.status).toBe('open');
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t1', 't4']);
  });

  it('switches to closed filter', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'closed'));
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t3']);
  });

  it('switches to backlog filter showing only drafts', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'backlog'));
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t2']);
  });

  it('provides status counts including backlog', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.counts.open).toBe(2);
    expect(result.current.counts.closed).toBe(1);
    expect(result.current.counts.backlog).toBe(1);
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
    expect(result.current.counts.backlog).toBe(0);
  });

  it('shows all tasks for selected repo when switching status tabs', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('repo', '/tmp/alpha'));
    act(() => result.current.setFilter('status', 'closed'));
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t3']);
  });

  // ─── Status persistence ──────────────────────────────────────────────

  it('persists status filter to localStorage', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'closed'));
    expect(localStorage.getItem('octomux-status-filter')).toBe('closed');
  });

  it('restores status filter from localStorage', () => {
    localStorage.setItem('octomux-status-filter', 'closed');
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.status).toBe('closed');
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t3']);
  });

  it('persists backlog status filter to localStorage', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('status', 'backlog'));
    expect(localStorage.getItem('octomux-status-filter')).toBe('backlog');
  });

  it('restores backlog status filter from localStorage', () => {
    localStorage.setItem('octomux-status-filter', 'backlog');
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.status).toBe('backlog');
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t2']);
  });

  // ─── Repo persistence ──────────────────────────────────────────────

  it('persists repo filter to localStorage', () => {
    const { result } = renderHook(() => useTaskFilters(tasks));
    act(() => result.current.setFilter('repo', '/tmp/beta'));
    expect(localStorage.getItem('octomux-repo-filter')).toBe('/tmp/beta');
  });

  it('restores repo filter from localStorage', () => {
    localStorage.setItem('octomux-repo-filter', '/tmp/beta');
    const { result } = renderHook(() => useTaskFilters(tasks));
    expect(result.current.filters.repo).toBe('/tmp/beta');
    // Should filter immediately — open tasks in beta (no draft)
    const ids = result.current.filtered.map((t) => t.id);
    expect(ids).toEqual(['t4']);
  });
});
